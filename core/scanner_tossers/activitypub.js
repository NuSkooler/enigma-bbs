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
                        if (deliveryEndpoints.additionalTo) {
                            note.to = [
                                PublicCollectionId,
                                deliveryEndpoints.additionalTo,
                            ];
                        } else {
                            note.to = PublicCollectionId;
                        }
                        note.cc = [
                            deliveryEndpoints.followers,
                            ...deliveryEndpoints.sharedInboxes,
                        ];

                        if (note.to.length < 2 && note.cc.length < 2) {
                            // If we only have a generic 'followers' endpoint, there is no where to send to
                            return callback(null, activity, fromUser);
                        }
                    }

                    const activity = Activity.makeCreate(
                        this._webServer(),
                        note.attributedTo,
                        note,
                        context
                    );

                    let allEndpoints = Array.isArray(deliveryEndpoints)
                        ? deliveryEndpoints
                        : deliveryEndpoints.sharedInboxes;
                    if (deliveryEndpoints.additionalTo) {
                        allEndpoints.push(deliveryEndpoints.additionalTo);
                    }
                    allEndpoints = Array.from(new Set(allEndpoints)); //  unique again

                    async.eachLimit(
                        allEndpoints,
                        4,
                        (inbox, nextInbox) => {
                            activity.sendTo(
                                inbox,
                                fromUser,
                                this._webServer(),
                                (err, respBody, res) => {
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
                                }
                            );
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
                        this._webServer(),
                        false, // do not ignore dupes
                        (err, localId) => {
                            if (!err) {
                                this.log.debug(
                                    { localId, activityId: activity.id, noteId: note.id },
                                    'Note Activity persisted to "outbox" collection"'
                                );
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

    _collectDeliveryEndpoints(message, localUser, cb) {
        this._collectFollowersSharedInboxEndpoints(
            localUser,
            (err, endpoints, followersEndpoint) => {
                if (err) {
                    return cb(err);
                }

                //
                //  Don't inspect the remote address/remote to
                //  Here; We already know this in a public
                //  area. Instead, see if the user typed in
                //  a reasonable AP address here. If so, we'll
                //  try to send directly to them as well.
                //
                const addrInfo = getAddressedToInfo(message.toUserName);
                if (
                    !message.isPrivate() &&
                    AddressFlavor.ActivityPub === addrInfo.flavor
                ) {
                    Actor.fromId(addrInfo.remote, (err, actor) => {
                        if (err) {
                            return cb(err);
                        }

                        return cb(null, {
                            additionalTo: actor.inbox,
                            sharedInboxes: endpoints,
                            followers: followersEndpoint,
                        });
                    });
                } else {
                    return cb(null, {
                        sharedInboxes: endpoints,
                        followers: followersEndpoint,
                    });
                }
            }
        );
    }

    _collectFollowersSharedInboxEndpoints(localUser, cb) {
        const localFollowersEndpoint = Endpoints.followers(this._webServer(), localUser);

        Collection.followers(localFollowersEndpoint, 'all', (err, collection) => {
            if (err) {
                return cb(err);
            }

            if (!collection.orderedItems || collection.orderedItems.length < 1) {
                // no followers :(
                return cb(null, []);
            }

            async.mapLimit(
                collection.orderedItems,
                4,
                (actorId, nextActorId) => {
                    Actor.fromId(actorId, (err, actor) => {
                        return nextActorId(err, actor);
                    });
                },
                (err, followerActors) => {
                    if (err) {
                        return cb(err);
                    }

                    const sharedInboxEndpoints = Array.from(
                        new Set(
                            followerActors
                                .map(actor => {
                                    return _.get(actor, 'endpoints.sharedInbox');
                                })
                                .filter(inbox => inbox) // drop nulls
                        )
                    );

                    return cb(null, sharedInboxEndpoints, localFollowersEndpoint);
                }
            );
        });
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
