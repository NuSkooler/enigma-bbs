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

// deps
const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');
const httpSignature = require('http-signature');

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
            handler: this._inboxPostHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+\/outbox(\?page=true)?$/,
            handler: this._outboxGetHandler.bind(this),
        });

        //  :TODO: NYI
        // this.webServer.addRoute({
        //     method: 'GET',
        //     path: /^\/_enig\/authorize_interaction\?uri=(.+)$/,
        //     handler: this._authorizeInteractionHandler.bind(this),
        // });

        return cb(null);
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

    _inboxPostHandler(req, resp) {
        // the request must be signed, and the signature must be valid
        const signature = this._parseAndValidateSignature(req);
        if (!signature) {
            return this.webServer.accessDenied(resp);
        }

        const body = [];
        req.on('data', d => {
            body.push(d);
        });

        req.on('end', () => {
            let activity;
            try {
                activity = Activity.fromJsonString(Buffer.concat(body).toString());
            } catch (e) {
                this.log.error(
                    { error: e.message, url: req.url, method: req.method },
                    'Failed to parse Activity'
                );
                return this.webServer.resourceNotFound(resp);
            }

            if (!activity.isValid()) {
                this.log.warn({ activity }, 'Invalid or unsupported Activity');
                return this.webServer.webServer.badRequest(resp);
            }

            switch (activity.type) {
                case 'Follow':
                    return this._inboxFollowRequestHandler(
                        signature,
                        activity,
                        req,
                        resp
                    );

                default:
                    this.log.debug(
                        { type: activity.type },
                        `Unsupported Activity type "${activity.type}"`
                    );
                    return this.webServer.resourceNotFound(resp);
            }
        });
    }

    // https://docs.gotosocial.org/en/latest/federation/behaviors/outbox/
    _outboxGetHandler(req, resp) {
        this.log.trace({ url: req.url }, 'Request for "outbox"');

        // the request must be signed, and the signature must be valid
        const signature = this._parseAndValidateSignature(req);
        if (!signature) {
            return this.webServer.accessDenied(resp);
        }

        //  /_enig/ap/users/SomeName/outbox -> SomeName
        const url = new URL(req.url, `https://${req.headers.host}`);
        const m = url.pathname.match(/^\/_enig\/ap\/users\/(.+)\/outbox$/);
        if (!m || !m[1]) {
            return this.webServer.resourceNotFound(resp);
        }

        const accountName = m[1];
        userFromAccount(accountName, (err, user) => {
            if (err) {
                this.log.info(
                    { reason: err.message, accountName: accountName },
                    `No user "${accountName}" for "self"`
                );
                return this.webServer.resourceNotFound(resp);
            }

            Activity.fromOutboxEntries(user, this.webServer, (err, activity) => {
                if (err) {
                    //  :TODO: LOG ME
                    return this.webServer.internalServerError(resp);
                }

                const body = JSON.stringify(activity);
                const headers = {
                    'Content-Type': ActivityJsonMime,
                    'Content-Length': body.length,
                };

                resp.writeHead(200, headers);
                return resp.end(body);
            });
        });
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

    _inboxFollowRequestHandler(signature, activity, req, resp) {
        this.log.trace(
            { actor: activity.actor },
            `Follow request from ${activity.actor}`
        );

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
                    //  :TODO: log, and probably should be inspecting |err|
                    return this.webServer.internalServerError(resp);
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

                //  :TODO: return OK and kick off a async job of persisting and sending and 'Accepted'

                //
                //  If the user blindly accepts Followers, we can persist
                //  and send an 'Accept' now. Otherwise, we need to queue this
                //  request for the user to review and decide what to do with
                //  at a later time.
                //
                //  :TODO: Implement the queue
                const activityPubSettings = ActivityPubSettings.fromUser(user);
                if (!activityPubSettings.manuallyApproveFollowers) {
                    Actor.fromLocalUser(user, this.webServer, (err, localActor) => {
                        if (err) {
                            return this.log.warn(
                                { inbox: actor.inbox, error: err.message },
                                'Failed to load local Actor for "Accept"'
                            );
                        }

                        const accept = Activity.makeAccept(
                            this.webServer,
                            localActor,
                            activity
                        );

                        accept.sendTo(
                            actor.inbox,
                            user,
                            this.webServer,
                            (err, respBody, res) => {
                                if (err) {
                                    return this.log.warn(
                                        {
                                            inbox: actor.inbox,
                                            statusCode: res.statusCode,
                                            error: err.message,
                                        },
                                        'Failed POSTing "Accept" to inbox'
                                    );
                                }

                                if (res.statusCode !== 202 && res.statusCode !== 200) {
                                    return this.log.warn(
                                        {
                                            inbox: actor.inbox,
                                            statusCode: res.statusCode,
                                        },
                                        'Unexpected status code'
                                    );
                                }

                                this.log.trace(
                                    { inbox: actor.inbox },
                                    'Remote server received our "Accept" successfully'
                                );
                            }
                        );
                    });
                }

                resp.writeHead(200, { 'Content-Type': 'text/html' });
                return resp.end('');
            });
        });
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
                //  :TODO: Log me
                return this.webServer.internalServerError(resp);
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
