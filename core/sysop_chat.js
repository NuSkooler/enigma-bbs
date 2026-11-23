/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { pipeToAnsi } = require('./color_codes.js');
const stringFormat = require('./string_format.js');
const ansi = require('./ansi_term.js');
const { TextView } = require('./text_view.js');
const PipeCodes = require('./pipe_codes.js');
const { ErrorReasons } = require('./enig_error.js');

//  The input line previews |## colour codes only (EditTextView's live colour)
const EDITOR_TEXT = { dialect: 'color' };

//  deps
const _ = require('lodash');
const async = require('async');
const moment = require('moment');
const { randomUUID } = require('crypto');

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
    const id = randomUUID();
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
        if (
            session.state === 'pending' &&
            session.userClient &&
            session.userClient.node === nodeId
        ) {
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
        sysopLog: 1, //  MT1 — sysop's scrollback panel
        sysopInput: 2, //  ET2 — sysop's input line
        userLog: 3, //  MT3 — user's scrollback
        userInput: 4, //  ET4 — user's input line

        //  10+ are custom-range status/info views driven by chatInfoFormat10, etc.
        customRangeStart: 10,
    },
};

//  view ID -> the MCI code the chat art must have for it
const RequiredChatMci = {
    [MciViewIds.chat.sysopLog]: 'MT1',
    [MciViewIds.chat.sysopInput]: 'ET2',
    [MciViewIds.chat.userLog]: 'MT3',
    [MciViewIds.chat.userInput]: 'ET4',
};

