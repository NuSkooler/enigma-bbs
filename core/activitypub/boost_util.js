'use strict';

//
//  Boost (Announce) utilities for ActivityPub.
//
//  Inbound:
//    fetchAnnouncedNote(objectOrId, cb)  — resolve Announce.object to a Note
//    recordInboundBoost(activity, note, cb) — store Announce + meta in collection
//
//  Outbound (called by future UI action):
//    sendBoost(localUser, noteId, cb)   — build + deliver Announce, store in Outbox
//    undoBoost(localUser, noteId, cb)   — build + deliver Undo{Announce}, remove from Outbox
//
//  Query helpers (for Phase 6 AP browser):
//    getBoostActors(noteId, cb)         — list of actor IDs that boosted a given Note
//    getBoostCount(noteId, cb)          — count of boosts for a Note
//

const Collection = require('./collection');
const Activity = require('./activity');
const Actor = require('./actor');
const Note = require('./note');
const ActivityPubObject = require('./object');
const Endpoints = require('./endpoint');
const { getJson } = require('../http_util');
const { Errors } = require('../enig_error');
const { ActivityStreamMediaType, Collections, PublicCollectionId } = require('./const');
const UserProps = require('../user_property');
const Log = require('../logger').log;

// deps
const async = require('async');
const { isString } = require('lodash');

//  Timeout for dereferencing an Announce.object URL.
//  Kept short: we're blocking an inbound HTTP response while we make this request.
const AnnounceObjectFetchTimeoutMs = 3000;

exports.fetchAnnouncedNote = fetchAnnouncedNote;
exports.recordInboundBoost = recordInboundBoost;
exports.recordInboundLike = recordInboundLike;
exports.sendBoost = sendBoost;
exports.undoBoost = undoBoost;
exports.sendLike = sendLike;
exports.undoLike = undoLike;
exports.getBoostActors = getBoostActors;
exports.getBoostCount = getBoostCount;
exports.getLikeActors = getLikeActors;
exports.getLikeCount = getLikeCount;

//
//  Resolve an Announce's object field to a Note.
//
//  Handles three cases:
//    1. String URL that is one of our own Note endpoints → local collection lookup
//    2. String URL that is remote → HTTP GET with 3s timeout
//    3. Embedded object (non-conforming senders) → use directly if type === 'Note'
//
function fetchAnnouncedNote(objectOrId, cb) {
    //  Case 3: already an embedded object
    if (!isString(objectOrId)) {
        if (objectOrId && objectOrId.type === 'Note') {
            return cb(null, new Note(objectOrId));
        }
        return cb(
            Errors.Invalid(
                `Announce.object is an embedded non-Note type: ${objectOrId && objectOrId.type}`
            )
        );
    }

    const noteId = objectOrId;

    //  Case 1: check our own collection first (covers boosts of local Notes)
    Collection.objectByEmbeddedId(noteId, (err, wrappingActivity) => {
        if (err) {
            return cb(err);
        }

        if (wrappingActivity) {
            const embedded = wrappingActivity.object;
            if (embedded && embedded.type === 'Note') {
                return cb(null, new Note(embedded));
            }
        }

        //  Case 2: not found locally — fetch from remote
        const fetchOpts = {
            headers: { Accept: ActivityStreamMediaType },
            timeout: AnnounceObjectFetchTimeoutMs,
        };

        getJson(noteId, fetchOpts, (err, parsed) => {
            if (err) {
                return cb(
                    Errors.HttpError(
                        `Failed to fetch announced Note "${noteId}": ${err.message}`
                    )
                );
            }

            if (!parsed || parsed.type !== 'Note') {
                return cb(
                    Errors.Invalid(
                        `Fetched object at "${noteId}" is not a Note (got type: ${parsed && parsed.type})`
                    )
                );
            }

            return cb(null, new Note(new ActivityPubObject(parsed)));
        });
    });
}

