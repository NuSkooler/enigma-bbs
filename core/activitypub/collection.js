const { makeUserUrl } = require('./util');
const ActivityPubObject = require('./object');
const apDb = require('../database').dbs.activitypub;
const { getISOTimestampString } = require('../database');
const { Errors } = require('../enig_error.js');

// deps
const { isString, get, isObject } = require('lodash');

const APPublicCollectionId = 'https://www.w3.org/ns/activitystreams#Public';
const APPublicOwningUserId = 0;

module.exports = class Collection extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    static get PublicCollectionId() {
        return APPublicCollectionId;
    }

    static followers(owningUser, page, webServer, cb) {
        return Collection.getOrdered(
            'followers',
            owningUser,
            false,
            page,
            e => e.id,
            webServer,
            cb
        );
    }

    static following(owningUser, page, webServer, cb) {
        return Collection.getOrdered(
            'following',
            owningUser,
            false,
            page,
            e => get(e, 'object.id'),
            webServer,
            cb
        );
    }

    static addFollower(owningUser, followingActor, cb) {
        return Collection.addToCollection(
            'followers',
            owningUser,
            followingActor.id,
            followingActor,
            false,
            cb
        );
    }

    static addFollowRequest(owningUser, requestingActor, cb) {
        return Collection.addToCollection(
            'follow_requests',
            owningUser,
            requestingActor.id,
            requestingActor,
            true,
            cb
        );
    }

    static outbox(owningUser, page, webServer, cb) {
        return Collection.getOrdered(
            'outbox',
            owningUser,
            false,
            page,
            null,
            webServer,
            cb
        );
    }

    static addOutboxItem(owningUser, outboxItem, isPrivate, cb) {
        return Collection.addToCollection(
            'outbox',
            owningUser,
            outboxItem.id,
            outboxItem,
            isPrivate,
            cb
        );
    }

    static addPublicInboxItem(inboxItem, cb) {
        return Collection.addToCollection(
            'publicInbox',
            APPublicOwningUserId,
            inboxItem.id,
            inboxItem,
            false,
            cb
        );
    }

    static embeddedObjById(collectionName, includePrivate, objectId, cb) {
        const privateQuery = includePrivate ? '' : ' AND is_private = FALSE';

        apDb.get(
            `SELECT obj_json
            FROM collection
            WHERE name = ?
            ${privateQuery}
            AND json_extract(obj_json, '$.object.id') = ?;`,
            [collectionName, objectId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (!row) {
                    return cb(
                        Errors.DoesNotExist(
                            `No embedded Object with object.id of "${objectId}" found`
                        )
                    );
                }

                const obj = ActivityPubObject.fromJsonString(row.obj_json);
                if (!obj) {
                    return cb(Errors.Invalid('Failed to parse Object JSON'));
                }

                return cb(null, obj);
            }
        );
    }

    static getOrdered(
        collectionName,
        owningUser,
        includePrivate,
        page,
        mapper,
        webServer,
        cb
    ) {
        const privateQuery = includePrivate ? '' : ' AND is_private = FALSE';
        const owningUserId = isObject(owningUser) ? owningUser.userId : owningUser;

        // e.g. http://some.host/_enig/ap/collections/1234/followers
        const collectionIdBase =
            makeUserUrl(webServer, owningUser, `/ap/collections/${owningUserId}`) +
            `/${collectionName}`;

        if (!page) {
            return apDb.get(
                `SELECT COUNT(id) AS count
                FROM collection
                WHERE user_id = ? AND name = ?${privateQuery};`,
                [owningUserId, collectionName],
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
                            id: collectionIdBase,
                            type: 'OrderedCollection',
                            first: `${collectionIdBase}?page=1`,
                            totalItems: row.count,
                        };
                    } else {
                        obj = {
                            id: collectionIdBase,
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
            `SELECT obj_json
            FROM collection
            WHERE user_id = ? AND name = ?${privateQuery}
            ORDER BY timestamp;`,
            [owningUserId, collectionName],
            (err, entries) => {
                if (err) {
                    return cb(err);
                }

                entries = entries || [];
                if (mapper && entries.length > 0) {
                    entries = entries.map(mapper);
                }

                const obj = {
                    id: `${collectionIdBase}/page=${page}`,
                    type: 'OrderedCollectionPage',
                    totalItems: entries.length,
                    orderedItems: entries,
                    partOf: collectionIdBase,
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

        //  :TODO: The receiving server MUST take care to be sure that the Update is authorized to modify its object. At minimum, this may be done by ensuring that the Update and its object are of same origin.

        apDb.run(
            `UPDATE collection
            SET obj_json = ?, timestamp = ?
            WHERE name = ? AND obj_id = ?;`,
            [obj, collectionName, getISOTimestampString(), objectId],
            err => {
                return cb(err);
            }
        );
    }

    static addToCollection(collectionName, owningUser, objectId, obj, isPrivate, cb) {
        if (!isString(obj)) {
            obj = JSON.stringify(obj);
        }

        const owningUserId = isObject(owningUser) ? owningUser.userId : owningUser;
        isPrivate = isPrivate ? 1 : 0;
        apDb.run(
            `INSERT OR IGNORE INTO collection (name, timestamp, user_id, obj_id, obj_json, is_private)
            VALUES (?, ?, ?, ?, ?, ?);`,
            [
                collectionName,
                getISOTimestampString(),
                owningUserId,
                objectId,
                obj,
                isPrivate,
            ],
            function res(err) {
                // non-arrow for 'this' scope
                if (err) {
                    return cb(err);
                }
                return cb(err, this.lastID);
            }
        );
    }

    static removeFromCollectionById(collectionName, owningUser, objectId, cb) {
        const owningUserId = isObject(owningUser) ? owningUser.userId : owningUser;
        apDb.run(
            `DELETE FROM collection
            WHERE user_id = ? AND name = ? AND obj_id = ?;`,
            [owningUserId, collectionName, objectId],
            err => {
                return cb(err);
            }
        );
    }
};
