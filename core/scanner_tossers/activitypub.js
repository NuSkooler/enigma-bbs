const Activity = require('../activitypub/activity');
const Message = require('../message');
const { MessageScanTossModule } = require('../msg_scan_toss_module');
const { getServer } = require('../listening_server');
const Log = require('../logger').log;

// deps
const async = require('async');
const _ = require('lodash');
const Collection = require('../activitypub/collection');
const Note = require('../activitypub/note');

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

        async.waterfall(
            [
                callback => {
                    Note.fromLocalOutgoingMessage(
                        message,
                        this._webServer(),
                        (err, noteInfo) => {
                            return callback(err, noteInfo);
                        }
                    );
                },
                (noteInfo, callback) => {
                    const { note, fromUser, remoteActor } = noteInfo;

                    const activity = Activity.makeCreate(
                        this._webServer(),
                        note.attributedTo,
                        note
                    );

                    //  :TODO: Implement retry logic (connection issues, retryable HTTP status) ??
                    const inbox = remoteActor.inbox;

                    // const inbox = remoteActor.endpoints.sharedInbox;
                    // activity.object.to = 'https://www.w3.org/ns/activitystreams#Public';

                    activity.sendTo(
                        inbox,
                        fromUser,
                        this._webServer(),
                        (err, respBody, res) => {
                            if (err) {
                                this.log.warn(
                                    { error: err.message, inbox: remoteActor.inbox },
                                    'Failed to send "Note" Activity to Inbox'
                                );
                            } else if (res.statusCode !== 202 && res.statusCode !== 200) {
                                this.log.warn(
                                    {
                                        inbox: remoteActor.inbox,
                                        statusCode: res.statusCode,
                                        body: _.truncate(respBody, 128),
                                    },
                                    'Unexpected status code'
                                );
                            }

                            //  carry on regardless if we sent and record
                            //  the item in the user's Outbox collection
                            return callback(null, activity, fromUser);
                        }
                    );
                },
                (activity, fromUser, callback) => {
                    //  If we failed to send above,
                    Collection.addOutboxItem(
                        fromUser,
                        activity,
                        message.isPrivate(),
                        this._webServer(),
                        (err, localId) => {
                            if (!err) {
                                this.log.debug(
                                    { localId, activityId: activity.id },
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
                if (err) {
                    this.log.error(
                        { error: err.message, messageId: message.messageId },
                        'Failed to export message to ActivityPub'
                    );
                } else {
                    this.log.info(
                        { id: activity.id },
                        'Note Activity exported (published) successfully'
                    );
                }
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

        //  :TODO: Implement the area mapping check for public
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
