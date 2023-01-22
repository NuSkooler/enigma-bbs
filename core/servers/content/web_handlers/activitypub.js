const WebHandlerModule = require('../../../web_handler_module');
const {
    userFromAccount,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
    accountFromSelfUrl,
} = require('../../../activitypub/util');
const Config = require('../../../config').get;
const Activity = require('../../../activitypub/activity');
const ActivityPubSettings = require('../../../activitypub/settings');
const Actor = require('../../../activitypub/actor');
const Collection = require('../../../activitypub/collection');
const EnigAssert = require('../../../enigma_assert');

// deps
const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');
const httpSignature = require('http-signature');
const async = require('async');
const paths = require('path');
const fs = require('fs');
const mimeTypes = require('mime-types');

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

        //  default avatar routing
        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/avatar\/.+$/,
            handler: this._avatarGetHandler.bind(this),
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

        const url = new URL(req.url, `https://${req.headers.host}`);
        let accountName = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);
        let sendActor = false;

        // Like Mastodon, if .json is appended onto URL then return the JSON content
        if (accountName.endsWith('.json')) {
            sendActor = true;
            accountName = accountName.slice(0, -5);
        }

        userFromAccount(accountName, (err, user) => {
            if (err) {
                this.log.info(
                    { reason: err.message, accountName: accountName },
                    `No user "${accountName}" for "self"`
                );
                return this.webServer.resourceNotFound(resp);
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

            if (sendActor) {
                return this._selfAsActorHandler(user, req, resp);
            } else {
                return this._standardSelfHandler(user, req, resp);
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
            let activity;
            try {
                activity = JSON.parse(Buffer.concat(body).toString());
                activity = new Activity(activity);
            } catch (e) {
                this.log.error(
                    { error: e.message, url: req.url, method: req.method },
                    'Failed to parse Activity'
                );
                return this.webServer.resourceNotFound(resp);
            }

            if (!activity.isValid()) {
                this.log.warn({ activity }, 'Invalid or unsupported Activity');
                return this.webServer.badRequest(resp);
            }

            switch (activity.type) {
                case 'Follow':
                    return this._withUserRequestHandler(
                        signature,
                        activity,
                        this._inboxFollowRequestHandler.bind(this),
                        req,
                        resp
                    );

                case 'Undo':
                    return this._inboxUndoRequestHandler(activity, req, resp);

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

    _getCollectionHandler(name, req, resp, signature) {
        EnigAssert(signature, 'Missing signature!');

        const url = new URL(req.url, `https://${req.headers.host}`);
        const accountName = this._accountNameFromUserPath(url, name);
        if (!accountName) {
            return this.webServer.resourceNotFound(resp);
        }

        // can we even handle this request?
        const getter = Collection[name];
        if (!getter) {
            return this.webServer.resourceNotFound(resp);
        }

        userFromAccount(accountName, (err, user) => {
            if (err) {
                this.log.info(
                    { reason: err.message, accountName: accountName },
                    `No user "${accountName}" for "${name}"`
                );
                return this.webServer.resourceNotFound(resp);
            }

            const page = url.searchParams.get('page');
            getter(user, page, this.webServer, (err, collection) => {
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
        });
    }

    _followingGetHandler(req, resp, signature) {
        this.log.debug({ url: req.url }, 'Request for "following"');
        return this._getCollectionHandler('following', req, resp, signature);
    }

    // https://docs.gotosocial.org/en/latest/federation/behaviors/outbox/
    _outboxGetHandler(req, resp, signature) {
        this.log.debug({ url: req.url }, 'Request for "outbox"');
        return this._getCollectionHandler('outbox', req, resp, signature);
    }

    _avatarGetHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);
        const filename = paths.basename(url.pathname);
        if (!filename) {
            return this.webServer.fileNotFound(resp);
        }

        const storagePath = _.get(Config(), 'users.avatars.storagePath');
        if (!storagePath) {
            return this.webServer.fileNotFound(resp);
        }

        const localPath = paths.join(storagePath, filename);
        fs.stat(localPath, (err, stats) => {
            if (err || !stats.isFile()) {
                return this.webServer.accessDenied(resp);
            }

            const headers = {
                'Content-Type':
                    mimeTypes.contentType(paths.basename(localPath)) ||
                    mimeTypes.contentType('.png'),
                'Content-Length': stats.size,
            };

            const readStream = fs.createReadStream(localPath);
            resp.writeHead(200, headers);
            readStream.pipe(resp);
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

    _followersGetHandler(req, resp, signature) {
        this.log.debug({ url: req.url }, 'Request for "followers"');
        return this._getCollectionHandler('followers', req, resp, signature);
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

    _inboxFollowRequestHandler(activity, remoteActor, user, resp) {
        this.log.info({ user_id: user.userId, actor: activity.actor }, 'Follow request');

        //
        //  If the user blindly accepts Followers, we can persist
        //  and send an 'Accept' now. Otherwise, we need to queue this
        //  request for the user to review and decide what to do with
        //  at a later time.
        //
        const activityPubSettings = ActivityPubSettings.fromUser(user);
        if (!activityPubSettings.manuallyApproveFollowers) {
            this._recordAcceptedFollowRequest(user, remoteActor, activity);
        } else {
            //  :TODO: queue the request
        }

        resp.writeHead(200, { 'Content-Type': 'text/html' });
        return resp.end('');
    }

    _inboxUndoRequestHandler(activity, req, resp) {
        this.log.info({ actor: activity.actor }, 'Undo request');

        const url = new URL(req.url, `https://${req.headers.host}`);
        const accountName = this._accountNameFromUserPath(url, 'inbox');
        if (!accountName) {
            return this.webServer.resourceNotFound(resp);
        }

        userFromAccount(accountName, (err, user) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            // we only understand Follow right now
            if (!activity.object || activity.object.type !== 'Follow') {
                return this.webServer.notImplemented(resp);
            }

            Collection.removeFromCollectionById(
                'followers',
                user,
                activity.actor,
                err => {
                    if (err) {
                        return this.webServer.internalServerError(resp, err);
                    }

                    this.log.info(
                        { userId: user.userId, actor: activity.actor },
                        'Undo "Follow" (un-follow) success'
                    );

                    resp.writeHead(202);
                    return resp.end('');
                }
            );
        });
    }

    _withUserRequestHandler(signature, activity, activityHandler, req, resp) {
        this.log.debug({ actor: activity.actor }, `Inbox request from ${activity.actor}`);

        //  :TODO: trace
        const accountName = accountFromSelfUrl(activity.object);
        if (!accountName) {
            return this.webServer.badRequest(resp);
        }

        userFromAccount(accountName, (err, user) => {
            if (err) {
                return this.webServer.resourceNotFound(resp);
            }

            Actor.fromRemoteUrl(activity.actor, (err, actor) => {
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

                return activityHandler(activity, actor, user, resp);
            });
        });
    }

    _recordAcceptedFollowRequest(localUser, remoteActor, requestActivity) {
        async.series(
            [
                callback => {
                    return Collection.addFollower(localUser, remoteActor, callback);
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
};