//
//  Store an inbound Announce in the sharedInbox collection and record the
//  reaction in note_reactions for efficient Phase 6 aggregate queries.
//
//  Assumes the Announce's HTTP signature has already been validated.
//  The Note itself is stored separately (caller's responsibility) via the
//  standard toMessage() → persist() path.
//
function recordInboundBoost(activity, note, cb) {
    const actorId = isString(activity.actor) ? activity.actor : activity.actor.id;

    async.series(
        [
            //  Store the Announce activity itself in sharedInbox (for timeline display)
            callback => {
                Collection.addSharedInboxItem(activity, true /* ignoreDupes */, err => {
                    //  SQLITE_CONSTRAINT = already stored; idempotent
                    if (err && err.code !== 'SQLITE_CONSTRAINT') {
                        return callback(err);
                    }
                    return callback(null);
                });
            },

            //  Record the reaction in note_reactions
            callback => {
                Collection.addReaction(
                    note.id,
                    actorId,
                    'Announce',
                    activity.id,
                    callback
                );
            },
        ],
        err => cb(err)
    );
}

//
//  Record an inbound Like reaction against a Note.
//
//  Unlike boosts, Like activities are NOT stored in sharedInbox — they are
//  pure signals and do not appear in the timeline.  The reaction is recorded
//  directly in note_reactions for efficient aggregate queries.
//
//  activity.object may be a plain URL string or an embedded object with an .id.
//
function recordInboundLike(activity, cb) {
    const noteId = isString(activity.object)
        ? activity.object
        : activity.object && activity.object.id;
    const actorId = isString(activity.actor) ? activity.actor : activity.actor.id;

    Collection.addReaction(noteId, actorId, 'Like', activity.id, cb);
}

//
//  Outbound boost: build an Announce activity, deliver it to the local user's
//  followers' shared inboxes, and store it in the user's Outbox collection.
//
//  noteId: the AP object ID (URL) of the Note to boost.
//
function sendBoost(localUser, noteId, cb) {
    const localActorId = localUser.getProperty(UserProps.ActivityPubActorId);
    if (!localActorId) {
        return cb(
            Errors.MissingProperty(
                `User "${localUser.username}" missing property '${UserProps.ActivityPubActorId}'`
            )
        );
    }

    const followersEndpoint = Endpoints.followers(localUser);
    const announce = Activity.makeAnnounce(localActorId, noteId, followersEndpoint);

    async.waterfall(
        [
            //  Guard: reject duplicate outbound boosts before any delivery.
            callback => {
                Collection.hasReaction(noteId, localActorId, 'Announce', (err, already) => {
                    if (err) return callback(err);
                    if (already) {
                        return callback(
                            Errors.Duplicate(`Note "${noteId}" already boosted by "${localActorId}"`)
                        );
                    }
                    return callback(null);
                });
            },

            //  Collect follower shared-inbox endpoints (same helper as scanner/tosser)
            callback => {
                _collectFollowerSharedInboxes(localUser, (err, sharedInboxes) => {
                    return callback(err, sharedInboxes);
                });
            },

            //  Deliver to each unique shared inbox
            (sharedInboxes, callback) => {
                async.eachLimit(
                    sharedInboxes,
                    4,
                    (inbox, next) => {
                        announce.sendTo(inbox, localUser, (err, body, res) => {
                            if (err) {
                                Log.warn(
                                    { inbox, noteId, error: err.message },
                                    'Failed to deliver Announce to shared inbox'
                                );
                            } else if (res.statusCode !== 200 && res.statusCode !== 202) {
                                Log.warn(
                                    { inbox, noteId, statusCode: res.statusCode },
                                    'Unexpected status delivering Announce'
                                );
                            }
                            return next(null); // don't abort on per-inbox failure
                        });
                    },
                    callback
                );
            },

            //  Persist to Outbox
            callback => {
                Collection.addOutboxItem(
                    localUser,
                    announce,
                    false, // not private — Announces are always public
                    false, // do not ignore dupes (same Note boosted twice = error)
                    callback
                );
            },

            //  Record in note_reactions so getBoostCount reflects outbound boosts.
            //  _rowid is the lastInsertRowid from addOutboxItem; ignored here.
            (_rowid, callback) => {
                Collection.addReaction(noteId, localActorId, 'Announce', announce.id, callback);
            },
        ],
        //  setImmediate ensures the caller's callback fires on a fresh tick
        //  even though all steps run synchronously (better-sqlite3).
        err => setImmediate(() => cb(err, announce))
    );
}

