const { Collections, WellKnownActivity } = require('./const');
const ActivityPubObject = require('./object');
const UserProps = require('../user_property');
const StatLog = require('../stat_log');
const { Errors } = require('../enig_error');
const Collection = require('./collection');
const Actor = require('./actor');
const Activity = require('./activity');
const Endpoints = require('./endpoint');
const Logger = require('../logger');

const async = require('async');
const { isString } = require('lodash');

//  followers resolved at once when they are not in the actor cache; the
//  same bound the other actor fan-outs use
const FollowerFetchConcurrency = 4;

exports.sendFollowRequest = sendFollowRequest;
exports.sendUnfollowRequest = sendUnfollowRequest;
exports.acceptFollowRequest = acceptFollowRequest;
exports.rejectFollowRequest = rejectFollowRequest;
exports.collectFollowerInboxes = collectFollowerInboxes;

function sendFollowRequest(fromUser, toActor, cb) {
    const fromActorId = fromUser.getProperty(UserProps.ActivityPubActorId);
    if (!fromActorId) {
        return cb(
            Errors.MissingProperty(
                `User missing "${UserProps.ActivityPubActorId}" property`
            )
        );
    }

    //  We always add to the following collection;
    //  We expect an async follow up request to our server of
    //  Accept or Reject but it's not guaranteed
    const followRequest = new ActivityPubObject({
        id: ActivityPubObject.makeObjectId('follow'),
        type: WellKnownActivity.Follow,
        actor: fromActorId,
        object: toActor.id,
    });

    toActor._followRequest = followRequest;
    Collection.addFollowing(fromUser, toActor, true, err => {
        if (err) {
            return cb(err);
        }

        return followRequest.sendTo(toActor.inbox, fromUser, (err, body, res) => {
            if (!err) {
                StatLog.incrementUserStat(fromUser, UserProps.ApFollowCount, 1);
            }
            return cb(err, body, res);
        });
    });
}

function sendUnfollowRequest(fromUser, toActor, cb) {
    const fromActorId = fromUser.getProperty(UserProps.ActivityPubActorId);
    if (!fromActorId) {
        return cb(
            Errors.MissingProperty(
                `User missing "${UserProps.ActivityPubActorId}" property`
            )
        );
    }

    //  Fetch previously saved 'Follow'; We're going to Undo it &
    //  need a copy.
    Collection.ownedObjectByNameAndId(
        Collections.Following,
        fromUser,
        toActor.id,
        (err, followedActor) => {
            if (err) {
                return cb(err);
            }

            if (!followedActor) {
                //  Not in our following collection: nothing to Undo
                return cb(Errors.DoesNotExist(`Not following Actor "${toActor.id}"`));
            }

            //  Always remove from the local collection, notify the remote server
            Collection.removeOwnedById(
                Collections.Following,
                fromUser,
                toActor.id,
                err => {
                    if (err) {
                        return cb(err);
                    }

                    const undoRequest = new ActivityPubObject({
                        id: ActivityPubObject.makeObjectId('undo'),
                        type: WellKnownActivity.Undo,
                        actor: fromActorId,
                        object: followedActor._followRequest,
                    });

                    return undoRequest.sendTo(toActor.inbox, fromUser, cb);
                }
            );
        }
    );
}

