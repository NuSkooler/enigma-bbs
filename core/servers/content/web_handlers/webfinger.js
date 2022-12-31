const { ServerModule } = require('../../../server_module');
const Config = require('../../../config').get;
const { Errors } = require('../../../enig_error');

const WebServerPackageName = require('../web').moduleInfo.packageName;
const { WellKnownLocations } = require('../web');

const _ = require('lodash');
const User = require('../../../user');
const Log = require('../../../logger').log;

exports.moduleInfo = {
    name: 'WebFinger',
    desc: 'A simple WebFinger Handler',
    author: 'NuSkooler, CognitiveGears',
    packageName: 'codes.l33t.enigma.web.handler.finger',
};

exports.getModule = class WebFingerServerModule extends ServerModule {
    constructor() {
        super();
    }

    init(cb) {
        const config = Config();

        if (!_.get(config, 'contentServers.web.handlers.webFinger.enabled')) {
            return cb(null);
        }

        const { getServer } = require('../../../listening_server');

        // we rely on the web server
        this.webServer = getServer(WebServerPackageName);
        const ws = this._webServer();
        if (!ws || !ws.isEnabled()) {
            return cb(Errors.UnexpectedState('Cannot access web server!'));
        }

        const domain = ws.getDomain();
        if (!domain) {
            return cb(Errors.UnexpectedState('Web server does not have "domain" set'));
        }

        this.acceptedResourceRegExps = [
            // acct:NAME@our.domain.tld
            new RegExp(`^acct:(.+)@${domain}$`),
            // profile URL
            new RegExp(`^${ws.buildUrl(WellKnownLocations.Internal + '/wf/@')}(.+)$`),
            // self URL
            new RegExp(
                `^${ws.buildUrl(WellKnownLocations.Internal + '/ap/users/')}(.+)$`
            ),
        ];

        ws.addRoute({
            method: 'GET',
            // https://www.rfc-editor.org/rfc/rfc7033.html#section-10.1
            path: /^\/\.well-known\/webfinger\/?\?/,
            handler: this._webFingerRequestHandler.bind(this),
        });

        return cb(null);
    }

    _webServer() {
        return this.webServer.instance;
    }

    _webFingerRequestHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);

        const resource = url.searchParams.get('resource');
        if (!resource) {
            return this._webServer().respondWithError(
                resp,
                400,
                '"resource" is required',
                'Missing "resource"'
            );
        }

        this._getUser(resource, resp, (err, user) => {
            if (err) {
                // |resp| already written to
                return Log.warn({ error: err.message }, `WebFinger failed: ${req.url}`);
            }

            const domain = this._webServer().getDomain();

            const body = JSON.stringify({
                subject: `acct:${user.username}@${domain}`,
                aliases: [this._profileUrl(user), this._selfUrl(user)],
                links: [
                    this._profilePageLink(user),
                    this._selfLink(user),
                    this._subscribeLink(),
                ],
            });

            const headers = {
                'Content-Type': 'application/jrd+json',
                'Content-Length': body.length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _profileUrl(user) {
        return this._webServer().buildUrl(
            WellKnownLocations.Internal + `/wf/@${user.username}`
        );
    }

    _profilePageLink(user) {
        const href = this._profileUrl(user);
        return {
            rel: 'http://webfinger.net/rel/profile-page',
            type: 'text/plain',
            href,
        };
    }

    _selfUrl(user) {
        return this._webServer().buildUrl(
            WellKnownLocations.Internal + `/ap/users/${user.username}`
        );
    }

    // :TODO: only if ActivityPub is enabled
    _selfLink(user) {
        const href = this._selfUrl(user);
        return {
            rel: 'self',
            type: 'application/activity+json',
            href,
        };
    }

    // :TODO: only if ActivityPub is enabled
    _subscribeLink() {
        return {
            rel: 'http://ostatus.org/schema/1.0/subscribe',
            template: this._webServer().buildUrl(
                WellKnownLocations.Internal + '/ap/authorize_interaction?uri={uri}'
            ),
        };
    }

    _getAccountName(resource) {
        for (const re of this.acceptedResourceRegExps) {
            const m = resource.match(re);
            if (m && m.length === 2) {
                return m[1];
            }
        }
    }

    _getUser(resource, resp, cb) {
        const notFound = () => {
            this._webServer().respondWithError(
                resp,
                404,
                'Resource not found',
                'Resource Not Found'
            );
        };

        const accountName = this._getAccountName(resource);
        if (!accountName || accountName.length < 1) {
            notFound();
            return cb(
                Errors.DoesNotExist(
                    `Failed to parse "account name" for resource: ${resource}`
                )
            );
        }

        User.getUserIdAndName(accountName, (err, userId) => {
            if (err) {
                notFound();
                return cb(err);
            }

            User.getUser(userId, (err, user) => {
                if (err) {
                    notFound();
                    return cb(err);
                }

                return cb(null, user);
            });
        });
    }
};
