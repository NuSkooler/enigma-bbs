const WebHandlerModule = require('../../../web_handler_module');
const {
    makeUserUrl,
    webFingerProfileUrl,
    selfUrl,
    userFromAccount,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
    accountFromSelfUrl,
} = require('../../../activitypub_util');
const UserProps = require('../../../user_property');
const Config = require('../../../config').get;
const Activity = require('../../../activitypub_activity');

// deps
const _ = require('lodash');
const enigma_assert = require('../../../enigma_assert');
const httpSignature = require('http-signature');
const https = require('https');
const { Errors } = require('../../../enig_error');
const Actor = require('../../../activitypub_actor');

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

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+$/,
            handler: this._selfUrlRequestHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'POST',
            //inbox: makeUserUrl(this.webServer, user, '/ap/users/') + '/inbox',
            path: /^\/_enig\/ap\/users\/.+\/inbox$/,
            handler: this._inboxPostHandler.bind(this),
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
                'application/activity+json',
                'application/ld+json',
                'application/json',
            ];
            sendActor = accept.some(v => headerValues.includes(v));

            if (sendActor) {
                return this._selfAsActorHandler(user, req, resp);
            } else {
                return this._standardSelfHandler(user, req, resp);
            }
        });
    }

    _inboxPostHandler(req, resp) {
        // the request must be signed, and the signature must be valid
        const signature = this._parseSignature(req);
        if (!signature) {
            return this.webServer.resourceNotFound(resp);
        }

        //  quick check up front
        const keyId = signature.keyId;
        if (!this._validateKeyId(keyId)) {
            return this.webServer.resourceNotFound(resp);
        }

        let body = '';
        req.on('data', data => {
            body += data;
        });

        req.on('end', () => {
            let activity;
            try {
                activity = Activity.fromJson(body);
            } catch (e) {
                this.log.error(
                    { error: e.message, url: req.url, method: req.method },
                    'Failed to parse Activity'
                );
                return this.webServer.resourceNotFound(resp);
            }

            if (!activity.isValid()) {
                //  :TODO: Log me
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

    _parseSignature(req) {
        try {
            //  :TODO: validate options passed to parseRequest()
            return httpSignature.parseRequest(req);
        } catch (e) {
            this.log.warn(
                { error: e.message, url: req.url, method: req.method },
                'Failed to parse HTTP signature'
            );
        }
    }

    _inboxFollowRequestHandler(signature, activity, req, resp) {
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
                            keyId,
                            signature: req.headers['signature'] || '',
                        },
                        'Invalid signature supplied for Follow request'
                    );
                    return this.webServer.accessDenied(resp);
                }

                //  :TODO: return OK and kick off a async job of persisting and sending and 'Accepted'

                resp.writeHead(200, { 'Content-Type': 'text/html' });
                return resp.end('');
            });
        });
    }

    //  :TODO: replace me with a fetch-and-cache in Actor, wrapped in e.g. Actor.fetch(url, options, cb)
    _fetchActor(actorUrl, cb) {
        const headers = {
            Accept: 'application/activity+json',
        };
        https
            .get(actorUrl, { headers }, res => {
                if (res.statusCode !== 200) {
                    return cb(Errors.Invalid(`Bad HTTP status code: ${req.statusCode}`));
                }

                const contentType = res.headers['content-type'];
                if (
                    !_.isString(contentType) ||
                    !contentType.startsWith('application/activity+json')
                ) {
                    return cb(Errors.Invalid(`Invalid Content-Type: ${contentType}`));
                }

                res.setEncoding('utf8');
                let body = '';
                res.on('data', data => {
                    body += data;
                });

                res.on('end', () => {
                    try {
                        const actor = JSON.parse(body);
                        if (
                            !Array.isArray(actor['@context']) ||
                            actor['@context'][0] !==
                                'https://www.w3.org/ns/activitystreams'
                        ) {
                            return cb(
                                Errors.Invalid('Invalid or missing Actor "@context"')
                            );
                        }
                        return cb(null, actor);
                    } catch (e) {
                        return cb(e);
                    }
                });
            })
            .on('error', err => {
                return cb(err);
            });
    }

    _validateKeyId(keyId) {
        if (!keyId) {
            return false;
        }

        // we only accept main-key currently
        return keyId.endsWith('#main-key');
    }

    _authorizeInteractionHandler(req, resp) {
        console.log(req);
    }

    // _populateKeyIdInfo(keyId, info) {
    //     if (!_.isString(keyId)) {
    //         return false;
    //     }

    //     const m = /^https?:\/\/.+\/(.+)#(main-key)$/.exec(keyId);
    //     if (!m || !m.length === 3) {
    //         return false;
    //     }

    //     info.accountName = m[1];
    //     info.keyType = m[2];
    //     return true;
    // }

    _selfAsActorHandler(user, req, resp) {
        this.log.trace(
            { username: user.username },
            `Serving ActivityPub Actor for "${user.username}"`
        );

        const userSelfUrl = selfUrl(this.webServer, user);

        //  :TODO: something like: Actor.makeActor(...)
        const bodyJson = {
            '@context': [
                'https://www.w3.org/ns/activitystreams',
                'https://w3id.org/security/v1',
            ],
            id: userSelfUrl,
            type: 'Person',
            preferredUsername: user.username,
            name: user.getSanitizedName('real'),
            endpoints: {
                sharedInbox: 'TODO',
            },
            inbox: makeUserUrl(this.webServer, user, '/ap/users/') + '/inbox',
            outbox: makeUserUrl(this.webServer, user, '/ap/users/') + '/outbox',
            followers: makeUserUrl(this.webServer, user, '/ap/users/') + '/followers',
            following: makeUserUrl(this.webServer, user, '/ap/users/') + '/following',
            summary: user.getProperty(UserProps.AutoSignature) || '',
            url: webFingerProfileUrl(this.webServer, user),

            // :TODO: we can start to define BBS related stuff with the community perhaps
            // attachment: [
            //     {
            //         name: 'SomeNetwork Address',
            //         type: 'PropertyValue',
            //         value: 'Mateo@21:1/121',
            //     },
            // ],
        };

        const publicKeyPem = user.getProperty(UserProps.PublicKeyMain);
        if (!_.isEmpty(publicKeyPem)) {
            bodyJson['publicKey'] = {
                id: userSelfUrl + '#main-key',
                owner: userSelfUrl,
                publicKeyPem,
            };
        } else {
            this.log.warn(
                { username: user.username },
                `No public key (${UserProps.PublicKeyMain}) for user "${user.username}"`
            );
        }

        const body = JSON.stringify(bodyJson);

        const headers = {
            'Content-Type': 'application/activity+json',
            'Content-Length': body.length,
        };

        resp.writeHead(200, headers);
        return resp.end(body);
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
