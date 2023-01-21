const { makeUserUrl } = require('./util');
const ActivityPubObject = require('./object');
const apDb = require('../database').dbs.activitypub;
const { getISOTimestampString } = require('../database');

const { isString, get } = require('lodash');

module.exports = class Collection extends ActivityPubObject {
    constructor(obj) {
        super(obj);
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
        return Collection.addToCollection('followers', owningUser, followingActor, cb);
    }

    static getOrdered(name, owningUser, includePrivate, page, mapper, webServer, cb) {
        //  :TODD: |includePrivate| handling
        const followersUrl =
            makeUserUrl(webServer, owningUser, '/ap/users/') + `/${name}`;
        if (!page) {
            return apDb.get(
                `SELECT COUNT(id) AS count
                FROM collection_entry
                WHERE name = ?;`,
                [name],
                (err, row) => {
                    if (err) {
                        return cb(err);
                    }

                    let obj;
                    if (row.count > 0) {
                        obj = {
                            id: followersUrl,
                            type: 'OrderedCollection',
                            first: `${followersUrl}?page=1`,
                            totalItems: row.count,
                        };
                    } else {
                        obj = {
                            id: followersUrl,
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
            `SELECT entry_json
            FROM collection_entry
            WHERE user_id = ? AND name = ?
            ORDER BY timestamp;`,
            [owningUser.userId, name],
            (err, entries) => {
                if (err) {
                    return cb(err);
                }

                entries = entries || [];
                if (mapper && entries.length > 0) {
                    entries = entries.map(mapper);
                }

                const obj = {
                    id: `${followersUrl}/page=${page}`,
                    type: 'OrderedCollectionPage',
                    totalItems: entries.length,
                    orderedItems: entries,
                    partOf: followersUrl,
                };

                return cb(null, new Collection(obj));
            }
        );
    }

    static addToCollection(name, owningUser, entry, cb) {
        if (!isString(entry)) {
            entry = JSON.stringify(entry);
        }

        apDb.run(
            `INSERT OR IGNORE INTO collection_entry (name, timestamp, user_id, entry_json)
                VALUES (?, ?, ?, ?);`,
            [name, getISOTimestampString(), owningUser.userId, entry],
            function res(err) {
                // non-arrow for 'this' scope
                if (err) {
                    return cb(err);
                }
                return cb(err, this.lastID);
            }
        );
    }
};
