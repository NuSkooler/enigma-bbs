/* jslint node: true */
'use strict';

//  ENiGMA½
const { Errors } = require('../enig_error.js');
const UserProps = require('../user_property');
const Endpoints = require('./endpoint');
const { userNameFromSubject, isValidLink } = require('./util');
const Log = require('../logger').log;
const { queryWebFinger } = require('../webfinger');
const EnigAssert = require('../enigma_assert');
const ActivityPubSettings = require('./settings');
const ActivityPubObject = require('./object');
const { ActivityStreamMediaType, Collections } = require('./const');
const Config = require('../config').get;
const { stripMciColorCodes } = require('../color_codes');
const { stripAnsiControlCodes } = require('../string_util');

//  deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const { getJson } = require('../http_util.js');
const moment = require('moment');
const paths = require('path');
const Collection = require('./collection.js');

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

        const addImage = (o, t) => {
            const url = userSettings[t];
            if (url) {
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

        const summary = stripMciColorCodes(
            stripAnsiControlCodes(user.getProperty(UserProps.AutoSignature) || ''),
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

    static fromId(id, cb) {
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
            Actor._fromWebFinger(id, (err, actor, subject) => {
                if (err) {
                    return callback(err);
                }

                if (subject) {
                    subject = `@${userNameFromSubject(subject)}`; // e.g. @Username@host.com
                } else if (!_.isEmpty(actor)) {
                    subject = actor.id; //   best we can do for now
                }

                // deliver result to caller
                callback(err, actor, subject);

                // cache our entry
                if (actor) {
                    Collection.addActor(actor, subject, err => {
                        if (err) {
                            //  :TODO: Log me
                        }
                    });
                }
            });
        });
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

    static _fromRemoteQuery(id, cb) {
        const headers = {
            Accept: ActivityStreamMediaType,
        };

        getJson(id, { headers }, (err, actor) => {
            if (err) {
                return cb(err);
            }

            actor = new Actor(actor);

            if (!actor.isValid()) {
                return cb(Errors.Invalid('Invalid Actor'));
            }

            return cb(null, actor);
        });
    }

    static _fromCache(actorIdOrSubject, cb) {
        Collection.actor(actorIdOrSubject, (err, actor, info) => {
            if (err) {
                return cb(err);
            }

            const needsRefresh = moment().isAfter(
                info.timestamp.add(ActorCacheExpiration)
            );

            actor = new Actor(actor);
            if (!actor.isValid()) {
                return cb(Errors.Invalid('Failed to create Actor object'));
            }

            return cb(null, actor, info.subject, needsRefresh);
        });
    }

    static _fromWebFinger(actorQuery, cb) {
        queryWebFinger(actorQuery, (err, res) => {
            if (err) {
                return cb(err);
            }

            // we need a link with 'application/activity+json'
            const links = res.links;
            if (!Array.isArray(links)) {
                return cb(Errors.DoesNotExist('No "links" object in WebFinger response'));
            }

            const activityLink = links.find(l => {
                return l.type === ActivityStreamMediaType && l.href?.length > 0;
            });

            if (!activityLink) {
                return cb(
                    Errors.DoesNotExist('No Activity link found in WebFinger response')
                );
            }

            // we can now query the href value for an Actor
            return Actor._fromRemoteQuery(activityLink.href, (err, actor) => {
                return cb(err, actor, res.subject);
            });
        });
    }
};