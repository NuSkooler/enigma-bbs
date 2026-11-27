/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { ViewController, FormLifecycle } = require('./view_controller.js');
const { View } = require('./view.js');
const ansi = require('./ansi_term.js');
const theme = require('./theme.js');
const Message = require('./message.js');
const { updateMessageAreaLastReadId, getMessageAreaByTag } = require('./message_area.js');
const User = require('./user.js');
const StatLog = require('./stat_log.js');
const stringFormat = require('./string_format.js');
const { MessageAreaConfTempSwitcher } = require('./mod_mixins.js');
const {
    isAnsi,
    stripAnsiControlCodes,
    stripAllControlCodes,
    insert,
} = require('./string_util.js');
const { controlCodesToAnsi } = require('./color_codes.js');
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

//  editor -> Set of end() functions of art batches still open: see
//  _beginArtBatch(). Kept here, not on the module, so no name is taken
//  from a subclass.
const openArtBatches = new WeakMap();

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

    viewModeFooter: {
        msgNum: 6,
        msgTotal: 7,
        //  :TODO: Just use custom ranges
    },

    editorFooter: {
        status: 1, //  SB1 — panel status bar (panels: mode, pos)
    },

    quoteBuilder: {
        quotedMsg: 1,
        //  2 NYI
        quoteLines: 3,
    },
};

const FormIds = {
    header: 0,
    body: 1,
    footerEditor: 2,
    footerEditorMenu: 3,
    footerView: 4,
    quoteBuilder: 5,
    footerFind: 6,

    help: 50,
};

//  The forms that take turns in the footer rows (see getFooterName())
const FooterFormNames = ['footerEditor', 'footerEditorMenu', 'footerView', 'footerFind'];

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

//  Prefixed to the subject of a message whose body is ANSI art
const ANSI_SUBJECT_TAG = '[ANSI] ';
//  A subject that already carries the tag, also after a reply's "RE: " (any
//  case, as initHeaderReplyEditMode() matches it)
const ANSI_SUBJECT_TAG_RE = /^(?:[Rr][Ee]:\s+)?\[ANSI\] /;
//  A reply subject the editor tagged ("[ANSI] RE: ..."): the tag marks that
//  reply's own body, not the thread
const ANSI_TAGGED_REPLY_SUBJECT_RE = /^\[ANSI\] (?=[Rr][Ee]:\s+)/;

exports.MciViewIds = MciViewIds;
exports.FormIds = FormIds;

