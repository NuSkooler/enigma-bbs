const WebHandlerModule = require('../../../web_handler_module');
const {
    userFromActorId,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
    getActorId,
    prepareLocalUserAsActor,
    signedFetchOptions,
} = require('../../../activitypub/util');
const { acceptFollowRequest } = require('../../../activitypub/follow_util');
const {
    fetchAnnouncedNote,
    fetchNoteFromOrigin,
    isConstraintError,
    recordInboundBoost,
    recordInboundLike,
} = require('../../../activitypub/boost_util');
const SysLog = require('../../../logger').log;
const {
    ActivityStreamMediaType,
    WellKnownActivity,
    Collections,
    PublicCollectionId,
} = require('../../../activitypub/const');
const Config = require('../../../config').get;
const Activity = require('../../../activitypub/activity');
const ActivityPubSettings = require('../../../activitypub/settings');
const Actor = require('../../../activitypub/actor');
const Collection = require('../../../activitypub/collection');
const Endpoints = require('../../../activitypub/endpoint');
const Note = require('../../../activitypub/note');
const ActivityPubObject = require('../../../activitypub/object');
const EnigAssert = require('../../../enigma_assert');
const Message = require('../../../message');
//  called through the module, so tests can stand in for the network
const HttpUtil = require('../../../http_util');
const Events = require('../../../events');
const { Errors } = require('../../../enig_error');
const { getFullUrl } = require('../../../web_util');

const {
    validateRequestDate,
    verifyDigestHeader,
    normalizeHttpSigHeader,
    actorIdFromKeyId,
    hostsMatch,
    verifyObjectOwner,
    actorDomainMatchesKeyId,
    actorIdsOf,
    storedObjectOwnerIds,
    storedObjectsOwnerIds,
    verifySignerOwnsObject,
    verifyNoteAuthor,
    sameHost,
    readInboxBody,
} = require('../../../activitypub/security');

// deps
const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');
const httpSignature = require('http-signature');
const async = require('async');

//  collections whose rows are actors (the cache, follow lists), not Notes
const ActorKeyedCollections = [
    Collections.Actors,
    Collections.Following,
    Collections.Followers,
];

//
//  The Create stored for a Note taken from its origin (a forwarded reply):
//  built only from the origin's copy, nothing the forwarder sent. Its id is
//  derived from the Note id, which is verified to be on the author's host:
//  an activity id the forwarder chose could be another activity's (so a
//  Delete of it is checked against the wrong row) or the author's own, still
//  to come (so the real Create is dropped as a duplicate).
//
function createFromOrigin(note, authorId) {
    return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${note.id}#create-from-origin`,
        type: WellKnownActivity.Create,
        actor: authorId,
        published: note.published,
        to: note.to,
        cc: note.cc,
        object: note,
    };
}

exports.moduleInfo = {
    name: 'ActivityPub',
    desc: 'Provides ActivityPub support',
    author: 'NuSkooler, CognitiveGears',
    packageName: 'codes.l33t.enigma.web.handler.activitypub',
};

