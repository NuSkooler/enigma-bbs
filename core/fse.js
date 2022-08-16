/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { ViewController } = require('./view_controller.js');
const ansi = require('./ansi_term.js');
const theme = require('./theme.js');
const Message = require('./message.js');
const { updateMessageAreaLastReadId } = require('./message_area.js');
const { getMessageAreaByTag } = require('./message_area.js');
const User = require('./user.js');
const StatLog = require('./stat_log.js');
const stringFormat = require('./string_format.js');
const { MessageAreaConfTempSwitcher } = require('./mod_mixins.js');
const { isAnsi, stripAnsiControlCodes, insert } = require('./string_util.js');
const { stripMciColorCodes, controlCodesToAnsi } = require('./color_codes.js');
const Config = require('./config.js').get;
const { getAddressedToInfo } = require('./mail_util.js');
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const FileArea = require('./file_base_area.js');
const FileEntry = require('./file_entry.js');
const DownloadQueue = require('./download_queue.js');

//  deps
const async = require('async');
const assert = require('assert');
const _ = require('lodash');
const moment = require('moment');
const fse = require('fs-extra');
const fs = require('graceful-fs');
const paths = require('path');
const sanatizeFilename = require('sanitize-filename');

exports.moduleInfo = {
    name: 'Full Screen Editor (FSE)',
    desc: 'A full screen editor/viewer',
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

/*
    Custom formatting:
    header
        fromUserName
        toUserName

        fromRealName (may be fromUserName) NYI
        toRealName (may be toUserName) NYI

        fromRemoteUser (may be "N/A")
        toRemoteUser (may be "N/A")
        subject
        modTimestamp
        msgNum
        msgTotal (in area)
        messageId
*/

//  :TODO: convert code in this class to newer styles, conventions, etc. There is a lot of experimental stuff here that has better (DRY) alternatives

exports.FullScreenEditorModule =
    exports.getModule = class FullScreenEditorModule extends (
        MessageAreaConfTempSwitcher(MenuModule)
    ) {
        constructor(options) {
            super(options);

            const self = this;
            const config = this.menuConfig.config;

            //
            //  menuConfig.config:
            //      editorType              : email | area
            //      editorMode              : view | edit | quote
            //
            //  menuConfig.config or extraArgs
            //      messageAreaTag
            //      messageIndex / messageTotal
            //      toUserId
            //
            this.editorType = config.editorType;
            this.editorMode = config.editorMode;

            if (config.messageAreaTag) {
                //  :TODO: swtich to this.config.messageAreaTag so we can follow Object.assign pattern for config/extraArgs
                this.messageAreaTag = config.messageAreaTag;
            }

            this.messageIndex = config.messageIndex || 0;
            this.messageTotal = config.messageTotal || 0;
            this.toUserId = config.toUserId || 0;

            //  extraArgs can override some config
            if (_.isObject(options.extraArgs)) {
                if (options.extraArgs.messageAreaTag) {
                    this.messageAreaTag = options.extraArgs.messageAreaTag;
                }
                if (options.extraArgs.messageIndex) {
                    this.messageIndex = options.extraArgs.messageIndex;
                }
                if (options.extraArgs.messageTotal) {
                    this.messageTotal = options.extraArgs.messageTotal;
                }
                if (options.extraArgs.toUserId) {
                    this.toUserId = options.extraArgs.toUserId;
                }
            }

            this.noUpdateLastReadId =
                _.get(
                    options,
                    'extraArgs.noUpdateLastReadId',
                    config.noUpdateLastReadId
                ) || false;

            this.isReady = false;

            if (_.has(options, 'extraArgs.message')) {
                this.setMessage(options.extraArgs.message);
            } else if (_.has(options, 'extraArgs.replyToMessage')) {
                this.replyToMessage = options.extraArgs.replyToMessage;
            }

            this.menuMethods = {
                //
                //  Validation stuff
                //
                viewValidationListener: function (err, cb) {
                    var errMsgView = self.viewControllers.header.getView(
                        MciViewIds.header.errorMsg
                    );
                    var newFocusViewId;
                    if (errMsgView) {
                        if (err) {
                            errMsgView.setText(err.message);

                            if (MciViewIds.header.subject === err.view.getId()) {
                                //  :TODO: for "area" mode, should probably just bail if this is emtpy (e.g. cancel)
                            }
                        } else {
                            errMsgView.clearText();
                        }
                    }
                    cb(newFocusViewId);
                },
                headerSubmit: function (formData, extraArgs, cb) {
                    self.switchToBody();
                    return cb(null);
                },
                editModeEscPressed: function (formData, extraArgs, cb) {
                    self.footerMode =
                        'editor' === self.footerMode ? 'editorMenu' : 'editor';

                    self.switchFooter(function next(err) {
                        if (err) {
                            return cb(err);
                        }

                        switch (self.footerMode) {
                            case 'editor':
                                if (
                                    !_.isUndefined(self.viewControllers.footerEditorMenu)
                                ) {
                                    self.viewControllers.footerEditorMenu.detachClientEvents();
                                }
                                self.viewControllers.body.switchFocus(1);
                                self.observeEditorEvents();
                                break;

                            case 'editorMenu':
                                self.viewControllers.body.setFocus(false);
                                self.viewControllers.footerEditorMenu.switchFocus(1);
                                break;

                            default:
                                throw new Error('Unexpected mode');
                        }

                        return cb(null);
                    });
                },
                editModeMenuQuote: function (formData, extraArgs, cb) {
                    self.viewControllers.footerEditorMenu.setFocus(false);
                    self.displayQuoteBuilder();
                    return cb(null);
                },
                appendQuoteEntry: function (formData, extraArgs, cb) {
                    const quoteMsgView = self.viewControllers.quoteBuilder.getView(
                        MciViewIds.quoteBuilder.quotedMsg
                    );

                    if (self.newQuoteBlock) {
                        self.newQuoteBlock = false;

                        //  :TODO: If replying to ANSI, add a blank sepration line here

                        quoteMsgView.addText(self.getQuoteByHeader());
                    }

                    const quoteListView = self.viewControllers.quoteBuilder.getView(
                        MciViewIds.quoteBuilder.quoteLines
                    );
                    const quoteText = quoteListView.getItem(formData.value.quote);

                    quoteMsgView.addText(quoteText);

                    //
                    //  If this is *not* the last item, advance. Otherwise, do nothing as we
                    //  don't want to jump back to the top and repeat already quoted lines
                    //

                    if (quoteListView.getData() !== quoteListView.getCount() - 1) {
                        quoteListView.focusNext();
                    } else {
                        self.quoteBuilderFinalize();
                    }

                    return cb(null);
                },
                quoteBuilderEscPressed: function (formData, extraArgs, cb) {
                    self.quoteBuilderFinalize();
                    return cb(null);
                },
                /*
            replyDiscard : function(formData, extraArgs) {
                //  :TODO: need to prompt yes/no
                //  :TODO: @method for fallback would be better
                self.prevMenu();
            },
            */
                editModeMenuHelp: function (formData, extraArgs, cb) {
                    self.viewControllers.footerEditorMenu.setFocus(false);
                    return self.displayHelp(cb);
                },
                ///////////////////////////////////////////////////////////////////////
                //  View Mode
                ///////////////////////////////////////////////////////////////////////
                viewModeMenuHelp: function (formData, extraArgs, cb) {
                    self.viewControllers.footerView.setFocus(false);
                    return self.displayHelp(cb);
                },

                addToDownloadQueue: (formData, extraArgs, cb) => {
                    this.viewControllers.footerView.setFocus(false);
                    return this.addToDownloadQueue(cb);
                },
            };
        }

        isEditMode() {
            return 'edit' === this.editorMode;
        }

        isViewMode() {
            return 'view' === this.editorMode;
        }

        isPrivateMail() {
            return Message.WellKnownAreaTags.Private === this.messageAreaTag;
        }

        isReply() {
            return !_.isUndefined(this.replyToMessage);
        }

        getFooterName() {
            return 'footer' + _.upperFirst(this.footerMode); //  e.g. 'footerEditor', 'footerEditorMenu', ...
        }

        getFormId(name) {
            return {
                header: 0,
                body: 1,
                footerEditor: 2,
                footerEditorMenu: 3,
                footerView: 4,
                quoteBuilder: 5,

                help: 50,
            }[name];
        }

        getHeaderFormatObj() {
            const remoteUserNotAvail = this.menuConfig.config.remoteUserNotAvail || 'N/A';
            const localUserIdNotAvail =
                this.menuConfig.config.localUserIdNotAvail || 'N/A';
            const modTimestampFormat =
                this.menuConfig.config.modTimestampFormat ||
                this.client.currentTheme.helpers.getDateTimeFormat();

            return {
                //  :TODO: ensure we show real names for form/to if they are enforced in the area
                fromUserName: this.message.fromUserName,
                toUserName: this.message.toUserName,
                //  :TODO:
                //fromRealName
                //toRealName
                fromUserId: _.get(
                    this.message,
                    'meta.System.local_from_user_id',
                    localUserIdNotAvail
                ),
                toUserId: _.get(
                    this.message,
                    'meta.System.local_to_user_id',
                    localUserIdNotAvail
                ),
                fromRemoteUser: _.get(
                    this.message,
                    'meta.System.remote_from_user',
                    remoteUserNotAvail
                ),
                toRemoteUser: _.get(
                    this.message,
                    'meta.System.remote_to_user',
                    remoteUserNotAvail
                ),
                subject: this.message.subject,
                modTimestamp: this.message.modTimestamp.format(modTimestampFormat),
                msgNum: this.messageIndex + 1,
                msgTotal: this.messageTotal,
                messageId: this.message.messageId,
            };
        }

        setInitialFooterMode() {
            switch (this.editorMode) {
                case 'edit':
                    this.footerMode = 'editor';
                    break;
                case 'view':
                    this.footerMode = 'view';
                    break;
            }
        }

        buildMessage(cb) {
            const headerValues = this.viewControllers.header.getFormData().value;
            const area = getMessageAreaByTag(this.messageAreaTag);

            const getFromUserName = () => {
                return area && area.realNames
                    ? this.client.user.getProperty(UserProps.RealName) ||
                          this.client.user.username
                    : this.client.user.username;
            };

            let messageBody = this.viewControllers.body
                .getView(MciViewIds.body.message)
                .getData({ forceLineTerms: this.replyIsAnsi });

            const msgOpts = {
                areaTag: this.messageAreaTag,
                toUserName: headerValues.to,
                fromUserName: getFromUserName(),
                subject: headerValues.subject,
            };

            if (this.isReply()) {
                msgOpts.replyToMsgId = this.replyToMessage.messageId;

                if (this.replyIsAnsi) {
                    //
                    //  Ensure first characters indicate ANSI for detection down
                    //  the line (other boards/etc.). We also set explicit_encoding
                    //  to packetAnsiMsgEncoding (generally cp437) as various boards
                    //  really don't like ANSI messages in UTF-8 encoding (they should!)
                    //
                    msgOpts.meta = {
                        System: {
                            explicit_encoding: _.get(
                                Config(),
                                'scannerTossers.ftn_bso.packetAnsiMsgEncoding',
                                'cp437'
                            ),
                        },
                    };
                    messageBody = `${ansi.reset()}${ansi.eraseData(2)}${ansi.goto(
                        1,
                        1
                    )}\r\n${ansi.up()}${messageBody}`;
                }
            }

            //
            //  Append auto-signature, if enabled for the area & the user has one
            //
            if (false != area.autoSignatures) {
                const sig = this.client.user.getProperty(UserProps.AutoSignature);
                if (sig) {
                    messageBody += `\r\n-- \r\n${sig}`;
                }
            }

            //  finally, create the message
            msgOpts.message = messageBody;
            this.message = new Message(msgOpts);

            return cb(null);
        }

        updateLastReadId(cb) {
            if (this.noUpdateLastReadId) {
                return cb(null);
            }

            return updateMessageAreaLastReadId(
                this.client.user.userId,
                this.messageAreaTag,
                this.message.messageId,
                cb
            );
        }

        setMessage(message) {
            this.message = message;

            this.updateLastReadId(() => {
                if (this.isReady) {
                    this.initHeaderViewMode();
                    this.initFooterViewMode();

                    const bodyMessageView = this.viewControllers.body.getView(
                        MciViewIds.body.message
                    );
                    let msg = this.message.message;

                    if (bodyMessageView && _.has(this, 'message.message')) {
                        //
                        //  We handle ANSI messages differently than standard messages -- this is required as
                        //  we don't want to do things like word wrap ANSI, but instead, trust that it's formatted
                        //  how the author wanted it
                        //
                        if (isAnsi(msg)) {
                            //
                            //  Find tearline - we want to color it differently.
                            //
                            const tearLinePos = Message.getTearLinePosition(msg);

                            if (tearLinePos > -1) {
                                msg = insert(
                                    msg,
                                    tearLinePos,
                                    bodyMessageView.getSGRFor('text')
                                );
                            }

                            bodyMessageView.setAnsi(
                                msg.replace(/\r?\n/g, '\r\n'), //  messages are stored with CRLF -> LF
                                {
                                    prepped: false,
                                    forceLineTerm: true,
                                }
                            );
                        } else {
                            msg = stripAnsiControlCodes(msg); //  start clean

                            const styleToArray = (style, len) => {
                                if (!Array.isArray(style)) {
                                    style = [style];
                                }
                                while (style.length < len) {
                                    style.push(style[0]);
                                }
                                return style;
                            };

                            //
                            //  In *View* mode, if enabled, do a little prep work so we can stylize:
                            //  - Quote indicators
                            //  - Tear lines
                            //  - Origins
                            //
                            if (this.menuConfig.config.quoteStyleLevel1) {
                                //  can be a single style to cover 'XX> TEXT' or an array to cover 'XX', '>', and TEXT
                                //  Non-standard (as for BBSes) single > TEXT, omitting space before XX, etc. are allowed
                                const styleL1 = styleToArray(
                                    this.menuConfig.config.quoteStyleLevel1,
                                    3
                                );

                                const QuoteRegex =
                                    /^([ ]?)([!-~]{0,2})>([ ]*)([^\r\n]*\r?\n)/gm;
                                msg = msg.replace(
                                    QuoteRegex,
                                    (m, spc1, initials, spc2, text) => {
                                        return `${spc1}${styleL1[0]}${initials}${styleL1[1]}>${spc2}${styleL1[2]}${text}${bodyMessageView.styleSGR1}`;
                                    }
                                );
                            }

                            if (this.menuConfig.config.tearLineStyle) {
                                //  '---' and TEXT
                                const style = styleToArray(
                                    this.menuConfig.config.tearLineStyle,
                                    2
                                );

                                const TearLineRegex = /^--- (.+)$(?![\s\S]*^--- .+$)/m;
                                msg = msg.replace(TearLineRegex, (m, text) => {
                                    return `${style[0]}--- ${style[1]}${text}${bodyMessageView.styleSGR1}`;
                                });
                            }

                            if (this.menuConfig.config.originStyle) {
                                const style = styleToArray(
                                    this.menuConfig.config.originStyle,
                                    3
                                );

                                const OriginRegex = /^([ ]{1,2})\* Origin: (.+)$/m;
                                msg = msg.replace(OriginRegex, (m, spc, text) => {
                                    return `${spc}${style[0]}* ${style[1]}Origin: ${style[2]}${text}${bodyMessageView.styleSGR1}`;
                                });
                            }

                            bodyMessageView.setText(controlCodesToAnsi(msg));
                        }
                    }
                }
            });
        }

        getMessage(cb) {
            const self = this;

            async.series(
                [
                    function buildIfNecessary(callback) {
                        if (self.isEditMode()) {
                            return self.buildMessage(callback); //  creates initial self.message
                        }

                        return callback(null);
                    },
                    function populateLocalUserInfo(callback) {
                        self.message.setLocalFromUserId(self.client.user.userId);

                        if (!self.isPrivateMail()) {
                            return callback(null);
                        }

                        if (self.toUserId > 0) {
                            self.message.setLocalToUserId(self.toUserId);
                            return callback(null);
                        }

                        //
                        //  If the message we're replying to is from a remote user
                        //  don't try to look up the local user ID. Instead, mark the mail
                        //  for export with the remote to address.
                        //
                        if (
                            self.replyToMessage &&
                            self.replyToMessage.isFromRemoteUser()
                        ) {
                            self.message.setRemoteToUser(
                                self.replyToMessage.meta.System[
                                    Message.SystemMetaNames.RemoteFromUser
                                ]
                            );
                            self.message.setExternalFlavor(
                                self.replyToMessage.meta.System[
                                    Message.SystemMetaNames.ExternalFlavor
                                ]
                            );
                            return callback(null);
                        }

                        //
                        //  Detect if the user is attempting to send to a remote mail type that we support
                        //
                        //  :TODO: how to plug in support without tying to various types here? isSupportedExteranlType() or such
                        const addressedToInfo = getAddressedToInfo(
                            self.message.toUserName
                        );
                        if (
                            addressedToInfo.name &&
                            Message.AddressFlavor.FTN === addressedToInfo.flavor
                        ) {
                            self.message.setRemoteToUser(addressedToInfo.remote);
                            self.message.setExternalFlavor(addressedToInfo.flavor);
                            self.message.toUserName = addressedToInfo.name;
                            return callback(null);
                        }

                        //  we need to look it up
                        User.getUserIdAndNameByLookup(
                            self.message.toUserName,
                            (err, toUserId) => {
                                if (err) {
                                    return callback(err);
                                }

                                self.message.setLocalToUserId(toUserId);
                                return callback(null);
                            }
                        );
                    },
                ],
                err => {
                    return cb(err, self.message);
                }
            );
        }

        updateUserAndSystemStats(cb) {
            if (Message.isPrivateAreaTag(this.message.areaTag)) {
                Events.emit(Events.getSystemEvents().UserSendMail, {
                    user: this.client.user,
                });
                if (cb) {
                    cb(null);
                }
                return; //  don't inc stats for private messages
            }

            Events.emit(Events.getSystemEvents().UserPostMessage, {
                user: this.client.user,
                areaTag: this.message.areaTag,
            });

            StatLog.incrementNonPersistentSystemStat(SysProps.MessageTotalCount, 1);
            StatLog.incrementNonPersistentSystemStat(SysProps.MessagesToday, 1);
            return StatLog.incrementUserStat(
                this.client.user,
                UserProps.MessagePostCount,
                1,
                cb
            );
        }

        redrawFooter(options, cb) {
            const self = this;

            async.waterfall(
                [
                    function moveToFooterPosition(callback) {
                        //
                        //  Calculate footer starting position
                        //
                        //  row = (header height + body height)
                        //
                        var footerRow = self.header.height + self.body.height;
                        self.client.term.rawWrite(ansi.goto(footerRow, 1));
                        callback(null);
                    },
                    function clearFooterArea(callback) {
                        if (options.clear) {
                            //  footer up to 3 rows in height

                            //  :TODO: We'd like to delete up to N rows, but this does not work
                            //  in NetRunner:
                            self.client.term.rawWrite(ansi.reset() + ansi.deleteLine(3));

                            self.client.term.rawWrite(ansi.reset() + ansi.eraseLine(2));
                        }
                        callback(null);
                    },
                    function displayFooterArt(callback) {
                        const footerArt = self.menuConfig.config.art[options.footerName];

                        theme.displayThemedAsset(
                            footerArt,
                            self.client,
                            {
                                font: self.menuConfig.font,
                                startRow: self.header.height + self.body.height,
                            },
                            function displayed(err, artData) {
                                callback(err, artData);
                            }
                        );
                    },
                ],
                function complete(err, artData) {
                    cb(err, artData);
                }
            );
        }

        redrawScreen(cb) {
            var comps = ['header', 'body'];
            const self = this;
            var art = self.menuConfig.config.art;

            self.client.term.rawWrite(ansi.resetScreen());

            async.series(
                [
                    function displayHeaderAndBody(callback) {
                        async.waterfall(
                            [
                                function displayHeader(callback) {
                                    theme.displayThemedAsset(
                                        art['header'],
                                        self.client,
                                        { font: self.menuConfig.font },
                                        function displayed(err, artInfo) {
                                            return callback(err, artInfo);
                                        }
                                    );
                                },
                                function displayBody(artInfo, callback) {
                                    theme.displayThemedAsset(
                                        art['header'],
                                        self.client,
                                        {
                                            font: self.menuConfig.font,
                                            startRow: artInfo.height + 1,
                                        },
                                        function displayed(err, artInfo) {
                                            return callback(err, artInfo);
                                        }
                                    );
                                },
                            ],
                            function complete(err) {
                                //self.body.height = self.client.term.termHeight - self.header.height - 1;
                                callback(err);
                            }
                        );
                    },
                    function displayFooter(callback) {
                        //  we have to treat the footer special
                        self.redrawFooter(
                            { clear: false, footerName: self.getFooterName() },
                            function footerDisplayed(err) {
                                callback(err);
                            }
                        );
                    },
                    function refreshViews(callback) {
                        comps.push(self.getFooterName());

                        comps.forEach(function artComp(n) {
                            self.viewControllers[n].redrawAll();
                        });

                        callback(null);
                    },
                ],
                function complete(err) {
                    cb(err);
                }
            );
        }

        switchFooter(cb) {
            var footerName = this.getFooterName();

            this.redrawFooter({ footerName: footerName, clear: true }, (err, artData) => {
                if (err) {
                    cb(err);
                    return;
                }

                var formId = this.getFormId(footerName);

                if (_.isUndefined(this.viewControllers[footerName])) {
                    var menuLoadOpts = {
                        callingMenu: this,
                        formId: formId,
                        mciMap: artData.mciMap,
                    };

                    this.addViewController(
                        footerName,
                        new ViewController({ client: this.client, formId: formId })
                    ).loadFromMenuConfig(menuLoadOpts, err => {
                        cb(err);
                    });
                } else {
                    this.viewControllers[footerName].redrawAll();
                    cb(null);
                }
            });
        }

        initSequence() {
            var mciData = {};
            const self = this;
            var art = self.menuConfig.config.art;

            assert(_.isObject(art));

            async.waterfall(
                [
                    function beforeDisplayArt(callback) {
                        self.beforeArt(callback);
                    },
                    function displayHeader(callback) {
                        theme.displayThemedAsset(
                            art.header,
                            self.client,
                            { font: self.menuConfig.font },
                            function displayed(err, artInfo) {
                                if (artInfo) {
                                    mciData['header'] = artInfo;
                                    self.header = { height: artInfo.height };
                                }
                                return callback(err, artInfo);
                            }
                        );
                    },
                    function displayBody(artInfo, callback) {
                        theme.displayThemedAsset(
                            art.body,
                            self.client,
                            { font: self.menuConfig.font, startRow: artInfo.height + 1 },
                            function displayed(err, artInfo) {
                                if (artInfo) {
                                    mciData['body'] = artInfo;
                                    self.body = {
                                        height: artInfo.height - self.header.height,
                                    };
                                }
                                return callback(err, artInfo);
                            }
                        );
                    },
                    function displayFooter(artInfo, callback) {
                        self.setInitialFooterMode();

                        var footerName = self.getFooterName();

                        self.redrawFooter(
                            { footerName: footerName },
                            function artDisplayed(err, artData) {
                                mciData[footerName] = artData;
                                callback(err);
                            }
                        );
                    },
                    function afterArtDisplayed(callback) {
                        self.mciReady(mciData, callback);
                    },
                ],
                function complete(err) {
                    if (err) {
                        self.client.log.warn({ error: err.message }, 'FSE init error');
                    } else {
                        self.isReady = true;
                        self.finishedLoading();
                    }
                }
            );
        }

        createInitialViews(mciData, cb) {
            const self = this;
            var menuLoadOpts = { callingMenu: self };

            async.series(
                [
                    function header(callback) {
                        menuLoadOpts.formId = self.getFormId('header');
                        menuLoadOpts.mciMap = mciData.header.mciMap;

                        self.addViewController(
                            'header',
                            new ViewController({
                                client: self.client,
                                formId: menuLoadOpts.formId,
                            })
                        ).loadFromMenuConfig(menuLoadOpts, function headerReady(err) {
                            callback(err);
                        });
                    },
                    function body(callback) {
                        menuLoadOpts.formId = self.getFormId('body');
                        menuLoadOpts.mciMap = mciData.body.mciMap;

                        self.addViewController(
                            'body',
                            new ViewController({
                                client: self.client,
                                formId: menuLoadOpts.formId,
                            })
                        ).loadFromMenuConfig(menuLoadOpts, function bodyReady(err) {
                            callback(err);
                        });
                    },
                    function footer(callback) {
                        var footerName = self.getFooterName();

                        menuLoadOpts.formId = self.getFormId(footerName);
                        menuLoadOpts.mciMap = mciData[footerName].mciMap;

                        self.addViewController(
                            footerName,
                            new ViewController({
                                client: self.client,
                                formId: menuLoadOpts.formId,
                            })
                        ).loadFromMenuConfig(menuLoadOpts, function footerReady(err) {
                            callback(err);
                        });
                    },
                    function prepareViewStates(callback) {
                        let from = self.viewControllers.header.getView(
                            MciViewIds.header.from
                        );
                        if (from) {
                            from.acceptsFocus = false;
                        }

                        //  :TODO: make this a method
                        var body = self.viewControllers.body.getView(
                            MciViewIds.body.message
                        );
                        self.updateTextEditMode(body.getTextEditMode());
                        self.updateEditModePosition(body.getEditPosition());

                        //  :TODO: If view mode, set body to read only... which needs an impl...

                        callback(null);
                    },
                    function setInitialData(callback) {
                        switch (self.editorMode) {
                            case 'view':
                                if (self.message) {
                                    self.initHeaderViewMode();
                                    self.initFooterViewMode();

                                    var bodyMessageView =
                                        self.viewControllers.body.getView(
                                            MciViewIds.body.message
                                        );
                                    if (
                                        bodyMessageView &&
                                        _.has(self, 'message.message')
                                    ) {
                                        //self.setBodyMessageViewText();
                                        bodyMessageView.setText(
                                            stripAnsiControlCodes(self.message.message)
                                        );
                                    }
                                }
                                break;

                            case 'edit':
                                {
                                    const fromView = self.viewControllers.header.getView(
                                        MciViewIds.header.from
                                    );
                                    const area = getMessageAreaByTag(self.messageAreaTag);
                                    if (fromView !== undefined) {
                                        if (area && area.realNames) {
                                            fromView.setText(
                                                self.client.user.properties[
                                                    UserProps.RealName
                                                ] || self.client.user.username
                                            );
                                        } else {
                                            fromView.setText(self.client.user.username);
                                        }
                                    }

                                    if (self.replyToMessage) {
                                        self.initHeaderReplyEditMode();
                                    }
                                }
                                break;
                        }

                        callback(null);
                    },
                    function setInitialFocus(callback) {
                        switch (self.editorMode) {
                            case 'edit':
                                self.switchToHeader();
                                break;

                            case 'view':
                                self.switchToFooter();
                                //self.observeViewPosition();
                                break;
                        }

                        callback(null);
                    },
                ],
                function complete(err) {
                    return cb(err);
                }
            );
        }

        mciReadyHandler(mciData, cb) {
            this.createInitialViews(mciData, err => {
                //  :TODO: Can probably be replaced with @systemMethod:validateUserNameExists when the framework is in
                //  place - if this is for existing usernames else validate spec

                /*
            self.viewControllers.header.on('leave', function headerViewLeave(view) {

                if(2 === view.id) { //  "to" field
                    self.validateToUserName(view.getData(), function result(err) {
                        if(err) {
                            //  :TODO: display a error in a %TL area or such
                            view.clearText();
                            self.viewControllers.headers.switchFocus(2);
                        }
                    });
                }
            });*/

                cb(err);
            });
        }

        updateEditModePosition(pos) {
            if (this.isEditMode()) {
                var posView = this.viewControllers.footerEditor.getView(1);
                if (posView) {
                    this.client.term.rawWrite(ansi.savePos());
                    //  :TODO: Use new formatting techniques here, e.g. state.cursorPositionRow, cursorPositionCol and cursorPositionFormat
                    posView.setText(
                        _.padStart(String(pos.row + 1), 2, '0') +
                            ',' +
                            _.padEnd(String(pos.col + 1), 2, '0')
                    );
                    this.client.term.rawWrite(ansi.restorePos());
                }
            }
        }

        updateTextEditMode(mode) {
            if (this.isEditMode()) {
                var modeView = this.viewControllers.footerEditor.getView(2);
                if (modeView) {
                    this.client.term.rawWrite(ansi.savePos());
                    modeView.setText('insert' === mode ? 'INS' : 'OVR');
                    this.client.term.rawWrite(ansi.restorePos());
                }
            }
        }

        setHeaderText(id, text) {
            this.setViewText('header', id, text);
        }

        initHeaderViewMode() {
            // Only set header text for from view if it is on the form
            if (
                this.viewControllers.header.getView(MciViewIds.header.from) !== undefined
            ) {
                this.setHeaderText(MciViewIds.header.from, this.message.fromUserName);
            }
            this.setHeaderText(MciViewIds.header.to, this.message.toUserName);
            this.setHeaderText(MciViewIds.header.subject, this.message.subject);

            this.setHeaderText(
                MciViewIds.header.modTimestamp,
                moment(this.message.modTimestamp).format(
                    this.menuConfig.config.modTimestampFormat ||
                        this.client.currentTheme.helpers.getDateTimeFormat()
                )
            );

            this.setHeaderText(
                MciViewIds.header.msgNum,
                (this.messageIndex + 1).toString()
            );
            this.setHeaderText(MciViewIds.header.msgTotal, this.messageTotal.toString());

            this.updateCustomViewTextsWithFilter(
                'header',
                MciViewIds.header.customRangeStart,
                this.getHeaderFormatObj()
            );

            //  if we changed conf/area we need to update any related standard MCI view
            this.refreshPredefinedMciViewsByCode('header', ['MA', 'MC', 'ML', 'CM']);
        }

        initHeaderReplyEditMode() {
            assert(_.isObject(this.replyToMessage));

            this.setHeaderText(MciViewIds.header.to, this.replyToMessage.fromUserName);

            //
            //  We want to prefix the subject with "RE: " only if it's not already
            //  that way -- avoid RE: RE: RE: RE: ...
            //
            let newSubj = this.replyToMessage.subject;
            if (false === /^RE:\s+/i.test(newSubj)) {
                newSubj = `RE: ${newSubj}`;
            }

            this.setHeaderText(MciViewIds.header.subject, newSubj);
        }

        initFooterViewMode() {
            this.setViewText(
                'footerView',
                MciViewIds.ViewModeFooter.msgNum,
                (this.messageIndex + 1).toString()
            );
            this.setViewText(
                'footerView',
                MciViewIds.ViewModeFooter.msgTotal,
                this.messageTotal.toString()
            );
        }

        displayHelp(cb) {
            this.client.term.rawWrite(ansi.resetScreen());

            theme.displayThemeArt(
                { name: this.menuConfig.config.art.help, client: this.client },
                () => {
                    this.client.waitForKeyPress(() => {
                        this.redrawScreen(() => {
                            this.viewControllers[this.getFooterName()].setFocus(true);
                            return cb(null);
                        });
                    });
                }
            );
        }

        addToDownloadQueue(cb) {
            const sysTempDownloadArea = FileArea.getFileAreaByTag(
                FileArea.WellKnownAreaTags.TempDownloads
            );
            const sysTempDownloadDir =
                FileArea.getAreaDefaultStorageDirectory(sysTempDownloadArea);

            const msgInfo = this.getHeaderFormatObj();

            const outputFileName = paths.join(
                sysTempDownloadDir,
                sanatizeFilename(
                    `(${msgInfo.messageId}) ${
                        msgInfo.subject
                    }_(${this.message.modTimestamp.format('YYYY-MM-DD')}).txt`
                )
            );

            async.waterfall(
                [
                    callback => {
                        const header = `+${'-'.repeat(79)}
| To      : ${msgInfo.toUserName}
| From    : ${msgInfo.fromUserName}
| When    : ${moment(this.message.modTimestamp).format(
                            'dddd, MMMM Do YYYY, h:mm:ss a (UTCZ)'
                        )}
| Subject : ${msgInfo.subject}
| ID      : ${this.message.messageUuid} (${msgInfo.messageId})
+${'-'.repeat(79)}
`;
                        const body = this.viewControllers.body
                            .getView(MciViewIds.body.message)
                            .getData({ forceLineTerms: true });

                        const cleanBody = stripMciColorCodes(
                            stripAnsiControlCodes(body, { all: true })
                        );

                        const exportedMessage = `${header}\r\n${cleanBody}`;

                        fse.mkdirs(sysTempDownloadDir, err => {
                            return callback(err, exportedMessage);
                        });
                    },
                    (exportedMessage, callback) => {
                        return fs.writeFile(
                            outputFileName,
                            exportedMessage,
                            'utf8',
                            callback
                        );
                    },
                    callback => {
                        fs.stat(outputFileName, (err, stats) => {
                            return callback(err, stats.size);
                        });
                    },
                    (fileSize, callback) => {
                        const newEntry = new FileEntry({
                            areaTag: sysTempDownloadArea.areaTag,
                            fileName: paths.basename(outputFileName),
                            storageTag: sysTempDownloadArea.storageTags[0],
                            meta: {
                                upload_by_username: this.client.user.username,
                                upload_by_user_id: this.client.user.userId,
                                byte_size: fileSize,
                                session_temp_dl: 1, //  download is valid until session is over
                            },
                        });

                        newEntry.desc = `${msgInfo.messageId} - ${msgInfo.subject}`;

                        newEntry.persist(err => {
                            if (!err) {
                                //  queue it!
                                DownloadQueue.get(this.client).addTemporaryDownload(
                                    newEntry
                                );
                            }
                            return callback(err);
                        });
                    },
                    callback => {
                        const artSpec =
                            this.menuConfig.config.art.expToDlQueue ||
                            Buffer.from(
                                'Exported message has been added to your download queue!'
                            );
                        this.displayAsset(artSpec, { clearScreen: true }, () => {
                            this.client.waitForKeyPress(() => {
                                this.redrawScreen(() => {
                                    this.viewControllers[this.getFooterName()].setFocus(
                                        true
                                    );
                                    return callback(null);
                                });
                            });
                        });
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        }

        displayQuoteBuilder() {
            //
            //  Clear body area
            //
            this.newQuoteBlock = true;
            const self = this;

            async.waterfall(
                [
                    function clearAndDisplayArt(callback) {
                        //  :TODO: NetRunner does NOT support delete line, so this does not work:
                        self.client.term.rawWrite(
                            ansi.goto(self.header.height + 1, 1) +
                                ansi.deleteLine(
                                    self.client.term.termHeight - self.header.height - 1
                                )
                        );

                        theme.displayThemeArt(
                            {
                                name: self.menuConfig.config.art.quote,
                                client: self.client,
                            },
                            function displayed(err, artData) {
                                callback(err, artData);
                            }
                        );
                    },
                    function createViewsIfNecessary(artData, callback) {
                        var formId = self.getFormId('quoteBuilder');

                        if (_.isUndefined(self.viewControllers.quoteBuilder)) {
                            var menuLoadOpts = {
                                callingMenu: self,
                                formId: formId,
                                mciMap: artData.mciMap,
                                viewOffsets: {
                                    col: 0,
                                    row: self.header.height,
                                },
                            };

                            self.addViewController(
                                'quoteBuilder',
                                new ViewController({
                                    client: self.client,
                                    formId: formId,
                                })
                            ).loadFromMenuConfig(
                                menuLoadOpts,
                                function quoteViewsReady(err) {
                                    callback(err);
                                }
                            );
                        } else {
                            self.viewControllers.quoteBuilder.redrawAll();
                            callback(null);
                        }
                    },
                    function loadQuoteLines(callback) {
                        const quoteView = self.viewControllers.quoteBuilder.getView(
                            MciViewIds.quoteBuilder.quoteLines
                        );
                        const bodyView = self.viewControllers.body.getView(
                            MciViewIds.body.message
                        );

                        self.replyToMessage.getQuoteLines(
                            {
                                termWidth: self.client.term.termWidth,
                                termHeight: self.client.term.termHeight,
                                cols: quoteView.dimens.width,
                                startCol: quoteView.position.col,
                                ansiResetSgr: bodyView.styleSGR1,
                                ansiFocusPrefixSgr: quoteView.styleSGR2,
                            },
                            (err, quoteLines, focusQuoteLines, replyIsAnsi) => {
                                if (err) {
                                    return callback(err);
                                }

                                self.replyIsAnsi = replyIsAnsi;

                                quoteView.setItems(quoteLines);
                                quoteView.setFocusItems(focusQuoteLines);

                                self.viewControllers.quoteBuilder
                                    .getView(MciViewIds.quoteBuilder.quotedMsg)
                                    .setFocus(false);
                                self.viewControllers.quoteBuilder.switchFocus(
                                    MciViewIds.quoteBuilder.quoteLines
                                );

                                return callback(null);
                            }
                        );
                    },
                ],
                function complete(err) {
                    if (err) {
                        self.client.log.warn(
                            { error: err.message },
                            'Error displaying quote builder'
                        );
                    }
                }
            );
        }

        observeEditorEvents() {
            const bodyView = this.viewControllers.body.getView(MciViewIds.body.message);

            bodyView.on('edit position', pos => {
                this.updateEditModePosition(pos);
            });

            bodyView.on('text edit mode', mode => {
                this.updateTextEditMode(mode);
            });
        }

        /*
    this.observeViewPosition = function() {
        self.viewControllers.body.getView(MciViewIds.body.message).on('edit position', function positionUpdate(pos) {
            console.log(pos.percent + ' / ' + pos.below)
        });
    };
    */

        switchToHeader() {
            this.viewControllers.body.setFocus(false);
            this.viewControllers.header.switchFocus(2); //  to
        }

        switchToBody() {
            this.viewControllers.header.setFocus(false);
            this.viewControllers.body.switchFocus(1);

            this.observeEditorEvents();
        }

        switchToFooter() {
            this.viewControllers.header.setFocus(false);
            this.viewControllers.body.setFocus(false);

            this.viewControllers[this.getFooterName()].switchFocus(1); //  HM1
        }

        switchFromQuoteBuilderToBody() {
            this.viewControllers.quoteBuilder.setFocus(false);
            var body = this.viewControllers.body.getView(MciViewIds.body.message);
            body.redraw();
            this.viewControllers.body.switchFocus(1);

            //  :TODO: create method (DRY)

            this.updateTextEditMode(body.getTextEditMode());
            this.updateEditModePosition(body.getEditPosition());

            this.observeEditorEvents();
        }

        quoteBuilderFinalize() {
            //  :TODO: fix magic #'s
            const quoteMsgView = this.viewControllers.quoteBuilder.getView(
                MciViewIds.quoteBuilder.quotedMsg
            );
            const msgView = this.viewControllers.body.getView(MciViewIds.body.message);

            let quoteLines = quoteMsgView.getData().trim();

            if (quoteLines.length > 0) {
                if (this.replyIsAnsi) {
                    const bodyMessageView = this.viewControllers.body.getView(
                        MciViewIds.body.message
                    );
                    quoteLines += `${ansi.normal()}${bodyMessageView.getSGRFor('text')}`;
                }
                msgView.addText(`${quoteLines}\n\n`);
            }

            quoteMsgView.setText('');

            this.footerMode = 'editor';

            this.switchFooter(() => {
                this.switchFromQuoteBuilderToBody();
            });
        }

        getQuoteByHeader() {
            let quoteFormat = this.menuConfig.config.quoteFormats;

            if (Array.isArray(quoteFormat)) {
                quoteFormat = quoteFormat[Math.floor(Math.random() * quoteFormat.length)];
            } else if (!_.isString(quoteFormat)) {
                quoteFormat = 'On {dateTime} {userName} said...';
            }

            const dtFormat =
                this.menuConfig.config.quoteDateTimeFormat ||
                this.client.currentTheme.helpers.getDateTimeFormat();
            return stringFormat(quoteFormat, {
                dateTime: moment(this.replyToMessage.modTimestamp).format(dtFormat),
                userName: this.replyToMessage.fromUserName,
            });
        }

        enter() {
            if (this.messageAreaTag) {
                this.tempMessageConfAndAreaSwitch(this.messageAreaTag);
            }

            super.enter();
        }

        leave() {
            this.tempMessageConfAndAreaRestore();
            super.leave();
        }

        mciReady(mciData, cb) {
            return this.mciReadyHandler(mciData, cb);
        }
    };
