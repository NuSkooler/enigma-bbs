/* jslint node: true */
'use strict';

//  ENiGMA½
const { Errors } = require('../enig_error.js');
const UserProps = require('../user_property');
const Endpoints = require('./endpoint');
const { handleFromSubject, isValidLink } = require('./util');
const Log = require('../logger').log;
const Logger = require('../logger');

//  Logger.log is set at startup; read it when logging, not at require time
const warnLog = (obj, msg) => Logger.log && Logger.log.warn(obj, msg);
//  called through the module objects, so tests can stand in for the network
const WebFinger = require('../webfinger');
const EnigAssert = require('../enigma_assert');
const ActivityPubSettings = require('./settings');
const ActivityPubObject = require('./object');
const { ActivityStreamMediaType, Collections } = require('./const');
const Config = require('../config').get;
const { stripAllControlCodes } = require('../string_util');

//  deps
const _ = require('lodash');
const { encode } = require('html-entities');
const mimeTypes = require('mime-types');
const HttpUtil = require('../http_util.js');
const moment = require('moment');
const paths = require('path');
const Collection = require('./collection.js');
const { actorIdFromKeyId, sameHost, verifyFetchedActorId } = require('./security.js');

const ActorCacheExpiration = moment.duration(15, 'days');
const ActorCacheMaxAgeDays = 125; // hasn't been used in >= 125 days, nuke it.

// default context for Actor's
const DefaultContext = ActivityPubObject.makeContext(['https://w3id.org/security/v1'], {
    toot: 'http://joinmastodon.org/ns#',
    discoverable: 'toot:discoverable',
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
});

