/* jslint node: true */
'use strict';

const FullScreenEditorModule = require('./fse.js').FullScreenEditorModule;
const persistMessage = require('./message_area.js').persistMessage;
const UserProps = require('./user_property.js');
const { hasMessageConfAndAreaWrite } = require('./message_area.js');
const Message = require('./message.js');

const async = require('async');

exports.moduleInfo = {
    name: 'Message Area Post',
    desc: 'Module for posting a new message to an area',
    author: 'NuSkooler',
};

const MciViewIds = {
    header: {
        from: 1,
        to: 2,
        subject: 3,
        errorMsg: 4,
        modTimestamp: 5,
        msgNum: 6,
        msgTotal: 7,

        customRangeStart: 10, //  10+ = customs
    },

    body: {
        message: 1,
    },

    //  :TODO: quote builder MCIs - remove all magic #'s

    //  :TODO: consolidate all footer MCI's - remove all magic #'s
    ViewModeFooter: {
        MsgNum: 6,
        MsgTotal: 7,
        //  :TODO: Just use custom ranges
    },

    quoteBuilder: {
        quotedMsg: 1,
        //  2 NYI
        quoteLines: 3,
    },
};

exports.getModule = class AreaPostFSEModule extends FullScreenEditorModule {
    constructor(options) {
        super(options);

        this.editMessageUuid = options && options.extraArgs && options.extraArgs.editMessageUuid;
        this.editOriginalMessage = null;



        const self = this;

        //  we're posting, so always start with 'edit' mode
        this.editorMode = 'edit';

        this.menuMethods.editModeMenuSave = function (formData, extraArgs, cb) {
            var msg;
            async.series(
                [
                    function getMessageObject(callback) {
                        self.getMessage(function gotMsg(err, msgObj) {
                            msg = msgObj;
                            return callback(err);
                        });
                    },
                    function saveMessage(callback) {
                        return persistMessage(msg, callback);
                    },
                    function updateStats(callback) {
                        self.updateUserAndSystemStats(callback);
                    },
                ],
                function complete(err) {
                    if (err) {
                        const errMsgView = self.viewControllers.header.getView(
                            MciViewIds.header.errorMsg
                        );
                        if (errMsgView) {
                            errMsgView.setText(err.message);
                        }
                        return cb(err);
                    }

                    //  note: not logging 'from' here as it's part of client.log.xxxx()
                    self.client.log.info(
                        {
                            to: msg.toUserName,
                            subject: msg.subject,
                            uuid: msg.messageUuid,
                        },
                        `User "${self.client.user.username}" posted message to "${msg.toUserName}" (${msg.areaTag})`
                    );

                    return self.nextMenu(cb);
                }
            );
        };
        
        this.menuMethods.editModeMenuSaveEdit = function (formData, extraArgs, cb) {
            if (!self.editMessageUuid) {
                return cb(null);
            }

            let msg;
            async.series(
                [
                    function getMessageObject(callback) {
                        self.getMessage(function gotMsg(err, msgObj) {
                            msg = msgObj;
                            return callback(err);
                        });
                    },
                    function updateExisting(callback) {
                        // Wichtig: bestehende UUID setzen, damit updateInPlace die richtige Message trifft
                        msg.messageUuid = self.editMessageUuid;

                        msg.subject = (msg.subject || '').trim();
                        msg.message = (msg.message || '').trim();

                        if (0 === msg.subject.length || 0 === msg.message.length) {
                            return callback(new Error('Field cannot be empty'));
                        }


                        // Nur subject/message/timestamp updaten (deine updateInPlace macht das)
                        return msg.updateInPlace(callback);
                    },
                ],
                function complete(err) {
                    if (err) {
                        const errMsgView = self.viewControllers.header.getView(
                            MciViewIds.header.errorMsg
                        );
                        if (errMsgView) {
                            errMsgView.setText(err.message);
                        }
                        return cb(err);
                    }

                    self.client.log.info(
                        { subject: msg.subject, uuid: msg.messageUuid },
                        `User "${self.client.user.username}" edited message (${msg.areaTag || 'n/a'})`
                    );

                    // wie beim normalen Save: zurück via Menu-Flow
                    return self.nextMenu(cb);
                }
            );
};


    }

enter() {
    this.messageAreaTag =
        this.messageAreaTag || this.client.user.getProperty(UserProps.MessageAreaTag);

    // Normal (Reply/New Post): sofort wie vorher
    if (!this.editMessageUuid) {
        return super.enter();
    }

    // EDIT: erst Message laden, DANN Screen anzeigen
    const existing = new Message();
    existing.load({ uuid: this.editMessageUuid }, err => {
        // Screen trotzdem anzeigen, selbst wenn Laden fehlschlägt
        super.enter();

        if (err) {
            this.client.log.warn(
                { err: err.message },
                'Failed to load message for edit prefill'
            );
            return;
        }

        this.editOriginalMessage = existing;

        const setField = (view, value) => {
            if (!view) return;
            const v = (value || '').toString();
            if (typeof view.setData === 'function') return view.setData(v);
            if (typeof view.setValue === 'function') return view.setValue(v);
            if (typeof view.setText === 'function') return view.setText(v);
        };

        // Prefill, sobald Views wirklich existieren
        let tries = 0;
        const prefill = () => {
            if (
                !this.viewControllers ||
                !this.viewControllers.header ||
                typeof this.viewControllers.header.getView !== 'function'
            ) {
                if (++tries > 50) {
                    this.client.log.warn('Edit prefill: views not ready after retries');
                    return;
                }
                return setTimeout(prefill, 20);
            }

            const fromView = this.viewControllers.header.getView(MciViewIds.header.from);
            setField(fromView, existing.fromUserName);

            const toView = this.viewControllers.header.getView(MciViewIds.header.to);
            setField(toView, existing.toUserName);

            const subjView = this.viewControllers.header.getView(MciViewIds.header.subject);
            setField(subjView, existing.subject);

            if (this.viewControllers.body && typeof this.viewControllers.body.getView === 'function') {
                const bodyView = this.viewControllers.body.getView(MciViewIds.body.message);
                setField(bodyView, existing.message);
            }

            // Error-Text leeren
            const errView = this.viewControllers.header.getView(MciViewIds.header.errorMsg);
            if (errView && typeof errView.setText === 'function') {
                errView.setText('');
            }

            // Fokus hart auf Betreff setzen (wenn Header-Controller das kann)
            if (this.viewControllers.header && typeof this.viewControllers.header.setFocus === 'function') {
                this.viewControllers.header.setFocus(MciViewIds.header.subject);
            } else if (subjView && typeof subjView.focus === 'function') {
                subjView.focus();
            }
        };

        // nächsten Tick, damit Rendering fertig ist
        setTimeout(prefill, 0);
    });
}


    getMessage(cb) {
    super.getMessage((err, msg) => {
        if (err) {
            return cb(err);
        }

        // Beim Edit: fehlende Pflichtfelder aus der Original-Message ergänzen
        if (this.editMessageUuid) {
            msg.messageUuid = this.editMessageUuid;

            const orig = this.editOriginalMessage;

            // "To" ist in manchen Layouts kein echtes Eingabefeld -> bleibt intern leer
            if (!msg.toUserName || 0 === msg.toUserName.trim().length) {
                msg.toUserName = (orig && orig.toUserName) ? orig.toUserName : 'All';
            }

            // From/Area sind normalerweise da – aber sicher ist sicher
            if ((!msg.fromUserName || 0 === msg.fromUserName.trim().length) && orig && orig.fromUserName) {
                msg.fromUserName = orig.fromUserName;
            }
            if ((!msg.areaTag || 0 === msg.areaTag.trim().length) && orig && orig.areaTag) {
                msg.areaTag = orig.areaTag;
            }
        }

        return cb(null, msg);
    });
}


    initSequence() {
        if (!hasMessageConfAndAreaWrite(this.client, this.messageAreaTag)) {
            const noAcsMenu =
                this.menuConfig.config.messageBasePostMessageNoAccess ||
                'messageBasePostMessageNoAccess';

            return this.gotoMenuOrShowMessage(
                noAcsMenu,
                'You do not have the proper access to post here!'
            );
        }

        super.initSequence();
    }
};
