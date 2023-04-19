const WebHandlerModule = require('../../../web_handler_module');
const {
    userFromActorId,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
    getActorId,
    prepareLocalUserAsActor,
} = require('../../../activitypub/util');
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
const EnigAssert = require('../../../enigma_assert');
const Message = require('../../../message');
const Events = require('../../../events');
const { Errors } = require('../../../enig_error');
const { getFullUrl } = require('../../../web_util');

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
            //  :TODO: fix me: What are we exposing to the outbox? Should be public only; GET's don't have signatures
            handler: (req, resp) => {
                return this._enforceMainKeySignatureValidity(
                    req,
                    resp,
                    this._outboxGetHandler.bind(this)
                );
            },
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
            return this.webServer.accessDenied(resp);
        }

        return next(req, resp, signature);
    }

    _parseAndValidateSignature(req) {
        let signature;
        try {
            //  :TODO: validate options passed to parseRequest()
            signature = httpSignature.parseRequest(req);
        } catch (e) {
            this.log.warn(
                { error: e.message, url: req.url, method: req.method },
                'Failed to parse HTTP signature'
            );
            return null;
        }

        //  quick check up front
        const keyId = signature.keyId;
        if (!keyId || !keyId.endsWith('#main-key')) {
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
        const accept = req.headers['accept'].split(',').map(v => v.trim()) || ['*/*'];
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
        signatureActorId = async.waterfall(
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
            //  Collect and validate the posted Activity
            const activity = Activity.fromJsonString(Buffer.concat(body).toString());
            if (!activity || !activity.isValid()) {
                this.log.error(
                    { url: req.url, method: req.method, inboxType },
                    'Invalid or unsupported Activity'
                );

                return activity
                    ? this.webServer.badRequest(resp)
                    : this.webServer.notImplemented(resp);
            }

            //  Fetch and validate the signature of the remote Actor
            this._getAssociatedActors(
                getActorId(activity),
                signature.keyId.split('#', 1)[0], // trim #main-key
                (err, remoteActor, signatureActor) => {
                    //Actor.fromId(getActorId(activity), (err, remoteActor) => {
                    // validate sig up front
                    const httpSigValidated =
                        remoteActor &&
                        this._validateActorSignature(signatureActor, signature);
                    if (activity.type !== WellKnownActivity.Delete && !httpSigValidated) {
                        return this.webServer.accessDenied(resp);
                    }

                    switch (activity.type) {
                        case WellKnownActivity.Accept:
                            return this._inboxAcceptActivity(resp, activity);

                        case WellKnownActivity.Add:
                            break;

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
                                //  Only Notes currently supported
                                const type = _.get(activity, 'object.type');
                                if ('Note' === type) {
                                    //  :TODO: get rid of this extra indirection
                                    return this._inboxUpdateExistingObject(
                                        inboxType,
                                        resp,
                                        activity,
                                        httpSigValidated
                                    );
                                } else {
                                    this.log.warn(
                                        `Unsupported Inbox Update for type "${type}"`
                                    );
                                }
                            }
                            break;

                        case WellKnownActivity.Follow:
                            // Follow requests are only allowed directly
                            if (Collections.Inbox === inboxType) {
                                return this._inboxFollowActivity(
                                    resp,
                                    remoteActor,
                                    activity
                                );
                            }
                            break;

                        case WellKnownActivity.Reject:
                            return this._inboxRejectActivity(resp, activity);

                        case WellKnownActivity.Undo:
                            //  We only Undo from private inboxes
                            if (Collections.Inbox === inboxType) {
                                //  Only Follow Undo's currently supported
                                const type = _.get(activity, 'object.type');
                                if (WellKnownActivity.Follow === type) {
                                    return this._inboxUndoActivity(
                                        resp,
                                        remoteActor,
                                        activity
                                    );
                                } else {
                                    this.log.warn(`Unsupported Undo for type "${type}"`);
                                }
                            }
                            break;

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
            return this.webServer.notImplemented();
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

                return this.webServer.created(resp);
            }
        );
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
                                // Validate signature; Delete Actor and Following entries if any
                                break;

                            case Collection.Following:
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
                        //  :TODO: log me
                    }

                    this.log.info({ stats, inboxType }, 'Inbox Delete request complete');
                    return this.webServer.accepted(resp);
                }
            );
        });

        return this.webServer.accepted(resp);
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

            //  User accepts any followers automatically
            const activityPubSettings = ActivityPubSettings.fromUser(localUser);
            if (!activityPubSettings.manuallyApproveFollowers) {
                this._recordAcceptedFollowRequest(localUser, remoteActor, activity);
                return this.webServer.accepted(resp);
            }

            //  User manually approves requests; add them to their requests collection
            Collection.addFollowRequest(
                localUser,
                remoteActor,
                true, // ignore dupes
                err => {
                    if (err) {
                        return this.internalServerError(resp, err);
                    }

                    return this.webServer.accepted(resp);
                }
            );
        });
    }

    _inboxRejectActivity(resp, activity) {
        const rejectWhat = _.get(activity, 'object.type');
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

                        this.log.info(
                            {
                                inboxType,
                                objectId: targetObjectId,
                                objectType,
                            },
                            `${objectType} Updated`
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
            'Delivering Note to Public/Shared inbox'
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

            this.log.info(
                { activityId: activity.id, noteId: note.id, actorId },
                'Delivering Note to local Actor Private inbox'
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

            message.persist(err => {
                if (!err) {
                    if (_.isObject(localAddressedTo)) {
                        localAddressedTo = localAddressedTo.username;
                    }
                    this.log.info(
                        {
                            localAddressedTo,
                            activityId,
                            noteId: note.id,
                        },
                        'Note delivered as message to private mailbox'
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
        this.log.debug({ url: req.url }, 'Request for "Note"');

        const noteId = getFullUrl(req).toString();
        Note.fromPublicNoteId(noteId, (err, note) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            if (!note) {
                return this.webServer.resourceNotFound(resp);
            }

            //  :TODO: support a template here

            return this.webServer.ok(resp, note.content);
        });
    }

    _recordAcceptedFollowRequest(localUser, remoteActor, requestActivity) {
        async.series(
            [
                callback => {
                    return Collection.addFollower(
                        localUser,
                        remoteActor,
                        true, // ignore dupes
                        callback
                    );
                },
                callback => {
                    Actor.fromLocalUser(localUser, (err, localActor) => {
                        if (err) {
                            this.log.warn(
                                { inbox: remoteActor.inbox, error: err.message },
                                'Failed to load local Actor for "Accept"'
                            );
                            return callback(err);
                        }

                        const accept = Activity.makeAccept(
                            localActor.id,
                            requestActivity
                        );

                        accept.sendTo(
                            remoteActor.inbox,
                            localUser,
                            (err, respBody, res) => {
                                if (err) {
                                    this.log.warn(
                                        {
                                            inbox: remoteActor.inbox,
                                            error: err.message,
                                        },
                                        'Failed POSTing "Accept" to inbox'
                                    );
                                    return callback(null); // just a warning
                                }

                                if (res.statusCode !== 202 && res.statusCode !== 200) {
                                    this.log.warn(
                                        {
                                            inbox: remoteActor.inbox,
                                            statusCode: res.statusCode,
                                        },
                                        'Unexpected status code'
                                    );
                                    return callback(null); // just a warning
                                }

                                this.log.info(
                                    { inbox: remoteActor.inbox },
                                    'Remote server received our "Accept" successfully'
                                );

                                return callback(null);
                            }
                        );
                    });
                },
            ],
            err => {
                if (err) {
                    //  :TODO: move this request to the "Request queue" for the user to try later
                    this.log.error(
                        { error: err.message },
                        'Failed processing Follow request'
                    );
                }
            }
        );
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
            'text/plain',
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
        this.log.info(
            { username: user.username, userId: user.userId },
            `Preparing ActivityPub settings for "${user.username}"`
        );

        return prepareLocalUserAsActor(user, { force: false }, cb);
    }
};
