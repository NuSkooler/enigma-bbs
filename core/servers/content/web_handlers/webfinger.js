const { ServerModule } = require('../../../server_module');
const Config = require('../../../config').get;
const { Errors } = require('../../../enig_error');

const WebServerPackageName = require('../web').moduleInfo.packageName;

const _ = require('lodash');
const User = require('../../../user');
const { result } = require('lodash');
const Log = require('../../../logger').log;

exports.moduleInfo = {
    name: 'WebFinger',
    desc: 'A simple WebFinger Handler',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.handler.finger',
};

exports.getModule = class WebFingerServerModule extends ServerModule {
    constructor() {
        super();
    }

    init(cb) {
        if (!_.get(Config(), 'contentServers.web.handlers.webFinger.enabled')) {
            return cb(null);
        }

        const { getServer } = require('../../../listening_server');

        // we rely on the web server
        this.webServer = getServer(WebServerPackageName);
        if (!this.webServer || !this.webServer.instance.isEnabled()) {
            return cb(Errors.UnexpectedState('Cannot access web server!'));
        }

        this.webServer.instance.addRoute({
            method: 'GET',
            path: /^\/\.well-known\/webfinger\/?\?/,
            handler: this._webFingerRequestHandler.bind(this),
        });

        return cb(null);
    }

    _webFingerRequestHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);

        const resource = url.searchParams.get('resource');
        if (!resource) {
            return this.webServer.instance.respondWithError(
                resp,
                400,
                '"resource" is required',
                'Missing "resource"'
            );
        }

        this._getUser(resource, resp, (err, user, accountName) => {
            if (err) {
                // |resp| already written to
                return Log.warn({ error: err.message }, `WebFinger failed: ${req.url}`);
            }

            const body = JSON.stringify({
                subject: `acct:${accountName}`,
                links: [this._profilePageLink(user)],
            });

            const headers = {
                'Content-Type': 'application/jrd+json',
                'Content-Length': body.length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _profilePageLink(user) {
        const href = this.webServer.instance.buildUrl(`/wf/@${user.username}`);
        return {
            rel: 'http://webfinger.net/rel/profile-page',
            type: 'text/plain',
            href,
        };
    }

    _getUser(resource, resp, cb) {
        // we only handle "acct:NAME" URIs

        const notFound = () => {
            this.webServer.instance.respondWithError(
                resp,
                404,
                'Resource not found',
                'Resource Not Found'
            );
        };

        const acctIndex = resource.indexOf('acct:', 0);
        if (0 != acctIndex) {
            notFound();
            return cb(Errors.DoesNotExist('"acct:" missing'));
        }

        const accountName = resource.substring(acctIndex + 5);
        const domain = _.get(Config(), 'contentServers.web.domain', 'localhost');
        if (!accountName.endsWith(`@${domain}`)) {
            notFound();
            return cb(Errors.Invalid(`Invalid "acct" value: ${accountName}`));
        }

        const searchQuery = accountName.substring(
            0,
            accountName.length - (domain.length + 1)
        );

        User.getUserIdAndName(searchQuery, (err, userId) => {
            if (err) {
                notFound();
                return cb(err);
            }

            User.getUser(userId, (err, user) => {
                if (err) {
                    notFound();
                    return cb(err);
                }

                return cb(null, user, accountName);
            });
        });
    }
};
