const { makeUserUrl, parseTimestampOrNow } = require('./util');
const ActivityPubObject = require('./object');
const apDb = require('../database').dbs.activitypub;
const { getISOTimestampString } = require('../database');
const { Errors } = require('../enig_error.js');
const {
    PublicCollectionId: APPublicCollectionId,
    ActivityStreamMediaType,
} = require('./const');
const UserProps = require('../user_property');
const { getJson } = require('../http_util');

// deps
const { isString } = require('lodash');

module.exports = class Collection extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    static get PublicCollectionId() {
        return APPublicCollectionId;
    }

    static getRemoteCollectionStats(collectionUrl, cb) {
        const headers = {
            Accept: ActivityStreamMediaType,
        };
        getJson(collectionUrl, { headers }, (err, collection) => {
            if (err) {
                return cb(err);
            }

            //  :TODO: validate headers?

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
        });
    }

    static followers(collectionId, page, cb) {
        return Collection.publicOrderedById(
            'followers',
            collectionId,
            page,
            e => e.id,
            cb
        );
    }

    static following(collectionId, page, cb) {
        return Collection.publicOrderedById(
            'following',
            collectionId,
            page,
            e => e.id,
            cb
        );
    }

    static addFollower(owningUser, followingActor, webServer, ignoreDupes, cb) {
        const collectionId =
            makeUserUrl(webServer, owningUser, '/ap/collections/') + '/followers';
        return Collection.addToCollection(
            'followers',
            owningUser,
            collectionId,
            followingActor.id,
            followingActor,
            false,
            ignoreDupes,
            cb
        );
    }

    static addFollowRequest(owningUser, requestingActor, webServer, ignoreDupes, cb) {
        const collectionId =
            makeUserUrl(webServer, owningUser, '/ap/collections/') + '/follow-requests';
        return Collection.addToCollection(
            'follow-requests',
            owningUser,
            collectionId,
            requestingActor.id,
            requestingActor,
            true,
            ignoreDupes,
            cb
        );
    }

    static outbox(collectionId, page, cb) {
        return Collection.publicOrderedById('outbox', collectionId, page, null, cb);
    }

    static addOutboxItem(owningUser, outboxItem, isPrivate, webServer, ignoreDupes, cb) {
        const collectionId =
            makeUserUrl(webServer, owningUser, '/ap/collections/') + '/outbox';
        return Collection.addToCollection(
            'outbox',
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
        const collectionId =
            makeUserUrl(webServer, owningUser, '/ap/collections/') + '/inbox';
        return Collection.addToCollection(
            'inbox',
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
            'sharedInbox',
            null, // N/A
            Collection.PublicCollectionId,
            inboxItem.id,
            inboxItem,
            false,
            ignoreDupes,
            cb
        );
    }

    static objectById(objectId, cb) {
        apDb.get(
            `SELECT name, timestamp, owner_actor_id, object_json, is_private
            FROM collection
            WHERE name = ? AND object_id = ?
            LIMIT 1;`,
            [objectId],
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

        // e.g. http://somewhere.com/_enig/ap/collections/NuSkooler/followers
        const collectionId =
            makeUserUrl(webServer, owningUser, '/ap/collections/') + `/${collectionName}`;

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
            actorId = Collection.APPublicCollectionId;
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

    static removeById(collectionName, owningUser, objectId, cb) {
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

    static _rowToObjectInfo(row) {
        return {
            name: row.name,
            timestamp: parseTimestampOrNow(row.timestamp),
            ownerActorId: row.owner_actor_id,
            isPrivate: row.is_private,
        };
    }
};
