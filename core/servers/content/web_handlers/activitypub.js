const WebHandlerModule = require('../../../web_handler_module');
const {
    makeUserUrl,
    webFingerProfileUrl,
    selfUrl,
    userFromAccount,
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
} = require('../../../activitypub_util');
const UserProps = require('../../../user_property');
const { Errors } = require('../../../enig_error');
const Config = require('../../../config').get;
const Log = require('../../../logger').log;

// deps
const _ = require('lodash');

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

    init(cb) {
        this.webServer = WebHandlerModule.getWebServer();
        if (!this.webServer) {
            return cb(Errors.UnexpectedState('Cannot access web server!'));
        }
        Log.debug('Adding route for ActivityPub');

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+$/,
            handler: this._selfUrlRequestHandler.bind(this),
        });

        return cb(null);
    }

    _selfUrlRequestHandler(req, resp) {
        Log.debug({ url: req.url }, 'Received request for self url');
        const url = new URL(req.url, `https://${req.headers.host}`);
        let accountName = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);
        let sendActor = false;

        // Like Mastodon, if .json is appended onto URL then return the JSON content
        if (accountName.endsWith('.json')) {
            sendActor = true;
            accountName = accountName.slice(0, -5);
        }
        Log.debug({ accountName: accountName }, 'Retrieving self url for account.');

        userFromAccount(accountName, (err, user) => {
            if (err) {
                Log.info(
                    { accountName: accountName },
                    'Unable to find user from account retrieving self url.'
                );
                return this._notFound(resp);
            }

            const accept = req.headers['accept'] || '*/*';
            if (accept === 'application/activity+json') {
                sendActor = true;
            }

            Log.debug({ sendActor: sendActor }, 'Sending actor JSON');

            if (sendActor) {
                return this._selfAsActorHandler(user, req, resp);
            } else {
                return this._standardSelfHandler(user, req, resp);
            }
        });
    }

    _selfAsActorHandler(user, req, resp) {
        const selfUrl = selfUrl(this.webServer, user);

        const bodyJson = {
            '@context': [
                'https://www.w3.org/ns/activitystreams',
                'https://w3id.org/security/v1',
            ],
            id: selfUrl,
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
        };

        const publicKeyPem = user.getProperty(UserProps.PublicKeyMain);
        if (!_.isEmpty(publicKeyPem)) {
            bodyJson['publicKey'] = {
                id: selfUrl + '#main-key',
                owner: sUrl,
                publicKeyPem: user.getProperty(UserProps.PublicKeyMain),
            };
        } else {
            Log.debug({ username: user.username }, 'User does not have a publickey.');
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
                    return this._notFound(resp);
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

    _notFound(resp) {
        this.webServer.respondWithError(
            resp,
            404,
            'Resource not found',
            'Resource Not Found'
        );
    }
};
