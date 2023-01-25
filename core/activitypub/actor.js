/* jslint node: true */
'use strict';

//  ENiGMA½
const { Errors } = require('../enig_error.js');
const UserProps = require('../user_property');
const {
    ActivityStreamsContext,
    webFingerProfileUrl,
    makeUserUrl,
    selfUrl,
    isValidLink,
    makeSharedInboxUrl,
} = require('./util');
const Log = require('../logger').log;
const { queryWebFinger } = require('../webfinger');
const EnigAssert = require('../enigma_assert');
const ActivityPubSettings = require('./settings');
const ActivityPubObject = require('./object');
const apDb = require('../database').dbs.activitypub;

//  deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const { getJson } = require('../http_util.js');
const { getISOTimestampString } = require('../database.js');

// https://www.w3.org/TR/activitypub/#actor-objects
module.exports = class Actor extends ActivityPubObject {
    constructor(obj) {
        super(obj);
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

    static get WellKnownActorTypes() {
        return ['Person', 'Group', 'Organization', 'Service', 'Application'];
    }

    static get WellKnownLinkTypes() {
        return ['inbox', 'outbox', 'following', 'followers'];
    }

    static fromLocalUser(user, webServer, cb) {
        const userSelfUrl = selfUrl(webServer, user);
        const userSettings = ActivityPubSettings.fromUser(user);

        const addImage = (o, t) => {
            const url = userSettings[t];
            if (url) {
                const mt = mimeTypes.contentType(url);
                if (mt) {
                    o[t] = {
                        mediaType: mt,
                        type: 'Image',
                        url,
                    };
                }
            }
        };

        const obj = {
            '@context': [
                ActivityStreamsContext,
                'https://w3id.org/security/v1', // :TODO: add support
            ],
            id: userSelfUrl,
            type: 'Person',
            preferredUsername: user.username,
            name: userSettings.showRealName
                ? user.getSanitizedName('real')
                : user.username,
            endpoints: {
                sharedInbox: makeSharedInboxUrl(webServer),
            },
            inbox: makeUserUrl(webServer, user, '/ap/users/') + '/inbox',
            outbox: makeUserUrl(webServer, user, '/ap/users/') + '/outbox',
            followers: makeUserUrl(webServer, user, '/ap/users/') + '/followers',
            following: makeUserUrl(webServer, user, '/ap/users/') + '/following',
            summary: user.getProperty(UserProps.AutoSignature) || '',
            url: webFingerProfileUrl(webServer, user),
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
        };

        addImage(obj, 'icon');
        addImage(obj, 'image');

        const publicKeyPem = user.getProperty(UserProps.PublicActivityPubSigningKey);
        if (!_.isEmpty(publicKeyPem)) {
            obj.publicKey = {
                id: userSelfUrl + '#main-key',
                owner: userSelfUrl,
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

    static fromId(id, forceRefresh, cb) {
        if (_.isFunction(forceRefresh) && !cb) {
            cb = forceRefresh;
            forceRefresh = false;
        }

        Actor.fromCache(id, (err, actor) => {
            if (err) {
                if (forceRefresh) {
                    return cb(err);
                }

                Actor.fromRemoteQuery(id, (err, actor) => {
                    // deliver result to caller
                    cb(err, actor);

                    // cache our entry
                    if (actor) {
                        apDb.run(
                            `INSERT INTO actor_cache (actor_id, actor_json, timestamp)
                            VALUES (?, ?, ?);`,
                            [id, JSON.stringify(actor), getISOTimestampString()],
                            err => {
                                if (err) {
                                    //  :TODO: log me
                                }
                            }
                        );
                    }
                });
            } else {
                return cb(null, actor);
            }
        });
    }

    static fromRemoteQuery(id, cb) {
        const headers = {
            Accept: 'application/activity+json',
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

    static fromCache(id, cb) {
        apDb.get(
            `SELECT actor_json
            FROM actor_cache
            WHERE actor_id = ?
            LIMIT 1;`,
            [id],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    return cb(Errors.DoesNotExist());
                }

                const obj = ActivityPubObject.fromJsonString(row.actor_json);
                if (!obj || !obj.isValid()) {
                    return cb(Errors.Invalid('Failed to create ActivityPub object'));
                }

                const actor = new Actor(obj);
                if (!actor.isValid()) {
                    return cb(Errors.Invalid('Failed to create Actor object'));
                }

                return cb(null, actor);
            }
        );
    }

    static fromAccountName(actorName, cb) {
        //  :TODO: cache first -- do we have an Actor for this account already with a OK TTL?

        //  account names can come in multiple forms, so need a cache mapping of that as well
        //  actor_alias_cache
        //  actor_alias | actor_id
        //

        queryWebFinger(actorName, (err, res) => {
            if (err) {
                return cb(err);
            }

            // we need a link with 'application/activity+json'
            const links = res.links;
            if (!Array.isArray(links)) {
                return cb(Errors.DoesNotExist('No "links" object in WebFinger response'));
            }

            const activityLink = links.find(l => {
                return l.type === 'application/activity+json' && l.href?.length > 0;
            });

            if (!activityLink) {
                return cb(
                    Errors.DoesNotExist('No Activity link found in WebFinger response')
                );
            }

            // we can now query the href value for an Actor
            return Actor.fromId(activityLink.href, cb);
        });
    }
};
