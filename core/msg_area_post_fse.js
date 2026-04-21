/* jslint node: true */
'use strict';

const { FullScreenEditorModule, MciViewIds } = require('./fse.js');
const persistMessage = require('./message_area.js').persistMessage;
const UserProps = require('./user_property.js');
const { hasMessageConfAndAreaWrite } = require('./message_area.js');
const { AddressFlavor } = require('./message_const.js');

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
    }

    _isApReply() {
        return (
            this.replyToMessage &&
            this.replyToMessage.isFromRemoteUser() &&
            this.replyToMessage.getAddressFlavor() === AddressFlavor.ActivityPub
        );
    }

    //  For ActivityPub replies, use Markdown-style `> ` quote prefix
    //  instead of the FidoNet initials-based `Nu> ` style.
    _getQuoteLineOptions() {
        return this._isApReply() ? { quotePrefix: '> ' } : {};
    }

    //  AP clients don't use "On {date} {user} said..." attribution headers;
    //  suppress the header line entirely for AP replies.
    getQuoteByHeader() {
        return this._isApReply() ? '' : super.getQuoteByHeader();
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
