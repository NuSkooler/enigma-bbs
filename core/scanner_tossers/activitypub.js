const Activity = require('../activitypub_activity');
const Message = require('../message');
const { MessageScanTossModule } = require('../msg_scan_toss_module');
const { getServer } = require('../listening_server');

exports.moduleInfo = {
    name: 'ActivityPub',
    desc: 'Provides ActivityPub scanner/tosser integration',
    author: 'NuSkooler',
};

exports.getModule = class ActivityPubScannerTosser extends MessageScanTossModule {
    constructor() {
        super();
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

        Activity.noteFromLocalMessage(this._webServer(), message, (err, noteData) => {
            if (err) {
                // :TODO: Log me
            }

            const { activity, fromUser, remoteActor } = noteData;

            // - persist Activity
            // - sendTo
            // - update message properties:
            //  * exported
            //  * ActivityPub ID -> activity table
            activity.sendTo(
                remoteActor.inbox,
                fromUser,
                this._webServer(),
                (err, respBody, res) => {
                    if (err) {
                    }
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
