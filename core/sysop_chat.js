/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { pipeToAnsi } = require('./color_codes.js');
const stringFormat = require('./string_format.js');
const ansi = require('./ansi_term.js');
const { renderStringLength } = require('./string_util.js');
const { TextView } = require('./text_view.js');

//  deps
const _ = require('lodash');
const async = require('async');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');

exports.moduleInfo = {
    name: 'Sysop Chat',
    desc: 'Split-screen chat between sysop and user',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.sysop_chat',
};

//
//  Session registry — exported so page_sysop.js and wfc.js can interact with it.
//
//  Session shape:
//  {
//    id:          string (uuid)
//    state:       'pending' | 'active' | 'ended'
//    userClient:  client ref (the regular user)
//    sysopClient: client ref (null until activated)
//    message:     string (page reason, may be empty)
//    createdAt:   moment
//    userModule:  SysopChatModule instance (set when user enters the mod)
//    sysopModule: SysopChatModule instance (set when sysop enters the mod)
//  }
//
const sessions = new Map();

exports.getSessions = () => sessions;

exports.createSession = (userClient, message) => {
    const id = uuidv4();
    sessions.set(id, {
        id,
        state: 'pending',
        userClient,
        sysopClient: null,
        message: message || '',
        createdAt: moment(),
        userModule: null,
        sysopModule: null,
    });
    return id;
};

exports.activateSession = (sessionId, sysopClient) => {
    const session = sessions.get(sessionId);
    if (!session) {
        return false;
    }
    session.sysopClient = sysopClient;
    session.state = 'active';
    return true;
};

exports.endSession = sessionId => {
    const session = sessions.get(sessionId);
    if (!session) {
        return;
    }
    session.state = 'ended';
    sessions.delete(sessionId);
};

//  Find a pending session where the user is on a given node
exports.getPendingSessionForNode = nodeId => {
    for (const [id, session] of sessions) {
        if (session.state === 'pending' && session.userClient && session.userClient.node === nodeId) {
            return id;
        }
    }
    return null;
};

//  Remove any pending sessions belonging to a client that has disconnected
exports.clearSessionsForClient = client => {
    for (const [id, session] of sessions) {
        if (session.state === 'pending' && session.userClient === client) {
            sessions.delete(id);
        }
    }
};

//
//  MCI view IDs
//
const FormIds = {
    chat: 0,
};

const MciViewIds = {
    chat: {
        sysopLog:  1,  //  MT1 — sysop's scrollback panel
        sysopInput: 2,  //  ET2 — sysop's input line
        userLog:   3,  //  MT3 — user's scrollback
        userInput:  4,  //  ET4 — user's input line

        //  10+ are custom-range status/info views driven by chatInfoFormat10, etc.
        customRangeStart: 10,
    },
};

