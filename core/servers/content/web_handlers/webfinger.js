const WebHandlerModule = require('../../../web_handler_module');
const Config = require('../../../config').get;
const { Errors, ErrorReasons } = require('../../../enig_error');
const { WellKnownLocations } = require('../web');
const {
    getUserProfileTemplatedBody,
    DefaultProfileTemplate,
} = require('../../../activitypub/util');
const Endpoints = require('../../../activitypub/endpoint');
const EngiAssert = require('../../../enigma_assert');
const User = require('../../../user');
const UserProps = require('../../../user_property');
const ActivityPubSettings = require('../../../activitypub/settings');

// deps
const _ = require('lodash');
const Actor = require('../../../activitypub/actor');

exports.moduleInfo = {
    name: 'WebFinger',
    desc: 'A simple WebFinger Handler.',
    author: 'NuSkooler, CognitiveGears',
    packageName: 'codes.l33t.enigma.web.handler.webfinger',
};

//
//  WebFinger: https://www.rfc-editor.org/rfc/rfc7033
//
exports.getModule = class WebFingerWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        // we rely on the web server
        this.webServer = webServer;
        EngiAssert(webServer, 'WebFinger Web Handler init without webServer');

        this.log = webServer.logger().child({ webHandler: 'WebFinger' });

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
        //  Profile requests do not have an Actor ID available
        const profileQuery = this.webServer.fullUrl(req).toString();
        const accountName = this._getAccountName(profileQuery);
        if (!accountName) {
            this.log.warn(
                `Failed to parse "account name" for profile query: ${profileQuery}`
            );
            return this.webServer.resourceNotFound(resp);
        }

        this._localUserFromWebFingerAccountName(accountName, (err, localUser) => {
            if (err) {
                this.log.warn(
                    { error: err.message, type: 'Profile', accountName },
                    'Could not fetch profile for WebFinger request'
                );
                return this.webServer.resourceNotFound(resp);
            }

            let templateFile = _.get(
                Config(),
                'contentServers.web.handlers.webFinger.profileTemplate'
            );
            if (templateFile) {
                templateFile = this.webServer.resolveTemplatePath(templateFile);
            }

            Actor.fromLocalUser(localUser, this.webServer, (err, localActor) => {
                if (err) {
                    return this.webServer.internalServerError(resp, err);
                }

                getUserProfileTemplatedBody(
                    this.webServer,
                    templateFile,
                    localUser,
                    localActor,
                    DefaultProfileTemplate,
                    'text/plain',
                    (err, body, contentType) => {
                        if (err) {
                            return this.webServer.resourceNotFound(resp);
                        }

                        const headers = {
                            'Content-Type': contentType,
                            'Content-Length': Buffer(body).length,
                        };

                        resp.writeHead(200, headers);
                        return resp.end(body);
                    }
                );
            });
        });
    }

    _webFingerRequestHandler(req, resp) {
        const url = this.webServer.fullUrl(req);
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
            this.log.warn(`Failed to parse "account name" for resource: ${resource}`);
            return this.webServer.resourceNotFound(resp);
        }

        this._localUserFromWebFingerAccountName(accountName, (err, localUser) => {
            if (err) {
                this.log.warn(
                    { url: req.url, error: err.message, type: 'WebFinger' },
                    `No account for "${accountName}" could be retrieved`
                );
                return this.webServer.resourceNotFound(resp);
            }

            const domain = this.webServer.getDomain();

            const body = JSON.stringify({
                subject: `acct:${localUser.username}@${domain}`,
                aliases: [this._profileUrl(localUser), this._userActorId(localUser)],
                links: [
                    this._profilePageLink(localUser),
                    this._selfLink(localUser),
                    this._subscribeLink(),
                ],
            });

            const headers = {
                'Content-Type': 'application/jrd+json',
                'Content-Length': Buffer(body).length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _localUserFromWebFingerAccountName(accountName, cb) {
        if (accountName.startsWith('@')) {
            accountName = accountName.slice(1);
        }

        User.getUserIdAndName(accountName, (err, userId) => {
            if (err) {
                return cb(err);
            }

            User.getUser(userId, (err, user) => {
                if (err) {
                    return cb(err);
                }

                const accountStatus = user.getPropertyAsNumber(UserProps.AccountStatus);
                if (
                    User.AccountStatus.disabled == accountStatus ||
                    User.AccountStatus.inactive == accountStatus
                ) {
                    return cb(
                        Errors.AccessDenied('Account disabled', ErrorReasons.Disabled)
                    );
                }

                const activityPubSettings = ActivityPubSettings.fromUser(user);
                if (!activityPubSettings.enabled) {
                    return cb(Errors.AccessDenied('ActivityPub is not enabled for user'));
                }

                return cb(null, user);
            });
        });
    }

    _profileUrl(user) {
        return Endpoints.profile(this.webServer, user);
    }

    _profilePageLink(user) {
        const href = this._profileUrl(user);
        return {
            rel: 'http://webfinger.net/rel/profile-page',
            type: 'text/plain',
            href,
        };
    }

    _userActorId(user) {
        return Endpoints.actorId(this.webServer, user);
    }

    // :TODO: only if ActivityPub is enabled
    _selfLink(user) {
        const href = this._userActorId(user);
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
};
