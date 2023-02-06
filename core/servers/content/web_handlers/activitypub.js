const WebHandlerModule = require('../../../web_handler_module');
const {
    userFromActorId,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
} = require('../../../activitypub/util');
const Endpoints = require('../../../activitypub/endpoint');
const { ActivityStreamMediaType } = require('../../../activitypub/const');
const Config = require('../../../config').get;
const Activity = require('../../../activitypub/activity');
const ActivityPubSettings = require('../../../activitypub/settings');
const Actor = require('../../../activitypub/actor');
const Collection = require('../../../activitypub/collection');
const Note = require('../../../activitypub/note');
const EnigAssert = require('../../../enigma_assert');
const Message = require('../../../message');
const Events = require('../../../events');
const UserProps = require('../../../user_property');

// deps
const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');
const httpSignature = require('http-signature');
const async = require('async');
const paths = require('path');

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
                return this._enforceSigningPolicy(
                    req,
                    resp,
                    this._inboxPostHandler.bind(this)
                );
            },
        });

        this.webServer.addRoute({
            method: 'POST',
            path: /^\/_enig\/ap\/shared-inbox$/,
            handler: this._sharedInboxPostHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/outbox(\?page=[0-9]+)?$/,
            handler: (req, resp) => {
                return this._enforceSigningPolicy(
                    req,
                    resp,
                    this._outboxGetHandler.bind(this)
                );
            },
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/followers(\?page=[0-9]+)?$/,
            handler: (req, resp) => {
                return this._enforceSigningPolicy(
                    req,
                    resp,
                    this._followersGetHandler.bind(this)
                );
            },
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/following(\?page=[0-9]+)?$/,
            handler: (req, resp) => {
                return this._enforceSigningPolicy(
                    req,
                    resp,
                    this._followingGetHandler.bind(this)
                );
            },
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

    _enforceSigningPolicy(req, resp, next) {
        // the request must be signed, and the signature must be valid
        const signature = this._parseAndValidateSignature(req);
        if (!signature) {
            return this.webServer.accessDenied(resp);
        }

        return next(req, resp, signature);
    }

    _selfUrlRequestHandler(req, resp) {
        this.log.trace({ url: req.url }, 'Request for "self"');

        let actorId = this.webServer.fullUrl(req).toString();
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

            Actor.fromLocalUser(localUser, this.webServer, (err, localActor) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                if (sendActor) {
                    return this._selfAsActorHandler(localUser, localActor, req, resp);
                } else {
                    return this._standardSelfHandler(localUser, localActor, req, resp);
                }
            });
        });
    }

    _inboxPostHandler(req, resp, signature) {
        EnigAssert(signature, 'Called without signature!');

        const body = [];
        req.on('data', d => {
            body.push(d);
        });

        req.on('end', () => {
            const activity = Activity.fromJsonString(Buffer.concat(body).toString());
            if (!activity || !activity.isValid()) {
                this.log.error(
                    { url: req.url, method: req.method, endpoint: 'inbox' },
                    'Invalid or unsupported Activity'
                );
                return activity
                    ? this.webServer.badRequest(resp)
                    : this.webServer.notImplemented(resp);
            }

            switch (activity.type) {
                case 'Follow':
                    return this._collectionRequestHandler(
                        signature,
                        'inbox',
                        activity,
                        this._inboxFollowRequestHandler.bind(this),
                        req,
                        resp
                    );

                case 'Delete':
                    return this._collectionRequestHandler(
                        signature,
                        'inbox',
                        activity,
                        this._inboxDeleteRequestHandler.bind(this),
                        req,
                        resp
                    );

                case 'Update':
                    return this.inboxUpdateObject('inbox', req, resp, activity);

                case 'Undo':
                    return this._collectionRequestHandler(
                        signature,
                        'inbox',
                        activity,
                        this._inboxUndoRequestHandler.bind(this),
                        req,
                        resp
                    );

                default:
                    this.log.warn(
                        { type: activity.type },
                        `Unsupported Activity type "${activity.type}"`
                    );
                    break;
            }

            return this.webServer.notImplemented(resp);
        });
    }

    _sharedInboxPostHandler(req, resp) {
        const body = [];
        req.on('data', d => {
            body.push(d);
        });

        req.on('end', () => {
            const activity = Activity.fromJsonString(Buffer.concat(body).toString());
            if (!activity || !activity.isValid()) {
                this.log.error(
                    { url: req.url, method: req.method, endpoint: 'sharedInbox' },
                    'Invalid or unsupported Activity'
                );
                return activity
                    ? this.webServer.badRequest(resp)
                    : this.webServer.notImplemented(resp);
            }

            switch (activity.type) {
                case 'Create':
                    return this._sharedInboxCreateActivity(req, resp, activity);

                case 'Update':
                    return this.inboxUpdateObject('sharedInbox', req, resp, activity);

                default:
                    this.log.warn(
                        { type: activity.type },
                        'Invalid or unknown Activity type'
                    );
                    break;
            }

            // don't understand the 'type'
            return this.webServer.notImplemented(resp);
        });
    }

    _sharedInboxCreateActivity(req, resp, activity) {
        const deliverTo = activity.recipientIds();
        const createWhat = _.get(activity, 'object.type');
        switch (createWhat) {
            case 'Note':
                return this._deliverSharedInboxNote(req, resp, deliverTo, activity);

            default:
                this.log.warn(
                    { type: createWhat },
                    'Invalid or unsupported "Create" type'
                );
                return this.webServer.resourceNotFound(resp);
        }
    }

    inboxUpdateObject(inboxType, req, resp, activity) {
        const updateObjectId = _.get(activity, 'object.id');
        const objectType = _.get(activity, 'object.type');

        this.log.info(
            { inboxType, objectId: updateObjectId, type: objectType },
            'Inbox Object "Update" request'
        );

        //  :TODO: other types...
        if (!updateObjectId || !['Note'].includes(objectType)) {
            return this.webServer.notImplemented(resp);
        }

        //  Note's are wrapped in Create Activities
        Collection.objectByEmbeddedId(updateObjectId, (err, obj) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            if (!obj) {
                // no match, but respond as accepted and hopefully they don't ask again
                return this.webServer.accepted(resp);
            }

            // OK, the object exists; Does the caller have permission
            // to update? The origin must match
            //
            // "The receiving server MUST take care to be sure that the Update is authorized
            // to modify its object. At minimum, this may be done by ensuring that the Update
            // and its object are of same origin."
            try {
                const updateTargetUrl = new URL(obj.object.id);
                const updaterUrl = new URL(activity.actor);

                if (updateTargetUrl.host !== updaterUrl.host) {
                    this.log.warn(
                        {
                            objectId: updateObjectId,
                            type: objectType,
                            updateTargetHost: updateTargetUrl.host,
                            requestorHost: updaterUrl.host,
                        },
                        'Attempt to update object from another origin'
                    );
                    return this.webServer.accessDenied(resp);
                }

                Collection.updateCollectionEntry(
                    'inbox',
                    updateObjectId,
                    activity,
                    err => {
                        if (err) {
                            return this.webServer.internalServerError(resp, err);
                        }

                        this.log.info(
                            {
                                objectId: updateObjectId,
                                type: objectType,
                                collection: 'inbox',
                            },
                            'Object updated'
                        );
                        return this.webServer.accepted(resp);
                    }
                );
            } catch (e) {
                return this.webServer.internalServerError(resp, e);
            }
        });
    }

    _deliverSharedInboxNote(req, resp, deliverTo, activity) {
        // When an object is being delivered to the originating actor's followers,
        // a server MAY reduce the number of receiving actors delivered to by
        // identifying all followers which share the same sharedInbox who would
        // otherwise be individual recipients and instead deliver objects to said
        // sharedInbox. Thus in this scenario, the remote/receiving server participates
        // in determining targeting and performing delivery to specific inboxes.
        const note = new Note(activity.object);
        if (!note.isValid()) {
            //  :TODO: Log me
            return this.webServer.notImplemented();
        }

        async.forEach(
            deliverTo,
            (actorId, nextActor) => {
                switch (actorId) {
                    case Collection.PublicCollectionId:
                        this._deliverInboxNoteToSharedInbox(
                            req,
                            resp,
                            activity,
                            note,
                            err => {
                                return nextActor(err);
                            }
                        );
                        break;

                    default:
                        this._deliverInboxNoteToLocalActor(
                            req,
                            resp,
                            actorId,
                            activity,
                            note,
                            err => {
                                return nextActor(err);
                            }
                        );
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

    _deliverInboxNoteToSharedInbox(req, resp, activity, note, cb) {
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

    _deliverInboxNoteToLocalActor(req, resp, actorId, activity, note, cb) {
        userFromActorId(actorId, (err, localUser) => {
            if (err) {
                return cb(null); //  not found/etc., just bail
            }

            Collection.addInboxItem(activity, localUser, this.webServer, false, err => {
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

    _getCollectionHandler(collectionName, req, resp, signature) {
        EnigAssert(signature, 'Missing signature!');

        const getCollection = Collection[collectionName];
        if (!getCollection) {
            return this.webServer.resourceNotFound(resp);
        }

        const url = this.webServer.fullUrl(req);
        const page = url.searchParams.get('page');
        const collectionId = url.toString();
        getCollection(collectionId, page, (err, collection) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            const body = JSON.stringify(collection);
            return this.webServer.ok(resp, body, {
                'Content-Type': ActivityStreamMediaType,
            });
        });
    }

    _followingGetHandler(req, resp, signature) {
        this.log.debug({ url: req.url }, 'Request for "following"');
        return this._getCollectionHandler('following', req, resp, signature);
    }

    _followersGetHandler(req, resp, signature) {
        this.log.debug({ url: req.url }, 'Request for "followers"');
        return this._getCollectionHandler('followers', req, resp, signature);
    }

    // https://docs.gotosocial.org/en/latest/federation/behaviors/outbox/
    _outboxGetHandler(req, resp, signature) {
        this.log.debug({ url: req.url }, 'Request for "outbox"');
        return this._getCollectionHandler('outbox', req, resp, signature);
    }

    _singlePublicNoteGetHandler(req, resp) {
        this.log.debug({ url: req.url }, 'Request for "Note"');

        const noteId = this.webServer.fullUrl(req).toString();
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

    _accountNameFromUserPath(url, suffix) {
        const re = new RegExp(`^/_enig/ap/users/(.+)/${suffix}(\\?page=[0-9]+)?$`);
        const m = url.pathname.match(re);
        if (!m || !m[1]) {
            return null;
        }
        return m[1];
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
        if (!this._validateKeyId(keyId)) {
            return null;
        }

        return signature;
    }

    _validateKeyId(keyId) {
        if (!keyId) {
            return false;
        }

        // we only accept main-key currently
        return keyId.endsWith('#main-key');
    }

    _inboxFollowRequestHandler(activity, remoteActor, localUser, resp) {
        this.log.info(
            { user_id: localUser.userId, actor: activity.actor },
            'Follow request'
        );

        //
        //  If the user blindly accepts Followers, we can persist
        //  and send an 'Accept' now. Otherwise, we need to queue this
        //  request for the user to review and decide what to do with
        //  at a later time.
        //
        const activityPubSettings = ActivityPubSettings.fromUser(localUser);
        if (!activityPubSettings.manuallyApproveFollowers) {
            this._recordAcceptedFollowRequest(localUser, remoteActor, activity);
            return this.webServer.ok(resp);
        } else {
            Collection.addFollowRequest(
                localUser,
                remoteActor,
                this.webServer,
                true, // ignore dupes
                err => {
                    if (err) {
                        return this.internalServerError(resp, err);
                    }

                    return this.webServer.ok(resp);
                }
            );
        }
    }

    //  :TODO: DRY: update/delete are mostly the same code other than the final operation
    _inboxDeleteRequestHandler(activity, remoteActor, localUser, resp) {
        this.log.info(
            { user_id: localUser.userId, actor: activity.actor },
            'Delete request'
        );

        //  :TODO:only delete if it's owned by the sender

        return this.webServer.accepted(resp);
    }

    _inboxUndoRequestHandler(activity, remoteActor, localUser, resp) {
        this.log.info(
            { user: localUser.username, actor: remoteActor.id },
            'Undo Activity request'
        );

        // we only understand Follow right now
        if (!activity.object || activity.object.type !== 'Follow') {
            return this.webServer.notImplemented(resp);
        }

        Collection.removeById('followers', localUser, remoteActor.id, err => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            this.log.info(
                {
                    username: localUser.username,
                    userId: localUser.userId,
                    actor: remoteActor.id,
                },
                'Undo "Follow" (un-follow) success'
            );

            return this.webServer.accepted(resp);
        });
    }

    _collectionRequestHandler(
        signature,
        collectionName,
        activity,
        activityHandler,
        req,
        resp
    ) {
        //  turn a collection URL to a Actor ID
        let actorId = this.webServer.fullUrl(req).toString();
        const suffix = `/${collectionName}`;
        if (actorId.endsWith(suffix)) {
            actorId = actorId.slice(0, -suffix.length);
        }

        userFromActorId(actorId, (err, localUser) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            Actor.fromId(activity.actor, (err, actor) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                const pubKey = actor.publicKey;
                if (!_.isObject(pubKey)) {
                    //  Log me
                    return this.webServer.accessDenied();
                }

                if (signature.keyId !== pubKey.id) {
                    //  :TODO: Log me
                    return this.webServer.accessDenied(resp);
                }

                if (!httpSignature.verifySignature(signature, pubKey.publicKeyPem)) {
                    this.log.warn(
                        {
                            actor: activity.actor,
                            keyId: signature.keyId,
                            signature: req.headers['signature'] || '',
                        },
                        'Invalid signature supplied for Follow request'
                    );
                    return this.webServer.accessDenied(resp);
                }

                return activityHandler(activity, actor, localUser, resp);
            });
        });
    }

    _recordAcceptedFollowRequest(localUser, remoteActor, requestActivity) {
        async.series(
            [
                callback => {
                    return Collection.addFollower(
                        localUser,
                        remoteActor,
                        this.webServer,
                        true, // ignore dupes
                        callback
                    );
                },
                callback => {
                    Actor.fromLocalUser(localUser, this.webServer, (err, localActor) => {
                        if (err) {
                            this.log.warn(
                                { inbox: remoteActor.inbox, error: err.message },
                                'Failed to load local Actor for "Accept"'
                            );
                            return callback(err);
                        }

                        const accept = Activity.makeAccept(
                            this.webServer,
                            localActor,
                            requestActivity
                        );

                        accept.sendTo(
                            remoteActor.inbox,
                            localUser,
                            this.webServer,
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

    _authorizeInteractionHandler(req, resp) {
        console.log(req);
        console.log(resp);
    }

    _selfAsActorHandler(localUser, localActor, req, resp) {
        this.log.info(
            { username: localUser.username },
            `Serving ActivityPub Actor for "${localUser.username}"`
        );

        const body = JSON.stringify(localActor);

        return this.webServer.ok(resp, body, { 'Content-Type': ActivityStreamMediaType });
    }

    _standardSelfHandler(localUser, localActor, req, resp) {
        let templateFile = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.selfTemplate'
        );
        if (templateFile) {
            templateFile = this.webServer.resolveTemplatePath(templateFile);
        }

        // we'll fall back to the same default profile info as the WebFinger profile
        getUserProfileTemplatedBody(
            this.webServer,
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

        const actorId = Endpoints.actorId(this.webServer, user);
        user.setProperty(UserProps.ActivityPubActorId, actorId);

        user.updateActivityPubKeyPairProperties(err => {
            if (err) {
                return cb(err);
            }

            user.generateNewRandomAvatar((err, outPath) => {
                if (err) {
                    this.log.warn(
                        {
                            username: user.username,
                            userId: user.userId,
                            error: err.message,
                        },
                        `Failed to generate random avatar for "${user.username}"`
                    );
                }

                //  :TODO: fetch over +op default overrides here, e.g. 'enabled'
                const apSettings = ActivityPubSettings.fromUser(user);

                const filename = paths.basename(outPath);
                const avatarUrl = Endpoints.avatar(this.webServer, user, filename);

                apSettings.image = avatarUrl;
                apSettings.icon = avatarUrl;

                user.setProperty(
                    UserProps.ActivityPubSettings,
                    JSON.stringify(apSettings)
                );

                return cb(null);
            });
        });
    }
};
