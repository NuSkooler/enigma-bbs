/* jslint node: true */
'use strict';

const FullScreenEditorModule = require('./fse.js').FullScreenEditorModule;
const persistMessage = require('./message_area.js').persistMessage;
const UserProps = require('./user_property.js');
const { hasMessageConfAndAreaWrite } = require('./message_area.js');

const async = require('async');

exports.moduleInfo = {
    name: 'Message Area Post',
    desc: 'Module for posting a new message to an area',
    author: 'NuSkooler',
};

exports.getModule = class AreaPostFSEModule extends FullScreenEditorModule {
    constructor(options) {
        super(options);

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
                        //  :TODO:... sooooo now what?
                    } else {
                        //  note: not logging 'from' here as it's part of client.log.xxxx()
                        self.client.log.info(
                            {
                                to: msg.toUserName,
                                subject: msg.subject,
                                uuid: msg.messageUuid,
                            },
                            'Message persisted'
                        );
                    }

                    return self.nextMenu(cb);
                }
            );
        };
    }

    enter() {
        this.messageAreaTag =
            this.messageAreaTag || this.client.user.getProperty(UserProps.MessageAreaTag);

        super.enter();
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
