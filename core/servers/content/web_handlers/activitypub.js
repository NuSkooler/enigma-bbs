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

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/ap\/users\/.+$/,
            handler: this._selfUrlRequestHandler.bind(this),
        });

        return cb(null);
    }

    _selfUrlRequestHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);
        const accountName = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);

        userFromAccount(accountName, (err, user) => {
            if (err) {
                return this._notFound(resp);
            }

            const accept = req.headers['accept'] || '*/*';
            if (accept === 'application/activity+json') {
                return this._selfAsActorHandler(user, req, resp);
            }

            return this._standardSelfHandler(user, req, resp);
        });
    }

    _selfAsActorHandler(user, req, resp) {
        const body = JSON.stringify({
            '@context': [
                'https://www.w3.org/ns/activitystreams',
                'https://w3id.org/security/v1',
            ],
            id: selfUrl(this.webServer, user),
            type: 'Person',
            preferredUsername: user.username,
            name: user.getSanitizedName('real'),
            endpoints: {
                sharedInbox: 'TODO',
            },
            inbox: makeUserUrl(this.webServer, user, '/ap/users') + '/outbox',
            outbox: makeUserUrl(this.webServer, user, '/ap/users') + '/inbox',
            followers: makeUserUrl(this.webServer, user, '/ap/users') + '/followers',
            following: makeUserUrl(this.webServer, user, '/ap/users') + '/following',
            summary: user.getProperty(UserProps.AutoSignature) || '',
            url: webFingerProfileUrl(this.webServer, user),
            publicKey: {},

            // :TODO: we can start to define BBS related stuff with the community perhaps
        });

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
