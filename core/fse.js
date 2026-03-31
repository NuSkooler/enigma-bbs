/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { ViewController } = require('./view_controller.js');
const ansi = require('./ansi_term.js');
const theme = require('./theme.js');
const Message = require('./message.js');
const { updateMessageAreaLastReadId, getMessageAreaByTag } = require('./message_area.js');
const User = require('./user.js');
const StatLog = require('./stat_log.js');
const stringFormat = require('./string_format.js');
const { MessageAreaConfTempSwitcher } = require('./mod_mixins.js');
const { isAnsi, stripAnsiControlCodes, insert } = require('./string_util.js');
const { stripMciColorCodes, controlCodesToAnsi } = require('./color_codes.js');
const Config = require('./config.js').get;
const {
    getAddressedToInfo,
    messageInfoFromAddressedToInfo,
    setExternalAddressedToInfo,
    copyExternalAddressedToInfo,
    getReplyToMessagePrefix,
} = require('./mail_util.js');
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const FileArea = require('./file_base_area.js');
const FileEntry = require('./file_entry.js');
const DownloadQueue = require('./download_queue.js');
const MessageConst = require('./message_const');

//  deps
const async = require('async');
const moment = require('moment');
const fse = require('fs-extra');
const fs = require('graceful-fs');
const paths = require('path');
const sanitizeFilename = require('sanitize-filename');
const { ErrorReasons } = require('./enig_error.js');
const { pathWithTerminatingSeparator } = require('./file_util.js');
const temptmp = require('temptmp').createTrackedSession('fse');
const iconv = require('iconv-lite');

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

    ViewModeFooter: {
        MsgNum: 6,
        MsgTotal: 7,
        //  :TODO: Just use custom ranges
    },

    EditorFooter: {
        status: 1,  //  SB1 — panel status bar (panels: mode, pos)
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
                //  :TODO: switch to this.config.messageAreaTag so we can follow Object.assign pattern for config/extraArgs
                this.messageAreaTag = config.messageAreaTag;
            }

            this.messageIndex = config.messageIndex || 0;
            this.messageTotal = config.messageTotal || 0;
            this.toUserId = config.toUserId || 0;

            //  extraArgs can override some config
            if (options.extraArgs && typeof options.extraArgs === 'object') {
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
                (options?.extraArgs?.noUpdateLastReadId ?? config.noUpdateLastReadId) || false;

            this.isReady = false;

            if (options?.extraArgs?.message !== undefined) {
                this.setMessage(options.extraArgs.message);
            } else if (options?.extraArgs?.replyToMessage !== undefined) {
                this.replyToMessage = options.extraArgs.replyToMessage;
            }

            //  When returning from a file-transfer sub-menu, the transfer module's
            //  getMenuResult() lands here.  Store the paths so createInitialViews()
            //  can load them into the body after state is restored.
            if (options?.lastMenuResult?.recvFilePaths?.length > 0) {
                this._pendingUploadFiles = options.lastMenuResult.recvFilePaths;
            }

            this.menuMethods = {
                //
                //  Validation stuff
                //
                viewValidationListener: (err, cb) => {
                    if (
                        err &&
                        err.view.getId() === MciViewIds.header.subject &&
                        err.reasonCode === ErrorReasons.ValueTooShort
                    ) {
                        // Ignore validation errors if this is the subject field
                        // and it's optional
                        const areaInfo = getMessageAreaByTag(this.messageAreaTag);
                        if (true === areaInfo.subjectOptional) {
                            return cb(null, null);
                        }

                        // private messages are a little different...
                        const toView = this.getView('header', MciViewIds.header.to);
                        const msgInfo = messageInfoFromAddressedToInfo(
                            getAddressedToInfo(toView.getData())
                        );
                        if (true === msgInfo.subjectOptional) {
                            return cb(null, null);
                        }
                    }

                    const errMsgView = this.viewControllers.header.getView(
                        MciViewIds.header.errorMsg
                    );
                    if (errMsgView) {
                        if (err) {
                            errMsgView.clearText();
                            errMsgView.setText(err.friendlyText || err.message);

                            if (MciViewIds.header.subject === err.view.getId()) {
                                //  :TODO: for "area" mode, should probably just bail if this is emtpy (e.g. cancel)
                            }
                        } else {
                            errMsgView.clearText();
                        }
                    }

                    return cb(err, null);
                },
                headerSubmit: function (formData, extraArgs, cb) {
                    self.switchToBody();
                    return cb(null);
                },
                editModeEscPressed: function (formData, extraArgs, cb) {
                    const errMsgView = self.viewControllers.header.getView(
                        MciViewIds.header.errorMsg
                    );
                    if (errMsgView) {
                        errMsgView.clearText();
                    }

                    self.footerMode =
                        'editor' === self.footerMode ? 'editorMenu' : 'editor';

                    self.switchFooter(function next(err) {
                        if (err) {
                            return cb(err);
                        }

                        switch (self.footerMode) {
                            case 'editor':
                                if (self.viewControllers.footerEditorMenu !== undefined) {
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

                        //  :TODO: If replying to ANSI, add a blank separation line here

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
                //  Ctrl-S quick save: delegates to whichever subclass defined editModeMenuSave.
                editModeQuickSave: function (formData, extraArgs, cb) {
                    if ('function' === typeof self.menuMethods.editModeMenuSave) {
                        return self.menuMethods.editModeMenuSave(formData, extraArgs, cb);
                    }
                    return cb(null);
                },
                //  Ctrl-O quick help: open help screen without going through the ESC menu.
                editModeQuickHelp: function (_formData, _extraArgs, cb) {
                    return self.displayHelp(cb);
                },
                editModeMenuUpload: function (formData, extraArgs, cb) {
                    //
                    //  Receive a file via the configured transfer protocol and load
                    //  it into the message body.  ANSI art is detected automatically;
                    //  plain text falls through to setText().
                    //
                    self.viewControllers.footerEditorMenu.setFocus(false);
                    temptmp.mkdir({ prefix: 'enigfseul-' }, (err, tempDir) => {
                        if (err) {
                            self.client.log.warn({ err }, 'FSE: failed to create upload temp dir');
                            return cb(err);
                        }
                        //  Store dir so getSaveState() can include it for cleanup on re-entry.
                        self._pendingTempUploadDir = pathWithTerminatingSeparator(tempDir);
                        const modOpts = {
                            extraArgs: {
                                recvDirectory:  self._pendingTempUploadDir,
                                direction:      'recv',
                                returnToCaller: true,   //  skip fileBaseUploadFiles; return to FSE
                            },
                        };
                        return self.gotoMenu(
                            self.menuConfig.config.fileTransferProtocolSelection ||
                                'fileTransferProtocolSelection',
                            modOpts,
                            cb
                        );
                    });
                },
                ///////////////////////////////////////////////////////////////////////
                //  Find / Search
                ///////////////////////////////////////////////////////////////////////
                editModeFind: function (formData, extraArgs, cb) {
                    self.viewControllers.body.setFocus(false);
                    return self.openFindPrompt(cb);
                },
                editModeFindNext: function (_formData, _extraArgs, cb) {
                    self.viewControllers.body
                        .getView(MciViewIds.body.message)
                        .findNext();
                    return cb(null);
                },
                editModeFindPrev: function (_formData, _extraArgs, cb) {
                    self.viewControllers.body
                        .getView(MciViewIds.body.message)
                        .findPrev();
                    return cb(null);
                },
                viewModeFind: function (formData, extraArgs, cb) {
                    if (self.viewControllers.footerView) {
                        self.viewControllers.footerView.setFocus(false);
                    }
                    return self.openFindPrompt(cb);
                },
                viewModeFindNext: function (_formData, _extraArgs, cb) {
                    self.viewControllers.body
                        .getView(MciViewIds.body.message)
                        .findNext();
                    return cb(null);
                },
                viewModeFindPrev: function (_formData, _extraArgs, cb) {
                    self.viewControllers.body
                        .getView(MciViewIds.body.message)
                        .findPrev();
                    return cb(null);
                },
                footerFindSubmit: function (formData, extraArgs, cb) {
                    const query = (formData.value.query || '').trim();
                    const bodyView = self.viewControllers.body.getView(
                        MciViewIds.body.message
                    );
                    if (self.viewControllers.footerFind) {
                        self.viewControllers.footerFind.detachClientEvents();
                    }
                    self.footerMode = self._prevFooterMode;
                    self.switchFooter(err => {
                        if (err) {
                            return cb(err);
                        }
                        if (query) {
                            bodyView.setFindQuery(query);
                        } else {
                            bodyView.clearFind();
                        }
                        if ('view' === self.editorMode) {
                            self.viewControllers.footerView.switchFocus(1);
                        } else {
                            self.viewControllers.body.switchFocus(1);
                            self.updateTextEditMode(bodyView.getTextEditMode());
                            self.updateEditModePosition(bodyView.getEditPosition());
                            self.observeEditorEvents();
                        }
                        return cb(null);
                    });
                },
                footerFindCancel: function (_formData, _extraArgs, cb) {
                    if (self.viewControllers.footerFind) {
                        self.viewControllers.footerFind.detachClientEvents();
                    }
                    self.footerMode = self._prevFooterMode;
                    self.switchFooter(err => {
                        if (err) {
                            return cb(err);
                        }
                        if ('view' === self.editorMode) {
                            self.viewControllers.footerView.switchFocus(1);
                        } else {
                            self.viewControllers.body.switchFocus(1);
                            self.updateTextEditMode(
                                self.viewControllers.body
                                    .getView(MciViewIds.body.message)
                                    .getTextEditMode()
                            );
                            self.updateEditModePosition(
                                self.viewControllers.body
                                    .getView(MciViewIds.body.message)
                                    .getEditPosition()
                            );
                            self.observeEditorEvents();
                        }
                        return cb(null);
                    });
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

        //  Preserve enough state to survive a gotoMenu round-trip (e.g. file upload).
        getSaveState() {
            if (!this.isReady) return null;
            const bodyView = this.viewControllers.body?.getView(MciViewIds.body.message);
            const hdr = this.viewControllers.header?.getFormData()?.value ?? {};
            return {
                bodyText:      bodyView ? bodyView.getData() : '',
                replyIsAnsi:   !!this.replyIsAnsi,
                headerFrom:    hdr.from    ?? '',
                headerTo:      hdr.to      ?? '',
                headerSubject: hdr.subject ?? '',
                tempUploadDir: this._pendingTempUploadDir || null,
            };
        }

        restoreSavedState(savedState) {
            //  Stash for use once views are (re-)created in createInitialViews().
            this._pendingSavedState = savedState;
        }

        //  Add or remove the '[ANSI] ' prefix on the subject field to reflect
        //  whether the message body is (or will be) rendered as ANSI art.
        _syncAnsiSubjectTag(isAnsi) {
            const subjView = this.viewControllers.header?.getView(
                MciViewIds.header.subject
            );
            if (!subjView) return;
            const ANSI_TAG = '[ANSI] ';
            const current = subjView.getData() || '';
            const hasTag = current.startsWith(ANSI_TAG);
            if (isAnsi && !hasTag) {
                subjView.setText(ANSI_TAG + current);
            } else if (!isAnsi && hasTag) {
                subjView.setText(current.slice(ANSI_TAG.length));
            }
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
            return this.replyToMessage !== undefined;
        }

        getFooterName() {
            //  e.g. 'footerEditor', 'footerEditorMenu', 'footerView'
            return 'footer' + this.footerMode[0].toUpperCase() + this.footerMode.slice(1);
        }

        getFormId(name) {
            return {
                header: 0,
                body: 1,
                footerEditor: 2,
                footerEditorMenu: 3,
                footerView: 4,
                quoteBuilder: 5,
                footerFind: 6,

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
                toUserName: this._viewModeToField(),
                //  :TODO:
                //fromRealName
                //toRealName
                fromUserId:
                    this.message?.meta?.System?.local_from_user_id ?? localUserIdNotAvail,
                toUserId:
                    this.message?.meta?.System?.local_to_user_id ?? localUserIdNotAvail,
                fromRemoteUser:
                    this.message?.meta?.System?.remote_from_user ?? remoteUserNotAvail,
                toRemoteUser:
                    this.message?.meta?.System?.remote_to_user ?? remoteUserNotAvail,
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
                            explicit_encoding:
                                Config()?.scannerTossers?.ftn_bso?.packetAnsiMsgEncoding ??
                                'cp437',
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
            const msgInfo = messageInfoFromAddressedToInfo(
                MessageConst.AddressFlavor.ActivityPub === area.addressFlavor
                    ? { flavor: MessageConst.AddressFlavor.ActivityPub }
                    : getAddressedToInfo(headerValues.to)
            );
            if (false !== msgInfo.autoSignatures) {
                if (false !== area.autoSignatures) {
                    const sig = this.client.user.getProperty(UserProps.AutoSignature);
                    if (sig) {
                        messageBody += `\r\n-- \r\n${sig}`;
                    }
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
                if (!this.isReady) {
                    return;
                }

                this.initHeaderViewMode();
                this.initFooterViewMode();

                const bodyMessageView = this.viewControllers.body.getView(
                    MciViewIds.body.message
                );
                let msg = this.message.message;

                if (bodyMessageView && this.message?.message !== undefined) {
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
                                bodyMessageView.getTextSgrPrefix()
                            );
                        }

                        bodyMessageView.setAnsi(
                            //  Convert any pipe codes (|##) in the body to ANSI SGR before
                            //  setAnsi processes the string; setAnsi only handles \x1b sequences
                            //  so plain pipe codes would otherwise render as literal text.
                            controlCodesToAnsi(msg.replace(/\r?\n/g, '\r\n'), this.client),
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

                        const areaInfo = getMessageAreaByTag(self.messageAreaTag);
                        if (
                            !self.isPrivateMail() &&
                            true !== areaInfo.alwaysExportExternal
                        ) {
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
                            copyExternalAddressedToInfo(
                                self.replyToMessage,
                                self.message
                            );
                            return callback(null);
                        }

                        //
                        //  Detect if the user is attempting to send to a remote mail type that we support
                        //
                        const addressedToInfo = getAddressedToInfo(
                            self.message.toUserName
                        );

                        if (setExternalAddressedToInfo(addressedToInfo, self.message)) {
                            // setExternalAddressedToInfo() did what we need
                            return callback(null);
                        }

                        //  Local user -- we need to look it up
                        User.getUserIdAndNameByLookup(
                            self.message.toUserName,
                            (err, toUserId) => {
                                if (err) {
                                    if (self.message.isPrivate()) {
                                        return callback(err);
                                    }

                                    if (areaInfo.addressFlavor) {
                                        self.message.setExternalFlavor(
                                            areaInfo.addressFlavor
                                        );
                                    }

                                    return callback(null);
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
            const footerRow = this.header.height + this.body.height;

            async.waterfall(
                [
                    callback => {
                        this.client.term.rawWrite(ansi.goto(footerRow, 1));
                        callback(null);
                    },
                    callback => {
                        if (options.clear) {
                            //  :TODO: We'd like to delete up to N rows, but this does not work in NetRunner:
                            this.client.term.rawWrite(ansi.reset() + ansi.deleteLine(3));
                            this.client.term.rawWrite(ansi.reset() + ansi.eraseLine(2));
                        }
                        callback(null);
                    },
                    callback => {
                        const footerArt = this.menuConfig.config.art[options.footerName];
                        this.displayAsset(
                            footerArt,
                            { startRow: footerRow },
                            (err, artData) => callback(err, artData)
                        );
                    },
                ],
                (err, artData) => cb(err, artData)
            );
        }

        redrawScreen(cb) {
            const art = this.menuConfig.config.art;
            const comps = ['header', 'body'];

            this.client.term.rawWrite(ansi.resetScreen());

            async.series(
                [
                    callback => {
                        async.waterfall(
                            [
                                wfCb => {
                                    this.displayAsset(art.header, {}, (err, artInfo) =>
                                        wfCb(err, artInfo)
                                    );
                                },
                                (artInfo, wfCb) => {
                                    this.displayAsset(
                                        art.body,
                                        { startRow: artInfo.height + 1 },
                                        err => wfCb(err)
                                    );
                                },
                            ],
                            err => callback(err)
                        );
                    },
                    callback => {
                        this.redrawFooter(
                            { clear: false, footerName: this.getFooterName() },
                            err => callback(err)
                        );
                    },
                    callback => {
                        comps.push(this.getFooterName());
                        comps.forEach(n => this.viewControllers[n].redrawAll());
                        callback(null);
                    },
                ],
                err => cb(err)
            );
        }

        switchFooter(cb) {
            const footerName = this.getFooterName();
            const formId = this.getFormId(footerName);
            const startRow = this.header.height + this.body.height;

            this.client.term.rawWrite(ansi.goto(startRow, 1) + ansi.eraseLine(2));
            this.prepViewControllerWithArt(
                footerName,
                formId,
                { startRow },
                (err, vc, created) => {
                    if (err) return cb(err);
                    if (!created) {
                        vc.redrawAll();
                    }
                    return cb(null);
                }
            );
        }

        initSequence() {
            const art = this.menuConfig.config.art;
            if (!art || typeof art !== 'object') {
                return this.client.log.warn('FSE: config.art is required');
            }

            const mciData = {};

            async.waterfall(
                [
                    cb => this.beforeArt(cb),
                    cb => {
                        this.client.term.rawWrite(ansi.goto(1, 1));
                        this.displayAsset(art.header, {}, (err, artInfo) => {
                            if (artInfo) {
                                mciData.header = artInfo;
                                this.header = { height: artInfo.height };
                            }
                            return cb(err, artInfo);
                        });
                    },
                    (artInfo, cb) => {
                        const bodyStartRow = artInfo.height + 1;
                        this.client.term.rawWrite(ansi.goto(bodyStartRow, 1));
                        this.displayAsset(
                            art.body,
                            { startRow: bodyStartRow },
                            (err, artInfo) => {
                                if (artInfo) {
                                    mciData.body = artInfo;
                                    this.body = {
                                        height: artInfo.height - this.header.height,
                                    };
                                }
                                return cb(err, artInfo);
                            }
                        );
                    },
                    (_artInfo, cb) => {
                        this.setInitialFooterMode();
                        const footerName = this.getFooterName();
                        const footerStartRow = this.header.height + this.body.height;
                        this.client.term.rawWrite(ansi.goto(footerStartRow, 1));
                        this.displayAsset(
                            art[footerName],
                            { startRow: footerStartRow },
                            (err, artData) => {
                                mciData[footerName] = artData;
                                return cb(err);
                            }
                        );
                    },
                    cb => this.mciReady(mciData, cb),
                ],
                err => {
                    if (err) {
                        this.client.log.warn({ error: err.message }, 'FSE init error');
                    } else {
                        this.isReady = true;
                        this.finishedLoading();
                    }
                }
            );
        }

        createInitialViews(mciData, cb) {
            async.series(
                [
                    callback => {
                        this.prepViewController(
                            'header',
                            this.getFormId('header'),
                            mciData.header.mciMap,
                            err => callback(err)
                        );
                    },
                    callback => {
                        this.prepViewController(
                            'body',
                            this.getFormId('body'),
                            mciData.body.mciMap,
                            err => callback(err)
                        );
                    },
                    callback => {
                        const footerName = this.getFooterName();
                        this.prepViewController(
                            footerName,
                            this.getFormId(footerName),
                            mciData[footerName].mciMap,
                            err => callback(err)
                        );
                    },
                    callback => {
                        //  Hide the upload item from the editor menu if the user
                        //  lacks access.  Sysops can override via config.uploadAcs.
                        if (
                            'footerEditorMenu' === this.getFooterName() &&
                            !this.client.acs.hasMessageBodyUpload(
                                this.menuConfig.config || {}
                            )
                        ) {
                            const hmView =
                                this.viewControllers.footerEditorMenu?.getView(1);
                            if (hmView) {
                                hmView.setItems(
                                    hmView
                                        .getItems()
                                        .filter(t => 'upload' !== t.toLowerCase())
                                );
                                hmView.redraw();
                            }
                        }
                        return callback(null);
                    },
                    callback => {
                        const from = this.viewControllers.header.getView(
                            MciViewIds.header.from
                        );
                        if (from) {
                            from.acceptsFocus = false;
                        }

                        const body = this.viewControllers.body.getView(
                            MciViewIds.body.message
                        );
                        this.updateTextEditMode(body.getTextEditMode());
                        this.updateEditModePosition(body.getEditPosition());

                        callback(null);
                    },
                    callback => {
                        //  View mode: header/footer/body are populated by setMessage()
                        //  which is called from finishedLoading() after isReady = true.
                        //  Edit mode: populate From field; reply mode also sets subject/to.
                        if (this.editorMode === 'edit') {
                            const fromView = this.viewControllers.header.getView(
                                MciViewIds.header.from
                            );
                            const area = getMessageAreaByTag(this.messageAreaTag);
                            if (fromView !== undefined) {
                                if (area && area.realNames) {
                                    fromView.setText(this.client.user.realName());
                                } else {
                                    fromView.setText(this.client.user.username);
                                }
                            }

                            if (this.replyToMessage) {
                                this.initHeaderReplyEditMode();
                            }
                        }

                        callback(null);
                    },
                    callback => {
                        switch (this.editorMode) {
                            case 'edit':
                                this.switchToHeader();
                                break;
                            case 'view':
                                this.switchToFooter();
                                break;
                        }

                        callback(null);
                    },
                    //  Restore state saved before a gotoMenu round-trip (e.g. upload).
                    //  Runs after all normal init so views already exist.
                    callback => {
                        const saved = this._pendingSavedState;
                        if (!saved) {
                            return callback(null);
                        }
                        this._pendingSavedState = null;

                        //  Restore header fields the user had typed before the transfer.
                        const toView   = this.viewControllers.header.getView(MciViewIds.header.to);
                        const subjView = this.viewControllers.header.getView(MciViewIds.header.subject);
                        if (toView   && saved.headerTo)      toView.setText(saved.headerTo);
                        if (subjView && saved.headerSubject)  subjView.setText(saved.headerSubject);

                        this.replyIsAnsi = saved.replyIsAnsi;

                        const bodyView = this.viewControllers.body.getView(MciViewIds.body.message);

                        //  After loading content, transfer focus to the body so the user
                        //  can interact immediately (header ESC → prevMenu would fire otherwise).
                        const done = () => {
                            if (this.isEditMode()) {
                                this.switchToBody();
                            }
                            return callback(null);
                        };

                        if (this._pendingUploadFiles?.length > 0) {
                            //
                            //  A file transfer just completed.  Read the first received file,
                            //  detect its type, and load it into the body.
                            //
                            const uploadPath = this._pendingUploadFiles[0];
                            const tempDir    = saved.tempUploadDir || paths.dirname(uploadPath);
                            this._pendingUploadFiles = null;

                            fs.readFile(uploadPath, (err, data) => {
                                //  Clean up the temp dir regardless of read outcome.
                                fse.remove(tempDir, rmErr => {
                                    if (rmErr) {
                                        this.client.log.warn(
                                            { err: rmErr, tempDir },
                                            'FSE: failed to remove upload temp dir'
                                        );
                                    }
                                });

                                if (err) {
                                    this.client.log.warn({ err, uploadPath }, 'FSE: failed to read uploaded file');
                                    return done(); //  non-fatal; just leave body empty
                                }

                                //  Detect encoding: UTF-8 BOM wins outright; otherwise
                                //  attempt a UTF-8 decode — if it produces no replacement
                                //  characters the file is clean UTF-8.  CP437 is the fallback
                                //  (most classic ANSI art uses high-byte block/box chars that
                                //  are not valid UTF-8 sequences).
                                const hasUtf8Bom =
                                    data.length >= 3 &&
                                    data[0] === 0xef &&
                                    data[1] === 0xbb &&
                                    data[2] === 0xbf;
                                const enc =
                                    hasUtf8Bom || !data.toString('utf8').includes('\uFFFD')
                                        ? 'utf8'
                                        : 'cp437';
                                const content = iconv.decode(data, enc);
                                if (isAnsi(content)) {
                                    this.replyIsAnsi = true;
                                    this._syncAnsiSubjectTag(true);
                                    return bodyView.setAnsi(
                                        content,
                                        { prepped: false, forceLineTerm: true },
                                        done
                                    );
                                } else {
                                    //  Plain text — pipe codes, PCBoard codes, etc. are handled
                                    //  transparently by controlCodesToAnsi() at display time.
                                    bodyView.setText(content);
                                    return done();
                                }
                            });
                        } else if (saved.bodyText) {
                            //  Round-trip with no upload (e.g. help screen) — restore body.
                            if (saved.replyIsAnsi) {
                                return bodyView.setAnsi(
                                    saved.bodyText,
                                    { prepped: false, forceLineTerm: true },
                                    done
                                );
                            } else {
                                bodyView.setText(saved.bodyText);
                                return done();
                            }
                        } else {
                            return done();
                        }
                    },
                ],
                err => cb(err)
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
            if (!this.isEditMode()) return;

            const statusView = this.viewControllers.footerEditor
                ?.getView(MciViewIds.EditorFooter.status);
            if (!statusView) return;

            //  setPanel targets only the 'pos' slot; the 'mode' panel is unchanged.
            //  moveClientCursorToCursorPos() uses pipe-code display-col mapping so
            //  buffer col ≠ display col on |## lines doesn't cause rightward drift.
            statusView.setPanel('pos',
                `${String(pos.row + 1).padStart(2, '0')},${String(pos.col + 1).padStart(2, '0')}`
            );
            this.viewControllers.body
                ?.getView(MciViewIds.body.message)
                ?.moveClientCursorToCursorPos();
        }

        updateTextEditMode(mode) {
            if (!this.isEditMode()) return;

            const statusView = this.viewControllers.footerEditor
                ?.getView(MciViewIds.EditorFooter.status);
            if (!statusView) return;

            statusView.setPanel('mode', 'insert' === mode ? 'INS' : 'OVR');
            this.viewControllers.body
                ?.getView(MciViewIds.body.message)
                ?.moveClientCursorToCursorPos();
        }

        setHeaderText(id, text) {
            this.setViewText('header', id, text);
        }

        _viewModeToField() {
            //  Imported messages may have no explicit 'to' on various public forums
            if (this.message.toUserName) {
                return this.message.toUserName;
            }

            const toRemoteUser = this.message?.meta?.System?.remote_to_user;
            if (toRemoteUser) {
                return toRemoteUser;
            }

            if (this.message.isPublic()) {
                return '(Public)';
            }

            return this.menuConfig.config.remoteUserNotAvail || 'N/A';
        }

        initHeaderViewMode() {
            // Only set header text for from view if it is on the form
            if (
                this.viewControllers.header.getView(MciViewIds.header.from) !== undefined
            ) {
                this.setHeaderText(MciViewIds.header.from, this.message.fromUserName);
            }
            this.setHeaderText(MciViewIds.header.to, this._viewModeToField());
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

        initBodyReplyEditMode() {

            const bodyMessageView = this.viewControllers.body.getView(
                MciViewIds.body.message
            );

            const messagePrefix = getReplyToMessagePrefix(
                this.replyToMessage.fromUserName
            );

            bodyMessageView.setText(messagePrefix);
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
                sanitizeFilename(
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

                        if (self.viewControllers.quoteBuilder === undefined) {
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
                                self._syncAnsiSubjectTag(replyIsAnsi);

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

            //  Remove any previously attached listeners to avoid double-firing
            //  when observeEditorEvents() is called more than once (e.g. after
            //  returning from the quote builder or help screen).
            bodyView.removeAllListeners('edit position');
            bodyView.removeAllListeners('text edit mode');

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

        openFindPrompt(cb) {
            this._prevFooterMode = this.footerMode;
            this.footerMode = 'find';
            this.switchFooter(err => {
                if (err) {
                    return cb(err);
                }
                const et1 = this.viewControllers.footerFind.getView(1);
                if (et1) {
                    et1.setText('');
                }
                this.viewControllers.footerFind.switchFocus(1);
                return cb(null);
            });
        }

        switchToHeader() {
            this.viewControllers.body.setFocus(false);
            this.viewControllers.header.switchFocus(2); //  to
        }

        switchToBody() {
            const to = this.getView('header', MciViewIds.header.to).getData();
            const msgInfo = messageInfoFromAddressedToInfo(getAddressedToInfo(to));
            const bodyView = this.getView('body', MciViewIds.body.message);

            if (msgInfo.maxMessageLength > 0) {
                bodyView.maxLength = msgInfo.maxMessageLength;
            }

            // first pass through, init body (we may need header values set)
            const bodyText = bodyView.getData();
            if (!bodyText && this.isReply()) {
                this.initBodyReplyEditMode();
            }

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
                    quoteLines += `${ansi.normal()}${bodyMessageView.getTextSgrPrefix()}`;
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
            } else if (typeof quoteFormat !== 'string') {
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
