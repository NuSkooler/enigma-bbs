const WebHandlerModule = require('../../../web_handler_module');
const Config = require('../../../config').get;
const { Errors, ErrorReasons } = require('../../../enig_error');

const WebServerPackageName = require('../web').moduleInfo.packageName;
const { WellKnownLocations } = require('../web');

const _ = require('lodash');
const User = require('../../../user');
const UserProps = require('../../../user_property');
const Log = require('../../../logger').log;
const mimeTypes = require('mime-types');

const fs = require('graceful-fs');
const paths = require('path');

exports.moduleInfo = {
    name: 'WebFinger',
    desc: 'A simple WebFinger Handler.',
    author: 'NuSkooler, CognitiveGears',
    packageName: 'codes.l33t.enigma.web.handler.finger',
};

//
//  WebFinger: https://www.rfc-editor.org/rfc/rfc7033
//
exports.getModule = class WebFingerServerModule extends WebHandlerModule {
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
            // https://www.rfc-editor.org/rfc/rfc7565
            new RegExp(`^acct:(.+)@${domain}$`),
            // profile page
            // https://webfinger.net/rel/profile-page/
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

        ws.addRoute({
            method: 'GET',
            path: /^\/_enig\/wf\/@.+$/,
            handler: this._profileRequestHandler.bind(this),
        });

        return cb(null);
    }

    _webServer() {
        return this.webServer.instance;
    }

    _profileRequestHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);

        const resource = url.pathname;
        if (_.isEmpty(resource)) {
            return this.webServer.instance.respondWithError(
                resp,
                400,
                'pathname is required',
                'Missing "resource"'
            );
        }

        // TODO: Handle URL escaped @ sign as well
        const userPosition = resource.indexOf('@');
        if (-1 == userPosition || userPosition == resource.length - 1) {
            this._notFound(resp);
            return Errors.DoesNotExist('"@username" missing from path');
        }

        const accountName = resource.substring(userPosition + 1);

        this._getUser(accountName, resp, (err, user) => {
            if (err) {
                // |resp| already written to
                return Log.warn(
                    { error: err.message },
                    `Profile request failed: ${req.url}`
                );
            }

            this._getProfileTemplate((template, mimeType) => {
                const varMap = {
                    USERNAME: user.username,
                    REAL_NAME: user.getSanitizedName('real'),
                    LOGIN_COUNT: user.getProperty(UserProps.LoginCount),
                    AFFILIATIONS: user.getProperty(UserProps.Affiliations) || 'N/A',
                    ACHIEVEMENT_POINTS:
                        user.getProperty(UserProps.AchievementTotalPoints) || '0',
                };

                let body = template;
                _.each(varMap, (val, varName) => {
                    body = body.replace(new RegExp(`%${varName}%`, 'g'), val);
                });

                const headers = {
                    'Content-Type': mimeType,
                    'Content-Length': body.length,
                };

                resp.writeHead(200, headers);
                return resp.end(body);
            });
        });
    }

    _getProfileTemplate(cb) {
        let templateFile = _.get(
            Config(),
            'contentServers.web.handlers.webFinger.profileTemplate'
        );
        if (templateFile) {
            templateFile = this._webServer().resolveTemplatePath(templateFile);
        }
        fs.readFile(templateFile || '', 'utf8', (err, data) => {
            if (err) {
                if (templateFile) {
                    Log.warn(
                        { error: err.message },
                        `Failed to load profile template "${templateFile}"`
                    );
                }

                //  :TODO: more info in default
                return cb(
                    `
User information for: %USERNAME%

Real Name: %REAL_NAME%
Login Count: %LOGIN_COUNT%
Affiliations: %AFFILIATIONS%
Achievement Points: %ACHIEVEMENT_POINTS%`,
                    'text/plain'
                );
            }
            return cb(data, mimeTypes.contentType(paths.basename(templateFile)));
        });
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

        const accountName = this._getAccountName(resource);
        if (!accountName || accountName.length < 1) {
            this._notFound(resp);
            return Errors.DoesNotExist(
                `Failed to parse "account name" for resource: ${resource}`
            );
        }

        this._getUser(accountName, resp, (err, user) => {
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

    _notFound(resp) {
        this._webServer().respondWithError(
            resp,
            404,
            'Resource not found',
            'Resource Not Found'
        );
    }

    _getUser(accountName, resp, cb) {
        User.getUserIdAndName(accountName, (err, userId) => {
            if (err) {
                this._notFound(resp);
                return cb(err);
            }

            User.getUser(userId, (err, user) => {
                if (err) {
                    this._notFound(resp);
                    return cb(err);
                }

                const accountStatus = user.getPropertyAsNumber(UserProps.AccountStatus);
                if (
                    User.AccountStatus.disabled == accountStatus &&
                    User.AccountStatus.inactive == accountStatus
                ) {
                    this._notFound(resp);
                    return cb(
                        Errors.AccessDenied('Account disabled', ErrorReasons.Disabled)
                    );
                }

                return cb(null, user);
            });
        });
    }
};