exports.getModule = class SysopChatModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        //  extraArgs supplied by whoever navigates us here
        this.sessionId = _.get(options, 'extraArgs.sessionId');
        this.role = _.get(options, 'extraArgs.role'); // 'sysop' | 'user'
        this.chatStartTime = moment();

        this.menuMethods = {
            sendMessage: (formData, extraArgs, cb) => this._sendMessage(formData, cb),
            endChat: (formData, extraArgs, cb) => this._endChat(cb),
        };
    }

    initSequence() {
        async.series(
            [callback => this.beforeArt(callback), callback => this._initChat(callback)],
            err => {
                if (err) {
                    return this.initSequenceFailed(err);
                }
                return this.finishedLoading();
            }
        );
    }

    //
    //  The chat could not be set up: its art is missing, say, or lacks one
    //  of the views both sides type and read in. Nobody can type in what
    //  is on screen, so say why in the log and end the chat as Escape
    //  would (_endChat()): a partner already in it is told and sent back,
    //  and this side goes back to where it came from.
    //
    //  Unlike the base, this always goes back. The base stays put on a
    //  repeat failure in case the previous menu leads straight back here;
    //  nothing does (a chat is only ever reached by someone choosing to
    //  start one), and staying would strand the caller in a dead chat.
    //
    initSequenceFailed(err) {
        //  left while loading (or the caller went): leave() ended the session
        if (this.hasLeftMenu() || ErrorReasons.ClientEnded === err.reasonCode) {
            return;
        }

        const logObj = {
            menuName: this.menuName,
            role: this.role,
            //  not sessionId: the log already has that, for the connection
            chatSessionId: this.sessionId,
            error: err.message,
        };
        const missingMci = this._missingChatMci();
        if (missingMci.length > 0) {
            logObj.missingMci = missingMci;
            logObj.requiredMci = Object.values(RequiredChatMci);
        }
        this.client.log.error(logObj, 'Sysop chat could not be set up; ending the chat');

        return this._endChat(() => {
            /* dummy */
        });
    }

    //  The required MCI codes the chat art did not provide ([] if none, or
    //  if the art never loaded)
    _missingChatMci() {
        const form = this.viewControllers.chat;
        if (!form) {
            return [];
        }
        return Object.keys(RequiredChatMci)
            .filter(id => !form.hasView(parseInt(id)))
            .map(id => RequiredChatMci[id]);
    }

    //
    //  A live chat must never be painted over, and unlike the WFC there is
    //  nothing here to route an item into -- so hold everything for the
    //  destination menu, which drains its queue in initSequence(). When that
    //  destination is the WFC (the usual case, since the +op arrives here by
    //  pressing B on the dashboard) it routes rather than displays.
    //
    //  This is explicit rather than inherited: the base returns false only
    //  because `realTimeInterrupt` never reaches 'allowed' in a module that
    //  overrides initSequence(), which is an accident we should not depend on.
    //
    attemptInterruptNow(interruptItem, cb) {
        return cb(null, false);
    }

    //
    //  Nothing is drawn over a chat, arriving or leaving. MenuModule.enter()
    //  drains queued interrupts on arrival, which for every other menu is
    //  right -- here it would paint over the conversation before it is even
    //  drawn. Defer instead: the queue is untouched and the next menu shows it.
    //
    displayQueuedInterruptions(cb) {
        return cb(null);
    }

    //
    //  The base no longer drains on departure, so this is only about handing
    //  over cleanly: detach before the stack pops so nothing of ours is still
    //  listening while the destination draws.
    //
    prevMenu(cb) {
        this.detachViewControllers();
        return super.prevMenu(cb);
    }

    _initChat(cb) {
        async.series(
            [
                callback =>
                    this.displayArtAndPrepViewController(
                        'chat',
                        FormIds.chat,
                        { clearScreen: true },
                        callback
                    ),
                callback =>
                    this.validateMCIByViewIds(
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
                            const chatMenuName = _.get(
                                this.config,
                                'chatMenuName',
                                'sysopChat'
                            );
                            session.userClient.menuStack.goto(
                                chatMenuName,
                                {
                                    extraArgs: {
                                        sessionId: this.sessionId,
                                        role: 'user',
                                    },
                                },
                                () => {}
                            );
                        }
                    } else {
                        session.userModule = this;

                        //  Flush any messages the sysop sent before we loaded
                        if (Array.isArray(session.pendingMessages)) {
                            session.pendingMessages.forEach(
                                ({ displayLine, senderRole }) => {
                                    this._appendToPanel(senderRole, displayLine);
                                }
                            );
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
                    const myInputId =
                        this.role === 'sysop'
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
        //  Once a minute, and {duration} is humanized: most ticks change nothing
        this.updateCustomViewTextsWithFilter(
            'chat',
            MciViewIds.chat.customRangeStart,
            {
                partnerName: this._getPartnerName(session),
                duration: moment.duration(moment().diff(this.chatStartTime)).humanize(),
                userName: this.client.user.username,
                userNode: this.client.node,
            },
            { skipUnchanged: true }
        );
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
            {
                role: this.role,
                fieldName,
                sessionId: this.sessionId,
                textLen: text.length,
            },
            'sysopChat._sendMessage'
        );

        if (!text) {
            return cb(null);
        }

        //  Clear our own input view
        const myInputId =
            this.role === 'sysop'
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

        const partnerModule =
            this.role === 'sysop' ? session.userModule : session.sysopModule;
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
        const viewId =
            senderRole === 'sysop' ? MciViewIds.chat.sysopLog : MciViewIds.chat.userLog;

        const view = this.getView('chat', viewId);
        if (!view) {
            return;
        }

        //  addText redraws the log panel and leaves the terminal cursor there,
        //  usually while the user is typing (the partner's lines arrive at any
        //  time): drawInBackground() puts it back in the focused input line,
        //  through its patched, prefix-aware _repositionCursor()
        //  The line goes in first, and is drawn after: a background draw only
        //  draws (see View.drawInBackground())
        view.addText(pipeToAnsi(displayLine, this.client), {
            scrollMode: 'end',
            redraw: false,
        });
        view.drawInBackground(() => view.redrawChanged());
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
        //  The width is that of the rendered prefix: a pipe left after
        //  rendering ('||' drawn as '|') is text and takes its column
        const { text: resolvedPrefix, width: prefixW } = prefixFmt
            ? PipeCodes.renderWithWidth(
                  stringFormat(
                      prefixFmt,
                      { userName: this.client.user.username },
                      { client }
                  ),
                  { client }
              )
            : { text: '', width: 0 };

        //  Wire itemFormat so TextView.drawText applies pipeToAnsi on every redraw.
        //  Also store on the view instance so EditTextView._atomicLineWrite can use them
        //  directly (needed for expanded-mode rendering that bypasses pipeToAnsi).
        //  resolvedPrefix is rendered: escaped, it comes out of the redraw's
        //  render as it is
        inputView.itemFormat = PipeCodes.escape(resolvedPrefix) + '{text}';
        inputView._resolvedPrefix = resolvedPrefix;
        inputView._prefixW = prefixW;
        //  the scroll offset below is in display columns, prefix or not
        inputView._scrollInCells = true;

        //  ── Helpers ──────────────────────────────────────────────────────────

        //  Display columns of s up to rawIndex, as the live preview draws it
        //  (|## codes take none).
        const visLen = (s, rawIndex) =>
            PipeCodes.width(
                rawIndex === undefined ? s : s.slice(0, rawIndex),
                EDITOR_TEXT
            );

        //  A column that is not inside a wide character: one inside moves to
        //  the column after it, so the window never starts mid-character.
        const charStart = (s, col) => {
            if (0 === col) {
                return 0;
            }
            const end = PipeCodes.splitPos(s, col, EDITOR_TEXT);
            const w = PipeCodes.width(s.slice(0, end), EDITOR_TEXT);
            return w < col ? visLen(s, PipeCodes.splitPos(s, col + 1, EDITOR_TEXT)) : col;
        };

        //  Where the window may start: not inside a wide character, and not
        //  inside the code shown as typed (in |text| that is three columns).
        const windowStart = (text, expanded, col) => {
            col = charStart(text, col);
            if (!expanded) {
                return col;
            }
            const nearCol = visLen(text, inputView._pipeNearIndex);
            return col > nearCol && col < nearCol + 3 ? nearCol + 3 : col;
        };

        const effectiveWidth = () => inputView.dimens.width - prefixW;

        //  ── Patch scroll offset (now in display columns) ─────────────────────
        //  (laid out as the live preview draws it: a code shown as typed is
        //  three columns)
        inputView._computeScrollOffset = () => {
            const raw = inputView.lineBuffer ? inputView.lineBuffer.lines[0].chars : '';
            const text = inputView._previewChars(raw);
            const visTotal = visLen(text);
            const col = inputView.cursorPos.col;
            const visCur = col >= text.length ? visTotal : visLen(text, col);
            const ew = effectiveWidth();
            const cur = inputView._scrollOffset || 0;
            const maxOff = Math.max(0, visTotal - ew);

            if (visCur < cur) {
                return visCur;
            }
            if (visCur >= cur + ew) {
                return windowStart(text, text !== raw, Math.min(visCur - ew + 1, maxOff));
            }
            return windowStart(text, text !== raw, Math.min(cur, maxOff));
        };

        //  ── Patch drawText (use effective width for slice, skip to TextView) ─
        inputView.drawText = s => {
            //  as EditTextView.drawText(): a redraw draws every code as its
            //  colour, so a code shown as typed collapses first
            if (inputView._pipeExpanded) {
                inputView._ensureCollapsed();
            }
            if (inputView.hasFocus && inputView.lineBuffer) {
                inputView._scrollOffset = inputView._computeScrollOffset();
                s = inputView._visSliceRaw(s, inputView._scrollOffset, effectiveWidth());
            }
            TextView.prototype.drawText.call(inputView, s);
        };

        //  ── Patch cursor positioning ─────────────────────────────────────────
        inputView._repositionCursor = () => {
            const raw = inputView.lineBuffer ? inputView.lineBuffer.getText() : '';
            const visCur = visLen(inputView._previewChars(raw), inputView.cursorPos.col);
            const screenCol =
                inputView.position.col +
                prefixW +
                (visCur - (inputView._scrollOffset || 0));
            client.term.write(
                ansi.goto(inputView.position.row, screenCol) + inputView.getFocusSGR()
            );
        };
    }

    _endChat(cb) {
        const session = sessions.get(this.sessionId);

        //  Notify the partner before cleaning up
        if (session && session.state === 'active') {
            const partnerModule =
                this.role === 'sysop' ? session.userModule : session.sysopModule;
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
            const partnerModule =
                this.role === 'sysop' ? session.userModule : session.sysopModule;
            if (partnerModule && !partnerModule._chatEndedHandled) {
                partnerModule.chatEnded();
            }
            exports.endSession(this.sessionId);
        }

        this.client.startIdleMonitor();
        super.leave();
    }
};
