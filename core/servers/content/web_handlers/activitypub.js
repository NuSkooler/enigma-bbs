const WebHandlerModule = require('../../../web_handler_module');
const {
    userFromActorId,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
    getActorId,
    prepareLocalUserAsActor,
} = require('../../../activitypub/util');
const { acceptFollowRequest } = require('../../../activitypub/follow_util');
const {
    fetchAnnouncedNote,
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
const Note = require('../../../activitypub/note');
const ActivityPubObject = require('../../../activitypub/object');
const EnigAssert = require('../../../enigma_assert');
const Message = require('../../../message');
const Events = require('../../../events');
const { Errors } = require('../../../enig_error');
const { getFullUrl } = require('../../../web_util');

const {
    validateRequestDate,
    verifyDigestHeader,
    normalizeHttpSigHeader,
    actorIdFromKeyId,
    MaxRequestAgeSecs,
} = require('../../../activitypub/security');

// deps
const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');
const httpSignature = require('http-signature');
const async = require('async');

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
            path: /^\/_enig\/ap\/users\/.+\/inbox$/,
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
            path: /^\/_enig\/ap\/users\/.+\/outbox(\?page=[0-9]+)?$/,
            handler: this._outboxGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/followers(\?page=[0-9]+)?$/,
            handler: this._followersGetHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/following(\?page=[0-9]+)?$/,
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

    _getAssociatedActors(objectActorId, signatureActorId, cb) {
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

                    Actor.fromId(signatureActorId, (err, signatureActor) => {
                        return callback(err, objectActor, signatureActor);
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

        const body = [];
        req.on('data', d => {
            body.push(d);
        });

        req.on('end', () => {
            const rawBody = Buffer.concat(body);

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

            const sigActorId = actorIdFromKeyId(signature.keyId);

            //  Fetch and validate the signature of the remote Actor
            this._getAssociatedActors(
                getActorId(activity),
                sigActorId,
                (err, remoteActor, signatureActor) => {
                    if (err) {
                        this.log.warn(
                            { err: err.message, sigActorId, inboxType },
                            'Failed to fetch remote actor — access denied'
                        );
                        return this.webServer.accessDenied(resp);
                    }

                    // validate sig up front
                    const httpSigValidated =
                        remoteActor &&
                        this._validateActorSignature(signatureActor, signature);
                    if (activity.type !== WellKnownActivity.Delete && !httpSigValidated) {
                        this.log.warn(
                            { sigActorId, activityType: activity.type, inboxType },
                            'HTTP signature validation failed — access denied'
                        );
                        return this.webServer.accessDenied(resp);
                    }

                    switch (activity.type) {
                        case WellKnownActivity.Accept:
                            return this._inboxAcceptActivity(resp, activity);

                        case WellKnownActivity.Add:
                            break;

                        case WellKnownActivity.Announce:
                            return this._inboxAnnounceActivity(resp, activity);

                        case WellKnownActivity.Create:
                            return this._inboxCreateActivity(resp, activity);

                        case WellKnownActivity.Delete:
                            return this._inboxDeleteActivity(
                                inboxType,
                                resp,
                                activity,
                                httpSigValidated
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
                                        httpSigValidated
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
                            return this._inboxFollowActivity(
                                resp,
                                remoteActor,
                                activity
                            );

                        case WellKnownActivity.Like:
                            return this._inboxLikeActivity(resp, activity);

                        case WellKnownActivity.Reject:
                            return this._inboxRejectActivity(resp, activity);

                        case WellKnownActivity.Undo: {
                            const undoType = _.get(activity, 'object.type');
                            if (WellKnownActivity.Follow === undoType) {
                                return this._inboxUndoActivity(
                                    resp,
                                    remoteActor,
                                    activity
                                );
                            } else if (WellKnownActivity.Like === undoType) {
                                return this._inboxUndoLikeActivity(resp, activity);
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

    _inboxCreateActivity(resp, activity) {
        const createWhat = _.get(activity, 'object.type');
        switch (createWhat) {
            case 'Note':
            case 'Article':
                return this._inboxCreateNoteActivity(resp, activity);

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

    _inboxCreateNoteActivity(resp, activity) {
        const note = new Note(activity.object);
        if (!note.isValid()) {
            this.log.warn({ note }, 'Invalid Note');
            return this.webServer.notImplemented(resp);
        }

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
                if (err && err.code !== 'SQLITE_CONSTRAINT') {
                    return this.webServer.internalServerError(resp, err);
                }

                return this.webServer.accepted(resp);
            }
        );
    }

    _inboxAnnounceActivity(resp, activity) {
        //  Announce.object may be a URL string or an embedded object.
        fetchAnnouncedNote(activity.object, (err, note) => {
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
                        { activityId: activity.id, noteId: note.id, error: err.message },
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
                        if (err && err.code !== 'SQLITE_CONSTRAINT') {
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

    _inboxUndoLikeActivity(resp, activity) {
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

        Collection.removeReactionByActivityId(likeActivityId, err => {
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

    _inboxRejectFollowActivity(resp, activity) {
        // A user Rejected our local Actor/user's Follow request;
        // Update the local Collection to reflect this fact.
        const remoteActorId = activity.actor;
        const localActorId = _.get(activity, 'object.actor');

        if (!remoteActorId || !localActorId) {
            return this.webServer.badRequest(resp);
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
                    Collection.objectByEmbeddedId(objectId, (err, obj, objInfo) => {
                        if (err) {
                            return callback(err);
                        }

                        const allObjsInfo = objectsInfo;
                        if (obj) {
                            allObjsInfo.push({ info: objInfo, object: obj });
                        }
                        return callback(null, objectsInfo);
                    });
                },
            ],
            (err, objectsInfo) => {
                return cb(err, objectsInfo);
            }
        );
    }

    _inboxDeleteActivity(inboxType, resp, activity, httpSigValidated) {
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

            //  Generally we'd have a 1:1 objectId -> object here, but it's
            //  possible for example, that we're being asked to delete an Actor;
            //  If this is the case, they may be following multiple local Actor/users
            //  and we have multiple entries.
            const stats = {
                deleted: [],
                failed: [],
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
                                    httpSigValidated,
                                    objInfo.object,
                                    activity,
                                    err => {
                                        if (err) {
                                            this.log.warn(
                                                {
                                                    error: err.message,
                                                    inboxType,
                                                    collectionName,
                                                    objectId,
                                                },
                                                'Will not Delete object: Signature mismatch'
                                            );
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
                                return this._verifyObjectOwner(
                                    httpSigValidated,
                                    objInfo.object,
                                    activity,
                                    err => {
                                        if (err) {
                                            this.log.warn(
                                                {
                                                    error: err.message,
                                                    objectId,
                                                },
                                                'Will not Delete Actor: signature mismatch'
                                            );
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

                    //  Malformed; we'll go ahead and remove
                    return this._deleteObjectWithStats(
                        collectionName,
                        objInfo.object,
                        stats,
                        nextObjInfo
                    );
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
                    return this.webServer.accepted(resp);
                }
            );
        });
    }

    _updateMessageAssocWithNote(objectId, activity) {
        const filter = {
            resultType: 'uuid',
            metaTuples: [
                {
                    category: Message.WellKnownMetaCategories.ActivityPub,
                    name: Message.ActivityPubPropertyNames.NoteId,
                    value: objectId,
                },
            ],
            limit: 1,
        };

        Message.findMessages(filter, (err, messageUuid) => {
            if (!messageUuid) {
                return this.log.warn(
                    { messageUuid },
                    'Failed to find message for Update Note'
                );
            }

            messageUuid = messageUuid[0]; // limit 1

            const note = new Note(activity.object);
            if (!note.isValid()) {
                return this.log.error('Note within Update does not appear to be valid');
            }

            const updateOpts = {
                messageUuid,
            };

            note.toUpdatedMessage(updateOpts, (err, message) => {
                if (err) {
                    return this.log.error(
                        { error: err.message, messageUuid, step: 'Note to Message' },
                        'Note Update failed to update underlying message'
                    );
                }

                message.update(err => {
                    if (err) {
                        this.log.error(
                            { error: err.message, messageUuid, step: 'Persist' },
                            'Note Update failed to update underlying message'
                        );
                    }
                });
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

    _verifyObjectOwner(httpSigValidated, object, activity, cb) {
        if (httpSigValidated) {
            //  owner signed
            return cb(null);
        }

        const creator = activity.signature?.creator;
        if (creator !== `${object.actor}#main-key`) {
            return cb(Errors.ValidationFailed('Creator mismatch'));
        }

        //
        //  We can't fetch an Actor for deleted Actors, so
        //  we're left with a basic comparison (above)
        //
        if (object.type === 'Actor') {
            return cb(null);
        }

        return cb(
            Errors.ValidationFailed(
                'Object does not appear to be owned by calling Activity'
            )
        );
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

    _inboxRejectActivity(resp, activity) {
        //  The spec allows activity.object to be a full object or just an ID string.
        //  When it's a string, we cannot inspect .type, but Follow is the only Reject
        //  we handle, so treat a bare string as an implicit Follow rejection.
        const rejectWhat = _.isString(activity.object)
            ? WellKnownActivity.Follow
            : _.get(activity, 'object.type');

        switch (rejectWhat) {
            case WellKnownActivity.Follow:
                return this._inboxRejectFollowActivity(resp, activity);

            default:
                this.log.warn(
                    { type: rejectWhat },
                    'Invalid or unsupported "Reject" type'
                );
                return this.webServer.notImplemented(resp);
        }
    }

    _inboxUndoActivity(resp, remoteActor, activity) {
        const localActorId = _.get(activity, 'object.object');

        this.log.info(
            { remoteActorId: remoteActor.id, localActorId },
            'Incoming Undo Activity'
        );

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

    _inboxUpdateExistingObject(inboxType, resp, activity, httpSigValidated) {
        const targetObjectId = _.get(activity, 'object.id');
        const objectType = _.get(activity, 'object.type');

        Collection.objectByEmbeddedId(targetObjectId, (err, obj) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            if (!obj) {
                this.log.warn(
                    { targetObjectId, type: objectType, activityType: activity.type },
                    `Could not ${activity.type} Object; Not found`
                );
                return this.webServer.resourceNotFound(resp);
            }

            this._verifyObjectOwner(httpSigValidated, obj, activity, err => {
                if (err) {
                    this.log.warn(
                        {
                            error: err.message,
                            inboxType,
                            objectId: targetObjectId,
                            objectType,
                        },
                        'Will not Update object: Signature mismatch'
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

        Collection.addSharedInboxItem(activity, true, err => {
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

            Collection.addInboxItem(activity, localUser, false, err => {
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
            });
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
                } else if (err.code === 'SQLITE_CONSTRAINT') {
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

    // https://docs.gotosocial.org/en/latest/federation/behaviors/outbox/
    _outboxGetHandler(req, resp) {
        this.log.debug({ url: req.url }, 'Request for "outbox"');
        return this._actorCollectionRequest(Collections.Outbox, req, resp);
    }

    _singlePublicNoteGetHandler(req, resp) {
        this.log.info({ url: req.url, userAgent: req.headers['user-agent'] }, 'Request for "Note"');

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
        let templateFile = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.selfTemplate'
        );
        if (templateFile) {
            templateFile = this.webServer.resolveTemplatePath(templateFile);
        }

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
    }

    _prepareNewUserAsActor(user, cb) {
        this.sysLog.info(
            { username: user.username, userId: user.userId },
            `AP: Preparing ActivityPub settings for "${user.username}"`
        );

        return prepareLocalUserAsActor(user, { force: false }, cb);
    }
};