//
//  Outbound undo-boost: send Undo{Announce} to followers and remove from Outbox.
//
//  noteId: the AP object ID of the Note whose boost to retract.
//
function undoBoost(localUser, noteId, cb) {
    const localActorId = localUser.getProperty(UserProps.ActivityPubActorId);
    if (!localActorId) {
        return cb(
            Errors.MissingProperty(
                `User "${localUser.username}" missing property '${UserProps.ActivityPubActorId}'`
            )
        );
    }

    const followersEndpoint = Endpoints.followers(localUser);

    //  We need the original Announce to wrap in Undo.object
    //  Find it in the Outbox by scanning for an Announce with matching object.
    //  Note: this queries via json_extract — acceptable for a user-triggered action.
    Collection.objectByEmbeddedId(noteId, (err, outboxActivity) => {
        if (err) {
            return cb(err);
        }

        if (!outboxActivity || outboxActivity.type !== 'Announce') {
            return cb(
                Errors.DoesNotExist(`No outbound Announce found for Note "${noteId}"`)
            );
        }

        const announceId = outboxActivity.id;
        const followersEndpoint = Endpoints.followers(localUser);

        const undo = new ActivityPubObject({
            id: ActivityPubObject.makeObjectId('undo'),
            type: 'Undo',
            actor: localActorId,
            object: outboxActivity,
            to: [PublicCollectionId],
            cc: [followersEndpoint],
        });

        async.waterfall(
            [
                callback => {
                    _collectFollowerSharedInboxes(localUser, (err, sharedInboxes) => {
                        return callback(err, sharedInboxes);
                    });
                },
                (sharedInboxes, callback) => {
                    async.eachLimit(
                        sharedInboxes,
                        4,
                        (inbox, next) => {
                            undo.sendTo(inbox, localUser, (err, body, res) => {
                                if (err) {
                                    Log.warn(
                                        { inbox, noteId, error: err.message },
                                        'Failed to deliver Undo{Announce}'
                                    );
                                }
                                return next(null);
                            });
                        },
                        callback
                    );
                },
                callback => {
                    Collection.removeOwnedById(
                        Collections.Outbox,
                        localUser,
                        announceId,
                        callback
                    );
                },
            ],
            err => cb(err)
        );
    });
}

//
//  Return actor IDs of all remote actors who boosted (Announced) a given Note ID.
//
function getBoostActors(noteId, cb) {
    Collection.getReactionActors(noteId, 'Announce', cb);
}

//
//  Return the count of boosts for a given Note ID.
//
function getBoostCount(noteId, cb) {
    Collection.getReactionCount(noteId, 'Announce', cb);
}

//
//  Return actor IDs of all remote actors who liked a given Note ID.
//
function getLikeActors(noteId, cb) {
    Collection.getReactionActors(noteId, 'Like', cb);
}

//
//  Return the count of likes for a given Note ID.
//
function getLikeCount(noteId, cb) {
    Collection.getReactionCount(noteId, 'Like', cb);
}

//
//  Outbound like: build a Like activity, deliver it to the local user's
//  followers' shared inboxes, and store it in the user's Outbox collection.
//
//  noteId: the AP object ID (URL) of the Note to like.
//
function sendLike(localUser, noteId, cb) {
    const localActorId = localUser.getProperty(UserProps.ActivityPubActorId);
    if (!localActorId) {
        return cb(
            Errors.MissingProperty(
                `User "${localUser.username}" missing property '${UserProps.ActivityPubActorId}'`
            )
        );
    }

    const followersEndpoint = Endpoints.followers(localUser);
    const like = Activity.makeLike(localActorId, noteId, followersEndpoint);

    async.waterfall(
        [
            //  Guard: reject duplicate outbound likes before any delivery.
            callback => {
                Collection.hasReaction(noteId, localActorId, 'Like', (err, already) => {
                    if (err) return callback(err);
                    if (already) {
                        return callback(
                            Errors.Duplicate(`Note "${noteId}" already liked by "${localActorId}"`)
                        );
                    }
                    return callback(null);
                });
            },
            callback => {
                _collectFollowerSharedInboxes(localUser, (err, sharedInboxes) => {
                    return callback(err, sharedInboxes);
                });
            },
            (sharedInboxes, callback) => {
                async.eachLimit(
                    sharedInboxes,
                    4,
                    (inbox, next) => {
                        like.sendTo(inbox, localUser, (err, body, res) => {
                            if (err) {
                                Log.warn(
                                    { inbox, noteId, error: err.message },
                                    'Failed to deliver Like to shared inbox'
                                );
                            } else if (res.statusCode !== 200 && res.statusCode !== 202) {
                                Log.warn(
                                    { inbox, noteId, statusCode: res.statusCode },
                                    'Unexpected status delivering Like'
                                );
                            }
                            return next(null);
                        });
                    },
                    callback
                );
            },
            callback => {
                Collection.addOutboxItem(
                    localUser,
                    like,
                    false, // not private
                    false, // do not ignore dupes
                    callback
                );
            },
            //  _rowid is the lastInsertRowid from addOutboxItem; ignored here.
            (_rowid, callback) => {
                Collection.addReaction(noteId, localActorId, 'Like', like.id, callback);
            },
        ],
        //  setImmediate ensures the caller's callback fires on a fresh tick.
        err => setImmediate(() => cb(err, like))
    );
}