exports.getModule = class SysopChatModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        //  extraArgs supplied by whoever navigates us here
        this.sessionId = _.get(options, 'extraArgs.sessionId');
        this.role      = _.get(options, 'extraArgs.role'); // 'sysop' | 'user'
        this.chatStartTime = moment();

        this.menuMethods = {
            sendMessage: (formData, extraArgs, cb) => this._sendMessage(formData, cb),
            endChat: (formData, extraArgs, cb) => this._endChat(cb),
        };
    }

    initSequence() {
        async.series(
            [
                callback => this.beforeArt(callback),
                callback => this._initChat(callback),
            ],
            () => this.finishedLoading()
        );
    }

    _initChat(cb) {
        async.series(
            [
                callback => this.displayArtAndPrepViewController(
                    'chat',
                    FormIds.chat,
                    { clearScreen: true },
                    callback
                ),
                callback => this.validateMCIByViewIds(
                    'chat',
                    [
                        MciViewIds.chat.sysopLog,
                        MciViewIds.chat.sysopInput,
                        MciViewIds.chat.userLog,
                        MciViewIds.chat.userInput,
                    ],
                    callback
                ),
                callback => {
                    const session = sessions.get(this.sessionId);
                    if (!session || session.state === 'ended') {
                        return this.prevMenu(callback);
                    }

                    if (this.role === 'sysop') {
                        session.sysopModule = this;
                        // No pending flush needed for sysop — they're first to arrive

                        //  Push the user directly into chat — no pre-chat interrupt art.
                        //  The abrupt transition is intentional: the sysop has already
                        //  chosen to break in, and any delay risks confusing state.
                        if (session.userClient) {
                            const chatMenuName = _.get(this.config, 'chatMenuName', 'sysopChat');
                            session.userClient.menuStack.goto(
                                chatMenuName,
                                { extraArgs: { sessionId: this.sessionId, role: 'user' } },
                                () => {}
                            );
                        }
                    } else {
                        session.userModule = this;

                        //  Flush any messages the sysop sent before we loaded
                        if (Array.isArray(session.pendingMessages)) {
                            session.pendingMessages.forEach(({ displayLine, senderRole }) => {
                                this._appendToPanel(senderRole, displayLine);
                            });
                            session.pendingMessages = [];
                        }

                        //  Let the sysop know the user is connected and ready
                        if (session.sysopModule) {
                            session.sysopModule._updateStatus();
                        }
                    }

                    this._updateStatus();
                    this.client.stopIdleMonitor();

                    //  Refresh status every minute so the duration stays current
                    this._statusTimer = setInterval(() => {
                        const s = sessions.get(this.sessionId);
                        if (!s || s.state === 'ended') {
                            clearInterval(this._statusTimer);
                            return;
                        }
                        this._updateStatus();
                    }, 60 * 1000);

                    //  Configure the input view before focusing so that the
                    //  prefix and live colour are in place for the initial redraw
                    //  that switchFocus triggers.
                    const myInputId = this.role === 'sysop'
                        ? MciViewIds.chat.sysopInput
                        : MciViewIds.chat.userInput;
                    const inputView = this.getView('chat', myInputId);
                    if (inputView) {
                        this._enableLiveColorOnInput(inputView);
                    }

                    //  switchFocus attaches client events so typing works and
                    //  triggers the first redraw (now with itemFormat set above).
                    this.viewControllers.chat.switchFocus(myInputId);

                    return callback(null);
                },
            ],
            cb
        );
    }

    _updateStatus() {
        const session = sessions.get(this.sessionId);
        this.updateCustomViewTextsWithFilter('chat', MciViewIds.chat.customRangeStart, {
            partnerName: this._getPartnerName(session),
            duration:    moment.duration(moment().diff(this.chatStartTime)).humanize(),
            userName:    this.client.user.username,
            userNode:    this.client.node,
        });
        this._restoreCursorToInput();
    }

    _getPartnerName(session) {
        if (!session) {
            return '?';
        }
        if (this.role === 'sysop') {
            return session.userClient ? session.userClient.user.username : '?';
        }
        return session.sysopClient ? session.sysopClient.user.username : 'Sysop';
    }

    _sendMessage(formData, cb) {
        //  Read text from formData captured at submit time (most reliable);
        //  the field name matches the argName set on each role's input view.
        const fieldName = this.role === 'sysop' ? 'sysopMessage' : 'userMessage';
        const text = (_.get(formData, ['value', fieldName], '') || '').trim();

        this.client.log.trace(
            { role: this.role, fieldName, sessionId: this.sessionId, textLen: text.length },
            'sysopChat._sendMessage'
        );

        if (!text) {
            return cb(null);
        }

        //  Clear our own input view
        const myInputId = this.role === 'sysop'
            ? MciViewIds.chat.sysopInput
            : MciViewIds.chat.userInput;
        const inputView = this.getView('chat', myInputId);
        if (inputView) {
            inputView.setText('');
        }

        const session = sessions.get(this.sessionId);
        if (!session || session.state === 'ended') {
            return cb(null);
        }

        const displayLine = stringFormat(
            this.config.messageFormat || '|15{userName}|07: {message}',
            { userName: this.client.user.username, message: text }
        );

        //  Append to our own panel immediately
        this._appendToPanel(this.role, displayLine);

        const partnerModule = this.role === 'sysop' ? session.userModule : session.sysopModule;
        if (partnerModule) {
            try {
                partnerModule.receiveMessage(displayLine, this.role);
            } catch (err) {
                this.client.log.warn(
                    { err: err.message },
                    'sysopChat: failed to deliver message to partner'
                );
            }
        } else {
            //  Partner not yet loaded — queue for delivery when they arrive
            if (!session.pendingMessages) {
                session.pendingMessages = [];
            }
            session.pendingMessages.push({ displayLine, senderRole: this.role });
        }

        return cb(null);
    }

    //  Called by the partner's module instance to push an incoming line
    receiveMessage(displayLine, senderRole) {
        this._appendToPanel(senderRole, displayLine);
    }

    _appendToPanel(senderRole, displayLine) {
        const viewId = senderRole === 'sysop'
            ? MciViewIds.chat.sysopLog
            : MciViewIds.chat.userLog;

        const view = this.getView('chat', viewId);
        if (view) {
            view.addText(pipeToAnsi(displayLine, this.client), { scrollMode: 'end' });
        }

        //  addText redraws the log panel and leaves the terminal cursor there;
        //  move it back to our input field so the next keypress goes to the right place.
        this._restoreCursorToInput();
    }

    //  Configure an EditTextView for live colour rendering and an optional
    //  role-specific prefix.
    //
    //  prefixFormat can be set per-view in theme.hjson (ET2: { prefixFormat: … })
    //  or at the module config level (config: { prefixFormat: … }).  View-level
    //  wins.  Token {userName} is substituted at init time.
    //
    //  Setting itemFormat to "<resolvedPrefix>{text}" delegates all rendering
    //  (pipe codes, padding, SGR) to TextView.drawText on every redraw.
    //  drawText, _computeScrollOffset, and _repositionCursor are overridden on
    //  the instance to account for the prefix width and pipe codes in typed text.
    _enableLiveColorOnInput(inputView) {
        const client = this.client;

        //  ── Resolve prefix ───────────────────────────────────────────────────
        const prefixFmt = inputView.prefixFormat || this.config.prefixFormat || '';
        const resolvedPrefix = prefixFmt
            ? pipeToAnsi(stringFormat(prefixFmt, { userName: this.client.user.username }), client)
            : '';
        const prefixW = renderStringLength(resolvedPrefix); // visible terminal columns

        //  Wire itemFormat so TextView.drawText applies pipeToAnsi on every redraw.
        //  Also store on the view instance so EditTextView._atomicLineWrite can use them
        //  directly (needed for expanded-mode rendering that bypasses pipeToAnsi).
        inputView.itemFormat = resolvedPrefix + '{text}';
        inputView._resolvedPrefix = resolvedPrefix;
        inputView._prefixW = prefixW;

        //  ── Helpers ──────────────────────────────────────────────────────────

        //  Visible (non-pipe-code) char count of s up to rawIndex.
        const visLen = (s, rawIndex) => {
            const sub = rawIndex === undefined ? s : s.slice(0, rawIndex);
            return sub.replace(/\|[0-9]{2}/g, '').length;
        };

        //  Slice s to visCount visible chars starting at visible offset visOff,
        //  preserving pipe codes so they reach TextView.drawText intact.
        const visSlice = (s, visOff, visCount) => {
            let i = 0, vis = 0;
            while (i < s.length && vis < visOff) {
                if (s[i] === '|' && /[0-9]{2}/.test(s.slice(i + 1, i + 3))) { i += 3; }
                else { i++; vis++; }
            }
            let result = '', seen = 0;
            while (i < s.length && seen < visCount) {
                if (s[i] === '|' && /[0-9]{2}/.test(s.slice(i + 1, i + 3))) {
                    result += s.slice(i, i + 3); i += 3;
                } else { result += s[i]; i++; seen++; }
            }
            return result;
        };

        const effectiveWidth = () => inputView.dimens.width - prefixW;

        //  ── Patch scroll offset (now in visible-char units) ──────────────────
        inputView._computeScrollOffset = () => {
            const raw = inputView.lineBuffer ? inputView.lineBuffer.lines[0].chars : '';
            const visCur = visLen(raw, inputView.cursorPos.col);
            const visTotal = visLen(raw);
            const ew = effectiveWidth();
            const cur = inputView._scrollOffset || 0;
            const maxOff = Math.max(0, visTotal - ew);

            if (visCur < cur)              { return visCur; }
            if (visCur >= cur + ew)        { return Math.min(visCur - ew + 1, maxOff); }
            return Math.min(cur, maxOff);
        };

        //  ── Patch drawText (use effective width for slice, skip to TextView) ─
        inputView.drawText = s => {
            if (inputView.hasFocus && inputView.lineBuffer) {
                inputView._scrollOffset = inputView._computeScrollOffset();
                s = visSlice(s, inputView._scrollOffset, effectiveWidth());
            }
            TextView.prototype.drawText.call(inputView, s);
        };

        //  ── Patch cursor positioning ─────────────────────────────────────────
        inputView._repositionCursor = () => {
            const raw = inputView.lineBuffer ? inputView.lineBuffer.getText() : '';
            const visCur = visLen(raw, inputView.cursorPos.col);
            const screenCol = inputView.position.col + prefixW + (visCur - (inputView._scrollOffset || 0));
            client.term.write(ansi.goto(inputView.position.row, screenCol) + inputView.getFocusSGR());
        };
    }

    _restoreCursorToInput() {
        const myInputId = this.role === 'sysop'
            ? MciViewIds.chat.sysopInput
            : MciViewIds.chat.userInput;
        const inputView = this.getView('chat', myInputId);
        if (inputView && typeof inputView._repositionCursor === 'function') {
            inputView._repositionCursor();
        }
    }

    _endChat(cb) {
        const session = sessions.get(this.sessionId);

        //  Notify the partner before cleaning up
        if (session && session.state === 'active') {
            const partnerModule = this.role === 'sysop' ? session.userModule : session.sysopModule;
            if (partnerModule) {
                partnerModule.chatEnded();
            }
        }

        exports.endSession(this.sessionId);
        this.client.startIdleMonitor();
        return this.prevMenu(cb);
    }

    //  Called on this module by the partner when they end the chat
    chatEnded() {
        clearInterval(this._statusTimer);

        const endMsg = this.config.chatEndedText || '|08[ Chat session ended ]|07';
        //  Show the end notice in the sysop panel regardless of our role
        //  so it's always visible in the top half of the screen
        const logView = this.getView('chat', MciViewIds.chat.sysopLog);
        if (logView) {
            logView.addText(pipeToAnsi(endMsg, this.client), { scrollMode: 'end' });
        }

        //  Give a brief moment to read the message, then exit.
        //  Guard with _chatEndedHandled so leave() doesn't double-trigger this path.
        this._chatEndedHandled = true;
        setTimeout(() => {
            exports.endSession(this.sessionId);
            this.client.startIdleMonitor();
            this.prevMenu(() => {});
        }, 2000);
    }

    leave() {
        clearInterval(this._statusTimer);

        //  If we leave without explicitly ending (e.g. disconnect), clean up.
        //  Skip if chatEnded() already scheduled the prevMenu path (avoid double-navigation).
        const session = sessions.get(this.sessionId);
        if (session && session.state !== 'ended') {
            const partnerModule = this.role === 'sysop' ? session.userModule : session.sysopModule;
            if (partnerModule && !partnerModule._chatEndedHandled) {
                partnerModule.chatEnded();
            }
            exports.endSession(this.sessionId);
        }

        this.client.startIdleMonitor();
        super.leave();
    }
};
