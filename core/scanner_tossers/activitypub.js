const Activity = require('../activitypub/activity');
const Message = require('../message');
const { MessageScanTossModule } = require('../msg_scan_toss_module');
const { getServer } = require('../listening_server');
const Log = require('../logger').log;
const { WellKnownAreaTags, AddressFlavor } = require('../message_const');
const { Errors } = require('../enig_error');
const Collection = require('../activitypub/collection');
const Note = require('../activitypub/note');
const Endpoints = require('../activitypub/endpoint');
const { getAddressedToInfo } = require('../mail_util');
const { PublicCollectionId } = require('../activitypub/const');
const Actor = require('../activitypub/actor');
const StatLog = require('../stat_log');
const UserProps = require('../user_property');

// deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'ActivityPub',
    desc: 'Provides ActivityPub scanner/tosser integration',
    author: 'NuSkooler',
};

exports.getModule = class ActivityPubScannerTosser extends MessageScanTossModule {
    constructor() {
        super();

        this.log = Log.child({ module: 'ActivityPubScannerTosser' });
    }

    startup(cb) {
        return cb(null);
    }

    shutdown(cb) {
        return cb(null);
    }

    record(message) {
        if (!this._shouldExportMessage(message)) {
            return;
        }

        if (!this._isEnabled()) {
            return;
        }

        //
        //  Private:
        //  Send Note directly to another remote Actor's inbox
        //
        //  Public:
        //  - The original message may be addressed to a non-ActivityPub address
        //    or something like "All" or "Public"; In this case, ignore that entry
        //  - Additionally, we need to send to the local Actor's followers via their sharedInbox
        //
        //  To achieve the above for Public, we'll collect the followers from the local
        //  user, query their unique shared inboxes's, update the Note's addressing,
        //  then deliver and store.
        //

        async.waterfall(
            [
                callback => {
                    Note.fromLocalMessage(message, this._webServer(), (err, noteInfo) => {
                        return callback(err, noteInfo);
                    });
                },
                (noteInfo, callback) => {
                    if (message.isPrivate()) {
                        if (!noteInfo.remoteActor) {
                            return callback(
                                Errors.UnexpectedState(
                                    'Private messages should contain a remote Actor!'
                                )
                            );
                        }
                        return callback(null, noteInfo, [noteInfo.remoteActor.inbox]);
                    }

                    //  public: we need to build a list of sharedInbox's
                    this._collectDeliveryEndpoints(
                        message,
                        noteInfo.note,
                        noteInfo.fromUser,
                        (err, deliveryEndpoints) => {
                            return callback(err, noteInfo, deliveryEndpoints);
                        }
                    );
                },
                (noteInfo, deliveryEndpoints, callback) => {
                    const { note, fromUser, context } = noteInfo;

                    //
                    //  Update the Note's addressing:
                    //  - Private:
                    //      to: Directly to addressed-to Actor inbox
                    //
                    //  - Public:
                    //      to: https://www.w3.org/ns/activitystreams#Public
                    //          ... and the message.getRemoteToUser() value *if*
                    //          the flavor is deemed ActivityPub
                    //      cc: [sharedInboxEndpoints]
                    //
                    if (message.isPrivate()) {
                        note.to = deliveryEndpoints;
                    } else {
                        //  Public posts follow Mastodon/GTS convention:
                        //    to:  [Public]
                        //    cc:  [followersCollection, mentionedActorId?]
                        //
                        //  sharedInboxes are *delivery* targets only — they are inbox
                        //  URLs (not actor/collection IDs) and must NOT appear in cc.
                        note.to = [PublicCollectionId];
                        note.cc = [deliveryEndpoints.followers];
                        if (deliveryEndpoints.additionalToActorId) {
                            note.cc.push(deliveryEndpoints.additionalToActorId);

                            //  GTS (and others) require a Mention tag for the reply
                            //  target's actor; without it they drop the note as
                            //  "not relevant to receiver (not mentioned)".
                            note.tag = Array.isArray(note.tag) ? note.tag : [];
                            if (
                                !note.tag.some(
                                    t =>
                                        t.type === 'Mention' &&
                                        t.href === deliveryEndpoints.additionalToActorId
                                )
                            ) {
                                note.tag.push({
                                    type: 'Mention',
                                    href: deliveryEndpoints.additionalToActorId,
                                });
                            }
                        }
                        note.cc = note.cc.filter(Boolean);

                        if (note.to.length < 1 && note.cc.length < 1) {
                            // nowhere to send
                            return callback(null, activity, fromUser);
                        }
                    }

                    const activity = Activity.makeCreate(
                        note.attributedTo,
                        note,
                        context
                    );

                    let allEndpoints = Array.isArray(deliveryEndpoints)
                        ? deliveryEndpoints
                        : deliveryEndpoints.sharedInboxes;
                    if (deliveryEndpoints.additionalToInbox) {
                        allEndpoints.push(deliveryEndpoints.additionalToInbox);
                    }
                    allEndpoints = Array.from(new Set(allEndpoints)); //  unique again

                    async.eachLimit(
                        allEndpoints,
                        4,
                        (inbox, nextInbox) => {
                            activity.sendTo(inbox, fromUser, (err, respBody, res) => {
                                if (err) {
                                    this.log.warn(
                                        {
                                            inbox,
                                            error: err.message,
                                        },
                                        'Failed to send "Note" Activity to Inbox'
                                    );
                                } else if (
                                    res.statusCode === 200 ||
                                    res.statusCode === 202
                                ) {
                                    this.log.debug(
                                        { inbox, uuid: message.uuid },
                                        'Message delivered to Inbox'
                                    );
                                } else {
                                    this.log.warn(
                                        {
                                            inbox,
                                            statusCode: res.statusCode,
                                            body: _.truncate(respBody, 128),
                                        },
                                        'Unexpected status code'
                                    );
                                }

                                //  If we can't send now, no harm, we'll record to the outbox
                                return nextInbox(null);
                            });
                        },
                        () => {
                            return callback(null, activity, fromUser, note);
                        }
                    );
                },
                (activity, fromUser, note, callback) => {
                    Collection.addOutboxItem(
                        fromUser,
                        activity,
                        message.isPrivate(),
                        false, // do not ignore dupes
                        (err, localId) => {
                            if (!err) {
                                this.log.debug(
                                    { localId, activityId: activity.id, noteId: note.id },
                                    'Note Activity persisted to "outbox" collection"'
                                );
                                if (!message.isPrivate()) {
                                    StatLog.incrementUserStat(
                                        fromUser,
                                        UserProps.ApPostCount,
                                        1
                                    );
                                }
                            }
                            return callback(err, activity);
                        }
                    );
                },
                (activity, callback) => {
                    // mark exported
                    return message.persistMetaValue(
                        Message.WellKnownMetaCategories.System,
                        Message.SystemMetaNames.StateFlags0,
                        Message.StateFlags0.Exported.toString(),
                        err => {
                            return callback(err, activity);
                        }
                    );
                },
                (activity, callback) => {
                    // message -> Activity ID relation
                    return message.persistMetaValue(
                        Message.WellKnownMetaCategories.ActivityPub,
                        Message.ActivityPubPropertyNames.ActivityId,
                        activity.id,
                        err => {
                            return callback(err, activity);
                        }
                    );
                },
                (activity, callback) => {
                    return message.persistMetaValue(
                        Message.WellKnownMetaCategories.ActivityPub,
                        Message.ActivityPubPropertyNames.NoteId,
                        activity.object.id,
                        err => {
                            return callback(err, activity);
                        }
                    );
                },
            ],
            (err, activity) => {
                // dupes aren't considered failure
                if (err) {
                    if (err.code === 'SQLITE_CONSTRAINT') {
                        this.log.debug({ id: activity.id }, 'Ignoring duplicate');
                    } else {
                        this.log.error(
                            { error: err.message, messageId: message.messageId },
                            'Failed to export message to ActivityPub'
                        );
                    }
                } else {
                    this.log.info(
                        { activityId: activity.id, noteId: activity.object.id },
                        'Note Activity published successfully'
                    );
                }
            }
        );
    }

    _collectDeliveryEndpoints(message, note, localUser, cb) {
        this._collectFollowersSharedInboxEndpoints(
            localUser,
            (err, endpoints, followersEndpoint) => {
                if (err) {
                    return cb(err);
                }

                const base = { sharedInboxes: endpoints, followers: followersEndpoint };

                //  Priority 1: explicit AP address in the TO field
                const addrInfo = getAddressedToInfo(message.toUserName);
                if (
                    !message.isPrivate() &&
                    AddressFlavor.ActivityPub === addrInfo.flavor
                ) {
                    return Actor.fromId(addrInfo.remote, (err, actor) => {
                        if (err) {
                            return cb(err);
                        }
                        return cb(null, {
                            ...base,
                            additionalToActorId: actor.id,
                            additionalToInbox: actor.inbox,
                        });
                    });
                }

                //  Priority 2: reply — deliver to the inReplyTo note's author
                if (note && note.inReplyTo) {
                    return Collection.objectByEmbeddedId(
                        note.inReplyTo,
                        (err, activity) => {
                            const parentNote = activity && activity.object;
                            const attributedTo =
                                parentNote &&
                                (typeof parentNote.attributedTo === 'string'
                                    ? parentNote.attributedTo
                                    : parentNote.attributedTo &&
                                      parentNote.attributedTo.id);

                            if (!attributedTo) {
                                return cb(null, base);
                            }

                            Actor.fromId(attributedTo, (err, actor) => {
                                if (err || !actor) {
                                    return cb(null, base);
                                }
                                const inbox =
                                    (actor.endpoints && actor.endpoints.sharedInbox) ||
                                    actor.inbox;
                                return cb(null, {
                                    ...base,
                                    additionalToActorId: actor.id,
                                    additionalToInbox: inbox,
                                });
                            });
                        }
                    );
                }

                return cb(null, base);
            }
        );
    }

    _collectFollowersSharedInboxEndpoints(localUser, cb) {
        const localFollowersEndpoint = Endpoints.followers(localUser);

        //  Single SQL query: join the followers collection against the actor
        //  cache and extract sharedInbox URLs directly.  O(1) DB round-trips
        //  regardless of follower count; actors not yet cached are skipped
        //  (same behaviour as the previous per-actor fromId() fan-out loop).
        Collection.getFollowerSharedInboxes(
            localFollowersEndpoint,
            (err, sharedInboxEndpoints) => {
                if (err) {
                    return cb(err);
                }
                return cb(null, sharedInboxEndpoints, localFollowersEndpoint);
            }
        );
    }

    _isEnabled() {
        //  :TODO: check config to see if AP integration is enabled/etc.
        return this._webServer();
    }

    _shouldExportMessage(message) {
        //
        // - Private messages: Must be ActivityPub flavor
        // - Public messages: Must be in area mapped for ActivityPub import/export
        //
        if (
            Message.AddressFlavor.ActivityPub === message.getAddressFlavor() &&
            message.isPrivate()
        ) {
            return true;
        }

        //  Public items do not need a specific 'to'; we'll record to the
        //  local Actor's outbox and send to any followers we know about
        if (message.areaTag === WellKnownAreaTags.ActivityPubShared) {
            return true;
        }

        //  :TODO: Implement the area mapping check for public 'groups'
        return false;
    }

    _exportToActivityPub(message, cb) {
        return cb(null);
    }

    _webServer() {
        // we have to lazy init
        if (undefined === this.webServer) {
            this.webServer = getServer('codes.l33t.enigma.web.server') || null;
        }

        return this.webServer ? this.webServer.instance : null;
    }
};
