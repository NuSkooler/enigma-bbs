/* jslint node: true */
'use strict';

//  ENiGMA½
const actorDb = require('./database.js').dbs.actor;
const { Errors } = require('./enig_error.js');
const Events = require('./events.js');
const { ActorProps } = require('./activitypub_actor_property');
const { isValidLink } = require('./activitypub_util');

//  deps
const assert = require('assert');
const async = require('async');
const _ = require('lodash');
const https = require('https');

const isString = require('lodash/isString');

// https://www.w3.org/TR/activitypub/#actor-objects
module.exports = class Actor {
    constructor(obj) {
        if (obj) {
            Object.assign(this, obj);
        } else {
            this['@context'] = ['https://www.w3.org/ns/activitystreams'];
            this.id = '';
            this.type = '';
            this.inbox = '';
            this.outbox = '';
            this.following = '';
            this.followers = '';
            this.liked = '';
        }

        this.actorId = 0;
        this.actorUrl = '';
        this.properties = {}; //  name:value
        this.groups = []; //  group membership(s)
    }

    isValid() {
        if (
            !Array.isArray(this['@context']) ||
            this['@context'][0] !== 'https://www.w3.org/ns/activitystreams'
        ) {
            return false;
        }

        if (!isString(this.type) || this.type.length < 1) {
            return false;
        }

        const linksValid = ['inbox', 'outbox', 'following', 'followers'].every(p => {
            return isValidLink(this[p]);
        });
        if (!linksValid) {
            return false;
        }

        return true;
    }

    static getRemoteActor(url, cb) {
        const headers = {
            Accept: 'application/activity+json',
        };

        https.get(url, { headers }, res => {
            if (res.statusCode !== 200) {
                return cb(Errors.Invalid(`Bad HTTP status code: ${req.statusCode}`));
            }

            const contentType = res.headers['content-type'];
            if (
                !_.isString(contentType) ||
                !contentType.startsWith('application/activity+json')
            ) {
                return cb(Errors.Invalid(`Invalid Content-Type: ${contentType}`));
            }

            res.setEncoding('utf8');
            let body = '';
            res.on('data', data => {
                body += data;
            });

            res.on('end', () => {
                let actor;
                try {
                    actor = Actor.fromJson(body);
                } catch (e) {
                    return cb(e);
                }

                if (!actor.isValid()) {
                    return cb(Errors.Invalid('Invalid Actor'));
                }

                return cb(null, actor);
            });
        });
    }

    static fromJson(json) {
        const parsed = JSON.parse(json);
        return new Actor(parsed);
    }

    create(cb) {
        assert(0 === this.actorId);

        if (_.isEmpty(this.actorUrl)) {
            return cb(Errors.Invalid('Blank actor url'));
        }

        const self = this;

        async.waterfall(
            [
                function beginTransaction(callback) {
                    return actorDb.beginTransaction(callback);
                },
                function createActorRec(trans, callback) {
                    trans.run(
                        `INSERT INTO actor (actor_url)
                        VALUES (?);`,
                        [self.actorUrl],
                        function inserted(err) {
                            //  use classic function for |this|
                            if (err) {
                                return callback(err);
                            }

                            self.actorId = this.lastID;

                            return callback(null, trans);
                        }
                    );
                },
                function saveAll(trans, callback) {
                    self.persistWithTransaction(trans, err => {
                        return callback(err, trans);
                    });
                },
                function sendEvent(trans, callback) {
                    Events.emit(Events.getSystemEvents().NewActor, {
                        actor: Object.assign({}, self, {}),
                    });
                    return callback(null, trans);
                },
            ],
            (err, trans) => {
                if (trans) {
                    trans[err ? 'rollback' : 'commit'](transErr => {
                        return cb(err ? err : transErr);
                    });
                } else {
                    return cb(err);
                }
            }
        );
    }

    persistWithTransaction(trans, cb) {
        assert(this.actorId > 0);

        const self = this;

        async.series(
            [
                function saveProps(callback) {
                    self.persistProperties(self.properties, trans, err => {
                        return callback(err);
                    });
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    static persistPropertyByActorId(actorId, propName, propValue, cb) {
        actorDb.run(
            `REPLACE INTO activitypub_actor_property (actor_id, prop_name, prop_value)
            VALUES (?, ?, ?);`,
            [actorId, propName, propValue],
            err => {
                if (cb) {
                    return cb(err, propValue);
                }
            }
        );
    }

    setProperty(propName, propValue) {
        this.properties[propName] = propValue;
    }

    incrementProperty(propName, incrementBy) {
        incrementBy = incrementBy || 1;
        let newValue = parseInt(this.getProperty(propName));
        if (newValue) {
            newValue += incrementBy;
        } else {
            newValue = incrementBy;
        }
        this.setProperty(propName, newValue);
        return newValue;
    }

    getProperty(propName) {
        return this.properties[propName];
    }

    getPropertyAsNumber(propName) {
        return parseInt(this.getProperty(propName), 10);
    }

    persistProperty(propName, propValue, cb) {
        //  update live props
        this.properties[propName] = propValue;

        return Actor.persistPropertyByActorId(this.actorId, propName, propValue, cb);
    }

    removeProperty(propName, cb) {
        //  update live
        delete this.properties[propName];

        actorDb.run(
            `DELETE FROM activitypub_actor_property
            WHERE activity_id = ? AND prop_name = ?;`,
            [this.actorId, propName],
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    removeProperties(propNames, cb) {
        async.each(
            propNames,
            (name, next) => {
                return this.removeProperty(name, next);
            },
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    persistProperties(properties, transOrDb, cb) {
        if (!_.isFunction(cb) && _.isFunction(transOrDb)) {
            cb = transOrDb;
            transOrDb = actorDb;
        }

        const self = this;

        //  update live props
        _.merge(this.properties, properties);

        const stmt = transOrDb.prepare(
            `REPLACE INTO activitypub_actor_property (actor_id, prop_name, prop_value)
            VALUES (?, ?, ?);`
        );

        async.each(
            Object.keys(properties),
            (propName, nextProp) => {
                stmt.run(self.actorId, propName, properties[propName], err => {
                    return nextProp(err);
                });
            },
            err => {
                if (err) {
                    return cb(err);
                }

                stmt.finalize(() => {
                    return cb(null);
                });
            }
        );
    }

    static getActor(actorId, cb) {
        async.waterfall(
            [
                function fetchActorId(callback) {
                    Actor.getActorUrl(actorId, (err, actorUrl) => {
                        return callback(null, actorUrl);
                    });
                },
                function initProps(actorUrl, callback) {
                    Actor.loadProperties(actorId, (err, properties) => {
                        return callback(err, actorUrl, properties);
                    });
                },
            ],
            (err, actorUrl, properties) => {
                const actor = new Actor();
                actor.actorId = actorId;
                actor.actorUrl = actorUrl;
                actor.properties = properties;

                return cb(err, actor);
            }
        );
    }

    // FIXME
    static getActorInfo(actorId, propsList, cb) {
        if (!cb && _.isFunction(propsList)) {
            cb = propsList;
            propsList = [
                ActorProps.Type,
                ActorProps.PreferredUsername,
                ActorProps.Name,
                ActorProps.Summary,
                ActorProps.IconUrl,
                ActorProps.BannerUrl,
                ActorProps.PublicKeyMain,
            ];
        }

        async.waterfall(
            [
                callback => {
                    return Actor.getActorUrl(actorId, callback);
                },
                (actorUrl, callback) => {
                    Actor.loadProperties(actorId, { names: propsList }, (err, props) => {
                        return callback(
                            err,
                            Object.assign({}, props, { actor_url: actorUrl })
                        );
                    });
                },
            ],
            (err, actorProps) => {
                if (err) {
                    return cb(err);
                }

                const actorInfo = {};
                Object.keys(actorProps).forEach(key => {
                    actorInfo[_.camelCase(key)] = actorProps[key] || 'N/A';
                });

                return cb(null, actorInfo);
            }
        );
    }

    static getActorIdAndUrl(actorUrl, cb) {
        actorDb.get(
            `SELECT id, actor_url
            FROM activitypub_actor
            WHERE actor_url LIKE ?;`,
            [actorUrl],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (row) {
                    return cb(null, row.id, row.actor_url);
                }

                return cb(Errors.DoesNotExist('No matching actorUrl'));
            }
        );
    }

    static getActorUrl(actorId, cb) {
        actorDb.get(
            `SELECT actor_url
            FROM activitypub_actor
            WHERE id = ?;`,
            [actorId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (row) {
                    return cb(null, row.actor_url);
                }

                return cb(Errors.DoesNotExist('No matching actor ID'));
            }
        );
    }

    static loadProperties(actorId, options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        let sql = `SELECT prop_name, prop_value
            FROM activitypub_actor_property
            WHERE actor_id = ?`;

        if (options.names) {
            sql += ` AND prop_name IN("${options.names.join('","')}");`;
        } else {
            sql += ';';
        }

        let properties = {};
        actorDb.each(
            sql,
            [actorId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }
                properties[row.prop_name] = row.prop_value;
            },
            err => {
                return cb(err, err ? null : properties);
            }
        );
    }

    //  :TODO: make this much more flexible - propValue should allow for case-insensitive compare, etc.
    static getActorIdsWithProperty(propName, propValue, cb) {
        let actorIds = [];

        actorDb.each(
            `SELECT actor_id
            FROM activitypub_actor_property
            WHERE prop_name = ? AND prop_value = ?;`,
            [propName, propValue],
            (err, row) => {
                if (row) {
                    actorIds.push(row.actor_id);
                }
            },
            () => {
                return cb(null, actorIds);
            }
        );
    }

    static getActorCount(cb) {
        actorDb.get(
            `SELECT count() AS actor_count
            FROM activitypub_actor;`,
            (err, row) => {
                if (err) {
                    return cb(err);
                }
                return cb(null, row.actor_count);
            }
        );
    }
};
