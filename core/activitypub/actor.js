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
const { ActivityStreamMediaType } = require('./const');
const apDb = require('../database').dbs.activitypub;
const Config = require('../config').get;
const parseFullName = require('parse-full-name').parseFullName;

//  deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const { getJson } = require('../http_util.js');
const { getISOTimestampString } = require('../database.js');
const paths = require('path');

const ActorCacheMaxAgeDays = 125; // hasn't been used in >= 125 days, nuke it.
const MaxSearchResults = 10; // Maximum number of results to show for a search

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

    static get WellKnownActorTypes() {
        return ['Person', 'Group', 'Organization', 'Service', 'Application'];
    }

    static get WellKnownLinkTypes() {
        return ['inbox', 'outbox', 'following', 'followers'];
    }

    static fromLocalUser(user, webServer, cb) {
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
                const mt = mimeTypes.contentType(fn);
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
            id: userActorId,
            type: 'Person',
            preferredUsername: user.username,
            name: userSettings.showRealName
                ? user.getSanitizedName('real')
                : user.username,
            endpoints: {
                sharedInbox: Endpoints.sharedInbox(webServer),
            },
            inbox: Endpoints.inbox(webServer, user),
            outbox: Endpoints.outbox(webServer, user),
            followers: Endpoints.followers(webServer, user),
            following: Endpoints.following(webServer, user),
            summary: user.getProperty(UserProps.AutoSignature) || '',
            url: Endpoints.profile(webServer, user),
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

        Actor._fromCache(id, (err, actor, subject) => {
            if (!err) {
                // cache hit
                callback(null, actor, subject);
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
                    apDb.run(
                        'DELETE FROM actor_cache_search WHERE actor_id=?',
                        [id],
                        err => {
                            if (err) {
                                Log.warn(
                                    { err: err },
                                    'Error deleting previous actor_cache_search'
                                );
                            }
                        }
                    );

                    apDb.run(
                        `REPLACE INTO actor_cache (actor_id, actor_json, subject, timestamp)
                        VALUES (?, ?, ?, ?);`,
                        [id, JSON.stringify(actor), subject, getISOTimestampString()],
                        err => {
                            if (err) {
                                Log.warn(
                                    { err: err },
                                    'Error replacing into the actor cache'
                                );
                            }
                        }
                    );

                    const searchNames = this._parseSearchNames(actor);
                    if (searchNames.length > 0) {
                        const searchStatement = apDb.prepare(
                            'INSERT INTO actor_cache_search (actor_id, search_name) VALUES (?, ?)'
                        );
                        searchNames.forEach(name => {
                            searchStatement.run([id, name], err => {
                                if (err) {
                                    Log.warn(
                                        { err: err },
                                        'Error inserting into actor cache search'
                                    );
                                }
                            });
                        });
                    }
                }
            });
        });
    }

    static _parseSearchNames(actor) {
        const searchNames = [];

        if (!_.isEmpty(actor.preferredUsername)) {
            searchNames.push(actor.preferredUsername);
        }
        const name = parseFullName(actor.name);
        if (!_.isEmpty(name.first)) {
            searchNames.push(name.first);
        }

        if (!_.isEmpty(name.last)) {
            searchNames.push(name.last);
        }

        if (!_.isEmpty(name.nick)) {
            searchNames.push(name.nick);
        }

        return searchNames;
    }

    static actorCacheMaintenanceTask(args, cb) {
        const enabled = _.get(
            Config(),
            'contentServers.web.handlers.activityPub.enabled'
        );
        if (!enabled) {
            return;
        }

        apDb.run(
            `DELETE FROM actor_cache
            WHERE DATETIME(timestamp) < DATETIME("now", "-${ActorCacheMaxAgeDays} day");`,
            err => {
                if (err) {
                    Log.warn({ err: err }, 'Error clearing old cache entries.');
                }

                return cb(null); // always non-fatal
            }
        );
    }

    static fromSearch(searchString, cb) {
        // first try to find an exact match
        this.fromId(searchString, (err, remoteActor) => {
            if (!err) {
                return cb(null, [remoteActor]);
            } else {
                Log.info({ err: err }, 'Not able to find based on id');
            }
        });

        let returnRows = [];
        // If not found, try searching database for known actors
        apDb.each(
            `SELECT actor_cache.actor_json
            FROM actor_cache INNER JOIN actor_cache_search ON actor_cache.actor_id = actor_cache_search.actor_id
            WHERE actor_cache_search.search_name like '%'||?||'%'
            LIMIT ${MaxSearchResults}`,
            (err, row) => {
                if (err) {
                    Log.warn({ err: err }, 'error retrieving search results');
                    return cb(err, []);
                }
                this._fromJsonToActor(row.actor_json, (err, actor) => {
                    if (err) {
                        Log.warn({ err: err }, 'error converting search results');
                        return cb(err, []);
                    }
                    returnRows.push(actor);
                });
            }
        );
        return cb(null, returnRows);
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
        apDb.get(
            `SELECT actor_json, subject
            FROM actor_cache
            WHERE actor_id = ? OR subject = ?
            AND DATETIME(timestamp) > DATETIME("now", "-${ActorCacheMaxAgeDays} day")
            LIMIT 1;`,
            [actorIdOrSubject, actorIdOrSubject],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    return cb(Errors.DoesNotExist());
                }

                this._fromJsonToActor(row.actor_json, (err, actor) => {
                    if (err) {
                        return cb(err);
                    }
                    const subject = row.subject || actor.id;
                    return cb(null, actor, subject);
                });
            }
        );
    }

    static _fromJsonToActor(actorJson, cb) {
        const obj = ActivityPubObject.fromJsonString(actorJson);
        if (!obj || !obj.isValid()) {
            return cb(Errors.Invalid('Failed to create ActivityPub object'));
        }

        const actor = new Actor(obj);
        if (!actor.isValid()) {
            return cb(Errors.Invalid('Failed to create Actor object'));
        }

        return cb(null, actor);
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
