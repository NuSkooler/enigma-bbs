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
const Log = require('../logger').log;

//  Default page size for AP collections (e.g. outbox, followers, following).
//  Callers that need all items at once (scanner/tosser) pass page='all'.
const CollectionPageSize = 20;

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

    static followRequests(owningUser, page, cb) {
        return Collection.ownedOrderedByUser(
            Collections.FollowRequests,
            owningUser,
            true, // private
            page,
            null, // return full Follow Request Activity
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

    static addFollower(owningUser, followingActor, ignoreDupes, cb) {
        const collectionId = Endpoints.followers(owningUser);
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

    static addFollowRequest(owningUser, requestActivity, cb) {
        const collectionId = Endpoints.makeUserUrl(owningUser) + '/follow-requests';
        return Collection.addToCollection(
            Collections.FollowRequests,
            owningUser,
            collectionId,
            requestActivity.id,
            requestActivity,
            true, // private
            true, // ignoreDupes
            cb
        );
    }

    static addFollowing(owningUser, followingActor, ignoreDupes, cb) {
        const collectionId = Endpoints.following(owningUser);
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

    static addOutboxItem(owningUser, outboxItem, isPrivate, ignoreDupes, cb) {
        const collectionId = Endpoints.outbox(owningUser);
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

    static addInboxItem(inboxItem, owningUser, ignoreDupes, cb) {
        const collectionId = Endpoints.inbox(owningUser);
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

        try {
            const row = apDb
                .prepare(
                    `SELECT c.name, c.timestamp, c.owner_actor_id, c.is_private, c.object_json, m.meta_value
                    FROM collection c, collection_object_meta m
                    WHERE c.collection_id = ? AND c.name = ? AND m.object_id = c.object_id AND (c.object_id LIKE ? OR (m.meta_name = ? AND m.meta_value LIKE ?))
                    LIMIT 1;`
                )
                .get(
                    ActorCollectionId,
                    Collections.Actors,
                    actorIdOrSubject,
                    'actor_subject',
                    actorIdOrSubject
                );

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
        } catch (err) {
            return cb(err);
        }
    }

    static addActor(actor, subject, cb) {
        try {
            apDb.transaction(() => {
                apDb.prepare(
                    `REPLACE INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                        VALUES(?, ?, ?, ?, ?, ?, ?);`
                ).run(
                    ActorCollectionId,
                    Collections.Actors,
                    getISOTimestampString(),
                    PublicCollectionId,
                    actor.id,
                    JSON.stringify(actor),
                    false
                );

                apDb.prepare(
                    `REPLACE INTO collection_object_meta (collection_id, name, object_id, meta_name, meta_value)
                        VALUES(?, ?, ?, ?, ?);`
                ).run(
                    ActorCollectionId,
                    Collections.Actors,
                    actor.id,
                    'actor_subject',
                    subject
                );
            })();

            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static removeExpiredActors(maxAgeDays, cb) {
        try {
            apDb.prepare(
                `DELETE FROM collection
                    WHERE collection_id = ? AND name = ? AND DATETIME(timestamp, '+${maxAgeDays} days') < DATETIME('now');`
            ).run(ActorCollectionId, Collections.Actors);

            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    //  Get Object(s) by ID; There may be multiples as they may be
    //  e.g. Actors belonging to multiple followers collections.
    //  This method also returns information about the objects
    //  and any items that can't be parsed
    static objectsById(objectId, cb) {
        try {
            const rows = apDb
                .prepare(
                    `SELECT name, timestamp, owner_actor_id, object_json, is_private
                    FROM collection
                    WHERE object_id = ?;`
                )
                .all(objectId);

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
        } catch (err) {
            return cb(err);
        }
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

        try {
            const row = apDb
                .prepare(
                    `SELECT name, timestamp, owner_actor_id, object_json, is_private
                    FROM collection
                    WHERE name = ? AND owner_actor_id = ? AND object_id = ?
                    LIMIT 1;`
                )
                .get(collectionName, actorId, objectId);

            if (!row) {
                return cb(null, null);
            }

            const obj = ActivityPubObject.fromJsonString(row.object_json);
            if (!obj) {
                return cb(Errors.Invalid('Failed to parse Object JSON'));
            }

            return cb(null, obj, Collection._rowToObjectInfo(row));
        } catch (err) {
            return cb(err);
        }
    }

    static objectByNameAndId(collectionName, objectId, cb) {
        try {
            const row = apDb
                .prepare(
                    `SELECT name, timestamp, owner_actor_id, object_json, is_private
                    FROM collection
                    WHERE name = ? AND object_id = ?
                    LIMIT 1;`
                )
                .get(collectionName, objectId);

            if (!row) {
                return cb(null, null);
            }

            const obj = ActivityPubObject.fromJsonString(row.object_json);
            if (!obj) {
                return cb(Errors.Invalid('Failed to parse Object JSON'));
            }

            return cb(null, obj, Collection._rowToObjectInfo(row));
        } catch (err) {
            return cb(err);
        }
    }

    static objectByEmbeddedId(objectId, cb) {
        try {
            const row = apDb
                .prepare(
                    `SELECT name, timestamp, owner_actor_id, object_json, is_private
                    FROM collection
                    WHERE json_extract(object_json, '$.object.id') = ?
                    LIMIT 1;`
                )
                .get(objectId);

            if (!row) {
                // no match
                return cb(null, null);
            }

            const obj = ActivityPubObject.fromJsonString(row.object_json);
            if (!obj) {
                return cb(Errors.Invalid('Failed to parse Object JSON'));
            }

            return cb(null, obj, Collection._rowToObjectInfo(row));
        } catch (err) {
            return cb(err);
        }
    }

    static publicOrderedById(collectionName, collectionId, page, mapper, cb) {
        if (!page) {
            try {
                const row = apDb
                    .prepare(
                        `SELECT COUNT(collection_id) AS count
                        FROM collection
                        WHERE name = ? AND collection_id = ? AND is_private = FALSE;`
                    )
                    .get(collectionName, collectionId);

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
            } catch (err) {
                return cb(err);
            }
        }

        try {
            //  'all' is an internal-only sentinel used by the scanner/tosser to
            //  collect every follower endpoint in one pass; it skips pagination.
            if ('all' === page) {
                let entries = apDb
                    .prepare(
                        `SELECT object_json
                        FROM collection
                        WHERE name = ? AND collection_id = ? AND is_private = FALSE
                        ORDER BY timestamp;`
                    )
                    .all(collectionName, collectionId);

                try {
                    entries = (entries || []).map(e => JSON.parse(e.object_json));
                } catch (e) {
                    Log.error(`Collection "${collectionId}" error: ${e.message}`);
                }

                if (mapper && entries.length > 0) {
                    entries = entries.map(mapper);
                }

                return cb(
                    null,
                    new Collection({
                        id: collectionId,
                        type: 'OrderedCollection',
                        totalItems: entries.length,
                        orderedItems: entries,
                    })
                );
            }

            //  Numeric page: proper AP paging with next/prev links
            const pageNum = Math.max(1, parseInt(page, 10) || 1);
            const offset = (pageNum - 1) * CollectionPageSize;

            const countRow = apDb
                .prepare(
                    `SELECT COUNT(collection_id) AS count
                    FROM collection
                    WHERE name = ? AND collection_id = ? AND is_private = FALSE;`
                )
                .get(collectionName, collectionId);

            let rows = apDb
                .prepare(
                    `SELECT object_json
                    FROM collection
                    WHERE name = ? AND collection_id = ? AND is_private = FALSE
                    ORDER BY timestamp
                    LIMIT ? OFFSET ?;`
                )
                .all(collectionName, collectionId, CollectionPageSize + 1, offset);

            const hasNext = rows.length > CollectionPageSize;
            if (hasNext) {
                rows = rows.slice(0, CollectionPageSize);
            }

            let entries;
            try {
                entries = rows.map(e => JSON.parse(e.object_json));
            } catch (e) {
                Log.error(
                    `Collection "${collectionId}" page ${pageNum} parse error: ${e.message}`
                );
                entries = [];
            }

            if (mapper && entries.length > 0) {
                entries = entries.map(mapper);
            }

            const obj = {
                id: `${collectionId}?page=${pageNum}`,
                type: 'OrderedCollectionPage',
                totalItems: countRow.count,
                orderedItems: entries,
                partOf: collectionId,
            };
            if (pageNum > 1) {
                obj.prev = `${collectionId}?page=${pageNum - 1}`;
            }
            if (hasNext) {
                obj.next = `${collectionId}?page=${pageNum + 1}`;
            }

            return cb(null, new Collection(obj));
        } catch (err) {
            return cb(err);
        }
    }

    static ownedOrderedByUser(
        collectionName,
        owningUser,
        includePrivate,
        page,
        mapper,
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
        const collectionId = Endpoints.makeUserUrl(owningUser) + `/${collectionName}`;

        if (!page) {
            try {
                const row = apDb
                    .prepare(
                        `SELECT COUNT(collection_id) AS count
                        FROM collection
                        WHERE owner_actor_id = ? AND name = ?${privateQuery};`
                    )
                    .get(actorId, collectionName);

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
            } catch (err) {
                return cb(err);
            }
        }

        try {
            //  'all' sentinel: used internally, no pagination
            if ('all' === page) {
                let entries = apDb
                    .prepare(
                        `SELECT object_json
                        FROM collection
                        WHERE owner_actor_id = ? AND name = ?${privateQuery}
                        ORDER BY timestamp;`
                    )
                    .all(actorId, collectionName);

                try {
                    entries = (entries || []).map(e => JSON.parse(e.object_json));
                } catch (e) {
                    Log.error(`Collection "${collectionId}" error: ${e.message}`);
                }

                if (mapper && entries.length > 0) {
                    entries = entries.map(mapper);
                }

                return cb(
                    null,
                    new Collection({
                        id: collectionId,
                        type: 'OrderedCollection',
                        totalItems: entries.length,
                        orderedItems: entries,
                    })
                );
            }

            //  Numeric page: proper AP paging with next/prev links
            const pageNum = Math.max(1, parseInt(page, 10) || 1);
            const offset = (pageNum - 1) * CollectionPageSize;

            const countRow = apDb
                .prepare(
                    `SELECT COUNT(collection_id) AS count
                    FROM collection
                    WHERE owner_actor_id = ? AND name = ?${privateQuery};`
                )
                .get(actorId, collectionName);

            let rows = apDb
                .prepare(
                    `SELECT object_json
                    FROM collection
                    WHERE owner_actor_id = ? AND name = ?${privateQuery}
                    ORDER BY timestamp
                    LIMIT ? OFFSET ?;`
                )
                .all(actorId, collectionName, CollectionPageSize + 1, offset);

            const hasNext = rows.length > CollectionPageSize;
            if (hasNext) {
                rows = rows.slice(0, CollectionPageSize);
            }

            let entries;
            try {
                entries = rows.map(e => JSON.parse(e.object_json));
            } catch (e) {
                Log.error(
                    `Collection "${collectionId}" page ${pageNum} parse error: ${e.message}`
                );
                entries = [];
            }

            if (mapper && entries.length > 0) {
                entries = entries.map(mapper);
            }

            const obj = {
                id: `${collectionId}?page=${pageNum}`,
                type: 'OrderedCollectionPage',
                totalItems: countRow.count,
                orderedItems: entries,
                partOf: collectionId,
            };
            if (pageNum > 1) {
                obj.prev = `${collectionId}?page=${pageNum - 1}`;
            }
            if (hasNext) {
                obj.next = `${collectionId}?page=${pageNum + 1}`;
            }

            return cb(null, new Collection(obj));
        } catch (err) {
            return cb(err);
        }
    }

    // https://www.w3.org/TR/activitypub/#update-activity-inbox
    static updateCollectionEntry(collectionName, objectId, obj, cb) {
        if (!isString(obj)) {
            obj = JSON.stringify(obj);
        }

        try {
            apDb.prepare(
                `UPDATE collection
                    SET object_json = ?, timestamp = ?
                    WHERE name = ? AND object_id = ?;`
            ).run(obj, getISOTimestampString(), collectionName, objectId);

            return cb(null);
        } catch (err) {
            return cb(err);
        }
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

        try {
            const info = apDb
                .prepare(
                    `INSERT OR IGNORE INTO collection (name, timestamp, collection_id, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, ?, ?, ?, ?, ?);`
                )
                .run(
                    collectionName,
                    getISOTimestampString(),
                    collectionId,
                    actorId,
                    objectId,
                    obj,
                    isPrivate
                );

            return cb(null, info.lastInsertRowid);
        } catch (err) {
            return cb(err);
        }
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

        try {
            apDb.prepare(
                `DELETE FROM collection
                    WHERE name = ? AND owner_actor_id = ? AND object_id = ?;`
            ).run(collectionName, actorId, objectId);

            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static removeById(collectionName, objectId, cb) {
        try {
            apDb.prepare(
                `DELETE FROM collection
                    WHERE name = ? AND object_id = ?;`
            ).run(collectionName, objectId);

            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static removeByMaxCount(collectionName, maxCount, cb) {
        try {
            const info = apDb
                .prepare(
                    `DELETE FROM collection
                    WHERE _rowid_ IN (
                        SELECT _rowid_
                        FROM collection
                        WHERE name = ?
                        ORDER BY _rowid_ DESC
                        LIMIT -1 OFFSET ${maxCount}
                    );`
                )
                .run(collectionName);

            Collection._removeByLogHelper(
                collectionName,
                'MaxCount',
                null,
                maxCount,
                info.changes
            );
            return cb(null);
        } catch (err) {
            Collection._removeByLogHelper(collectionName, 'MaxCount', err, maxCount, 0);
            return cb(err);
        }
    }

    static removeByMaxAgeDays(collectionName, maxAgeDays, cb) {
        try {
            const info = apDb
                .prepare(
                    `DELETE FROM collection
                    WHERE name = ? AND timestamp < DATE('now', '-${maxAgeDays} days');`
                )
                .run(collectionName);

            Collection._removeByLogHelper(
                collectionName,
                'MaxAgeDays',
                null,
                maxAgeDays,
                info.changes
            );
            return cb(null);
        } catch (err) {
            Collection._removeByLogHelper(
                collectionName,
                'MaxAgeDays',
                err,
                maxAgeDays,
                0
            );
            return cb(err);
        }
    }

    static _removeByLogHelper(collectionName, type, err, value, deletedCount) {
        if (err) {
            Log.error(
                { collectionName, error: err.message, type, value },
                'Error trimming collection'
            );
        } else {
            Log.debug(
                { collectionName, type, value, deletedCount },
                'Collection trimmed successfully'
            );
        }
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
