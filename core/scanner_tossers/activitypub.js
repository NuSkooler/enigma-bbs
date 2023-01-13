const Activity = require('../activitypub_activity');
const Message = require('../message');
const { MessageScanTossModule } = require('../msg_scan_toss_module');
const { getServer } = require('../listening_server');
const Log = require('../logger').log;
const { persistToOutbox } = require('../activitypub_db');

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
        if (!this._isEnabled()) {
            return;
        }

        async.waterfall(
            [
                callback => {
                    return Activity.noteFromLocalMessage(
                        this._webServer(),
                        message,
                        callback
                    );
                },
                (noteInfo, callback) => {
                    const { activity, fromUser, remoteActor } = noteInfo;

                    persistToOutbox(
                        activity,
                        fromUser.userId,
                        message.messageId,
                        (err, localId) => {
                            if (!err) {
                                this.log.debug(
                                    { localId, activityId: activity.id },
                                    'Note Activity persisted to database'
                                );
                            }
                            return callback(err, activity, fromUser, remoteActor);
                        }
                    );
                },
                (activity, fromUser, remoteActor, callback) => {
                    activity.sendTo(
                        remoteActor.inbox,
                        fromUser,
                        this._webServer(),
                        (err, respBody, res) => {
                            if (err) {
                                return callback(err);
                            }

                            if (res.statusCode !== 202 && res.statusCode !== 200) {
                                this.log.warn(
                                    {
                                        inbox: remoteActor.inbox,
                                        statusCode: res.statusCode,
                                        body: _.truncate(respBody, 128),
                                    },
                                    'Unexpected status code'
                                );
                            }

                            //
                            // We sent successfully; update some properties
                            // in the original message to indicate export
                            // and updated mapping of message -> Activity record
                            //
                            return callback(null, activity);
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
            ],
            (err, activity) => {
                if (err) {
                    this.log.error(
                        { error: err.message, messageId: message.messageId },
                        'Failed to export message to ActivityPub'
                    );
                } else {
                    this.log.info({id: activity.id}, 'Note Activity exported (published) successfully');
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
        //  :TODO: Implement the mapping
        if (
            Message.AddressFlavor.ActivityPub === message.getAddressFlavor() &&
            Message.isPrivateAreaTag()
        ) {
            return true;
        }

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
