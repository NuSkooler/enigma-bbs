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

//  meta_name constants stored in collection_object_meta for Announce activities
const BoostMeta = {
    ActivityType: 'activity_type',
    OriginalNoteId: 'original_note_id',
    BoostedBy: 'boosted_by',
};
exports.BoostMeta = BoostMeta;

//  meta_name constants stored in collection_object_meta for Like activities
const LikeMeta = {
    ActivityType: 'activity_type', //  value is always 'Like'
    LikedObjectId: 'liked_object_id',
    LikedBy: 'liked_by',
};
exports.LikeMeta = LikeMeta;

exports.fetchAnnouncedNote = fetchAnnouncedNote;
exports.recordInboundBoost = recordInboundBoost;
exports.recordInboundLike = recordInboundLike;
exports.sendBoost = sendBoost;
exports.undoBoost = undoBoost;
exports.getBoostActors = getBoostActors;
exports.getBoostCount = getBoostCount;

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
//  Store an inbound Announce in the sharedInbox collection and attach
//  metadata so the AP browser can query boosts efficiently.
//
//  Assumes the Announce's HTTP signature has already been validated.
//  The Note itself is stored separately (caller's responsibility) via the
//  standard toMessage() → persist() path.
//
function recordInboundBoost(activity, note, cb) {
    const collectionId = PublicCollectionId;
    const collectionName = Collections.SharedInbox;

    async.series(
        [
            //  Store the Announce activity itself
            callback => {
                Collection.addSharedInboxItem(activity, true /* ignoreDupes */, err => {
                    //  SQLITE_CONSTRAINT = already stored; idempotent
                    if (err && err.code !== 'SQLITE_CONSTRAINT') {
                        return callback(err);
                    }
                    return callback(null);
                });
            },

            //  Attach meta: activity type tag (allows filtering collection by type)
            callback => {
                Collection.addCollectionObjectMeta(
                    collectionName,
                    collectionId,
                    activity.id,
                    BoostMeta.ActivityType,
                    'Announce',
                    callback
                );
            },

            //  Attach meta: the original Note ID that was announced
            callback => {
                Collection.addCollectionObjectMeta(
                    collectionName,
                    collectionId,
                    activity.id,
                    BoostMeta.OriginalNoteId,
                    note.id,
                    callback
                );
            },

            //  Attach meta: who boosted (the Announce actor)
            callback => {
                Collection.addCollectionObjectMeta(
                    collectionName,
                    collectionId,
                    activity.id,
                    BoostMeta.BoostedBy,
                    isString(activity.actor) ? activity.actor : activity.actor.id,
                    callback
                );
            },
        ],
        err => cb(err)
    );
}

//
//  Store an inbound Like in the sharedInbox collection and attach metadata
//  so the AP browser can query likes efficiently.
//
//  activity.object may be a plain URL string or an embedded object with an .id.
//
function recordInboundLike(activity, cb) {
    const collectionId = PublicCollectionId;
    const collectionName = Collections.SharedInbox;
    const likedId = isString(activity.object)
        ? activity.object
        : activity.object && activity.object.id;

    async.series(
        [
            //  Store the Like activity itself
            callback => {
                Collection.addSharedInboxItem(activity, true /* ignoreDupes */, err => {
                    if (err && err.code !== 'SQLITE_CONSTRAINT') {
                        return callback(err);
                    }
                    return callback(null);
                });
            },

            //  Attach meta: activity type tag
            callback => {
                Collection.addCollectionObjectMeta(
                    collectionName,
                    collectionId,
                    activity.id,
                    LikeMeta.ActivityType,
                    'Like',
                    callback
                );
            },

            //  Attach meta: the object ID that was liked
            callback => {
                Collection.addCollectionObjectMeta(
                    collectionName,
                    collectionId,
                    activity.id,
                    LikeMeta.LikedObjectId,
                    likedId,
                    callback
                );
            },

            //  Attach meta: who liked
            callback => {
                Collection.addCollectionObjectMeta(
                    collectionName,
                    collectionId,
                    activity.id,
                    LikeMeta.LikedBy,
                    isString(activity.actor) ? activity.actor : activity.actor.id,
                    callback
                );
            },
        ],
        err => cb(err)
    );
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
        ],
        err => cb(err, announce)
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
//  Return actor IDs of all remote actors who boosted a given Note ID.
//  Used by the Phase 6 AP browser to display boost counts and actors.
//
function getBoostActors(noteId, cb) {
    Collection.getCollectionObjectsByMeta(
        Collections.SharedInbox,
        BoostMeta.OriginalNoteId,
        noteId,
        (err, results) => {
            if (err) {
                return cb(err);
            }
            const actors = results
                .map(r => {
                    const actor = r.object.actor;
                    return isString(actor) ? actor : actor && actor.id;
                })
                .filter(Boolean);
            return cb(null, actors);
        }
    );
}

//
//  Return the count of boosts for a given Note ID.
//
function getBoostCount(noteId, cb) {
    getBoostActors(noteId, (err, actors) => {
        if (err) {
            return cb(err);
        }
        return cb(null, actors.length);
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
