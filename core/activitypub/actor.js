/* jslint node: true */
'use strict';

//  ENiGMA½
const { Errors } = require('../enig_error.js');
const UserProps = require('../user_property');
const {
    webFingerProfileUrl,
    makeUserUrl,
    selfUrl,
    isValidLink,
} = require('../activitypub/util');
const { ActivityStreamsContext } = require('./const');
const Log = require('../logger').log;
const { queryWebFinger } = require('../webfinger');
const EnigAssert = require('../enigma_assert');
const ActivityPubSettings = require('./settings');
const ActivityPubObject = require('./object');

//  deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const { getJson } = require('../http_util.js');

// https://www.w3.org/TR/activitypub/#actor-objects
module.exports = class Actor extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    isValid() {
        if (!super.isValid()) {
            return false;
        }

        if (
            !['Person', 'Group', 'Organization', 'Service', 'Application'].includes(
                this.type
            )
        ) {
            return false;
        }

        const linksValid = ['inbox', 'outbox', 'following', 'followers'].every(l => {
            // must be valid if set
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

    //  :TODO: from a User object
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
            name: user.getSanitizedName('real'),
            endpoints: {
                sharedInbox: 'TODO',
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

        addImage('icon');
        addImage('image');

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

    static fromRemoteUrl(url, cb) {
        //  :TODO: cache first
        const headers = {
            Accept: 'application/activity+json',
        };

        getJson(url, { headers }, (err, actor) => {
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

    static fromAccountName(actorName, options, cb) {
        //  :TODO: cache first -- do we have an Actor for this account already with a OK TTL?

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
            return Actor.fromRemoteUrl(activityLink.href, cb);
        });
    }

    static fromJsonString(json) {
        const parsed = JSON.parse(json);
        return new Actor(parsed);
    }

    //  :TODO: persist()?
    // create(cb) {
    //     assert(0 === this.actorId);

    //     if (_.isEmpty(this.actorUrl)) {
    //         return cb(Errors.Invalid('Blank actor url'));
    //     }

    //     const self = this;

    //     async.waterfall(
    //         [
    //             function beginTransaction(callback) {
    //                 return actorDb.beginTransaction(callback);
    //             },
    //             function createActorRec(trans, callback) {
    //                 trans.run(
    //                     `INSERT INTO actor (actor_url)
    //                     VALUES (?);`,
    //                     [self.actorUrl],
    //                     function inserted(err) {
    //                         //  use classic function for |this|
    //                         if (err) {
    //                             return callback(err);
    //                         }

    //                         self.actorId = this.lastID;

    //                         return callback(null, trans);
    //                     }
    //                 );
    //             },
    //             function saveAll(trans, callback) {
    //                 self.persistWithTransaction(trans, err => {
    //                     return callback(err, trans);
    //                 });
    //             },
    //             function sendEvent(trans, callback) {
    //                 Events.emit(Events.getSystemEvents().NewActor, {
    //                     actor: Object.assign({}, self, {}),
    //                 });
    //                 return callback(null, trans);
    //             },
    //         ],
    //         (err, trans) => {
    //             if (trans) {
    //                 trans[err ? 'rollback' : 'commit'](transErr => {
    //                     return cb(err ? err : transErr);
    //                 });
    //             } else {
    //                 return cb(err);
    //             }
    //         }
    //     );
    // }

    // persistWithTransaction(trans, cb) {
    //     assert(this.actorId > 0);

    //     const self = this;

    //     async.series(
    //         [
    //             function saveProps(callback) {
    //                 self.persistProperties(self.properties, trans, err => {
    //                     return callback(err);
    //                 });
    //             },
    //         ],
    //         err => {
    //             return cb(err);
    //         }
    //     );
    // }

    // static persistPropertyByActorId(actorId, propName, propValue, cb) {
    //     actorDb.run(
    //         `REPLACE INTO activitypub_actor_property (actor_id, prop_name, prop_value)
    //         VALUES (?, ?, ?);`,
    //         [actorId, propName, propValue],
    //         err => {
    //             if (cb) {
    //                 return cb(err, propValue);
    //             }
    //         }
    //     );
    // }

    // setProperty(propName, propValue) {
    //     this.properties[propName] = propValue;
    // }

    // incrementProperty(propName, incrementBy) {
    //     incrementBy = incrementBy || 1;
    //     let newValue = parseInt(this.getProperty(propName));
    //     if (newValue) {
    //         newValue += incrementBy;
    //     } else {
    //         newValue = incrementBy;
    //     }
    //     this.setProperty(propName, newValue);
    //     return newValue;
    // }

    // getProperty(propName) {
    //     return this.properties[propName];
    // }

    // getPropertyAsNumber(propName) {
    //     return parseInt(this.getProperty(propName), 10);
    // }

    // persistProperty(propName, propValue, cb) {
    //     //  update live props
    //     this.properties[propName] = propValue;

    //     return Actor.persistPropertyByActorId(this.actorId, propName, propValue, cb);
    // }

    // removeProperty(propName, cb) {
    //     //  update live
    //     delete this.properties[propName];

    //     actorDb.run(
    //         `DELETE FROM activitypub_actor_property
    //         WHERE activity_id = ? AND prop_name = ?;`,
    //         [this.actorId, propName],
    //         err => {
    //             if (cb) {
    //                 return cb(err);
    //             }
    //         }
    //     );
    // }

    // removeProperties(propNames, cb) {
    //     async.each(
    //         propNames,
    //         (name, next) => {
    //             return this.removeProperty(name, next);
    //         },
    //         err => {
    //             if (cb) {
    //                 return cb(err);
    //             }
    //         }
    //     );
    // }

    // persistProperties(properties, transOrDb, cb) {
    //     if (!_.isFunction(cb) && _.isFunction(transOrDb)) {
    //         cb = transOrDb;
    //         transOrDb = actorDb;
    //     }

    //     const self = this;

    //     //  update live props
    //     _.merge(this.properties, properties);

    //     const stmt = transOrDb.prepare(
    //         `REPLACE INTO activitypub_actor_property (actor_id, prop_name, prop_value)
    //         VALUES (?, ?, ?);`
    //     );

    //     async.each(
    //         Object.keys(properties),
    //         (propName, nextProp) => {
    //             stmt.run(self.actorId, propName, properties[propName], err => {
    //                 return nextProp(err);
    //             });
    //         },
    //         err => {
    //             if (err) {
    //                 return cb(err);
    //             }

    //             stmt.finalize(() => {
    //                 return cb(null);
    //             });
    //         }
    //     );
    // }

    // static getActor(actorId, cb) {
    //     async.waterfall(
    //         [
    //             function fetchActorId(callback) {
    //                 Actor.getActorUrl(actorId, (err, actorUrl) => {
    //                     return callback(null, actorUrl);
    //                 });
    //             },
    //             function initProps(actorUrl, callback) {
    //                 Actor.loadProperties(actorId, (err, properties) => {
    //                     return callback(err, actorUrl, properties);
    //                 });
    //             },
    //         ],
    //         (err, actorUrl, properties) => {
    //             const actor = new Actor();
    //             actor.actorId = actorId;
    //             actor.actorUrl = actorUrl;
    //             actor.properties = properties;

    //             return cb(err, actor);
    //         }
    //     );
    // }

    // // FIXME
    // static getActorInfo(actorId, propsList, cb) {
    //     if (!cb && _.isFunction(propsList)) {
    //         cb = propsList;
    //         propsList = [
    //             ActorProps.Type,
    //             ActorProps.PreferredUsername,
    //             ActorProps.Name,
    //             ActorProps.Summary,
    //             ActorProps.IconUrl,
    //             ActorProps.BannerUrl,
    //             ActorProps.PublicActivityPubSigningKey,
    //         ];
    //     }

    //     async.waterfall(
    //         [
    //             callback => {
    //                 return Actor.getActorUrl(actorId, callback);
    //             },
    //             (actorUrl, callback) => {
    //                 Actor.loadProperties(actorId, { names: propsList }, (err, props) => {
    //                     return callback(
    //                         err,
    //                         Object.assign({}, props, { actor_url: actorUrl })
    //                     );
    //                 });
    //             },
    //         ],
    //         (err, actorProps) => {
    //             if (err) {
    //                 return cb(err);
    //             }

    //             const actorInfo = {};
    //             Object.keys(actorProps).forEach(key => {
    //                 actorInfo[_.camelCase(key)] = actorProps[key] || 'N/A';
    //             });

    //             return cb(null, actorInfo);
    //         }
    //     );
    // }

    // static getActorIdAndUrl(actorUrl, cb) {
    //     actorDb.get(
    //         `SELECT id, actor_url
    //         FROM activitypub_actor
    //         WHERE actor_url LIKE ?;`,
    //         [actorUrl],
    //         (err, row) => {
    //             if (err) {
    //                 return cb(err);
    //             }

    //             if (row) {
    //                 return cb(null, row.id, row.actor_url);
    //             }

    //             return cb(Errors.DoesNotExist('No matching actorUrl'));
    //         }
    //     );
    // }

    // static getActorUrl(actorId, cb) {
    //     actorDb.get(
    //         `SELECT actor_url
    //         FROM activitypub_actor
    //         WHERE id = ?;`,
    //         [actorId],
    //         (err, row) => {
    //             if (err) {
    //                 return cb(err);
    //             }

    //             if (row) {
    //                 return cb(null, row.actor_url);
    //             }

    //             return cb(Errors.DoesNotExist('No matching actor ID'));
    //         }
    //     );
    // }

    // static loadProperties(actorId, options, cb) {
    //     if (!cb && _.isFunction(options)) {
    //         cb = options;
    //         options = {};
    //     }

    //     let sql = `SELECT prop_name, prop_value
    //         FROM activitypub_actor_property
    //         WHERE actor_id = ?`;

    //     if (options.names) {
    //         sql += ` AND prop_name IN("${options.names.join('","')}");`;
    //     } else {
    //         sql += ';';
    //     }

    //     let properties = {};
    //     actorDb.each(
    //         sql,
    //         [actorId],
    //         (err, row) => {
    //             if (err) {
    //                 return cb(err);
    //             }
    //             properties[row.prop_name] = row.prop_value;
    //         },
    //         err => {
    //             return cb(err, err ? null : properties);
    //         }
    //     );
    // }

    // //  :TODO: make this much more flexible - propValue should allow for case-insensitive compare, etc.
    // static getActorIdsWithProperty(propName, propValue, cb) {
    //     let actorIds = [];

    //     actorDb.each(
    //         `SELECT actor_id
    //         FROM activitypub_actor_property
    //         WHERE prop_name = ? AND prop_value = ?;`,
    //         [propName, propValue],
    //         (err, row) => {
    //             if (row) {
    //                 actorIds.push(row.actor_id);
    //             }
    //         },
    //         () => {
    //             return cb(null, actorIds);
    //         }
    //     );
    // }

    // static getActorCount(cb) {
    //     actorDb.get(
    //         `SELECT count() AS actor_count
    //         FROM activitypub_actor;`,
    //         (err, row) => {
    //             if (err) {
    //                 return cb(err);
    //             }
    //             return cb(null, row.actor_count);
    //         }
    //     );
    // }
};
