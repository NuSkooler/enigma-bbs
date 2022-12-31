const { ServerModule } = require('../../../server_module');
const Config = require('../../../config').get;
const { Errors } = require('../../../enig_error');

const WebServerPackageName = require('../web').moduleInfo.packageName;

const _ = require('lodash');
const User = require('../../../user');
const Log = require('../../../logger').log;

exports.moduleInfo = {
    name: 'Profile',
    desc: 'Displays a user profile',
    author: 'CognitiveGears',
    packageName: 'codes.l33t.enigma.web.handler.profile',
};

exports.getModule = class ProfileServerModule extends ServerModule {
    constructor() {
        super();
    }

    init(cb) {
        if (!_.get(Config(), 'contentServers.web.handlers.profile.enabled')) {
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
            path: /^\/profile\//,
            handler: this._profileRequestHandler.bind(this),
        });

        return cb(null);
    }

    _profileRequestHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);

        const resource = url.pathname;
        if (!resource) {
            return this.webServer.instance.respondWithError(
                resp,
                400,
                'pathname is required',
                'Missing "resource"'
            );
        }

        this._getUser(resource, resp, (err, user, accountName) => {
            if (err) {
                // |resp| already written to
                return Log.warn({ error: err.message }, `Profile request failed: ${req.url}`);
            }

            // TODO: More user information here
            const body = `
        User name: ${accountName},
`;

            const headers = {
                'Content-Type': 'text/plain',
                'Content-Length': body.length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _getUser(resource, resp, cb) {

        const notFound = () => {
            this.webServer.instance.respondWithError(
                resp,
                404,
                'Resource not found',
                'Resource Not Found'
            );
        };

        // TODO: Handle URL escaped @ sign as well
        const userPosition = resource.indexOf('@');
        if (-1 == userPosition) {
            notFound();
            return cb(Errors.DoesNotExist('"@username" missing from path'));
        }

        const searchQuery = resource.substring(userPosition + 1);

        if (_.isEmpty(searchQuery)) {
            notFound();
            return cb(Errors.DoesNotExist('Empty username in path'));
        }

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

                return cb(null, user, searchQuery);
            });
        });
    }
};