//
//  Outbound undo-like: send Undo{Like} to followers and remove from Outbox.
//
//  noteId: the AP object ID of the Note whose like to retract.
//
function undoLike(localUser, noteId, cb) {
    const localActorId = localUser.getProperty(UserProps.ActivityPubActorId);
    if (!localActorId) {
        return cb(
            Errors.MissingProperty(
                `User "${localUser.username}" missing property '${UserProps.ActivityPubActorId}'`
            )
        );
    }

    const followersEndpoint = Endpoints.followers(localUser);

    //  Find the Like in the Outbox by matching object == noteId and type == Like
    Collection.objectByEmbeddedId(noteId, (err, outboxActivity) => {
        if (err) {
            return cb(err);
        }

        if (!outboxActivity || outboxActivity.type !== 'Like') {
            return cb(
                Errors.DoesNotExist(`No outbound Like found for Note "${noteId}"`)
            );
        }

        const likeId = outboxActivity.id;

        const undo = new ActivityPubObject({
            id: ActivityPubObject.makeObjectId('undo'),
            type: 'Undo',
            actor: localActorId,
            object: outboxActivity,
            to: [PublicCollectionId],
            cc: [followersEndpoint],
        });

        async.waterfall(
            [
                callback => {
                    _collectFollowerSharedInboxes(localUser, (err, sharedInboxes) => {
                        return callback(err, sharedInboxes);
                    });
                },
                (sharedInboxes, callback) => {
                    async.eachLimit(
                        sharedInboxes,
                        4,
                        (inbox, next) => {
                            undo.sendTo(inbox, localUser, (err) => {
                                if (err) {
                                    Log.warn(
                                        { inbox, noteId, error: err.message },
                                        'Failed to deliver Undo{Like}'
                                    );
                                }
                                return next(null);
                            });
                        },
                        callback
                    );
                },
                callback => {
                    Collection.removeOwnedById(
                        Collections.Outbox,
                        localUser,
                        likeId,
                        callback
                    );
                },
                callback => {
                    Collection.removeReactionByActivityId(likeId, callback);
                },
            ],
            err => cb(err)
        );
    });
}

//  Shared helper: collect unique shared-inbox endpoints for the local user's followers.
//  Mirrors the logic in scanner_tossers/activitypub.js without duplicating the module.
function _collectFollowerSharedInboxes(localUser, cb) {
    const followersEndpoint = Endpoints.followers(localUser);

    Collection.followers(followersEndpoint, 'all', (err, collection) => {
        if (err) {
            return cb(err);
        }

        const items =
            collection && collection.orderedItems ? collection.orderedItems : [];

        if (items.length === 0) {
            return cb(null, []);
        }

        async.mapLimit(
            items,
            4,
            (actorId, next) => {
                Actor.fromId(actorId, (err, actor) => {
                    if (err || !actor) {
                        return next(null, null);
                    }
                    return next(null, actor.endpoints && actor.endpoints.sharedInbox);
                });
            },
            (err, inboxes) => {
                if (err) {
                    return cb(err);
                }
                const unique = Array.from(new Set(inboxes.filter(Boolean)));
                return cb(null, unique);
            }
        );
    });
}
