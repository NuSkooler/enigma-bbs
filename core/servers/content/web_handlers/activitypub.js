const WebHandlerModule = require('../../../web_handler_module');
const {
    userFromActorId,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
    makeUserUrl,
    localActorId,
} = require('../../../activitypub/util');
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

const ActivityJsonMime = 'application/activity+json';

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
            ActivityJsonMime,
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

            if (sendActor) {
                return this._selfAsActorHandler(localUser, req, resp);
            } else {
                return this._standardSelfHandler(localUser, req, resp);
            }
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
            if (!activity) {
                this.log.error(
                    { url: req.url, method: req.method, endpoint: 'inbox' },
                    'Failed to parse Activity'
                );
                return this.webServer.resourceNotFound(resp);
            }

            if (!activity.isValid()) {
                this.log.warn(
                    { activity, endpoint: 'inbox' },
                    'Invalid or unsupported Activity'
                );
                return this.webServer.badRequest(resp);
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

                case 'Update':
                    return this._inboxUpdateRequestHandler(activity, req, resp);

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

            return this.webServer.resourceNotFound(resp);
        });
    }

    _sharedInboxPostHandler(req, resp) {
        const body = [];
        req.on('data', d => {
            body.push(d);
        });

        req.on('end', () => {
            const activity = Activity.fromJsonString(Buffer.concat(body).toString());
            if (!activity) {
                this.log.error(
                    { url: req.url, method: req.method, endpoint: 'sharedInbox' },
                    'Failed to parse Activity'
                );
                return this.webServer.resourceNotFound(resp);
            }

            if (!activity.isValid()) {
                this.log.warn(
                    { activity, endpoint: 'sharedInbox' },
                    'Invalid or unsupported Activity'
                );
                return this.webServer.badRequest(resp);
            }

            switch (activity.type) {
                case 'Create':
                    return this._sharedInboxCreateActivity(req, resp, activity);

                default:
                    this.log.warn(
                        { type: activity.type },
                        'Invalid or unknown Activity type'
                    );
                    return this.webServer.resourceNotFound(resp);
            }
        });
    }

    _sharedInboxCreateActivity(req, resp, activity) {
        const deliverTo = activity.recipientIds();

        //Create a method to gather all to, cc, bcc, etc. dests (see spec) -> single array
        // loop through, and attempt to fetch user-by-actor id for each; if found, deliver
        // --we may need to add properties for ActivityPubFollowersId, ActivityPubFollowingId, etc.
        // to user props for quick lookup -> user
        // special handling of bcc (remove others before delivery), etc.
        // const toActorIds = activity.recipientActorIds()

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
                        //  :TODO: we should probably land this in a public areaTag as well for AP; allowing Message objects to be used/etc.
                        Collection.addPublicInboxItem(note, err => {
                            return nextActor(err);
                        });
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
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                return this.webServer.accepted(resp);
            }
        );
    }

    _deliverInboxNoteToLocalActor(req, resp, actorId, activity, note, cb) {
        userFromActorId(actorId, (err, localUser) => {
            if (err) {
                return cb(null); //  not found/etc., just bail
            }

            Collection.addInboxItem(note, localUser, this.webServer, err => {
                if (err) {
                    return cb(err);
                }

                //
                // Import the item to the user's private mailbox
                //
                const messageOpts = {
                    //  Notes can have 1:N 'to' relationships while a Message is 1:1;
                    activityId: activity.id,
                    toUser: localUser,
                    areaTag: Message.WellKnownAreaTags.Private,
                };

                note.toMessage(messageOpts, (err, message) => {
                    if (err) {
                        return cb(err);
                    }

                    message.persist(err => {
                        if (!err) {
                            this.log.info(
                                {
                                    user: localUser.username,
                                    userId: localUser.userId,
                                    activityId: activity.id,
                                    noteId: note.id,
                                },
                                'Note delivered as message to private mailbox'
                            );
                        }
                        return cb(err);
                    });
                });
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
            const headers = {
                'Content-Type': ActivityJsonMime,
                'Content-Length': body.length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
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

            //  :TODO: support a template here

            resp.writeHead(200, { 'Content-Type': 'text/html' });
            return resp.end(note.content);
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

        const ok = () => {
            resp.writeHead(200, { 'Content-Type': 'text/html' });
            return resp.end('');
        };

        //
        //  If the user blindly accepts Followers, we can persist
        //  and send an 'Accept' now. Otherwise, we need to queue this
        //  request for the user to review and decide what to do with
        //  at a later time.
        //
        const activityPubSettings = ActivityPubSettings.fromUser(localUser);
        if (!activityPubSettings.manuallyApproveFollowers) {
            this._recordAcceptedFollowRequest(localUser, remoteActor, activity);
            return ok();
        } else {
            Collection.addFollowRequest(localUser, remoteActor, this.webServer, err => {
                if (err) {
                    return this.internalServerError(resp, err);
                }

                return ok();
            });
        }
    }

    _inboxUpdateRequestHandler(activity, req, resp) {
        this.log.info({ actor: activity.actor }, 'Update Activity request');

        return this.webServer.notImplemented(resp);

        // Collection.updateCollectionEntry('inbox', activity.id, activity, err => {
        // });
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

        Collection.removeFromCollectionById(
            'followers',
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
                        actor: remoteActor.id,
                    },
                    'Undo "Follow" (un-follow) success'
                );

                return this.webServer.accepted(resp);
            }
        );
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

    _selfAsActorHandler(user, req, resp) {
        this.log.trace(
            { username: user.username },
            `Serving ActivityPub Actor for "${user.username}"`
        );

        Actor.fromLocalUser(user, this.webServer, (err, actor) => {
            if (err) {
                return this.webServer.internalServerError(resp, err);
            }

            const body = JSON.stringify(actor);

            const headers = {
                'Content-Type': ActivityJsonMime,
                'Content-Length': body.length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _standardSelfHandler(user, req, resp) {
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
            user,
            DefaultProfileTemplate,
            'text/plain',
            (err, body, contentType) => {
                if (err) {
                    return this.webServer.resourceNotFound(resp);
                }

                const headers = {
                    'Content-Type': contentType,
                    'Content-Length': body.length,
                };

                resp.writeHead(200, headers);
                return resp.end(body);
            }
        );
    }

    _prepareNewUserAsActor(user, cb) {
        this.log.info(
            { username: user.username, userId: user.userId },
            `Preparing ActivityPub settings for "${user.username}"`
        );

        const actorId = localActorId(this.webServer, user);
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
                const avatarUrl =
                    makeUserUrl(this.webServer, user, '/users/') + `/avatar/${filename}`;

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