exports.FullScreenEditorModule =
    exports.getModule = class FullScreenEditorModule extends (
        MessageAreaConfTempSwitcher(MenuModule)
    ) {
        constructor(options) {
            super(options);

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
                options?.extraArgs?.noUpdateLastReadId ??
                config.noUpdateLastReadId ??
                false;

            this.isReady = false;
            this.header = null;
            this.body = null;

            //  Two separate facts (#1084):
            //  - replyIsAnsi: the message replied to is ANSI, so its quote
            //    lines are ANSI (set each time the quote builder opens)
            //  - bodyIsAnsi: the body being written is ANSI art, so it is
            //    saved as ANSI and the subject carries the [ANSI] tag
            this.replyIsAnsi = false;
            this.bodyIsAnsi = false;

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

            //  ── Header / Validation ──────────────────────────────────────────────────
            this.menuMethods = {
                viewValidationListener: (err, cb) => this._onViewValidation(err, cb),
                headerSubmit: (_formData, _extraArgs, cb) => {
                    this._changingSubject = false;
                    this.switchToBody();
                    return cb(null);
                },
                //  Escape in the header form: if we arrived here via Ctrl-A
                //  ("change subject"), return focus to the body without exiting
                //  the FSE.  Otherwise behave like the original prevMenu action.
                headerEscapePressed: (_formData, _extraArgs, cb) => {
                    if (this._changingSubject) {
                        this._changingSubject = false;
                        this.switchToBody();
                        return cb(null);
                    }
                    return this.prevMenu(cb);
                },
                //  Ctrl-A from the body: jump focus to the subject field so the
                //  user can edit it without leaving the FSE.  Enter confirms
                //  (headerSubmit → switchToBody); Escape cancels (headerEscapePressed).
                editModeChangeSubject: (_formData, _extraArgs, cb) => {
                    this._changingSubject = true;
                    FormLifecycle.deactivate(this.viewControllers.body);
                    this.viewControllers.header.switchFocus(MciViewIds.header.subject);
                    return cb(null);
                },

                //  ── Body Editor ──────────────────────────────────────────────────────
                editModeEscPressed: (_formData, _extraArgs, cb) =>
                    this._toggleEditorMenu(cb),

                //  ── Quote Builder ────────────────────────────────────────────────────
                editModeMenuQuote: (_formData, _extraArgs, cb) => {
                    //  the quote builder is drawn over the body and the footer
                    FormLifecycle.cover(this.viewControllers.footerEditorMenu);
                    FormLifecycle.cover(this.viewControllers.body);
                    this.displayQuoteBuilder();
                    return cb(null);
                },
                appendQuoteEntry: (formData, _extraArgs, cb) =>
                    this._appendQuoteEntry(formData, cb),
                quoteBuilderEscPressed: (_formData, _extraArgs, cb) => {
                    this.quoteBuilderFinalize();
                    return cb(null);
                },

                //  ── Editor Menu ──────────────────────────────────────────────────────
                editModeMenuHelp: (_formData, _extraArgs, cb) => {
                    FormLifecycle.cover(this.viewControllers.footerEditorMenu);
                    return this.displayHelp(cb);
                },
                //  Ctrl-S quick save: delegates to whichever subclass defined editModeMenuSave.
                editModeQuickSave: (formData, extraArgs, cb) => {
                    if ('function' === typeof this.menuMethods.editModeMenuSave) {
                        return this.menuMethods.editModeMenuSave(formData, extraArgs, cb);
                    }
                    return cb(null);
                },
                //  Ctrl-O quick help: open help screen without going through the ESC menu.
                editModeQuickHelp: (_formData, _extraArgs, cb) => this.displayHelp(cb),
                editModeMenuUpload: (_formData, _extraArgs, cb) =>
                    this._startBodyUpload(cb),

                //  ── Find / Search ────────────────────────────────────────────────────
                editModeFind: (_formData, _extraArgs, cb) => {
                    FormLifecycle.deactivate(this.viewControllers.body);
                    return this.openFindPrompt(err => {
                        if (err) {
                            //  If the prompt fails to open (e.g. missing art),
                            //  restore focus to the body so the keyboard isn't frozen.
                            this._returnFocusToBody();
                        }
                        return cb(err);
                    });
                },
                editModeFindNext: (_formData, _extraArgs, cb) => {
                    this._bodyView.findNext();
                    return cb(null);
                },
                editModeFindPrev: (_formData, _extraArgs, cb) => {
                    this._bodyView.findPrev();
                    return cb(null);
                },
                viewModeFind: (_formData, _extraArgs, cb) => {
                    if (this.viewControllers.footerView) {
                        FormLifecycle.deactivate(this.viewControllers.footerView);
                    }
                    return this.openFindPrompt(cb);
                },
                viewModeFindNext: (_formData, _extraArgs, cb) => {
                    this._bodyView.findNext();
                    return cb(null);
                },
                viewModeFindPrev: (_formData, _extraArgs, cb) => {
                    this._bodyView.findPrev();
                    return cb(null);
                },
                footerFindSubmit: (formData, _extraArgs, cb) => {
                    const query = (formData.value.query || '').trim();
                    return this._closeFindPrompt(query, cb);
                },
                footerFindCancel: (_formData, _extraArgs, cb) =>
                    this._closeFindPrompt(null, cb),

                //  ── View Mode ───────────────────────────────────────────────────────
                viewModeMenuHelp: (_formData, _extraArgs, cb) => {
                    FormLifecycle.cover(this.viewControllers.footerView);
                    return this.displayHelp(cb);
                },
                addToDownloadQueue: (_formData, _extraArgs, cb) => {
                    FormLifecycle.cover(this.viewControllers.footerView);
                    return this.addToDownloadQueue(cb);
                },
            };
        }

        //  Validate a header field value.  Subject is optional when the area or
        //  addressing layer marks it so; all other validation errors are surfaced
        //  in the error-message view.
        _onViewValidation(err, cb) {
            if (
                err &&
                err.view.getId() === MciViewIds.header.subject &&
                err.reasonCode === ErrorReasons.ValueTooShort
            ) {
                const areaInfo = getMessageAreaByTag(this.messageAreaTag);
                if (true === areaInfo.subjectOptional) {
                    return cb(null, null);
                }

                //  Private messages are a little different...
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
                } else {
                    errMsgView.clearText();
                }
            }

            return cb(err, null);
        }

        //  Toggle between the inline editor footer and the ESC command menu.
        //  Clears any stale error text, switches footer mode, then transfers
        //  keyboard focus to the appropriate ViewController.
        _toggleEditorMenu(cb) {
            const errMsgView = this.viewControllers.header.getView(
                MciViewIds.header.errorMsg
            );
            if (errMsgView) {
                errMsgView.clearText();
            }

            this.footerMode = 'editor' === this.footerMode ? 'editorMenu' : 'editor';

            this.switchFooter(err => {
                if (err) {
                    return cb(err);
                }

                switch (this.footerMode) {
                    case 'editor':
                        //  (switchFooter() covered it already; kept, as it is
                        //  shown again on the next Escape)
                        if (this.viewControllers.footerEditorMenu !== undefined) {
                            FormLifecycle.cover(this.viewControllers.footerEditorMenu);
                        }
                        this.viewControllers.body.switchFocus(1);
                        this.observeEditorEvents();
                        break;

                    case 'editorMenu':
                        FormLifecycle.deactivate(this.viewControllers.body);
                        this.viewControllers.footerEditorMenu.switchFocus(1);
                        break;

                    default:
                        return cb(new Error(`Unexpected footerMode: ${this.footerMode}`));
                }

                return cb(null);
            });
        }

        //  Append the currently highlighted quote-list line to the growing quote
        //  preview, then advance the list cursor (or finalize if at the last item).
        //  ANSI lines are accumulated in _ansiQuoteLines and rendered via setAnsi();
        //  plain-text lines go directly into the MT1 preview view via addText().
        _appendQuoteEntry(formData, cb) {
            const quoteListView = this.viewControllers.quoteBuilder.getView(
                MciViewIds.quoteBuilder.quoteLines
            );
            const quoteMsgView = this.viewControllers.quoteBuilder.getView(
                MciViewIds.quoteBuilder.quotedMsg
            );
            const quoteText = quoteListView.getItem(formData.value.quote);

            //  Advance the quote list cursor or finalize — called after any
            //  (possibly async) preview update is complete.
            const afterUpdate = () => {
                if (quoteListView.getData() !== quoteListView.getCount() - 1) {
                    quoteListView.focusNext();
                } else {
                    this.quoteBuilderFinalize();
                }
                return cb(null);
            };

            if (this.replyIsAnsi) {
                //  ANSI: accumulate for finalize and render the growing set into the
                //  preview via setAnsi() — addText() can't handle \x1b sequences.
                this._ansiQuoteLines.push(quoteText);
                const preview = this._ansiQuoteLines.join('\r\n');
                quoteMsgView.setAnsi(preview, { prepped: true }, _err => {
                    quoteMsgView.cursorEndOfDocument();
                    afterUpdate();
                });
            } else {
                //  Plain text: accumulate in the MT1 preview view with a header
                //  on the first line selected.
                if (this.newQuoteBlock) {
                    this.newQuoteBlock = false;
                    const header = this.getQuoteByHeader();
                    if (header) {
                        quoteMsgView.addText(header, { scrollMode: 'end' });
                    }
                }
                quoteMsgView.addText(quoteText, { scrollMode: 'end' });
                afterUpdate();
            }
        }

        //  Launch the file-transfer protocol selector so the user can upload a
        //  file to use as the message body.  Creates a temp directory, stores its
        //  path in _pendingTempUploadDir for getSaveState(), then transitions to
        //  the transfer module with returnToCaller so we come back here on exit.
        _startBodyUpload(cb) {
            const menu = this.viewControllers.footerEditorMenu;
            FormLifecycle.cover(menu);
            temptmp.mkdir({ prefix: 'enigfseul-' }, (err, tempDir) => {
                if (err) {
                    this.client.log.warn(
                        { err },
                        'FSE: failed to create upload temp dir'
                    );
                    //  still on the menu: give it the keys back
                    if (!this.hasLeftMenu()) {
                        FormLifecycle.activate(menu);
                    }
                    return cb(err);
                }
                //  Store dir so getSaveState() can include it for cleanup on re-entry.
                this._pendingTempUploadDir = pathWithTerminatingSeparator(tempDir);
                const modOpts = {
                    extraArgs: {
                        recvDirectory: this._pendingTempUploadDir,
                        direction: 'recv',
                        returnToCaller: true, //  skip fileBaseUploadFiles; return to FSE
                    },
                };
                return this.gotoMenu(
                    this.menuConfig.config.fileTransferProtocolSelection ||
                        'fileTransferProtocolSelection',
                    modOpts,
                    cb
                );
            });
        }

        //  Preserve enough state to survive a gotoMenu round-trip (e.g. file upload).
        getSaveState() {
            if (!this.isReady) return null;
            const bodyView = this._bodyView;
            const hdr = this.viewControllers.header?.getFormData()?.value ?? {};
            return {
                bodyText: bodyView ? bodyView.getData() : '',
                replyIsAnsi: !!this.replyIsAnsi,
                bodyIsAnsi: !!this.bodyIsAnsi,
                headerFrom: hdr.from ?? '',
                headerTo: hdr.to ?? '',
                headerSubject: hdr.subject ?? '',
                ansiTagAdded: !!this._ansiTagAdded,
                tempUploadDir: this._pendingTempUploadDir || null,
            };
        }

        restoreSavedState(savedState) {
            //  Stash for use once views are (re-)created in createInitialViews().
            this._pendingSavedState = savedState;
        }

        //  Add or remove the '[ANSI] ' prefix on the subject field to reflect
        //  whether the message body is (or will be) rendered as ANSI art.
        //
        //  The tag is a hint for readers; the subject is the user's text. So
        //  the tag is added only when the whole subject still fits the field,
        //  and only a tag added here is taken off again (nothing was cut, so
        //  that restores the subject exactly). A subject already carrying the
        //  tag, including after a leading "RE: ", is left as it is.
        _syncAnsiSubjectTag(isAnsi) {
            const subjView = this.viewControllers.header?.getView(
                MciViewIds.header.subject
            );
            if (!subjView) return;
            const current = subjView.getData() || '';
            if (isAnsi) {
                if (ANSI_SUBJECT_TAG_RE.test(current)) {
                    return;
                }
                const tagged = ANSI_SUBJECT_TAG + current;
                if (subjView.maxLength > 0 && tagged.length > subjView.maxLength) {
                    this.client.log.debug(
                        { subjectLength: current.length, maxLength: subjView.maxLength },
                        'FSE: subject too long for the [ANSI] tag; left untagged'
                    );
                    return;
                }
                subjView.setText(tagged);
                this._ansiTagAdded = true;
            } else if (this._ansiTagAdded) {
                this._ansiTagAdded = false;
                if (current.startsWith(ANSI_SUBJECT_TAG)) {
                    subjView.setText(current.slice(ANSI_SUBJECT_TAG.length));
                }
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

        //  Convenience accessor — avoids repeating the VC + MCI lookup everywhere.
        get _bodyView() {
            return this.viewControllers.body?.getView(MciViewIds.body.message);
        }

        //  Row (1-based) where the footer begins — below header and body art.
        get _footerStartRow() {
            return this.header.height + this.body.height;
        }

        //  Restore keyboard focus and editor-state indicators to the body MLTEV
        //  after returning from any overlay (quote builder, find prompt, help, etc.).
        _returnFocusToBody() {
            this.client.term.beginWrite();
            //  Deactivate any other input-accepting section (in particular the
            //  header) so the body is the only ViewController attached to the
            //  client 'key press' event. Otherwise a still-attached header would
            //  receive the same keystrokes as the body (#712). The header stays
            //  on screen, so it is deactivated, not torn down: its views and
            //  their timers live on. Safe on the overlay-return paths
            //  (find/quote/help) where the header was inactive already.
            if (this.viewControllers.header) {
                FormLifecycle.deactivate(this.viewControllers.header);
            }
            this.viewControllers.body.switchFocus(1);
            const bodyView = this._bodyView;
            if (bodyView) {
                this.updateTextEditMode(bodyView.getTextEditMode());
                this.updateEditModePosition(bodyView.getEditPosition());
            }
            this.observeEditorEvents();
            this.client.term.commitWrite();
        }

        //  Shared teardown for footerFindSubmit and footerFindCancel.
        //  Detaches the find VC, restores the previous footer, then either
        //  applies the query (if non-empty) or clears any active find state,
        //  then returns focus to body or footerView as appropriate.
        //
        //  In view mode a submitted query calls setFindQuery() so highlights
        //  stay visible and Ctrl-N/P navigation works.  In edit mode we use
        //  gotoFirstMatch() instead — it scrolls to the first hit and positions
        //  the cursor there without setting _findState, so no highlight overlay
        //  is painted and no ESC sequences can bleed into the editing session.
        _closeFindPrompt(query, cb) {
            //  kept for the next find: covered, not torn down
            if (this.viewControllers.footerFind) {
                FormLifecycle.cover(this.viewControllers.footerFind);
            }
            this.footerMode = this._prevFooterMode;
            this.switchFooter(err => {
                if (err) return cb(err);
                if (query) {
                    if (this.isViewMode()) {
                        this._bodyView.setFindQuery(query);
                    } else {
                        this._bodyView.gotoFirstMatch(query);
                    }
                } else {
                    this._bodyView.clearFind();
                }
                if (this.isViewMode()) {
                    this.viewControllers.footerView.switchFocus(1);
                } else {
                    this._returnFocusToBody();
                }
                return cb(null);
            });
        }

        getFooterName() {
            //  e.g. 'footerEditor', 'footerEditorMenu', 'footerView'
            return 'footer' + this.footerMode[0].toUpperCase() + this.footerMode.slice(1);
        }

        getHeaderFormatObj() {
            const remoteUserNotAvail = this.menuConfig.config.remoteUserNotAvail || 'N/A';
            const localUserIdNotAvail =
                this.menuConfig.config.localUserIdNotAvail || 'N/A';

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
                modTimestamp: this.message.modTimestamp.format(
                    this.getModTimestampFormat()
                ),
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
                default:
                    this.footerMode = 'editor';
                    this.client.log.warn(
                        { editorMode: this.editorMode },
                        'FSE: unexpected editorMode in setInitialFooterMode'
                    );
                    break;
            }
        }

        buildMessage(cb) {
            const headerValues = this.viewControllers.header.getFormData().value;
            const area = getMessageAreaByTag(this.messageAreaTag);

            const getFromUserName = () => this._getFromUserName(area);

            let messageBody = this._bodyView.getData({
                forceLineTerms: this.bodyIsAnsi,
            });

            const msgOpts = {
                areaTag: this.messageAreaTag,
                toUserName: headerValues.to,
                fromUserName: getFromUserName(),
                subject: headerValues.subject,
            };

            if (this.isReply()) {
                msgOpts.replyToMsgId = this.replyToMessage.messageId;
            }

            //  A reply or a new post alike (#1084)
            if (this.bodyIsAnsi) {
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
                            controlCodesToAnsi(
                                msg.replace(/\r?\n/g, '\r\n'),
                                this.client
                            ),
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
                        self.message.setLocalFromUserId(self._getLocalFromUserId());

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
                return cb(null); //  don't inc stats for private messages
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

            this.client.term.rawWrite(ansi.goto(footerRow, 1));

            if (options.clear) {
                //  :TODO: We'd like to delete up to N rows, but this does not work in NetRunner:
                this.client.term.rawWrite(ansi.reset() + ansi.deleteLine(3));
                this.client.term.rawWrite(ansi.reset() + ansi.eraseLine(2));
            }

            const footerArt = this.menuConfig.config.art[options.footerName];
            this.displayAsset(footerArt, { startRow: footerRow }, cb);
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

        //
        //  Begin a write batch for an erase + art + form sequence that waits
        //  on the art (read from disk), so the caller sees it in one socket
        //  write, with background drawing (a ticker or status bar in the
        //  header) suspended for its span. A tick inside the open batch used
        //  to be held in it and sent between the erase and the art, which
        //  then drew from wherever the tick left the cursor. Returns end(),
        //  which commits the batch and resumes background drawing (a view
        //  that missed a tick is redrawn once); only the first call does
        //  anything. leave() ends any batch still open.
        //
        _beginArtBatch() {
            const client = this.client;
            let batches = openArtBatches.get(this);
            if (!batches) {
                batches = new Set();
                openArtBatches.set(this, batches);
            }

            const token = View.suspendBackgroundDraw(client);
            client.term.beginWrite();

            const end = ({ redrawMissed = true } = {}) => {
                if (!batches.delete(end)) {
                    return;
                }
                try {
                    client.term.commitWrite();
                } finally {
                    View.resumeBackgroundDraw(client, token, { redrawMissed });
                }
            };
            batches.add(end);
            return end;
        }

        //  the menu is gone: send what they hold, redraw nothing
        _endArtBatches() {
            const batches = openArtBatches.get(this);
            if (batches) {
                [...batches].forEach(end => end({ redrawMissed: false }));
            }
        }

        switchFooter(cb) {
            const footerName = this.getFooterName();
            const formId = FormIds[footerName];
            const startRow = this._footerStartRow;

            //  Buffer the entire erase → art display → view redraw sequence so the
            //  client receives it as one atomic socket write — no visible blank-row
            //  flash between clearing the old footer and drawing the new one.
            const endBatch = this._beginArtBatch();
            try {
                //  Cover the outgoing footer first: blurring its focused view
                //  may draw it (a menu redraws its items), which the erase
                //  and the new art then paint over, not the other way round.
                const covered = this.hasLeftMenu()
                    ? []
                    : this._coverOtherFooters(footerName);
                this.client.term.rawWrite(ansi.goto(startRow, 1) + ansi.eraseLine(2));
                this.prepViewControllerWithArt(
                    footerName,
                    formId,
                    { startRow },
                    (err, vc, created) => {
                        try {
                            //  (a left menu's form is torn down: not drawn)
                            if (!err && !this.hasLeftMenu()) {
                                if (!created) {
                                    vc.redrawAll();
                                }
                            } else if (err && !this.hasLeftMenu()) {
                                //  no new footer: give the keys back to the
                                //  one that had them, as before
                                covered.forEach(f => FormLifecycle.activate(f));
                            }
                        } finally {
                            endBatch();
                        }
                        return cb(err);
                    }
                );
            } catch (e) {
                endBatch();
                throw e;
            }
        }

        //
        //  The footers share the rows below the body, and only |footerName|
        //  is shown: every other footer form is covered (no keys, no
        //  background drawing) until it is shown again. They are kept, not
        //  torn down, as each is shown again later (prepViewController()
        //  activates an existing form). Returns the footers that had the keys.
        //
        _coverOtherFooters(footerName) {
            const hadKeys = [];
            for (const name of FooterFormNames) {
                const vc = this.viewControllers[name];
                if (name !== footerName && vc instanceof ViewController) {
                    if (vc.attached) {
                        hadKeys.push(vc);
                    }
                    FormLifecycle.cover(vc);
                }
            }
            return hadKeys;
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
                        const footerStartRow = this._footerStartRow;
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
                        if (this.isEditMode()) {
                            return this._finishEditModeInit(() => this.finishedLoading());
                        }
                        this.finishedLoading();
                    }
                }
            );
        }

        //  Final init step for edit mode.
        //
        //  switchFooter() re-renders the footer art so the static command hints
        //  (painted over by the body MLTEV render during mciReady) are visible
        //  from the start — this is the #705/#706 fix. But switchFooter() also
        //  moves keyboard focus onto the footer ViewController, so focus must be
        //  restored afterward.
        //
        //  Focus is then restored to whichever section init landed on — and only
        //  that one — so a single ViewController is attached to the client 'key
        //  press' event. Attaching two input-accepting sections at once (as the
        //  original code did by returning focus to the body while the header was
        //  still attached) delivered every keystroke — and later the ESC
        //  command-menu navigation — to both views, corrupting input (#712).
        //
        //  A fresh compose starts on the header (To field); returning from an
        //  upload round-trip keeps the cursor in the body, where _restoreSavedState
        //  set _focusBodyAfterInit. _returnFocusToBody()/switchToHeader() each
        //  detach the other section, preserving the single-attach invariant.
        _finishEditModeInit(cb) {
            this.switchFooter(() => {
                if (this._focusBodyAfterInit) {
                    this._returnFocusToBody();
                } else {
                    this.switchToHeader();
                }
                return cb();
            });
        }

        //  Step 1 of createInitialViews: prep header, body, and footer ViewControllers.
        _prepViewControllers(mciData, cb) {
            const footerName = this.getFooterName();
            async.series(
                [
                    callback =>
                        this.prepViewController(
                            'header',
                            FormIds.header,
                            mciData.header.mciMap,
                            callback
                        ),
                    callback =>
                        this.prepViewController(
                            'body',
                            FormIds.body,
                            mciData.body.mciMap,
                            callback
                        ),
                    callback =>
                        this.prepViewController(
                            footerName,
                            FormIds[footerName],
                            mciData[footerName].mciMap,
                            callback
                        ),
                ],
                cb
            );
        }

        //  Step 2: hide the Upload item from the editor menu if the user lacks ACS.
        _hideRestrictedMenuItems(cb) {
            if (
                'footerEditorMenu' === this.getFooterName() &&
                !this.client.acs.hasMessageBodyUpload(this.menuConfig.config || {})
            ) {
                const hmView = this.viewControllers.footerEditorMenu?.getView(1);
                if (hmView) {
                    hmView.setItems(
                        hmView.getItems().filter(t => 'upload' !== t.toLowerCase())
                    );
                    hmView.redraw();
                }
            }
            return cb(null);
        }

        //  Subclasses that allow the sender to type their own From name (e.g.
        //  pre-auth feedback) override this to return true.
        _isFromFieldEditable() {
            return false;
        }

        //  Subclasses that should not stamp a local from-user-id (e.g. pre-auth
        //  feedback where the sender has no user record) override this to return 0.
        _getLocalFromUserId() {
            return this.client.user.userId;
        }

        //  Subclasses that provide a different From name source (e.g. a free-text
        //  field typed by a pre-auth user) override this.
        _getFromUserName(area) {
            return area && area.realNames
                ? this.client.user.getProperty(UserProps.RealName) ||
                      this.client.user.username
                : this.client.user.username;
        }

        //  Step 3: lock the From field (display-only) and seed the body view's
        //  edit-mode/position indicator state.
        _initViewState(cb) {
            const from = this.viewControllers.header.getView(MciViewIds.header.from);
            if (from && !this._isFromFieldEditable()) {
                from.acceptsFocus = false;
            }

            const body = this.viewControllers.body.getView(MciViewIds.body.message);
            this.updateTextEditMode(body.getTextEditMode());
            this.updateEditModePosition(body.getEditPosition());

            return cb(null);
        }

        //  Step 4: populate the From field and (for replies) set subject/recipient.
        //  View mode skips this — setMessage() handles population after isReady.
        _initHeaderFields(cb) {
            if (this.editorMode === 'edit') {
                const fromView = this.viewControllers.header.getView(
                    MciViewIds.header.from
                );
                if (fromView !== undefined) {
                    const area = getMessageAreaByTag(this.messageAreaTag);
                    fromView.setText(
                        area && area.realNames
                            ? this.client.user.realName()
                            : this.client.user.username
                    );
                }

                if (this.replyToMessage) {
                    this.initHeaderReplyEditMode();
                }
            }
            return cb(null);
        }

        //  Step 5: move initial keyboard focus to the right section based on mode.
        _setInitialFocus(cb) {
            switch (this.editorMode) {
                case 'edit':
                    this.switchToHeader();
                    break;
                case 'view':
                    this.switchToFooter();
                    break;
            }
            return cb(null);
        }

        //  Step 5b: a new message started from one handed in as
        //  extraArgs.message (page sysop's "send as mail": addressed to the
        //  sysop, the page text as its body). setMessage() fills the views
        //  only in view mode; in edit mode the message was kept and never
        //  shown, so the editor opened empty (#1144). Its To, Subject and
        //  body go into the views here, and the cursor into the body, as
        //  after an upload round-trip: the message is ready to add to or
        //  save. A round-trip back here (help, upload) restores what was
        //  typed instead, in the next step.
        _initFromPresetMessage(cb) {
            if (
                !this.isEditMode() ||
                this.isReply() ||
                !this.message ||
                this._pendingSavedState
            ) {
                return cb(null);
            }

            const { toUserName, subject, message } = this.message;
            if (toUserName) {
                this.setHeaderText(MciViewIds.header.to, toUserName);
            }
            if (subject) {
                this.setHeaderText(MciViewIds.header.subject, subject);
            }
            const bodyView = this._bodyView;
            if (bodyView && message) {
                bodyView.setText(message);
            }

            //  with no addressee the caller still has To to fill: the
            //  cursor stays there
            if (toUserName) {
                this._focusBodyAfterInit = true;
                this.switchToBody();
            }
            return cb(null);
        }

        //  Step 6: restore state saved before a gotoMenu round-trip (e.g. file upload).
        //  Runs last so all views already exist.  Handles both the upload-completed
        //  case (read file → detect encoding → load body) and the simple round-trip
        //  case (e.g. help screen — just restore body text and refocus).
        _restoreSavedState(cb) {
            const saved = this._pendingSavedState;
            if (!saved) {
                return cb(null);
            }
            this._pendingSavedState = null;

            //  Restore header fields the user had typed before the transfer.
            const toView = this.viewControllers.header.getView(MciViewIds.header.to);
            const subjView = this.viewControllers.header.getView(
                MciViewIds.header.subject
            );
            if (toView && saved.headerTo) toView.setText(saved.headerTo);
            if (subjView && saved.headerSubject) subjView.setText(saved.headerSubject);

            this.replyIsAnsi = !!saved.replyIsAnsi;
            //  a state saved before bodyIsAnsi existed used replyIsAnsi for both
            this.bodyIsAnsi =
                undefined === saved.bodyIsAnsi ? !!saved.replyIsAnsi : !!saved.bodyIsAnsi;
            this._ansiTagAdded = !!saved.ansiTagAdded;

            const bodyView = this._bodyView;

            //  After loading content, transfer focus to the body so the user
            //  can interact immediately (header ESC → prevMenu would fire otherwise).
            //  We also flag this so the final init step (_finishEditModeInit)
            //  re-focuses the body — not the header — after it redraws the footer
            //  (which steals focus). This keeps the cursor in the body when
            //  returning from an upload round-trip (#712).
            const done = () => {
                if (this.isEditMode()) {
                    this._focusBodyAfterInit = true;
                    this.switchToBody();
                }
                return cb(null);
            };

            const uploadReceived = this._pendingUploadFiles?.length > 0;

            //  A body upload that was canceled, or that received nothing, comes
            //  back with its temp directory still there and nothing to read
            //  out of it: remove it now rather than when the board shuts down.
            if (!uploadReceived && saved.tempUploadDir) {
                fse.remove(saved.tempUploadDir, rmErr => {
                    if (rmErr) {
                        this.client.log.warn(
                            { err: rmErr, tempDir: saved.tempUploadDir },
                            'FSE: failed to remove upload temp dir'
                        );
                    }
                });
            }

            if (uploadReceived) {
                //  A file transfer just completed.  Read the first received file,
                //  detect its encoding, and load it into the body.
                const uploadPath = this._pendingUploadFiles[0];
                const tempDir = saved.tempUploadDir || paths.dirname(uploadPath);
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
                        this.client.log.warn(
                            { err, uploadPath },
                            'FSE: failed to read uploaded file'
                        );
                        return done(); //  non-fatal; just leave body empty
                    }

                    //  Detect encoding: UTF-8 BOM wins outright; otherwise attempt a
                    //  UTF-8 decode — if it produces no replacement characters the file
                    //  is clean UTF-8.  CP437 is the fallback (most classic ANSI art
                    //  uses high-byte block/box chars that are not valid UTF-8 sequences).
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

                    //  The upload replaces the body, so it alone decides
                    //  whether the body is ANSI
                    this.bodyIsAnsi = isAnsi(content);
                    this._syncAnsiSubjectTag(this.bodyIsAnsi);
                    if (this.bodyIsAnsi) {
                        return bodyView.setAnsi(
                            content,
                            { prepped: false, forceLineTerm: true },
                            done
                        );
                    } else {
                        //  Plain text — pipe/PCBoard codes handled at display time.
                        bodyView.setText(content);
                        return done();
                    }
                });
            } else if (saved.bodyText) {
                //  Round-trip with no upload (e.g. help screen) — restore body.
                if (this.bodyIsAnsi) {
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
        }

        createInitialViews(mciData, cb) {
            async.series(
                [
                    callback => this._prepViewControllers(mciData, callback),
                    callback => this._hideRestrictedMenuItems(callback),
                    callback => this._initViewState(callback),
                    callback => this._initHeaderFields(callback),
                    callback => this._setInitialFocus(callback),
                    callback => this._initFromPresetMessage(callback),
                    callback => this._restoreSavedState(callback),
                ],
                cb
            );
        }

        mciReadyHandler(mciData, cb) {
            this.createInitialViews(mciData, cb);
        }

        updateEditModePosition(pos) {
            if (!this.isEditMode()) return;

            const statusView = this.viewControllers.footerEditor?.getView(
                MciViewIds.editorFooter.status
            );
            if (!statusView) return;

            //  setPanel targets only the 'pos' slot; the 'mode' panel is unchanged.
            //  moveClientCursorToCursorPos() uses pipe-code display-col mapping so
            //  buffer col ≠ display col on |## lines doesn't cause rightward drift.
            statusView.setPanel(
                'pos',
                `${String(pos.row + 1).padStart(2, '0')},${String(pos.col + 1).padStart(
                    2,
                    '0'
                )}`
            );
            this._bodyView?.moveClientCursorToCursorPos();
        }

        updateTextEditMode(mode) {
            if (!this.isEditMode()) return;

            const statusView = this.viewControllers.footerEditor?.getView(
                MciViewIds.editorFooter.status
            );
            if (!statusView) return;

            statusView.setPanel('mode', 'insert' === mode ? 'INS' : 'OVR');
            this._bodyView?.moveClientCursorToCursorPos();
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

        getModTimestampFormat() {
            return (
                this.menuConfig.config.modTimestampFormat ||
                this.client.currentTheme.helpers.getDateTimeFormat()
            );
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
                moment(this.message.modTimestamp).format(this.getModTimestampFormat())
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
            if (!this.replyToMessage) return;

            this.setHeaderText(MciViewIds.header.to, this.replyToMessage.fromUserName);

            //
            //  We want to prefix the subject with "RE: " only if it's not already
            //  that way -- avoid RE: RE: RE: RE: ...
            //
            //  "[ANSI] RE: ..." is a reply the editor tagged: the tag described
            //  that reply's body, so it is dropped here, and this reply is
            //  tagged again only if its own body is ANSI (#1084). A tag after
            //  the "RE: " is part of the thread's subject and stays.
            //
            let newSubj = (this.replyToMessage.subject || '').replace(
                ANSI_TAGGED_REPLY_SUBJECT_RE,
                ''
            );
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
                MciViewIds.viewModeFooter.msgNum,
                (this.messageIndex + 1).toString()
            );
            this.setViewText(
                'footerView',
                MciViewIds.viewModeFooter.msgTotal,
                this.messageTotal.toString()
            );
        }

        //  Help is shown over the editor, whose forms stay attached: as a
        //  cover, so the key that dismisses it is not typed into the message
        //  (#1137) and nothing in the editor draws over it
        displayHelp(cb) {
            this.coverScreen(
                { restore: done => this.redrawScreen(done) },
                done => {
                    this.client.term.rawWrite(ansi.resetScreen());

                    theme.displayThemeArt(
                        { name: this.menuConfig.config.art.help, client: this.client },
                        () => {
                            this.client.waitForKeyPress(() => done(null));
                        }
                    );
                },
                err => {
                    if (err) return cb(err);
                    this.viewControllers[this.getFooterName()].setFocus(true);
                    return cb(null);
                }
            );
        }

        //  "Added to your download queue", shown over the attached message
        //  view: a cover, as help is
        displayExportedToDownloadQueue(cb) {
            const artSpec =
                this.menuConfig.config.art.expToDlQueue ||
                Buffer.from('Exported message has been added to your download queue!');
            this.coverScreen(
                { restore: done => this.redrawScreen(() => done(null)) },
                done => {
                    this.displayAsset(artSpec, { clearScreen: true }, () => {
                        this.client.waitForKeyPress(() => done(null));
                    });
                },
                () => {
                    this.viewControllers[this.getFooterName()].setFocus(true);
                    return cb(null);
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
                        const body = this._bodyView.getData({ forceLineTerms: true });

                        const cleanBody = stripAllControlCodes(body);

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
                        return this.displayExportedToDownloadQueue(callback);
                    },
                ],
                err => {
                    if (err) {
                        //  Restore the screen/footer so the user isn't left with a blank display.
                        this.redrawScreen(() => {
                            this.viewControllers[this.getFooterName()].setFocus(true);
                            return cb(err);
                        });
                    } else {
                        return cb(null);
                    }
                }
            );
        }

        displayQuoteBuilder() {
            this.newQuoteBlock = true;
            this._ansiQuoteLines = [];
            const self = this;

            async.waterfall(
                [
                    function clearAndDisplayArt(callback) {
                        //  Batch the erase + art display into a single socket write so the
                        //  client never sees the intermediate blank state.
                        //  eraseData(0) = erase from cursor to end of display; works on all
                        //  major BBS terminals (unlike deleteLine which scrolls content up and
                        //  is unsupported on NetRunner).
                        //  Background drawing waits too: see _beginArtBatch().
                        const endBatch = self._beginArtBatch();
                        try {
                            self.client.term.rawWrite(
                                ansi.goto(self.header.height + 1, 1) + ansi.eraseData(0)
                            );

                            theme.displayThemeArt(
                                {
                                    name: self.menuConfig.config.art.quote,
                                    client: self.client,
                                },
                                function displayed(err, artData) {
                                    endBatch();
                                    callback(err, artData);
                                }
                            );
                        } catch (e) {
                            endBatch();
                            throw e;
                        }
                    },
                    function createViewsIfNecessary(artData, callback) {
                        const formId = FormIds.quoteBuilder;

                        if (self.viewControllers.quoteBuilder === undefined) {
                            const menuLoadOpts = {
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
                            Object.assign(
                                {
                                    termWidth: self.client.term.termWidth,
                                    termHeight: self.client.term.termHeight,
                                    cols: quoteView.dimens.width,
                                    startCol: quoteView.position.col,
                                    ansiResetSgr: bodyView.styleSGR1,
                                    ansiFocusPrefixSgr: quoteView.styleSGR2,
                                },
                                self._getQuoteLineOptions()
                            ),
                            (err, quoteLines, focusQuoteLines, replyIsAnsi) => {
                                if (err) {
                                    return callback(err);
                                }

                                //  how the quote lines are shown and added;
                                //  the body becomes ANSI only once ANSI
                                //  quote lines are added to it (finalize)
                                self.replyIsAnsi = !!replyIsAnsi;

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
            const bodyView = this._bodyView;
            if (!bodyView) return;

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
            FormLifecycle.deactivate(this.viewControllers.body);

            //  Already on To (the form's initial focus): give the header the
            //  keys back without moving focus. switchFocus() validates the
            //  view focus leaves, even when it is the one asked for, so To
            //  was checked as if the caller had left it: empty, that showed
            //  "Field cannot be empty" before anything was typed (#1144).
            const header = this.viewControllers.header;
            const toView = header.getView(MciViewIds.header.to);
            if (toView && header.focusedView === toView) {
                return FormLifecycle.activate(header);
            }

            header.switchFocus(MciViewIds.header.to);
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

            FormLifecycle.deactivate(this.viewControllers.header);
            this.viewControllers.body.switchFocus(1);

            this.observeEditorEvents();
        }

        switchToFooter() {
            FormLifecycle.deactivate(this.viewControllers.header);
            FormLifecycle.deactivate(this.viewControllers.body);

            this.viewControllers[this.getFooterName()].switchFocus(1); //  HM1
        }

        switchFromQuoteBuilderToBody() {
            //  kept for the next quote: covered, not torn down
            FormLifecycle.cover(this.viewControllers.quoteBuilder);
            this.client.term.beginWrite();
            this._bodyView.redraw();
            this._returnFocusToBody(); //  has its own nested beginWrite/commitWrite
            this.client.term.commitWrite();
        }

        quoteBuilderFinalize() {
            const bodyView = this._bodyView;

            //  The quote lines decide the path. ANSI quote lines turn the body
            //  into ANSI (the existing text is kept, as text); plain quote
            //  lines are added as typed text would be, so an ANSI body (e.g.
            //  an uploaded file) stays ANSI and a plain body stays plain.
            if (this.replyIsAnsi) {
                //  ANSI path: combine any existing body content with the newly selected
                //  quote lines so repeated quote sessions append rather than replace.
                const ansiQuoteText = this._ansiQuoteLines.join('\r\n');
                this._ansiQuoteLines = [];
                if (ansiQuoteText.length > 0) {
                    this.bodyIsAnsi = true;
                    this._syncAnsiSubjectTag(true);
                }

                this.footerMode = 'editor';
                this.switchFooter(err => {
                    if (err) {
                        return this.client.log.warn(
                            { err },
                            'FSE: switchFooter failed in quoteBuilderFinalize (ANSI)'
                        );
                    }
                    if (ansiQuoteText.length > 0) {
                        //  Retrieve already-processed ANSI from the body buffer so we can
                        //  append without re-running ansiPrep on existing content.
                        const existing = bodyView
                            .getData({ forceLineTerms: true })
                            .trimEnd();
                        const combined = existing
                            ? `${existing}\r\n\r\n${ansiQuoteText}\r\n\r\n`
                            : `${ansiQuoteText}\r\n\r\n`;
                        bodyView.setAnsi(combined, { prepped: true }, _err => {
                            bodyView.cursorEndOfDocument();
                            this.switchFromQuoteBuilderToBody();
                        });
                    } else {
                        this.switchFromQuoteBuilderToBody();
                    }
                });
            } else {
                //  Plain text path: drain the MT1 preview view into the body editor
                const quoteMsgView = this.viewControllers.quoteBuilder.getView(
                    MciViewIds.quoteBuilder.quotedMsg
                );
                const quoteLines = quoteMsgView.getData().trim();
                if (quoteLines.length > 0) {
                    bodyView.addText(`${quoteLines}\n\n`, { scrollMode: 'end' });
                }
                quoteMsgView.setText('');

                this.footerMode = 'editor';
                this.switchFooter(err => {
                    if (err) {
                        return this.client.log.warn(
                            { err },
                            'FSE: switchFooter failed in quoteBuilderFinalize'
                        );
                    }
                    this.switchFromQuoteBuilderToBody();
                });
            }
        }

        //  Returns extra options merged into the getQuoteLines() call.
        //  Subclasses can override to inject e.g. a custom quotePrefix.
        _getQuoteLineOptions() {
            return {};
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
            this._endArtBatches();
        }

        mciReady(mciData, cb) {
            return this.mciReadyHandler(mciData, cb);
        }
    };
