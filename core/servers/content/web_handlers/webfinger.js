const WebHandlerModule = require('../../../web_handler_module');
const Config = require('../../../config').get;
const { Errors, ErrorReasons } = require('../../../enig_error');
const { WellKnownLocations } = require('../web');
const { buildSelfUrl } = require('../../../activitypub_util');

const _ = require('lodash');
const User = require('../../../user');
const UserProps = require('../../../user_property');
const Log = require('../../../logger').log;
const mimeTypes = require('mime-types');

const fs = require('graceful-fs');
const paths = require('path');
const moment = require('moment');

exports.moduleInfo = {
    name: 'WebFinger',
    desc: 'A simple WebFinger Handler.',
    author: 'NuSkooler, CognitiveGears',
    packageName: 'codes.l33t.enigma.web.handler.webfinger',
};

//  :TODO: more info in default
const DefaultProfileTemplate = `
User information for: %USERNAME%

Real Name: %REAL_NAME%
Login Count: %LOGIN_COUNT%
Affiliations: %AFFILIATIONS%
Achievement Points: %ACHIEVEMENT_POINTS%
`;

//
//  WebFinger: https://www.rfc-editor.org/rfc/rfc7033
//
exports.getModule = class WebFingerWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(cb) {
        const config = Config();

        // we rely on the web server
        this.webServer = WebHandlerModule.getWebServer();
        if (!this.webServer || !this.webServer.isEnabled()) {
            return cb(Errors.UnexpectedState('Cannot access web server!'));
        }

        const domain = this.webServer.getDomain();
        if (!domain) {
            return cb(Errors.UnexpectedState('Web server does not have "domain" set'));
        }

        this.acceptedResourceRegExps = [
            // acct:NAME@our.domain.tld
            // https://www.rfc-editor.org/rfc/rfc7565
            new RegExp(`^acct:(.+)@${domain}$`),
            // profile page
            // https://webfinger.net/rel/profile-page/
            new RegExp(
                `^${this.webServer.buildUrl(WellKnownLocations.Internal + '/wf/@')}(.+)$`
            ),
            // self URL
            new RegExp(
                `^${this.webServer.buildUrl(
                    WellKnownLocations.Internal + '/ap/users/'
                )}(.+)$`
            ),
        ];

        this.webServer.addRoute({
            method: 'GET',
            // https://www.rfc-editor.org/rfc/rfc7033.html#section-10.1
            path: /^\/\.well-known\/webfinger\/?\?/,
            handler: this._webFingerRequestHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/wf\/@.+$/,
            handler: this._profileRequestHandler.bind(this),
        });

        return cb(null);
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
                const up = (p, na = 'N/A') => {
                    return user.getProperty(p) || na;
                };

                let birthDate = up(UserProps.Birthdate);
                if (moment.isDate(birthDate)) {
                    birthDate = moment(birthDate);
                }

                const varMap = {
                    USERNAME: user.username,
                    REAL_NAME: user.getSanitizedName('real'),
                    SEX: up(UserProps.Sex),
                    BIRTHDATE: birthDate,
                    AGE: user.getAge(),
                    LOCATION: up(UserProps.Location),
                    AFFILIATIONS: up(UserProps.Affiliations),
                    EMAIL: up(UserProps.EmailAddress),
                    WEB_ADDRESS: up(UserProps.WebAddress),
                    ACCOUNT_CREATED: moment(user.getProperty(UserProps.AccountCreated)),
                    LAST_LOGIN: moment(user.getProperty(UserProps.LastLoginTs)),
                    LOGIN_COUNT: up(UserProps.LoginCount),
                    ACHIEVEMENT_COUNT: up(UserProps.AchievementTotalCount, '0'),
                    ACHIEVEMENT_POINTS: up(UserProps.AchievementTotalPoints, '0'),
                    BOARDNAME: Config().general.boardName,
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
            templateFile = this.webServer.resolveTemplatePath(templateFile);
        }
        fs.readFile(templateFile || '', 'utf8', (err, data) => {
            if (err) {
                if (templateFile) {
                    Log.warn(
                        { error: err.message },
                        `Failed to load profile template "${templateFile}"`
                    );
                }

                return cb(DefaultProfileTemplate, 'text/plain');
            }
            return cb(data, mimeTypes.contentType(paths.basename(templateFile)));
        });
    }

    _webFingerRequestHandler(req, resp) {
        const url = new URL(req.url, `https://${req.headers.host}`);

        const resource = url.searchParams.get('resource');
        if (!resource) {
            return this.webServer.respondWithError(
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

            const domain = this.webServer.getDomain();

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
        return this.webServer.buildUrl(
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
        return buildSelfUrl(this.webServer, user, '/ap/users/');
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
            template: this.webServer.buildUrl(
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
        this.webServer.respondWithError(
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
                    User.AccountStatus.disabled == accountStatus ||
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