exports.getModule = class ActivityPubWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        this.webServer = webServer;
        enigma_assert(webServer, 'ActivityPub Web Handler init without webServer');

        this.log = webServer.logger().child({ webHandler: 'ActivityPub' });
        this.sysLog = SysLog.child({ webHandler: 'ActivityPub' });

        //  If ActivityPub is disabled at the handler level, skip route
        //  registration entirely — all AP paths will 404 naturally.
        const enabled = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.enabled',
            false
        );
        if (!enabled) {
            return cb(null);
        }

        Events.addListener(Events.getSystemEvents().NewUserPrePersist, eventInfo => {
            const { user, callback } = eventInfo;
            return this._prepareNewUserAsActor(user, callback);
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/[^/]+$/,
            handler: this._selfUrlRequestHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'POST',
            path: /^\/_enig\/ap\/users\/[^/]+\/inbox$/,
            handler: (req, resp) => {
                return this._enforceMainKeySignatureValidity(
                    req,
                    resp,
                    (req, resp, signature) => {
                        return this._inboxPostHandler(
                            req,
                            resp,
                            signature,
                            Collections.Inbox
                        );
                    }
                );
            },
        });

        this.webServer.addRoute({
            method: 'POST',
            path: /^\/_enig\/ap\/shared-inbox$/,
            handler: (req, resp) => {
                return this._enforceMainKeySignatureValidity(
                    req,
                    resp,
                    (req, resp, signature) => {
                        return this._inboxPostHandler(
                            req,
                            resp,
                            signature,
                            Collections.SharedInbox
                        );
                    }
                );
            },
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/[^/]+\/outbox(\?page=[0-9]+)?$/,
            handler: this._outboxGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/[^/]+\/followers(\?page=[0-9]+)?$/,
            handler: this._followersGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/[^/]+\/following(\?page=[0-9]+)?$/,
            handler: this._followingGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            // e.g. http://some.host/_enig/ap/bf81a22e-cb3e-41c8-b114-21f375b61124/note
            path: /^\/_enig\/ap\/[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}\/note$/,
            handler: this._singlePublicNoteGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            // e.g. http://some.host/_enig/ap/bf81a22e-cb3e-41c8-b114-21f375b61124/note/likes
            path: /^\/_enig\/ap\/[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}\/note\/likes$/,
            handler: this._noteLikesGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            // e.g. http://some.host/_enig/ap/bf81a22e-cb3e-41c8-b114-21f375b61124/note/shares
            path: /^\/_enig\/ap\/[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}\/note\/shares$/,
            handler: this._noteSharesGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            // e.g. http://some.host/_enig/ap/bf81a22e-cb3e-41c8-b114-21f375b61124/note/context
            path: /^\/_enig\/ap\/[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}\/note\/context$/,
            handler: this._noteContextGetHandler.bind(this),
        });

        //  :TODO: NYI
        // this.webServer.addRoute({
        //     method: 'GET',
        //     path: /^\/_enig\/authorize_interaction\?uri=(.+)$/,
        //     handler: this._authorizeInteractionHandler.bind(this),
        // });

        return cb(null);
    }

    _enforceMainKeySignatureValidity(req, resp, next) {
        // the request must be signed, and the signature must be valid
        const signature = this._parseAndValidateSignature(req);
        if (!signature) {
            this.log.warn(
                { url: req.url, method: req.method },
                'Signature validation failed — access denied'
            );
            return this.webServer.accessDenied(resp);
        }

        return next(req, resp, signature);
    }

    _parseAndValidateSignature(req) {
        //  Normalize hs2019 → rsa-sha256 before parsing.
        //  hs2019 is a draft-spec algorithm alias used by GoToSocial (and others);
        //  it is functionally rsa-sha256 for RSA keys.
        for (const h of ['signature', 'authorization']) {
            if (req.headers[h] && req.headers[h].includes('hs2019')) {
                this.log.info({ header: h }, 'Normalizing hs2019 → rsa-sha256');
                req.headers[h] = normalizeHttpSigHeader(req.headers[h]);
            }
        }

        let signature;
        try {
            signature = httpSignature.parseRequest(req);
        } catch (e) {
            this.log.warn(
                { error: e.message, url: req.url, method: req.method },
                'Failed to parse HTTP signature'
            );
            return null;
        }

        //  Sanity check: keyId must be a non-empty URL. The AP ecosystem uses
        //  many key ID conventions (#main-key, /main-key, /keys/1, etc.) so we
        //  only enforce that it looks like a URL; actual key verification happens below.
        const keyId = signature.keyId;
        if (!keyId || !/^https?:\/\//i.test(keyId)) {
            return null;
        }

        //  Reject stale or future-dated requests to prevent replay attacks.
        const dateReason = validateRequestDate(req.headers);
        if (dateReason) {
            this.log.warn(
                { url: req.url, reason: dateReason },
                'Rejected signed request: invalid Date header'
            );
            return null;
        }

        return signature;
    }

    _selfUrlRequestHandler(req, resp) {
        this.log.trace({ url: req.url }, 'Request for "self"');

        let actorId = getFullUrl(req).toString();
        let sendActor = false;
        if (actorId.endsWith('.json')) {
            sendActor = true;
            actorId = actorId.slice(0, -5);
        }

        // Additionally, serve activity JSON if the proper 'Accept' header was sent
        const accept = (req.headers.accept &&
            req.headers.accept.split(',').map(v => v.trim())) || ['*/*'];
        const headerValues = [
            ActivityStreamMediaType,
            'application/ld+json',
            'application/json',
        ];
        if (accept.some(v => headerValues.includes(v))) {
            sendActor = true;
        }

        userFromActorId(actorId, (err, localUser) => {
            if (err) {
                this.log.info(
                    { error: err.message, actorId },
                    `No user for Actor ID ${actorId}`
                );
                return this.webServer.resourceNotFound(resp);
            }

            Actor.fromLocalUser(localUser, (err, localActor) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                if (sendActor) {
                    return this._selfAsActorHandler(localUser, localActor, req, resp);
                } else {
                    return this._selfAsProfileHandler(localUser, localActor, req, resp);
                }
            });
        });
    }

    _getAssociatedActors(objectActorId, keyId, cb) {
        const signatureActorId = actorIdFromKeyId(keyId);
        async.waterfall(
            [
                callback => {
                    Actor.fromId(objectActorId, (err, objectActor) => {
                        return callback(err, objectActor);
                    });
                },
                (objectActor, callback) => {
                    // shortcut
                    if (objectActorId === signatureActorId) {
                        return callback(null, objectActor, objectActor);
                    }

                    //  by keyId, so a key URL answered with its owning actor
                    //  is checked against that keyId
                    Actor.fromKeyId(keyId, (err, signatureActor) => {
                        if (err) {
                            return callback(err);
                        }

                        //  Domain binding: the fetched actor's canonical id must belong
                        //  to the same host as the keyId.  Without this check an attacker
                        //  could host a key at evil.example and return an actor JSON
                        //  claiming id: "https://good.example/users/victim".
                        if (
                            signatureActor &&
                            !actorDomainMatchesKeyId(signatureActor.id, signatureActorId)
                        ) {
                            return callback(
                                Errors.ValidationFailed(
                                    `Actor id domain (${signatureActor.id}) does not match keyId domain (${signatureActorId})`
                                )
                            );
                        }

                        return callback(null, objectActor, signatureActor);
                    });
                },
            ],
            (err, objectActor, signatureActor) => {
                return cb(err, objectActor, signatureActor);
            }
        );
    }

    _inboxPostHandler(req, resp, signature, inboxType) {
        EnigAssert(signature, 'Called without signature!');
        EnigAssert(signature.keyId, 'No keyId in signature!');

        const maxBytes = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.maxInboxBodyBytes',
            1048576
        );

        readInboxBody(req, maxBytes, (err, rawBody) => {
            if (err) {
                if (err.code === 'ENTITY_TOO_LARGE') {
                    this.log.warn(
                        { url: req.url, maxBytes, inboxType },
                        'Inbox body exceeds size limit — rejected'
                    );
                    return this.webServer.requestEntityTooLarge(resp);
                }
                return this.webServer.internalServerError(resp, err);
            }

            //  Independently verify the Digest header body hash when present.
            //  The HTTP signature covers the Digest header, so a valid signature
            //  proves the body hasn't been tampered with since signing — but only
            //  if we also check that the Digest header matches the actual body.
            if (!verifyDigestHeader(req.headers['digest'], rawBody)) {
                this.log.warn(
                    { url: req.url, inboxType },
                    'Digest body hash mismatch — request body may have been tampered with'
                );
                return this.webServer.badRequest(resp);
            }

            //  Collect and validate the posted Activity
            const activity = Activity.fromJsonString(rawBody.toString());
            if (!activity || !activity.isValid()) {
                this.log.error(
                    { url: req.url, method: req.method, inboxType },
                    'Invalid or unsupported Activity'
                );

                return activity
                    ? this.webServer.badRequest(resp)
                    : this.webServer.notImplemented(resp);
            }

            //  The actor must be one id (a URL): an array, object or number
            //  would reach lookups that expect a string
            const activityActorId = getActorId(activity);
            if (!_.isString(activityActorId) || !/^https?:\/\//i.test(activityActorId)) {
                this.log.warn(
                    { url: req.url, activityId: activity.id, inboxType },
                    'Activity actor is not an id — rejected'
                );
                return this.webServer.badRequest(resp);
            }

            //  Verify activity.id belongs to the same domain as activity.actor.
            //  The id is used for deduplication and logging; a mismatch is a
            //  sign of a forged or misrouted activity.
            if (
                activity.id &&
                activity.actor &&
                !hostsMatch(activity.id, activity.actor)
            ) {
                this.log.warn(
                    { activityId: activity.id, actor: activity.actor, inboxType },
                    'activity.id domain does not match actor domain — rejected'
                );
                return this.webServer.badRequest(resp);
            }

            const sigActorId = actorIdFromKeyId(signature.keyId);

            //  whom the inbox's own GETs for this activity are signed as
            const inboxActorId =
                Collections.Inbox === inboxType
                    ? getFullUrl(req)
                          .toString()
                          .replace(/\/inbox$/, '')
                    : null;
            const fetchAs = (remoteActorId, cb) =>
                this._fetchAsUser(inboxActorId, remoteActorId, cb);

            //  Fetch and validate the signature of the remote Actor
            this._getAssociatedActors(
                getActorId(activity),
                signature.keyId,
                (err, remoteActor, signatureActor) => {
                    if (err) {
                        //  An actor that deleted itself may be gone from its
                        //  server before its Delete reaches us, so its key
                        //  cannot be fetched. Such a Delete is not signed by
                        //  anything we can check; it is accepted only when
                        //  the actor's own origin says the actor is gone.
                        if (
                            activity.type === WellKnownActivity.Delete &&
                            _.get(activity, 'object.id', activity.object) ===
                                getActorId(activity)
                        ) {
                            return this._inboxDeleteGoneActor(
                                inboxType,
                                resp,
                                getActorId(activity),
                                fetchAs
                            );
                        }
                        this.log.warn(
                            { err: err.message, sigActorId, inboxType },
                            'Failed to fetch remote actor — access denied'
                        );
                        return this.webServer.accessDenied(resp);
                    }

                    // validate sig up front — all activity types require a valid signature
                    const httpSigValidated =
                        remoteActor &&
                        this._validateActorSignature(signatureActor, signature);
                    if (!httpSigValidated) {
                        this.log.warn(
                            { sigActorId, activityType: activity.type, inboxType },
                            'HTTP signature validation failed — access denied'
                        );
                        return this.webServer.accessDenied(resp);
                    }

                    //  Who signed: the actor whose key verified the signature.
                    //  Its id must be on the keyId's host, which
                    //  _getAssociatedActors checks only when it differs from
                    //  activity.actor.
                    const signerId =
                        signatureActor &&
                        actorDomainMatchesKeyId(signatureActor.id, signature.keyId)
                            ? signatureActor.id
                            : null;
                    const auth = {
                        httpSigValidated,
                        domainVerifiedOnly: false,
                        signerId,
                        fetchAs,
                    };

                    //  An activity speaks for its actor, so the actor must be
                    //  the signer: a Like, Follow or Announce is recorded for
                    //  activity.actor. Create is not bound here; a forwarded
                    //  reply arrives signed by the server forwarding it.
                    if (
                        activity.type !== WellKnownActivity.Create &&
                        getActorId(activity) !== signerId
                    ) {
                        //  Mastodon forwards a reply's Delete as it forwards
                        //  its Create, signed by the forwarder; it is checked
                        //  with the object's origin instead
                        const deletedId = _.get(activity, 'object.id', activity.object);
                        if (
                            WellKnownActivity.Delete === activity.type &&
                            deletedId !== getActorId(activity)
                        ) {
                            return this._inboxForwardedDelete(
                                inboxType,
                                resp,
                                activity,
                                auth
                            );
                        }
                        this.log.warn(
                            {
                                activityType: activity.type,
                                actorId: getActorId(activity),
                                signerId,
                                inboxType,
                            },
                            'Activity actor is not the signing actor — access denied'
                        );
                        return this.webServer.accessDenied(resp);
                    }

                    switch (activity.type) {
                        case WellKnownActivity.Accept:
                            return this._inboxAcceptActivity(resp, activity);

                        case WellKnownActivity.Add:
                            break;

                        case WellKnownActivity.Announce:
                            return this._inboxAnnounceActivity(resp, activity, auth);

                        case WellKnownActivity.Create:
                            return this._inboxCreateActivity(resp, activity, auth);

                        case WellKnownActivity.Delete:
                            return this._inboxDeleteActivity(
                                inboxType,
                                resp,
                                activity,
                                auth
                            );

                        case WellKnownActivity.Update:
                            {
                                const type = _.get(activity, 'object.type');
                                if ('Note' === type || 'Article' === type) {
                                    //  :TODO: get rid of this extra indirection
                                    return this._inboxUpdateExistingObject(
                                        inboxType,
                                        resp,
                                        activity,
                                        auth
                                    );
                                } else if ('Person' === type || 'Service' === type) {
                                    //  Remote actor profile updates — silently accept;
                                    //  actor cache will refresh on next access
                                    return this.webServer.accepted(resp);
                                } else {
                                    this.log.warn(
                                        { type },
                                        `Unsupported Inbox Update for type "${type}"`
                                    );
                                }
                            }
                            break;

                        case WellKnownActivity.Follow:
                            return this._inboxFollowActivity(resp, remoteActor, activity);

                        case WellKnownActivity.Like:
                            return this._inboxLikeActivity(resp, activity);

                        case WellKnownActivity.Reject:
                            return this._inboxRejectActivity(resp, activity, auth);

                        case WellKnownActivity.Undo: {
                            const undoType = _.get(activity, 'object.type');
                            if (WellKnownActivity.Follow === undoType) {
                                return this._inboxUndoActivity(
                                    resp,
                                    remoteActor,
                                    activity,
                                    auth
                                );
                            } else if (WellKnownActivity.Like === undoType) {
                                return this._inboxUndoLikeActivity(resp, activity, auth);
                            } else {
                                this.log.warn(
                                    { undoType, inboxType },
                                    'Unsupported Undo activity type'
                                );
                            }
                            break;
                        }

                        default:
                            this.log.warn(
                                { type: activity.type, inboxType },
                                `Unsupported Activity type "${activity.type}"`
                            );
                            break;
                    }

                    return this.webServer.notImplemented(resp);
                }
            );
        });
    }

    _inboxAcceptActivity(resp, activity) {
        const acceptWhat = _.get(activity, 'object.type');
        switch (acceptWhat) {
            case WellKnownActivity.Follow:
                return this._inboxAcceptFollowActivity(resp, activity);

            default:
                this.log.warn(
                    { type: acceptWhat },
                    'Invalid or unsupported "Accept" type'
                );
                return this.webServer.notImplemented(resp);
        }
    }

    _inboxCreateActivity(resp, activity, auth) {
        const createWhat = _.get(activity, 'object.type');
        switch (createWhat) {
            case 'Note':
            case 'Article':
                return this._inboxCreateNoteActivity(resp, activity, auth);

            default:
                this.log.warn(
                    { type: createWhat },
                    'Invalid or unsupported "Create" type'
                );
                return this.webServer.notImplemented(resp);
        }
    }

    _inboxAcceptFollowActivity(resp, activity) {
        // Currently Accept's to Follow's are really just a formality;
        // we'll log it, but that's about it for now
        this.log.info(
            {
                remoteActorId: activity.actor,
                localActorId: _.get(activity, 'object.actor'),
            },
            'Follow request Accepted'
        );
        return this.webServer.accepted(resp);
    }

    //
    //  A Create must come from the Note's author (#964 review). Delivered
    //  directly, it is signed by the author, its actor is the author, and the
    //  Note is attributed to the author with an id on the author's host.
    //  Anything else may be a forwarded reply (Mastodon forwards a reply
    //  to the followers of the post it answers, signed by the forwarder): the
    //  copy as received is not used. The Note is fetched from its own id, and
    //  must come back with that id, from that host, attributed to an actor
    //  there, who must also be the activity's actor. That copy is stored.
    //
    _inboxCreateNoteActivity(resp, activity, auth) {
        const received = new Note(activity.object);
        if (!received.isValid()) {
            this.log.warn({ note: received }, 'Invalid Note');
            return this.webServer.notImplemented(resp);
        }

        const actorId = getActorId(activity);
        const signerId = auth && auth.signerId;
        const direct =
            signerId && actorId === signerId && !verifyNoteAuthor(received, signerId);

        const verified = cb => {
            if (direct) {
                return cb(null, received, activity);
            }
            //  the origin's author must be the actor, on the Note's host: a
            //  Note anywhere else cannot pass, so is not fetched at all
            if (!sameHost(received.id, actorId)) {
                return cb(
                    Errors.ValidationFailed("The Note id is not on the actor's host")
                );
            }
            return this._fetchNoteAs(auth, actorId, received.id, (err, note) => {
                if (err) {
                    return cb(err);
                }
                const authorId = actorIdsOf(note.attributedTo)[0];
                if (authorId !== actorId) {
                    return cb(
                        Errors.ValidationFailed(
                            "The Create's actor is not the Note's author"
                        )
                    );
                }
                //  store the origin's copy, not the one received
                return cb(null, note, createFromOrigin(note, authorId));
            });
        };

        verified((err, note, storedActivity) => {
            if (err) {
                this.log.warn(
                    {
                        error: err.message,
                        activityId: activity.id,
                        noteId: received.id,
                        actorId,
                        signerId,
                    },
                    'Will not accept Create: not verified as from the Note author'
                );
                return this.webServer.accessDenied(resp);
            }

            if (!direct) {
                this.log.info(
                    { activityId: activity.id, noteId: note.id, actorId, signerId },
                    'Accepted a forwarded Create from the Note origin'
                );
            }

            this._storeCreatedNote(resp, storedActivity, note);
        });
    }

    _storeCreatedNote(resp, activity, note) {
        const recipientActorIds = note.recipientIds();
        async.forEach(
            recipientActorIds,
            (actorId, nextActorId) => {
                switch (actorId) {
                    case PublicCollectionId:
                        this._deliverNoteToSharedInbox(activity, note, err => {
                            return nextActorId(err);
                        });
                        break;

                    default:
                        this._deliverNoteToLocalActor(actorId, activity, note, err => {
                            return nextActorId(err);
                        });
                        break;
                }
            },
            err => {
                //  a repeated delivery of the same Note is not an error
                if (err && !isConstraintError(err)) {
                    return this.webServer.internalServerError(resp, err);
                }

                return this.webServer.accepted(resp);
            }
        );
    }

    _inboxAnnounceActivity(resp, activity, auth) {
        //  Announce.object may be a URL string or an embedded object.
        const announceActorId =
            typeof activity.actor === 'string'
                ? activity.actor
                : activity.actor && activity.actor.id;
        //  a fetch goes to the announcer's host, signed as a local user
        //  who may sign there
        const fetchAs = (auth && auth.fetchAs) || ((id, cb) => cb(null, null));
        fetchAs(announceActorId, (err, fetchUser) => {
            fetchAnnouncedNote(
                activity.object,
                announceActorId,
                fetchUser,
                (err, note) => {
                    if (err) {
                        this.log.warn(
                            {
                                activityId: activity.id,
                                object: activity.object,
                                error: err.message,
                            },
                            'Failed to resolve Announce object — ignoring'
                        );
                        //  Return accepted so the remote server does not keep retrying;
                        //  the content just won't appear locally.
                        return this.webServer.accepted(resp);
                    }

                    if (!note.isValid()) {
                        this.log.warn(
                            { activityId: activity.id, noteId: note.id },
                            'Announced Note failed validation'
                        );
                        return this.webServer.accepted(resp);
                    }

                    //  Store the Announce activity + metadata in the shared inbox collection.
                    recordInboundBoost(activity, note, err => {
                        if (err) {
                            this.log.error(
                                {
                                    activityId: activity.id,
                                    noteId: note.id,
                                    error: err.message,
                                },
                                'Failed to record inbound boost'
                            );
                            return this.webServer.internalServerError(resp, err);
                        }

                        //  Ensure the Note itself exists as a local BBS message.
                        //  toMessage() generates a deterministic UUID so persist() is idempotent:
                        //  if a Create/Note already delivered this content, the SQLITE_CONSTRAINT
                        //  on message_uuid is silently swallowed.
                        this._storeNoteAsMessage(
                            activity.id,
                            'All',
                            Message.WellKnownAreaTags.ActivityPubShared,
                            note,
                            err => {
                                if (err && !isConstraintError(err)) {
                                    this.log.error(
                                        {
                                            activityId: activity.id,
                                            noteId: note.id,
                                            error: err.message,
                                        },
                                        'Failed to store announced Note as message'
                                    );
                                }
                                return this.webServer.accepted(resp);
                            }
                        );
                    });
                }
            );
        });
    }

    _inboxLikeActivity(resp, activity) {
        const objectId = _.isString(activity.object)
            ? activity.object
            : _.get(activity, 'object.id');

        this.log.info({ actorId: activity.actor, objectId }, 'Incoming Like activity');

        recordInboundLike(activity, err => {
            if (err) {
                this.log.warn(
                    { activityId: activity.id, objectId, error: err.message },
                    'Failed to record inbound Like'
                );
                //  Non-fatal: always accept so the remote doesn't keep retrying
            }
            return this.webServer.accepted(resp);
        });
    }

    _inboxUndoLikeActivity(resp, activity, auth) {
        //  activity.object is the original Like activity; its .id is the activity_id
        //  we stored in note_reactions when the Like arrived.
        const likeActivityId = _.get(activity, 'object.id');

        this.log.info(
            { actorId: activity.actor, likeActivityId },
            'Incoming Undo{Like} activity'
        );

        if (!likeActivityId) {
            return this.webServer.badRequest(resp);
        }

        //  only the actor who liked may take it back
        Collection.removeActorReactionByActivityId(likeActivityId, auth.signerId, err => {
            if (err) {
                this.log.warn(
                    { likeActivityId, error: err.message },
                    'Failed to remove Like reaction'
                );
                //  Non-fatal: always accept so the remote doesn't keep retrying
            }
            return this.webServer.accepted(resp);
        });
    }

    _inboxRejectFollowActivity(resp, activity, auth) {
        // A user Rejected our local Actor/user's Follow request;
        // Update the local Collection to reflect this fact.
        const remoteActorId = getActorId(activity);
        const localActorId = _.get(activity, 'object.actor');

        if (!remoteActorId || !localActorId) {
            return this.webServer.badRequest(resp);
        }

        //  only the followed actor may reject the follow
        if (remoteActorId !== auth.signerId) {
            this.log.warn(
                { remoteActorId, signerId: auth.signerId, localActorId },
                'Will not Reject Follow: not signed by the rejecting actor'
            );
            return this.webServer.accessDenied(resp);
        }

        userFromActorId(localActorId, (err, localUser) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            Collection.removeOwnedById(
                Collections.Following,
                localUser,
                remoteActorId,
                err => {
                    if (err) {
                        this.log.error(
                            { remoteActorId, localActorId },
                            'Failed removing "following" record'
                        );
                    }
                    return this.webServer.accepted(resp);
                }
            );
        });
    }

    _getMatchingObjectsForDeleteRequest(objectId, cb) {
        async.waterfall(
            [
                callback => {
                    return Collection.objectsById(objectId, callback);
                },
                (objectsInfo, callback) => {
                    //  every row holding the object, not one picked at random
                    Collection.objectsByEmbeddedId(objectId, (err, embedding) => {
                        if (err) {
                            return callback(err);
                        }
                        return callback(null, objectsInfo.concat(embedding));
                    });
                },
            ],
            (err, objectsInfo) => {
                return cb(err, objectsInfo);
            }
        );
    }

    _inboxDeleteActivity(inboxType, resp, activity, auth) {
        const objectId = _.get(activity, 'object.id', activity.object);

        this.log.info({ inboxType, objectId }, 'Incoming Delete request');

        //  :TODO: we need to DELETE the existing stored Message object if this is a Note, or associated if this is an Actor
        //  :TODO: delete / invalidate any actor cache if actor

        this._getMatchingObjectsForDeleteRequest(objectId, (err, objectsInfo) => {
            if (err) {
                this.log.warn({ objectId });
                // We'll respond accepted so they don't keep trying
                return this.webServer.accepted(resp);
            }

            if (objectsInfo.length === 0) {
                return this.webServer.resourceNotFound(resp);
            }

            //  Rows other than an actor's own (the cache, follow lists) hold a
            //  Note: all of them must name the signer as its owner, or none
            //  is deleted.
            const noteRows = objectsInfo.filter(
                o => !ActorKeyedCollections.includes(o.info.name)
            );
            if (noteRows.length > 0) {
                const owners = storedObjectsOwnerIds(
                    noteRows.map(o => o.object),
                    objectId
                );
                const reason =
                    owners.reason ||
                    verifyObjectOwner(auth.httpSigValidated) ||
                    verifySignerOwnsObject(
                        auth.signerId,
                        owners.ownerIds,
                        getActorId(activity)
                    );
                if (reason) {
                    this.log.warn(
                        {
                            error: reason,
                            inboxType,
                            objectId,
                            ownerIds: owners.ownerIds,
                            signerId: auth.signerId,
                        },
                        'Will not Delete object: not from its owner'
                    );
                    return this.webServer.accessDenied(resp);
                }
            }

            //  Generally we'd have a 1:1 objectId -> object here, but it's
            //  possible for example, that we're being asked to delete an Actor;
            //  If this is the case, they may be following multiple local Actor/users
            //  and we have multiple entries.
            const stats = {
                deleted: [],
                failed: [],
                refused: [],
            };
            async.forEachSeries(
                objectsInfo,
                (objInfo, nextObjInfo) => {
                    const collectionName = objInfo.info.name;

                    if (objInfo.object) {
                        //  Based on the collection we find this entry in,
                        //  we may have additional validation or actions
                        switch (collectionName) {
                            case Collections.Inbox:
                            case Collections.SharedInbox:
                                // Validate the inbox this was sent to
                                if (inboxType !== collectionName) {
                                    this.log.warn(
                                        { inboxType, collectionName, objectId },
                                        'Will not Delete object: Collection mismatch'
                                    );
                                    return nextObjInfo(null);
                                }

                                return this._verifyObjectOwner(
                                    auth,
                                    objInfo.object,
                                    storedObjectOwnerIds(objInfo.object, objectId),
                                    activity,
                                    err => {
                                        if (err) {
                                            this.log.warn(
                                                {
                                                    error: err.message,
                                                    inboxType,
                                                    collectionName,
                                                    objectId,
                                                    ownerIds: storedObjectOwnerIds(
                                                        objInfo.object,
                                                        objectId
                                                    ),
                                                    signerId: auth.signerId,
                                                },
                                                'Will not Delete object: not from its owner'
                                            );
                                            stats.refused.push({
                                                collectionName,
                                                objectId,
                                            });
                                            return nextObjInfo(null);
                                        }

                                        return this._deleteObjectWithStats(
                                            collectionName,
                                            objInfo.object,
                                            stats,
                                            () => {
                                                // if it was a Note before...
                                                if (
                                                    Collections.Inbox ===
                                                        objInfo.info.name ||
                                                    Collections.SharedInbox ===
                                                        objInfo.info.name
                                                ) {
                                                    return Note.deleteAssocMessage(
                                                        objectId,
                                                        auth.signerId,
                                                        err => {
                                                            if (err) {
                                                                this.log.warn(
                                                                    {
                                                                        error: err.message,
                                                                        noteId: objectId,
                                                                    },
                                                                    'Failed to remove message associated with Note'
                                                                );
                                                            }
                                                            return nextObjInfo(null);
                                                        }
                                                    );
                                                }

                                                return nextObjInfo(null);
                                            }
                                        );
                                    }
                                );

                            case Collections.Actors:
                                //  an Actor is owned by itself alone
                                return this._verifyObjectOwner(
                                    auth,
                                    objInfo.object,
                                    actorIdsOf(objInfo.object.id),
                                    activity,
                                    err => {
                                        if (err) {
                                            this.log.warn(
                                                {
                                                    error: err.message,
                                                    objectId,
                                                    signerId: auth.signerId,
                                                },
                                                'Will not Delete Actor: not from the actor itself'
                                            );
                                            stats.refused.push({
                                                collectionName,
                                                objectId,
                                            });
                                            return nextObjInfo(null);
                                        }

                                        async.series(
                                            [
                                                //  Evict from actor cache
                                                next =>
                                                    this._deleteObjectWithStats(
                                                        Collections.Actors,
                                                        objInfo.object,
                                                        stats,
                                                        next
                                                    ),
                                                //  Unfollow: remove from all local Following lists
                                                next =>
                                                    Collection.removeById(
                                                        Collections.Following,
                                                        objectId,
                                                        removeErr => {
                                                            if (removeErr) {
                                                                this.log.warn(
                                                                    {
                                                                        objectId,
                                                                        error: removeErr.message,
                                                                    },
                                                                    'Failed removing Following entries for deleted Actor'
                                                                );
                                                            }
                                                            return next(null);
                                                        }
                                                    ),
                                                //  Remove from all local Followers lists
                                                next =>
                                                    Collection.removeById(
                                                        Collections.Followers,
                                                        objectId,
                                                        removeErr => {
                                                            if (removeErr) {
                                                                this.log.warn(
                                                                    {
                                                                        objectId,
                                                                        error: removeErr.message,
                                                                    },
                                                                    'Failed removing Followers entries for deleted Actor'
                                                                );
                                                            }
                                                            return next(null);
                                                        }
                                                    ),
                                            ],
                                            () => nextObjInfo(null)
                                        );
                                    }
                                );

                            case Collections.Following:
                                break;

                            default:
                                break;
                        }

                        return nextObjInfo(null);
                    }

                    //  A row that does not parse: its owner cannot be checked
                    this.log.warn(
                        { inboxType, collectionName, objectId },
                        'Will not Delete object: the stored copy cannot be read'
                    );
                    stats.refused.push({ collectionName, objectId });
                    return nextObjInfo(null);
                },
                err => {
                    if (err) {
                        this.log.error(
                            { error: err.message, inboxType },
                            'Error during Delete processing'
                        );
                    }

                    this.sysLog.info(
                        { stats, inboxType },
                        `AP: ${_.startCase(inboxType)} delete request complete (${
                            stats.deleted.length
                        })`
                    );

                    if (stats.refused.length > 0 && stats.deleted.length === 0) {
                        return this.webServer.accessDenied(resp);
                    }
                    return this.webServer.accepted(resp);
                }
            );
        });
    }

    //
    //  Rewrite every message stored for the Note (one per local recipient of
    //  a private Note). toUpdatedMessage() refuses a message that is not by
    //  the Note's author.
    //
    _updateMessageAssocWithNote(objectId, activity) {
        Message.getMessageIdsByMetaValue(
            Message.WellKnownMetaCategories.ActivityPub,
            Message.ActivityPubPropertyNames.NoteId,
            objectId,
            (err, messageIds) => {
                if (err || !messageIds || messageIds.length === 0) {
                    return this.log.warn(
                        { objectId, error: err && err.message },
                        'Failed to find message for Update Note'
                    );
                }

                const note = new Note(activity.object);
                if (!note.isValid()) {
                    return this.log.error(
                        'Note within Update does not appear to be valid'
                    );
                }

                async.eachSeries(
                    messageIds,
                    (messageId, next) => {
                        note.toUpdatedMessage({ messageId }, (err, message) => {
                            if (err) {
                                this.log.error(
                                    {
                                        error: err.message,
                                        messageId,
                                        step: 'Note to Message',
                                    },
                                    'Note Update failed to update underlying message'
                                );
                                return next(null);
                            }

                            message.update(err => {
                                if (err) {
                                    this.log.error(
                                        {
                                            error: err.message,
                                            messageId,
                                            step: 'Persist',
                                        },
                                        'Note Update failed to update underlying message'
                                    );
                                }
                                return next(null);
                            });
                        });
                    },
                    () => {}
                );
            }
        );
    }

    //
    //  A Delete of an actor whose key could not be fetched (#964 review):
    //  nothing signed it that we can check, so ask the actor's own origin.
    //  Only a 410 Gone from the actor's host, for the actor's own id, says
    //  the actor is gone, as in Mastodon; a 404 can be transient. Then its
    //  local state alone is removed: the cached actor and its entries in
    //  local follow lists.
    //
    _inboxDeleteGoneActor(inboxType, resp, actorId, fetchAs) {
        (fetchAs || ((id, cb) => cb(null, null)))(actorId, (err, fetchUser) => {
            this._goneActorProbe(inboxType, resp, actorId, fetchUser);
        });
    }

    _goneActorProbe(inboxType, resp, actorId, fetchUser) {
        const opts = { headers: { Accept: ActivityStreamMediaType } };
        const sign = signedFetchOptions(fetchUser);
        if (sign) {
            opts.sign = sign;
        }
        HttpUtil.getJson(actorId, opts, err => {
            const gone =
                err &&
                err.statusCode === 410 &&
                sameHost(err.responseUrl || actorId, actorId);
            if (!gone) {
                this.log.warn(
                    {
                        actorId,
                        inboxType,
                        statusCode: err ? err.statusCode : 200,
                        error: err ? err.message : undefined,
                    },
                    'Will not Delete actor: its origin does not say it is gone'
                );
                return this.webServer.accessDenied(resp);
            }

            async.eachSeries(
                [Collections.Actors, Collections.Following, Collections.Followers],
                (collectionName, next) =>
                    Collection.removeById(collectionName, actorId, removeErr => {
                        if (removeErr) {
                            this.log.warn(
                                { actorId, collectionName, error: removeErr.message },
                                'Failed removing entries for deleted Actor'
                            );
                        }
                        return next(null);
                    }),
                () => {
                    this.sysLog.info(
                        { actorId, inboxType, statusCode: err.statusCode },
                        'AP: removed local state for an actor its origin reports gone'
                    );
                    return this.webServer.accepted(resp);
                }
            );
        });
    }

    //
    //  The local user the inbox's own GETs are signed as, for origins that
    //  refuse unsigned fetches; cb(null, user) or cb(null, null) for an
    //  unsigned GET. A personal inbox: its own user, whom the sender is
    //  writing to. The shared inbox has no user, and there is no instance
    //  actor to sign as, so: a local user who follows |remoteActorId|. That
    //  server already knows of the follow, so signing tells it nothing new.
    //
    _fetchAsUser(inboxActorId, remoteActorId, cb) {
        if (inboxActorId) {
            return this._localUserByActorId(inboxActorId, cb);
        }
        Collection.objectsById(remoteActorId, (err, rows) => {
            const follow =
                !err &&
                rows.find(
                    r => Collections.Following === r.info.name && r.info.ownerActorId
                );
            if (!follow) {
                return cb(null, null);
            }
            return this._localUserByActorId(follow.info.ownerActorId, cb);
        });
    }

    _localUserByActorId(actorId, cb) {
        userFromActorId(actorId, (err, user) => cb(null, err ? null : user));
    }

    //  A Note from its origin, the GET signed as a user who may sign to
    //  |actorId|'s host (see _fetchAsUser)
    _fetchNoteAs(auth, actorId, noteId, cb) {
        const fetchAs = (auth && auth.fetchAs) || ((id, next) => next(null, null));
        fetchAs(actorId, (err, fetchUser) =>
            fetchNoteFromOrigin(noteId, undefined, fetchUser, cb)
        );
    }

    //
    //  A Delete of a Note not signed by its actor: a forwarded one, as for a
    //  forwarded Create. The Note's own URL is asked (signed as a local user
    //  who may, see _fetchAsUser); the Delete is taken only when it answers
    //  410 Gone, or with a Tombstone of that id, from the Note's own host.
    //  Then it is processed as the actor's own, so our copy is removed only
    //  when stored as the actor's.
    //
    _inboxForwardedDelete(inboxType, resp, activity, auth) {
        const objectId = _.get(activity, 'object.id', activity.object);
        const actorId = getActorId(activity);
        const refuse = reason => {
            this.log.warn(
                { objectId, actorId, signerId: auth.signerId, inboxType, reason },
                'Will not accept a forwarded Delete'
            );
            return this.webServer.accessDenied(resp);
        };

        if (!_.isString(objectId) || !sameHost(objectId, actorId)) {
            return refuse("The object is not on the actor's host");
        }

        auth.fetchAs(actorId, (err, fetchUser) => {
            const opts = {
                headers: { Accept: ActivityStreamMediaType },
                timeout: 3000,
                validContentTypes: [
                    ActivityStreamMediaType,
                    'application/json',
                    'application/ld+json',
                ],
            };
            const sign = signedFetchOptions(fetchUser);
            if (sign) {
                opts.sign = sign;
            }
            HttpUtil.getJson(objectId, opts, (err, doc, res) => {
                const answeredBy = err
                    ? err.responseUrl || objectId
                    : (res && res.responseUrl) || objectId;
                const gone = err
                    ? err.statusCode === 410
                    : _.get(doc, 'type') === 'Tombstone' && _.get(doc, 'id') === objectId;
                if (!gone || !sameHost(answeredBy, objectId)) {
                    return refuse('The origin does not say the object is gone');
                }

                //  gone at its origin: the actor's Delete, for our copy
                return this._inboxDeleteActivity(
                    inboxType,
                    resp,
                    activity,
                    Object.assign({}, auth, { signerId: actorId })
                );
            });
        });
    }

    _deleteObjectWithStats(collectionName, object, stats, cb) {
        const objectId = _.isString(object) ? object : object.id;
        const type = object.type;
        Collection.removeById(collectionName, objectId, err => {
            if (err) {
                this.log.warn(
                    { objectId, collectionName, type },
                    'Failed to remove object'
                );
                stats.failed.push({ collectionName, objectId, type });
            } else {
                stats.deleted.push({ collectionName, objectId, type });
            }

            return cb(null);
        });
    }

    //
    //  An Update or Delete of an existing object must come from its owner:
    //  a verified signature, and |ownerIds| (see storedObjectsOwnerIds) must
    //  include the signing actor, who must also be the activity's actor.
    //
    _verifyObjectOwner(auth, object, ownerIds, activity, cb) {
        let reason = verifyObjectOwner(auth.httpSigValidated);
        if (!reason) {
            reason = verifySignerOwnsObject(
                auth.signerId,
                ownerIds,
                getActorId(activity)
            );
        }
        return reason ? cb(Errors.ValidationFailed(reason)) : cb(null);
    }

    _inboxFollowActivity(resp, remoteActor, activity) {
        this.log.info(
            { remoteActorId: remoteActor.id, localActorId: activity.object },
            'Incoming Follow Activity'
        );

        userFromActorId(activity.object, (err, localUser) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            const addReq = () => {
                //  User manually approves requests; add them to their requests collection
                //  :FIXME: We need to store the Activity and fetch the Actor as needed later;
                //  when accepting a request, we send back the Activity!
                Collection.addFollowRequest(localUser, activity, err => {
                    if (err) {
                        return this.internalServerError(resp, err);
                    }

                    return this.webServer.accepted(resp);
                });
            };

            //  User accepts any followers automatically
            const activityPubSettings = ActivityPubSettings.fromUser(localUser);
            if (activityPubSettings.manuallyApproveFollowers) {
                return addReq();
            }

            acceptFollowRequest(localUser, remoteActor, activity, err => {
                if (err) {
                    this.log.warn(
                        { error: err.message },
                        'Failed to post Accept. Recording to requests instead.'
                    );
                    return addReq();
                }

                return this.webServer.accepted(resp);
            });
        });
    }

    _inboxRejectActivity(resp, activity, auth) {
        //  The spec allows activity.object to be a full object or just an ID string.
        //  When it's a string, we cannot inspect .type, but Follow is the only Reject
        //  we handle, so treat a bare string as an implicit Follow rejection.
        const rejectWhat = _.isString(activity.object)
            ? WellKnownActivity.Follow
            : _.get(activity, 'object.type');

        switch (rejectWhat) {
            case WellKnownActivity.Follow:
                return this._inboxRejectFollowActivity(resp, activity, auth);

            default:
                this.log.warn(
                    { type: rejectWhat },
                    'Invalid or unsupported "Reject" type'
                );
                return this.webServer.notImplemented(resp);
        }
    }

    _inboxUndoActivity(resp, remoteActor, activity, auth) {
        const localActorId = _.get(activity, 'object.object');

        this.log.info(
            { remoteActorId: remoteActor.id, localActorId },
            'Incoming Undo Activity'
        );

        //  only the follower may undo its follow
        if (remoteActor.id !== auth.signerId) {
            this.log.warn(
                { remoteActorId: remoteActor.id, signerId: auth.signerId, localActorId },
                'Will not Undo Follow: not signed by the following actor'
            );
            return this.webServer.accessDenied(resp);
        }

        userFromActorId(localActorId, (err, localUser) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            Collection.removeOwnedById(
                Collections.Followers,
                localUser,
                remoteActor.id,
                err => {
                    if (err) {
                        return this.webServer.internalServerError(resp, err);
                    }

                    this.log.info(
                        {
                            username: localUser.username,
                            userId: localUser.userId,
                            remoteActorId: remoteActor.id,
                        },
                        'Undo "Follow" (un-follow) success'
                    );

                    return this.webServer.accepted(resp);
                }
            );
        });
    }

    _localUserFromCollectionEndpoint(req, collectionName, cb) {
        //  turn a collection URL to a Actor ID
        let actorId = getFullUrl(req).toString();
        const suffix = `/${collectionName}`;
        if (actorId.endsWith(suffix)) {
            actorId = actorId.slice(0, -suffix.length);
        }

        userFromActorId(actorId, (err, localUser) => {
            return cb(err, localUser);
        });
    }

    _validateActorSignature(actor, signature) {
        //  :TODO: If we stop enforcing HTTP signatures, we can check LD sigs here

        const pubKey = actor.publicKey;
        if (!_.isObject(pubKey)) {
            this.log.debug('Expected object of "pubKey"');
            return false;
        }

        if (signature.keyId !== pubKey.id) {
            this.log.warn(
                {
                    actorId: actor.id,
                    signatureKeyId: signature.keyId,
                    actorPubKeyId: pubKey.id,
                },
                'Key ID mismatch'
            );
            return false;
        }

        if (!httpSignature.verifySignature(signature, pubKey.publicKeyPem)) {
            this.log.warn(
                {
                    actorId: actor.id,
                    keyId: signature.keyId,
                    actorPubKeyId: pubKey.id,
                },
                'Actor signature verification failed'
            );
            return false;
        }

        return true;
    }

    _inboxUpdateExistingObject(inboxType, resp, activity, auth) {
        const targetObjectId = _.get(activity, 'object.id');
        const objectType = _.get(activity, 'object.type');

        //  every stored row holding the Note, the same rows a Delete checks
        this._getMatchingObjectsForDeleteRequest(targetObjectId, (err, objectsInfo) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            const rows = objectsInfo.filter(
                o => !ActorKeyedCollections.includes(o.info.name)
            );

            if (rows.length === 0) {
                this.log.warn(
                    { targetObjectId, type: objectType, activityType: activity.type },
                    `Could not ${activity.type} Object; Not found`
                );
                return this.webServer.resourceNotFound(resp);
            }

            const owners = storedObjectsOwnerIds(
                rows.map(r => r.object),
                targetObjectId
            );
            const ownerIds = owners.ownerIds;
            this._verifyObjectOwner(auth, rows[0].object, ownerIds, activity, err => {
                if (!err && owners.reason) {
                    err = Errors.ValidationFailed(owners.reason);
                }

                //  and an edit may not hand the object to someone else
                const newOwnerIds = actorIdsOf(_.get(activity, 'object.attributedTo'));
                if (
                    !err &&
                    !_.isEqual(_.sortBy(_.uniq(newOwnerIds)), _.sortBy(_.uniq(ownerIds)))
                ) {
                    err = Errors.ValidationFailed('The Update changes the object owner');
                }

                if (err) {
                    this.log.warn(
                        {
                            error: err.message,
                            inboxType,
                            objectId: targetObjectId,
                            objectType,
                            ownerIds,
                            signerId: auth.signerId,
                        },
                        'Will not Update object: not from its owner'
                    );
                    return this.webServer.accessDenied(resp);
                }

                Collection.updateCollectionEntry(
                    inboxType,
                    targetObjectId,
                    activity,
                    err => {
                        if (err) {
                            return this.webServer.internalServerError(resp, err);
                        }

                        this.sysLog.info(
                            {
                                inboxType,
                                objectId: targetObjectId,
                                objectType,
                            },
                            `AP: ${_.startCase(inboxType)} '${objectType}' updated`
                        );

                        //  Update any assoc Message object
                        this._updateMessageAssocWithNote(targetObjectId, activity);

                        return this.webServer.accepted(resp);
                    }
                );
            });
        });
    }

    _deliverNoteToSharedInbox(activity, note, cb) {
        this.log.info(
            { activityId: activity.id, noteId: note.id },
            "Delivering 'Note' to Public/Shared inbox"
        );

        this._addCreateItemOnce(
            Collections.SharedInbox,
            PublicCollectionId,
            activity,
            note,
            next => Collection.addSharedInboxItem(activity, true, next),
            err => {
                if (err) {
                    return cb(err);
                }

                return this._storeNoteAsMessage(
                    activity.id,
                    'All',
                    Message.WellKnownAreaTags.ActivityPubShared,
                    note,
                    cb
                );
            }
        );
    }

    //
    //  The same Note can arrive in more than one Create: forwarded (stored
    //  under an id derived from the Note) and sent by its author, in either
    //  order. It is stored once per collection; a Create of a Note already
    //  stored there from the same author is a duplicate.
    //
    _addCreateItemOnce(collectionName, collectionId, activity, note, add, cb) {
        Collection.createsOfObject(collectionName, collectionId, note.id, (err, rows) => {
            if (err) {
                return cb(err);
            }
            const authors = actorIdsOf(note.attributedTo);
            const stored = rows.some(row =>
                _.isEqual(actorIdsOf(_.get(row, 'object.attributedTo')), authors)
            );
            return stored ? cb(null) : add(cb);
        });
    }

    _deliverNoteToLocalActor(actorId, activity, note, cb) {
        //  Skip over e.g. actorId = https://someethingsomething/users/Actor/followers
        userFromActorId(actorId, (err, localUser) => {
            if (err) {
                this.log.trace(
                    { activityId: activity.id, noteId: note.id, actorId },
                    `No Actor by ID ${actorId}`
                );
                return cb(null); //  not found/etc., just bail
            }

            this.sysLog.info(
                {
                    activityId: activity.id,
                    noteId: note.id,
                    actorId,
                    username: localUser.username,
                },
                `AP: Delivering private 'Note' to user "${localUser.username}"`
            );

            this._addCreateItemOnce(
                Collections.Inbox,
                Endpoints.inbox(localUser),
                activity,
                note,
                next => Collection.addInboxItem(activity, localUser, false, next),
                err => {
                    if (err) {
                        return cb(err);
                    }

                    return this._storeNoteAsMessage(
                        activity.id,
                        localUser,
                        Message.WellKnownAreaTags.Private,
                        note,
                        cb
                    );
                }
            );
        });
    }

    _storeNoteAsMessage(activityId, localAddressedTo, areaTag, note, cb) {
        //
        // Import the item to the user's private mailbox
        //
        const messageOpts = {
            //  Notes can have 1:N 'to' relationships while a Message is 1:1;
            activityId,
            toUser: localAddressedTo,
            areaTag: areaTag,
        };

        note.toMessage(messageOpts, (err, message) => {
            if (err) {
                return cb(err);
            }

            message.persist((err, messageId) => {
                if (!err) {
                    if (_.isObject(localAddressedTo)) {
                        localAddressedTo = localAddressedTo.username;
                    }

                    this.sysLog.info(
                        {
                            localAddressedTo,
                            activityId,
                            noteId: note.id,
                            messageId,
                        },
                        `AP: Saved 'Note' to "${localAddressedTo}" as message ${messageId}`
                    );
                } else if (isConstraintError(err)) {
                    return cb(null);
                }
                return cb(err);
            });
        });
    }

    _actorCollectionRequest(collectionName, req, resp) {
        this.log.debug({ url: req.url }, `Request for "${collectionName}"`);

        const getCollection = Collection[collectionName];
        if (!getCollection) {
            return this.webServer.resourceNotFound(resp);
        }

        const url = getFullUrl(req);
        const page = url.searchParams.get('page');
        const collectionId = url.toString();

        this._localUserFromCollectionEndpoint(req, collectionName, (err, localUser) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            const apSettings = ActivityPubSettings.fromUser(localUser);
            if (apSettings.hideSocialGraph) {
                this.log.info(
                    { user: localUser.username },
                    `User has ${collectionName} hidden`
                );
                return this.webServer.accessDenied(resp);
            }

            //  :TODO: these getters should take a owningUser; they are not strictly public
            getCollection(collectionId, page, (err, collection) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                const body = JSON.stringify(collection);
                return this.webServer.ok(resp, body, {
                    'Content-Type': ActivityStreamMediaType,
                });
            });
        });

        //  :TODO: we need to validate the local user allows access to the particular collection
    }

    _followingGetHandler(req, resp) {
        return this._actorCollectionRequest(Collections.Following, req, resp);
    }

    _followersGetHandler(req, resp) {
        return this._actorCollectionRequest(Collections.Followers, req, resp);
    }

    // https://docs.gotosocial.org/en/latest/federation/actors/#outbox
    _outboxGetHandler(req, resp) {
        this.log.debug({ url: req.url }, 'Request for "outbox"');
        return this._actorCollectionRequest(Collections.Outbox, req, resp);
    }

    _singlePublicNoteGetHandler(req, resp) {
        this.log.debug({ url: req.url }, 'Request for "Note"');

        const noteId = getFullUrl(req).toString();
        Note.fromPublicNoteId(noteId, (err, note) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            if (!note) {
                return this.webServer.resourceNotFound(resp);
            }

            //  AP clients (Mastodon, etc.) send Accept: application/activity+json.
            //  Return the full Note object as JSON so they get likes/shares/context fields.
            //  Web browsers get the raw HTML content.
            const accept = req.headers.accept || '';
            if (
                accept.includes(ActivityStreamMediaType) ||
                accept.includes('application/ld+json')
            ) {
                //  Notes are stored without @context (they're normally embedded in
                //  a Create wrapper).  When served standalone, add it so remote
                //  servers can parse the document as valid JSON-LD.
                const noteWithContext = Object.assign(
                    {
                        '@context': ActivityPubObject.makeContext([], {
                            sensitive: 'as:sensitive',
                        }),
                    },
                    note
                );
                const body = JSON.stringify(noteWithContext);
                return this.webServer.ok(resp, body, {
                    'Content-Type': ActivityStreamMediaType,
                });
            }

            return this.webServer.ok(resp, note.content);
        });
    }

    _noteLikesGetHandler(req, resp) {
        return this._noteReactionCollectionHandler(req, resp, 'Like');
    }

    _noteSharesGetHandler(req, resp) {
        return this._noteReactionCollectionHandler(req, resp, 'Announce');
    }

    _noteContextGetHandler(req, resp) {
        this.log.debug({ url: req.url }, 'Request for "Note" context collection');

        //  Reconstruct the Note ID by stripping the /context suffix.
        const fullUrl = getFullUrl(req).toString();
        const noteId = fullUrl.replace(/\/context$/, '');

        //  The context ID for a root note equals the noteId itself; for replies it
        //  equals the root's noteId.  Use noteId as the context to query, which
        //  returns all notes in the thread whose context field points to this note.
        Collection.getCollectionByContext(
            Collections.SharedInbox,
            noteId,
            (err, result) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                const notes = [];
                (result.rows || []).forEach(row => {
                    try {
                        const activity = JSON.parse(row.object_json);
                        if (
                            activity &&
                            typeof activity.object === 'object' &&
                            activity.object.type === 'Note'
                        ) {
                            notes.push(activity.object);
                        }
                    } catch (_) {
                        // skip malformed rows
                    }
                });

                const collection = {
                    '@context': 'https://www.w3.org/ns/activitystreams',
                    id: fullUrl,
                    type: 'OrderedCollection',
                    totalItems: notes.length,
                    orderedItems: notes,
                };

                const body = JSON.stringify(collection);
                return this.webServer.ok(resp, body, {
                    'Content-Type': ActivityStreamMediaType,
                });
            }
        );
    }

    _noteReactionCollectionHandler(req, resp, reactionType) {
        //  Reconstruct the Note ID by stripping the /likes or /shares suffix
        const fullUrl = getFullUrl(req).toString();
        const noteId = fullUrl.replace(/\/(likes|shares)$/, '');

        Note.fromPublicNoteId(noteId, (err, note) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }
            if (!note) {
                return this.webServer.resourceNotFound(resp);
            }

            Collection.getReactionActors(noteId, reactionType, (err, actors) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                const collection = {
                    '@context': 'https://www.w3.org/ns/activitystreams',
                    id: fullUrl,
                    type: 'OrderedCollection',
                    totalItems: actors.length,
                    orderedItems: actors,
                };

                const body = JSON.stringify(collection);
                return this.webServer.ok(resp, body, {
                    'Content-Type': ActivityStreamMediaType,
                });
            });
        });
    }

    _selfAsActorHandler(localUser, localActor, req, resp) {
        this.log.info(
            { username: localUser.username },
            `Serving ActivityPub Actor for "${localUser.username}"`
        );

        const body = JSON.stringify(localActor);

        return this.webServer.ok(resp, body, { 'Content-Type': ActivityStreamMediaType });
    }

    _selfAsProfileHandler(localUser, localActor, req, resp) {
        const configuredTemplate = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.selfTemplate'
        );

        const renderProfile = templateFile => {
            // we'll fall back to the same default profile info as the WebFinger profile
            getUserProfileTemplatedBody(
                templateFile,
                localUser,
                localActor,
                DefaultProfileTemplate,
                'text/html',
                (err, body, contentType) => {
                    if (err) {
                        return this.webServer.resourceNotFound(resp);
                    }

                    this.log.info(
                        { username: localUser.username },
                        `Serving ActivityPub Profile for "${localUser.username}"`
                    );

                    return this.webServer.ok(resp, body, { 'Content-Type': contentType });
                }
            );
        };

        if (configuredTemplate) {
            return this.webServer.resolveTemplatePath(
                configuredTemplate,
                (err, templateFile) => {
                    return renderProfile(templateFile);
                }
            );
        }

        return renderProfile(null);
    }

    _prepareNewUserAsActor(user, cb) {
        this.sysLog.info(
            { username: user.username, userId: user.userId },
            `AP: Preparing ActivityPub settings for "${user.username}"`
        );

        return prepareLocalUserAsActor(user, { force: false }, cb);
    }
};
