const { parseTimestampOrNow } = require('./util');
const Endpoints = require('./endpoint');
const ActivityPubObject = require('./object');
const apDb = require('../database').dbs.activitypub;
const { getISOTimestampString } = require('../database');
const { Errors } = require('../enig_error.js');
const {
    PublicCollectionId,
    ActivityStreamMediaType,
    Collections,
    ActorCollectionId,
} = require('./const');
const UserProps = require('../user_property');
const { getJson } = require('../http_util');

// deps
const { isString } = require('lodash');
const Log = require('../logger');
const async = require('async');

module.exports = class Collection extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    static getRemoteCollectionStats(collectionUrl, cb) {
        const headers = {
            Accept: ActivityStreamMediaType,
        };

        getJson(
            collectionUrl,
            { headers, validContentTypes: [ActivityStreamMediaType] },
            (err, collection) => {
                if (err) {
                    return cb(err);
                }

                collection = new Collection(collection);
                if (!collection.isValid()) {
                    return cb(Errors.Invalid('Invalid Collection'));
                }

                const { totalItems, type, id, summary } = collection;

                return cb(null, {
                    totalItems,
                    type,
                    id,
                    summary,
                });
            }
        );
    }

    static followers(collectionId, page, cb) {
        return Collection.publicOrderedById(
            Collections.Followers,
            collectionId,
            page,
            e => e.id,
            cb
        );
    }

    static following(collectionId, page, cb) {
        return Collection.publicOrderedById(
            Collections.Following,
            collectionId,
            page,
            e => e.id,
            cb
        );
    }

    static outbox(collectionId, page, cb) {
        return Collection.publicOrderedById(
            Collections.Outbox,
            collectionId,
            page,
            null,
            cb
        );
    }

    static addFollower(owningUser, followingActor, webServer, ignoreDupes, cb) {
        const collectionId = Endpoints.followers(webServer, owningUser);
        return Collection.addToCollection(
            Collections.Followers,
            owningUser,
            collectionId,
            followingActor.id, // Actor following owningUser
            followingActor,
            false, // we'll check dynamically when queried
            ignoreDupes,
            cb
        );
    }

    static addFollowRequest(owningUser, requestingActor, webServer, ignoreDupes, cb) {
        const collectionId =
            Endpoints.makeUserUrl(webServer, owningUser) + 'follow-requests';
        return Collection.addToCollection(
            Collections.FollowRequests,
            owningUser,
            collectionId,
            requestingActor.id, // Actor requesting to follow owningUser
            requestingActor,
            true,
            ignoreDupes,
            cb
        );
    }

    static addFollowing(owningUser, followingActor, webServer, ignoreDupes, cb) {
        const collectionId = Endpoints.following(webServer, owningUser);
        return Collection.addToCollection(
            Collections.Following,
            owningUser,
            collectionId,
            followingActor.id, // Actor owningUser is following
            followingActor,
            false, // we'll check dynamically when queried
            ignoreDupes,
            cb
        );
    }

    static addOutboxItem(owningUser, outboxItem, isPrivate, webServer, ignoreDupes, cb) {
        const collectionId = Endpoints.outbox(webServer, owningUser);
        return Collection.addToCollection(
            Collections.Outbox,
            owningUser,
            collectionId,
            outboxItem.id,
            outboxItem,
            isPrivate,
            ignoreDupes,
            cb
        );
    }

    static addInboxItem(inboxItem, owningUser, webServer, ignoreDupes, cb) {
        const collectionId = Endpoints.inbox(webServer, owningUser);
        return Collection.addToCollection(
            Collections.Inbox,
            owningUser,
            collectionId,
            inboxItem.id,
            inboxItem,
            true,
            ignoreDupes,
            cb
        );
    }

    static addSharedInboxItem(inboxItem, ignoreDupes, cb) {
        return Collection.addToCollection(
            Collections.SharedInbox,
            null, // N/A
            PublicCollectionId,
            inboxItem.id,
            inboxItem,
            false,
            ignoreDupes,
            cb
        );
    }

    //  Actors is a special collection
    static actor(actorIdOrSubject, cb) {
        // We always store subjects prefixed with '@'
        if (!/^https?:\/\//.test(actorIdOrSubject) && '@' !== actorIdOrSubject[0]) {
            actorIdOrSubject = `@${actorIdOrSubject}`;
        }

        apDb.get(
            `SELECT c.name, c.timestamp, c.owner_actor_id, c.is_private, c.object_json, m.meta_value
            FROM collection c, collection_object_meta m
            WHERE c.collection_id = ? AND c.name = ? AND m.object_id = c.object_id AND (c.object_id LIKE ? OR (m.meta_name = ? AND m.meta_value LIKE ?))
            LIMIT 1;`,
            [
                ActorCollectionId,
                Collections.Actors,
                actorIdOrSubject,
                'actor_subject',
                actorIdOrSubject,
            ],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    return cb(
                        Errors.DoesNotExist(`No Actor found for "${actorIdOrSubject}"`)
                    );
                }

                const obj = ActivityPubObject.fromJsonString(row.object_json);
                if (!obj) {
                    return cb(Errors.Invalid('Failed to parse Object JSON'));
                }

                const info = Collection._rowToObjectInfo(row);
                if (row.meta_value) {
                    info.subject = row.meta_value;
                } else {
                    info.subject = obj.id;
                }

                return cb(null, obj, info);
            }
        );
    }

    static addActor(actor, subject, cb) {
        async.waterfall(
            [
                callback => {
                    return apDb.beginTransaction(callback);
                },
                (trans, callback) => {
                    trans.run(
                        `REPLACE INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                        VALUES(?, ?, ?, ?, ?, ?, ?);`,
                        [
                            ActorCollectionId,
                            Collections.Actors,
                            getISOTimestampString(),
                            PublicCollectionId,
                            actor.id,
                            JSON.stringify(actor),
                            false,
                        ],
                        err => {
                            return callback(err, trans);
                        }
                    );
                },
                (trans, callback) => {
                    trans.run(
                        `REPLACE INTO collection_object_meta (collection_id, name, object_id, meta_name, meta_value)
                        VALUES(?, ?, ?, ?, ?);`,
                        [
                            ActorCollectionId,
                            Collections.Actors,
                            actor.id,
                            'actor_subject',
                            subject,
                        ],
                        err => {
                            return callback(err, trans);
                        }
                    );
                },
            ],
            (err, trans) => {
                if (err) {
                    trans.rollback(err => {
                        return cb(err);
                    });
                } else {
                    trans.commit(err => {
                        return cb(err);
                    });
                }
            }
        );
    }

    static removeExpiredActors(maxAgeDays, cb) {
        apDb.run(
            `DELETE FROM collection
            WHERE collection_id = ? AND name = ? AND DATETIME(timestamp, "+${maxAgeDays} days") > DATETIME("now");`,
            [ActorCollectionId, Collections.Actors],
            err => {
                return cb(err);
            }
        );
    }

    //  Get Object(s) by ID; There may be multiples as they may be
    //  e.g. Actors belonging to multiple followers collections.
    //  This method also returns information about the objects
    //  and any items that can't be parsed
    static objectsById(objectId, cb) {
        apDb.all(
            `SELECT name, timestamp, owner_actor_id, object_json, is_private
            FROM collection
            WHERE object_id = ?;`,
            [objectId],
            (err, rows) => {
                if (err) {
                    return cb(err);
                }

                const results = (rows || []).map(r => {
                    const info = {
                        info: this._rowToObjectInfo(r),
                        object: ActivityPubObject.fromJsonString(r.object_json),
                    };
                    if (!info.object) {
                        info.raw = r.object_json;
                    }
                    return info;
                });

                return cb(null, results);
            }
        );
    }

    static ownedObjectByNameAndId(collectionName, owningUser, objectId, cb) {
        const actorId = owningUser.getProperty(UserProps.ActivityPubActorId);
        if (!actorId) {
            return cb(
                Errors.MissingProperty(
                    `User "${owningUser.username}" is missing property '${UserProps.ActivityPubActorId}'`
                )
            );
        }

        apDb.get(
            `SELECT name, timestamp, owner_actor_id, object_json, is_private
            FROM collection
            WHERE name = ? AND owner_actor_id = ? AND object_id = ?
            LIMIT 1;`,
            [collectionName, actorId, objectId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    return cb(null, null);
                }

                const obj = ActivityPubObject.fromJsonString(row.object_json);
                if (!obj) {
                    return cb(Errors.Invalid('Failed to parse Object JSON'));
                }

                return cb(null, obj, Collection._rowToObjectInfo(row));
            }
        );
    }

    static objectByNameAndId(collectionName, objectId, cb) {
        apDb.get(
            `SELECT name, timestamp, owner_actor_id, object_json, is_private
            FROM collection
            WHERE name = ? AND object_id = ?
            LIMIT 1;`,
            [collectionName, objectId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    return cb(null, null);
                }

                const obj = ActivityPubObject.fromJsonString(row.object_json);
                if (!obj) {
                    return cb(Errors.Invalid('Failed to parse Object JSON'));
                }

                return cb(null, obj, Collection._rowToObjectInfo(row));
            }
        );
    }

    static objectByEmbeddedId(objectId, cb) {
        apDb.get(
            `SELECT name, timestamp, owner_actor_id, object_json, is_private
            FROM collection
            WHERE json_extract(object_json, '$.object.id') = ?
            LIMIT 1;`,
            [objectId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    // no match
                    return cb(null, null);
                }

                const obj = ActivityPubObject.fromJsonString(row.object_json);
                if (!obj) {
                    return cb(Errors.Invalid('Failed to parse Object JSON'));
                }

                return cb(null, obj, Collection._rowToObjectInfo(row));
            }
        );
    }

    static publicOrderedById(collectionName, collectionId, page, mapper, cb) {
        if (!page) {
            return apDb.get(
                `SELECT COUNT(collection_id) AS count
                FROM collection
                WHERE name = ? AND collection_id = ? AND is_private = FALSE;`,
                [collectionName, collectionId],
                (err, row) => {
                    if (err) {
                        return cb(err);
                    }

                    let obj;
                    if (row.count > 0) {
                        obj = {
                            id: collectionId,
                            type: 'OrderedCollection',
                            first: `${collectionId}?page=1`,
                            totalItems: row.count,
                        };
                    } else {
                        obj = {
                            id: collectionId,
                            type: 'OrderedCollection',
                            totalItems: 0,
                            orderedItems: [],
                        };
                    }

                    return cb(null, new Collection(obj));
                }
            );
        }

        //  :TODO: actual paging...
        apDb.all(
            `SELECT object_json
            FROM collection
            WHERE name = ? AND collection_id = ? AND is_private = FALSE
            ORDER BY timestamp;`,
            [collectionName, collectionId],
            (err, entries) => {
                if (err) {
                    return cb(err);
                }

                try {
                    entries = (entries || []).map(e => JSON.parse(e.object_json));
                } catch (e) {
                    Log.error(`Collection "${collectionId}" error: ${e.message}`);
                }

                if (mapper && entries.length > 0) {
                    entries = entries.map(mapper);
                }

                let obj;
                if ('all' === page) {
                    obj = {
                        id: collectionId,
                        type: 'OrderedCollection',
                        totalItems: entries.length,
                        orderedItems: entries,
                    };
                } else {
                    obj = {
                        id: `${collectionId}/page=${page}`,
                        type: 'OrderedCollectionPage',
                        totalItems: entries.length,
                        orderedItems: entries,
                        partOf: collectionId,
                    };
                }

                return cb(null, new Collection(obj));
            }
        );
    }

    static ownedOrderedByUser(
        collectionName,
        owningUser,
        includePrivate,
        page,
        mapper,
        webServer,
        cb
    ) {
        const privateQuery = includePrivate ? '' : ' AND is_private = FALSE';
        const actorId = owningUser.getProperty(UserProps.ActivityPubActorId);
        if (!actorId) {
            return cb(
                Errors.MissingProperty(
                    `User "${owningUser.username}" is missing property '${UserProps.ActivityPubActorId}'`
                )
            );
        }

        // e.g. http://somewhere.com/_enig/ap/users/NuSkooler/followers
        const collectionId =
            Endpoints.makeUserUrl(webServer, owningUser) + `/${collectionName}`;

        if (!page) {
            return apDb.get(
                `SELECT COUNT(collection_id) AS count
                FROM collection
                WHERE owner_actor_id = ? AND name = ?${privateQuery};`,
                [actorId, collectionName],
                (err, row) => {
                    if (err) {
                        return cb(err);
                    }

                    //
                    //  Mastodon for instance, will never follow up for the
                    //  actual data from some Collections such as 'followers';
                    //  Instead, they only use the |totalItems| to form an
                    //  approximate follower count.
                    //
                    let obj;
                    if (row.count > 0) {
                        obj = {
                            id: collectionId,
                            type: 'OrderedCollection',
                            first: `${collectionId}?page=1`,
                            totalItems: row.count,
                        };
                    } else {
                        obj = {
                            id: collectionId,
                            type: 'OrderedCollection',
                            totalItems: 0,
                            orderedItems: [],
                        };
                    }

                    return cb(null, new Collection(obj));
                }
            );
        }

        //  :TODO: actual paging...
        apDb.all(
            `SELECT object_json
            FROM collection
            WHERE owner_actor_id = ? AND name = ?${privateQuery}
            ORDER BY timestamp;`,
            [actorId, collectionName],
            (err, entries) => {
                if (err) {
                    return cb(err);
                }

                entries = entries || [];
                if (mapper && entries.length > 0) {
                    entries = entries.map(mapper);
                }

                const obj = {
                    id: `${collectionId}/page=${page}`,
                    type: 'OrderedCollectionPage',
                    totalItems: entries.length,
                    orderedItems: entries,
                    partOf: collectionId,
                };

                return cb(null, new Collection(obj));
            }
        );
    }

    // https://www.w3.org/TR/activitypub/#update-activity-inbox
    static updateCollectionEntry(collectionName, objectId, obj, cb) {
        if (!isString(obj)) {
            obj = JSON.stringify(obj);
        }

        apDb.run(
            `UPDATE collection
            SET object_json = ?, timestamp = ?
            WHERE name = ? AND object_id = ?;`,
            [obj, collectionName, getISOTimestampString(), objectId],
            err => {
                return cb(err);
            }
        );
    }

    static addToCollection(
        collectionName,
        owningUser,
        collectionId,
        objectId,
        obj,
        isPrivate,
        ignoreDupes,
        cb
    ) {
        if (!isString(obj)) {
            obj = JSON.stringify(obj);
        }

        let actorId;
        if (owningUser) {
            actorId = owningUser.getProperty(UserProps.ActivityPubActorId);
            if (!actorId) {
                return cb(
                    Errors.MissingProperty(
                        `User "${owningUser.username}" is missing property '${UserProps.ActivityPubActorId}'`
                    )
                );
            }
        } else {
            actorId = PublicCollectionId;
        }

        isPrivate = isPrivate ? 1 : 0;

        apDb.run(
            `INSERT OR IGNORE INTO collection (name, timestamp, collection_id, owner_actor_id, object_id, object_json, is_private)
            VALUES (?, ?, ?, ?, ?, ?, ?);`,
            [
                collectionName,
                getISOTimestampString(),
                collectionId,
                actorId,
                objectId,
                obj,
                isPrivate,
            ],
            function res(err) {
                // non-arrow for 'this' scope
                if (err && 'SQLITE_CONSTRAINT' === err.code) {
                    if (ignoreDupes) {
                        err = null; // ignore
                    }
                    return cb(err);
                }
                return cb(err, this.lastID);
            }
        );
    }

    static removeOwnedById(collectionName, owningUser, objectId, cb) {
        const actorId = owningUser.getProperty(UserProps.ActivityPubActorId);
        if (!actorId) {
            return cb(
                Errors.MissingProperty(
                    `User "${owningUser.username}" is missing property '${UserProps.ActivityPubActorId}'`
                )
            );
        }
        apDb.run(
            `DELETE FROM collection
            WHERE name = ? AND owner_actor_id = ? AND object_id = ?;`,
            [collectionName, actorId, objectId],
            err => {
                return cb(err);
            }
        );
    }

    static removeById(collectionName, objectId, cb) {
        apDb.run(
            `DELETE FROM collection
            WHERE name = ? AND object_id = ?;`,
            [collectionName, objectId],
            err => {
                return cb(err);
            }
        );
    }

    static _rowToObjectInfo(row) {
        return {
            name: row.name,
            timestamp: parseTimestampOrNow(row.timestamp),
            ownerActorId: row.owner_actor_id,
            isPrivate: row.is_private,
        };
    }
};