// https://www.w3.org/TR/activitypub/#actor-objects
module.exports = class Actor extends ActivityPubObject {
    constructor(obj, withContext = DefaultContext) {
        super(obj, withContext);
    }

    isValid() {
        if (!super.isValid()) {
            return false;
        }

        if (!Actor.WellKnownActorTypes.includes(this.type)) {
            return false;
        }

        const linksValid = Actor.WellKnownLinkTypes.every(l => {
            // must be valid if present & non-empty
            if (this[l] && !isValidLink(this[l])) {
                return false;
            }
            return true;
        });

        if (!linksValid) {
            return false;
        }

        return true;
    }

    static fromJsonString(s) {
        const obj = ActivityPubObject.fromJsonString(s);
        return new Actor(obj);
    }

    static get WellKnownActorTypes() {
        return ['Person', 'Group', 'Organization', 'Service', 'Application'];
    }

    static get WellKnownLinkTypes() {
        return [
            Collections.Inbox,
            Collections.Outbox,
            Collections.Following,
            Collections.Followers,
        ];
    }

    static fromLocalUser(user, cb) {
        const userActorId = user.getProperty(UserProps.ActivityPubActorId);
        if (!userActorId) {
            return cb(
                Errors.MissingProperty(
                    `User missing '${UserProps.ActivityPubActorId}' property`
                )
            );
        }

        const userSettings = ActivityPubSettings.fromUser(user);

        //  Local auto-generated avatar paths follow /_enig/users/{user}/avatar/{file}.
        //  When a stored URL matches this pattern, rebuild it from the current base URL
        //  using the deterministic filename (user-avatar-{userId}.png) so that domain
        //  changes (e.g. ngrok rotation) are reflected without re-conditioning, and any
        //  stored filename corruption is bypassed.
        //  External/custom URLs (anything else) are used verbatim.
        const localAvatarRe = new RegExp(
            `/users/${_.escapeRegExp(user.username)}/avatar/`
        );

        const addImage = (o, t) => {
            const storedUrl = userSettings[t];
            if (storedUrl) {
                let url = storedUrl;
                if (localAvatarRe.test(storedUrl)) {
                    //  Use the deterministic local filename rather than whatever
                    //  may be stored (avoids stale domains and filename corruption).
                    const localFn = `user-avatar-${user.userId}.png`;
                    url = Endpoints.avatar(user, localFn);
                }
                const fn = paths.basename(url);
                const mt =
                    mimeTypes.contentType(fn) || mimeTypes.contentType('dummy.png');
                if (mt) {
                    o[t] = {
                        mediaType: mt,
                        type: 'Image',
                        url,
                    };
                }
            }
        };

        //  The signature is user-supplied and ends up in a public, federated
        //  object, so it gets the same treatment as a message body: strip every
        //  control code, then HTML-encode. The encode() was previously missing
        //  here -- the options object was being passed as a second argument to
        //  stripMciColorCodes(), which takes only one and silently ignored it,
        //  so summaries shipped unencoded and still carrying escapes.
        const summary = encode(
            stripAllControlCodes(user.getProperty(UserProps.AutoSignature) || ''),
            { mode: 'nonAsciiPrintable' }
        );

        const obj = {
            id: userActorId,
            type: 'Person',
            preferredUsername: user.username,
            name: userSettings.showRealName
                ? user.getSanitizedName('real')
                : user.username,
            endpoints: {
                sharedInbox: Endpoints.sharedInbox(),
            },
            inbox: Endpoints.inbox(user),
            outbox: Endpoints.outbox(user),
            followers: Endpoints.followers(user),
            following: Endpoints.following(user),
            summary,
            url: Endpoints.profile(user),
            manuallyApprovesFollowers: userSettings.manuallyApprovesFollowers,
            discoverable: userSettings.discoverable,
            // :TODO: we can start to define BBS related stuff with the community perhaps
            // attachment: [
            //     {
            //         name: 'SomeNetwork Address',
            //         type: 'PropertyValue',
            //         value: 'Mateo@21:1/121',
            //     },
            // ],

            //  :TODO: re-enable once a spec is defined; board should prob be a object with connection info, etc.
            // bbsInfo: {
            //     boardName: Config().general.boardName,
            //     memberSince: user.getProperty(UserProps.AccountCreated),
            //     affiliations: user.getProperty(UserProps.Affiliations) || '',
            // },
        };

        addImage(obj, 'icon');
        addImage(obj, 'image');

        const publicKeyPem = user.getProperty(UserProps.PublicActivityPubSigningKey);
        if (!_.isEmpty(publicKeyPem)) {
            obj.publicKey = {
                id: userActorId + '#main-key',
                owner: userActorId,
                publicKeyPem,
            };

            EnigAssert(
                !_.isEmpty(user.getProperty(UserProps.PrivateActivityPubSigningKey)),
                'User has public key but no private key!'
            );
        } else {
            Log.warn(
                { username: user.username },
                `No public key (${UserProps.PublicActivityPubSigningKey}) for user "${user.username}"`
            );
        }

        return cb(null, new Actor(obj));
    }

    //  fromUser is optional; when supplied the remote actor fetch is HTTP-signed.
    //  Some strict servers (e.g. GoToSocial) require signatures on GET requests.
    static fromId(id, fromUser, cb) {
        //  Support legacy two-arg call: fromId(id, cb)
        if (typeof fromUser === 'function') {
            cb = fromUser;
            fromUser = null;
        }

        return Actor._fromIdOrKeyId(id, null, fromUser, cb);
    }

    //  The actor that owns an HTTP signature's |keyId|. Fetches the actor id
    //  derived from the keyId; a server that answers with an actor of another
    //  id is accepted only under verifyFetchedActorId()'s keyId rule.
    static fromKeyId(keyId, cb) {
        const id = actorIdFromKeyId(keyId);
        if (!id) {
            return cb(Errors.Invalid(`Invalid keyId "${keyId}"`));
        }
        return Actor._fromIdOrKeyId(id, keyId, null, cb);
    }

    static _fromIdOrKeyId(id, keyId, fromUser, cb) {
        let delivered = false;
        const callback = (e, a, s) => {
            if (!delivered) {
                delivered = true;
                return cb(e, a, s);
            }
        };

        if (!id) {
            return cb(Errors.Invalid('Invalid Actor ID'));
        }

        Actor._fromCache(id, (err, actor, subject, needsRefresh) => {
            if (!err) {
                // cache hit
                callback(null, actor, subject);

                if (!needsRefresh) {
                    return;
                }
            }

            //  Cache miss or needs refreshed; Try to do so now
            Actor._fromWebFinger(id, fromUser, keyId, (err, actor, webFingerRes) => {
                if (err) {
                    return callback(err);
                }

                //  a handle only once confirmed; otherwise the actor's id,
                //  as when there is no subject at all
                Actor._confirmedHandle(actor, id, webFingerRes, handle => {
                    const subject = handle ? `@${handle}` : actor.id; // e.g. @Username@host.com

                    // deliver result to caller
                    callback(null, actor, subject);

                    // cache our entry
                    Collection.addActor(actor, subject, err => {
                        if (err) {
                            //  :TODO: Log me
                        }
                    });
                });
            });
        });
    }

    //
    //  The "user@host" handle |actor| may be shown and looked up as, or null.
    //  A WebFinger subject is taken on the word of both sides, as Mastodon
    //  does (ProcessAccountService#check_webfinger!): the actor's own host
    //  (for preferredUsername@actor-host, or the actor's FEP-2c59 webfinger
    //  property) must name the handle, and the handle's host must point it
    //  back at this actor id. Otherwise any server could claim
    //  alice@good.example for its own actor, or relabel someone else's.
    //
    //  query, queryRes — the WebFinger lookup that found the actor, reused
    //                    when it is one of the two above
    //
    static _confirmedHandle(actor, query, queryRes, cb) {
        const lower = h => (h || '').replace(/^@/, '').toLowerCase();
        let actorHost;
        try {
            actorHost = new URL(actor.id).host;
        } catch {
            return cb(null);
        }
        const start =
            handleFromSubject(actor.webfinger) ||
            (_.isString(actor.preferredUsername) &&
                handleFromSubject(`${actor.preferredUsername}@${actorHost}`));
        if (!start) {
            return cb(null);
        }

        const finger = (handle, next) => {
            if (queryRes && lower(query) === lower(handle)) {
                return next(queryRes);
            }
            WebFinger.queryWebFinger(`@${handle}`, (err, res) => next(err ? null : res));
        };
        const pointsHere = res => Actor._activityLinkHref(res) === actor.id;

        finger(start, res => {
            const named = res && handleFromSubject(res.subject);
            if (!named) {
                return cb(null);
            }
            if (lower(named) === lower(start)) {
                return cb(pointsHere(res) ? named : null);
            }
            //  the actor's host names a handle elsewhere (a split domain):
            //  that host must agree
            finger(named, res => {
                const again = res && handleFromSubject(res.subject);
                if (again && lower(again) === lower(named) && pointsHere(res)) {
                    return cb(named);
                }
                warnLog(
                    { actorId: actor.id, subject: named },
                    'WebFinger subject not confirmed by its host; not using it'
                );
                return cb(null);
            });
        });
    }

    static _activityLinkHref(res) {
        const links = res && res.links;
        if (!Array.isArray(links)) {
            return null;
        }
        const link = links.find(
            l => l && l.type === ActivityStreamMediaType && l.href?.length > 0
        );
        return link ? link.href : null;
    }

    static actorCacheMaintenanceTask(args, cb) {
        const enabled = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.enabled'
        );
        if (!enabled) {
            return;
        }

        Collection.removeExpiredActors(ActorCacheMaxAgeDays, err => {
            if (err) {
                Log.error('Failed removing expired Actor items');
            }

            return cb(null); // always non-fatal
        });
    }

    static _fromRemoteQuery(id, fromUser, keyId, cb) {
        const reqOpts = {
            headers: {
                Accept: ActivityStreamMediaType,
            },
        };

        //  Sign the GET if a local user was provided — required by strict servers
        //  such as GoToSocial that reject unsigned actor fetch requests.
        if (fromUser) {
            const privateKey = fromUser.getProperty(
                UserProps.PrivateActivityPubSigningKey
            );
            if (privateKey) {
                reqOpts.sign = {
                    key: privateKey,
                    keyId: Endpoints.actorId(fromUser) + '#main-key',
                    authorizationHeaderName: 'Signature',
                    //  GET has no body — omit digest and content-type
                    headers: ['(request-target)', 'host', 'date'],
                };
            }
        }

        HttpUtil.getJson(
            id,
            {
                ...reqOpts,
                timeout: 15000,
                validContentTypes: [
                    ActivityStreamMediaType,
                    'application/json',
                    'application/ld+json',
                ],
            },
            (err, actor, res) => {
                if (err) {
                    return cb(err);
                }

                //  signed GETs do not follow redirects; follow-redirects sets
                //  responseUrl to where an unsigned one ended up
                const fetchedUrl = (res && res.responseUrl) || id;
                const reason = verifyFetchedActorId(actor, id, fetchedUrl, keyId);
                if (reason) {
                    warnLog(
                        { requestedUrl: id, fetchedUrl, actorId: actor && actor.id },
                        `Refusing fetched Actor: ${reason}`
                    );
                    return cb(Errors.ValidationFailed(reason));
                }

                actor = new Actor(actor);

                if (!actor.isValid()) {
                    return cb(Errors.Invalid('Invalid Actor'));
                }

                return cb(null, actor);
            }
        );
    }

    static _fromCache(actorIdOrSubject, cb) {
        Collection.actor(actorIdOrSubject, (err, actor, info) => {
            if (err) {
                return cb(err);
            }

            const needsRefresh = moment().isAfter(
                moment(info.timestamp).add(ActorCacheExpiration)
            );

            actor = new Actor(actor);
            if (!actor.isValid()) {
                return cb(Errors.Invalid('Failed to create Actor object'));
            }

            return cb(null, actor, info.subject, needsRefresh);
        });
    }

    static _fromWebFinger(actorQuery, fromUser, keyId, cb) {
        WebFinger.queryWebFinger(actorQuery, (err, res, answeredBy) => {
            if (err) {
                return cb(err);
            }

            // we need a link with 'application/activity+json'
            if (!Array.isArray(res.links)) {
                return cb(Errors.DoesNotExist('No "links" object in WebFinger response'));
            }

            const href = Actor._activityLinkHref(res);
            if (!href) {
                return cb(
                    Errors.DoesNotExist('No Activity link found in WebFinger response')
                );
            }

            //  A handle's domain owns its namespace, so it may point at an
            //  actor on another host (a split domain with a static WebFinger
            //  document); the actor fetched must still be the one at that
            //  URL. A lookup by actor URL is answered by that URL's host (or
            //  the host it redirected the query to), for its own actors only.
            const byUrl = /^https?:\/\//i.test(actorQuery);
            if (byUrl && (!answeredBy || !sameHost(href, answeredBy))) {
                warnLog(
                    { actorQuery, href, answeredBy },
                    'Refusing WebFinger link to an actor on another host'
                );
                return cb(
                    Errors.ValidationFailed(
                        `WebFinger for "${actorQuery}" links to an actor on another host`
                    )
                );
            }

            // we can now query the href value for an Actor
            return Actor._fromRemoteQuery(href, fromUser, keyId, (err, actor) => {
                return cb(err, actor, res);
            });
        });
    }
};