function acceptFollowRequest(localUser, remoteActor, requestActivity, cb) {
    async.series(
        [
            callback => {
                return Collection.addFollower(
                    localUser,
                    remoteActor,
                    true, // ignore dupes
                    callback
                );
            },
            callback => {
                Actor.fromLocalUser(localUser, (err, localActor) => {
                    if (err) {
                        return callback(err);
                    }

                    const accept = Activity.makeAccept(localActor.id, requestActivity);

                    accept.sendTo(remoteActor.inbox, localUser, (err, respBody, res) => {
                        if (err) {
                            return callback(Errors.HttpError(err.message, err.code));
                        }

                        if (res.statusCode !== 202 && res.statusCode !== 200) {
                            return callback(
                                Errors.HttpError(
                                    `Unexpected HTTP status code ${res.statusCode}`
                                )
                            );
                        }

                        return callback(null);
                    });
                });
            },
            callback => {
                // remove from local requests Collection
                return Collection.removeOwnedById(
                    Collections.FollowRequests,
                    localUser,
                    requestActivity.id,
                    callback
                );
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function rejectFollowRequest(localUser, requestActor, requestActivity, cb) {
    async.series(
        [
            callback => {
                Actor.fromLocalUser(localUser, (err, localActor) => {
                    if (err) {
                        return callback(err);
                    }

                    const reject = Activity.makeReject(localActor, requestActivity);
                    reject.sendTo(requestActor.inbox, localUser, (err, respBody, res) => {
                        if (err) {
                            return callback(Errors.HttpError(err.message, err.code));
                        }

                        if (res.statusCode !== 202 && res.statusCode !== 200) {
                            return callback(
                                Errors.HttpError(
                                    `Unexpected HTTP status code ${res.statusCode}`
                                )
                            );
                        }

                        return callback(null);
                    });
                });
            },
            callback => {
                // remove from local requests Collection
                return Collection.removeOwnedById(
                    Collections.FollowRequests,
                    localUser,
                    requestActivity.id,
                    callback
                );
            },
        ],
        err => {
            return cb(err);
        }
    );
}

//
//  Followers that could not be resolved are not tried again for this long,
//  so a follower whose server is gone does not cost every post a full set of
//  fetches. Kept in memory: losing it on restart costs one retry each.
//
const FollowerFailureTtlMs = 6 * 60 * 60 * 1000;
const FollowerFailureMaxEntries = 10000;
const followerFailures = new Map(); // actorId -> retry after (ms)

function followerFailedRecently(actorId) {
    const retryAfter = followerFailures.get(actorId);
    if (retryAfter === undefined) {
        return false;
    }
    if (Date.now() < retryAfter) {
        return true;
    }
    followerFailures.delete(actorId);
    return false;
}

function noteFollowerFailure(actorId) {
    if (followerFailures.size >= FollowerFailureMaxEntries) {
        const now = Date.now();
        for (const [id, retryAfter] of followerFailures) {
            if (retryAfter <= now || followerFailures.size >= FollowerFailureMaxEntries) {
                followerFailures.delete(id);
            }
        }
    }
    followerFailures.set(actorId, Date.now() + FollowerFailureTtlMs);
}

//
//  Follower lookups are shared by every post: at most
//  FollowerFetchConcurrency run at once, board wide, and a post that needs
//  an actor already being looked up waits on that lookup instead of
//  starting its own.
//
//  A slot is freed after this long even if a lookup never calls back
//  (Actor.fromId() has its own request timeouts)
const FollowerLookupTimeoutMs = 60 * 1000;

//  Runs |work(finish)| and calls done() once: at finish(), or after |ms|
function withTimeout(work, ms, done) {
    let finished = false;
    const finish = (...args) => {
        if (!finished) {
            finished = true;
            clearTimeout(timer);
            done(...args);
        }
    };
    const timer = setTimeout(() => finish(Errors.General('Timed out')), ms);
    if (timer.unref) {
        timer.unref();
    }
    work(finish);
}

const followerLookups = new Map(); // actorId -> [cb, ...]
const newLookupQueue = () =>
    async.queue((task, done) => {
        withTimeout(
            //  signed as the local user, for servers that require it
            finish => Actor.fromId(task.actorId, task.localUser, finish),
            FollowerLookupTimeoutMs,
            (err, actor) => {
                const waiting = followerLookups.get(task.actorId) || [];
                followerLookups.delete(task.actorId);
                done();
                waiting.forEach(cb => cb(err, actor));
            }
        );
    }, FollowerFetchConcurrency);
let followerLookupQueue = newLookupQueue();

function lookUpFollower(actorId, localUser, cb) {
    const waiting = followerLookups.get(actorId);
    if (waiting) {
        return waiting.push(cb);
    }
    followerLookups.set(actorId, [cb]);
    followerLookupQueue.push({ actorId, localUser });
}

//
//  Sends to followers resolved late are fire-and-forget for the caller; they
//  go through one board-wide queue, FollowerFetchConcurrency at a time like
//  the sends to cached followers. A send that never calls back frees its
//  slot after LateSendTimeoutMs.
//
const LateSendTimeoutMs = 60 * 1000;
const newSendQueue = () =>
    async.queue(
        (send, done) => withTimeout(send, LateSendTimeoutMs, () => done()),
        FollowerFetchConcurrency
    );
let lateSendQueue = newSendQueue();

//  for tests: forget failures, lookups in flight and queued sends
exports.resetFollowerFailures = () => {
    followerFailures.clear();
    followerLookups.clear();
    followerLookupQueue.kill();
    followerLookupQueue = newLookupQueue();
    lateSendQueue.kill();
    lateSendQueue = newSendQueue();
};

//
//  The inboxes that reach |localUser|'s followers: each follower's sharedInbox,
//  or its own inbox when it has none.
//
//  cb(err, inboxes, late) is called once the actor cache has been read, with
//  the inboxes of cached followers, so delivery to them is not held up. A
//  follower missing from the cache (purged at upgrade, or expired) is
//  fetched again in the background through Actor.fromId(), which verifies
//  and re-caches it (see lookUpFollower); one that fails is not tried again
//  for FollowerFailureTtlMs. late(deliver) hands each further inbox found
//  that way to deliver(inbox, done), queued (see lateSendQueue), including those
//  found before late() was called, if they still follow; without it they
//  are cached for the next post. The follower row's own copy of the actor is not used: it may
//  predate those checks.
//
function collectFollowerInboxes(localUser, cb) {
    const followersEndpoint = Endpoints.followers(localUser);

    Collection.followers(followersEndpoint, 'all', (err, collection) => {
        if (err) {
            return cb(err);
        }

        const ids = ((collection && collection.orderedItems) || []).filter(isString);
        const inboxOf = actor =>
            (actor.endpoints && actor.endpoints.sharedInbox) || actor.inbox;

        Collection.actorsFromIds(ids, (err, cached) => {
            if (err) {
                return cb(err);
            }

            const seen = new Set();
            const misses = [];
            for (const id of ids) {
                const hit = cached.get(id);
                if (hit) {
                    const inbox = inboxOf(hit.actor);
                    if (isString(inbox) && inbox) {
                        seen.add(inbox);
                    }
                } else if (!followerFailedRecently(id)) {
                    misses.push(id);
                }
            }

            //  inboxes found after cb(), until a deliver function is given
            let deliver = null;
            const pending = [];
            const send = inbox => lateSendQueue.push(done => deliver(inbox, done));
            const late = fn => {
                deliver = fn;
                pending.splice(0).forEach(send);
            };
            const found = inbox => {
                if (!isString(inbox) || !inbox || seen.has(inbox)) {
                    return;
                }
                seen.add(inbox);
                return deliver ? send(inbox) : pending.push(inbox);
            };

            cb(null, Array.from(seen), late);

            misses.forEach(actorId => {
                lookUpFollower(actorId, localUser, (err, actor) => {
                    if (err || !actor) {
                        noteFollowerFailure(actorId);
                        Logger.log &&
                            Logger.log.warn(
                                { actorId, error: err && err.message },
                                'Cannot resolve follower; not delivering to it'
                            );
                        return;
                    }
                    //  the list was read before a lookup that can take a
                    //  while: skip one who has stopped following since
                    Collection.hasObject(
                        Collections.Followers,
                        followersEndpoint,
                        actorId,
                        (err, follows) => {
                            if (!err && follows) {
                                found(inboxOf(actor));
                            }
                        }
                    );
                });
            });
        });
    });
}
