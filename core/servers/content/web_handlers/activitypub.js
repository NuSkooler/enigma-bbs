const WebHandlerModule = require('../../../web_handler_module');
const {
    makeUserUrl,
    webFingerProfileUrl,
    selfUrl,
    userFromAccount,
} = require('../../../activitypub_util');
const UserProps = require('../../../user_property');
const { Errors } = require('../../../enig_error');

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
        const accept = req.headers['accept'] || '*/*';
        if (accept === 'application/activity+json') {
            return this._selfAsActorHandler(req, resp);
        }

        return this._standardSelfHandler(req, resp);
    }

    _selfAsActorHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);
        const accountName = url.pathname.substring(url.pathname.lastIndexOf('/') + 1);

        userFromAccount(accountName, (err, user) => {
            if (err) {
                return this._notFound(resp);
            }

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
        });
    }

    _standardSelfHandler(req, resp) {
        // :TODO: this should also be their profile page?! Perhaps that should also be shared...
        return this._notFound(resp);
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
