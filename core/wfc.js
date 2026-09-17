//  ENiGMA½
const fs = require('graceful-fs');

const { MenuModule } = require('./menu_module');
const stringFormat = require('./string_format');
const Events = require('./events');
const SysEvents = require('./system_events');
const SysopChat = require('./sysop_chat');

const {
    getActiveConnectionList,
    AllConnections,
    getConnectionByNodeId,
    removeClient,
} = require('./client_connections');
const StatLog = require('./stat_log');
const SysProps = require('./system_property');
const UserProps = require('./user_property');
const Log = require('./logger');
const Config = require('./config.js').get;
const { Errors } = require('./enig_error');
const { pipeToAnsi } = require('./color_codes');
const MultiLineEditTextView =
    require('./multi_line_edit_text_view').MultiLineEditTextView;
const WfcInbox = require('./wfc_inbox');
const { InterruptType } = require('./user_interrupt_queue');
const ansi = require('./ansi_term');

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const bunyan = require('bunyan');

exports.moduleInfo = {
    name: 'WFC',
    desc: 'Semi-Traditional Waiting For Caller',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.wfc',
};

const FormIds = {
    main: 0,
    help: 1,
    fullLog: 2,
    confirmKickPrompt: 3,
    messages: 4,
};

const MciViewIds = {
    main: {
        nodeStatus: 1,
        quickLogView: 2,
        selectedNodeStatusInfo: 3,
        confirmXy: 4,
        statusBar: 5,
        ticker: 6,

        customRangeStart: 10,
    },
    fullLog: {
        logList: 1,
        entryDetail: 2,

        customRangeStart: 10,
    },
    messages: {
        messageList: 1,
        messageDetail: 2,

        customRangeStart: 10,
    },
};

//
//  Where a notification goes when it reaches an +op who is sitting at the WFC.
//  A dashboard that gets painted over is not a dashboard, so nothing is ever
//  drawn on top of it -- each kind of notification is routed instead.
//
const Sinks = {
    Inbox: 'inbox', //  held for the op to read with the message key
    StatusBar: 'statusBar', //  surfaces as a count only
    Log: 'log', //  phase 4 -- no-op until then
    Ticker: 'ticker', //  phase 5 -- no-op until then
    Interrupt: 'interrupt', //  fall through to the normal queue
};

//
//  Overridable per install via the `notifications` config block. A type routed
//  to [] is deliberately dropped; an unknown/untagged type falls through to
//  Interrupt so that today's behaviour is what you get when nothing matches.
//
const DefaultNotificationSinks = {
    [InterruptType.NodeMsg]: [Sinks.Inbox, Sinks.StatusBar],
    [InterruptType.Achievement]: [Sinks.Log],
    [InterruptType.AchievementGlobal]: [Sinks.Log],
    //  The UserPagedSysop event already puts pages in pendingPages, where they
    //  drive {pendingPage*} and the node-list indicator. Queueing them again
    //  would double-report. Unifying pendingPages into the inbox is deferred.
    [InterruptType.SysopPage]: [],
    //  Sysops are typically unlimited, and enter() stops the idle monitor.
    [InterruptType.TimeWarning]: [],
    [InterruptType.System]: [Sinks.Interrupt],
};

//
//  System events the activity ticker can show, mapped to the short key an op
//  uses under `ticker.events`. Deliberately the same set sys_event_user_log
//  already subscribes to -- if it is worth writing to a user's log it is worth
//  putting on the marquee.
//
const TickerEventKeys = {
    [SysEvents.UserLogin]: 'userLogin',
    [SysEvents.UserLogoff]: 'userLogoff',
    [SysEvents.UserUpload]: 'userUpload',
    [SysEvents.UserDownload]: 'userDownload',
    [SysEvents.UserPostMessage]: 'userPostMessage',
    [SysEvents.UserSendMail]: 'userSendMail',
    [SysEvents.UserRunDoor]: 'userRunDoor',
    [SysEvents.UserSendNodeMsg]: 'userSendNodeMsg',
    [SysEvents.UserAchievementEarned]: 'userAchievementEarned',
};

//  Shown unless the op configures otherwise. Anything without a format string
//  is simply not shown, so ops opt in to the noisier ones.
const DefaultTickerEventFormats = {
    userLogin: '|15{userName}|07 logged in on node |15{nodeId}|07',
    userAchievementEarned: '|15{userName}|07 earned |14{title}|07 (+{points})',
    userUpload: '|15{userName}|07 uploaded |15{fileCount}|07 file(s)',
};

const DefaultTickerMaxItems = 10;

//  Secure + 2FA + root user + 'wfc' group.
const DefaultACS = 'SCAF2ID1GM[wfc]';
const MainStatRefreshTimeMs = 5000; // 5s
const MailCountTTLSeconds = 10;

exports.getModule = class WaitingForCallerModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        //
        //  Enforce that we have at least a secure connection in our ACS check
        //
        if (!this.config.acs) {
            this.config.acs = DefaultACS;
        } else if (!this.config.acs.includes('SC')) {
            this.config.acs = 'SC' + this.config.acs; //  secure connection at the very least
        }

        // ensure the menu instance has this setting
        if (!_.has(options, 'menuConfig.config.acs')) {
            _.set(options, 'menuConfig.config.acs', this.config.acs);
        }

        this.selectedNodeStatusIndex = -1; // no selection
        this.refreshing = false;
        this.pendingPages = []; //  [ { sessionId, userName, nodeId, message, timestamp } ]

        //  Store bound refs so we can properly remove the listeners in leave().
        //  .bind() returns a new function every call, so binding again at removal
        //  time never matches what was registered -- the listener then survives
        //  leave() and the stale instance keeps painting the dashboard over
        //  whatever menu the op moved on to, one more listener per visit.
        this._onClientDisconnectedBound = this._clientDisconnected.bind(this);
        this._onUserPagedSysopBound = this._onUserPagedSysop.bind(this);

        this.menuMethods = {
            toggleAvailable: (formData, extraArgs, cb) => {
                const avail = this.client.user.isAvailable();
                this.client.user.setAvailability(!avail);
                return this._refreshAll(cb);
            },
            toggleVisible: (formData, extraArgs, cb) => {
                const visible = this.client.user.isVisible();
                this.client.user.setVisibility(!visible);
                this.visibilityToggled = true; // we won't restore it in this case
                return this._refreshAll(cb);
            },
            displayHelp: (formData, extraArgs, cb) => {
                return this._displayHelpPage(cb);
            },
            setNodeStatusSelection: (formData, extraArgs, cb) => {
                const nodeStatusView = this.getView('main', MciViewIds.main.nodeStatus);
                if (!nodeStatusView) {
                    return cb(null);
                }

                const nodeId = parseInt(formData.ch); // 1-based
                if (isNaN(nodeId)) {
                    return cb(null);
                }

                const index = this._getNodeStatusIndexByNodeId(nodeStatusView, nodeId);
                if (index > -1) {
                    this.selectedNodeStatusIndex = index;
                    this._selectNodeByIndex(nodeStatusView, this.selectedNodeStatusIndex);

                    const nodeStatusSelectionView = this.getView(
                        'main',
                        MciViewIds.main.selectedNodeStatusInfo
                    );

                    if (nodeStatusSelectionView) {
                        const item = nodeStatusView.getItem(index);
                        this._updateNodeStatusSelection(nodeStatusSelectionView, item);
                    }
                }

                return cb(null);
            },
            kickSelectedNode: (formData, extraArgs, cb) => {
                return this._confirmKickSelectedNode(cb);
            },
            kickNodeYes: (formData, extraArgs, cb) => {
                return this._kickSelectedNode(cb);
            },
            kickNodeNo: (formData, extraArgs, cb) => {
                //this._startRefreshing();
                return cb(null);
            },
            chatWithSelectedNode: (formData, extraArgs, cb) => {
                return this._chatWithSelectedNode(cb);
            },
            displayFullLog: (formData, extraArgs, cb) => {
                return this._displayFullLogPage(cb);
            },
            scrollFullLogDetailPageUp: (formData, extraArgs, cb) => {
                const detailView = this.getView(
                    'fullLog',
                    MciViewIds.fullLog.entryDetail
                );
                if (detailView) {
                    detailView.topVisibleIndex = Math.max(
                        0,
                        detailView.topVisibleIndex - detailView.dimens.height
                    );
                    detailView.redraw();
                }
                return cb(null);
            },
            scrollFullLogDetailPageDown: (formData, extraArgs, cb) => {
                const detailView = this.getView(
                    'fullLog',
                    MciViewIds.fullLog.entryDetail
                );
                if (detailView) {
                    const maxTop = Math.max(
                        0,
                        detailView.buffer.lines.length - detailView.dimens.height
                    );
                    detailView.topVisibleIndex = Math.min(
                        maxTop,
                        detailView.topVisibleIndex + detailView.dimens.height
                    );
                    detailView.redraw();
                }
                return cb(null);
            },
            exitFullLog: (formData, extraArgs, cb) => {
                this.removeViewController('fullLog');
                return this._displayMainPage(true, cb);
            },
            displayMessages: (formData, extraArgs, cb) => {
                return this._displayMessagesPage(cb);
            },
            sendNodeMessage: (formData, extraArgs, cb) => {
                return this._sendMessageToSelectedNode(cb);
            },
            dismissSelectedMessage: (formData, extraArgs, cb) => {
                const item = this._selectedMessage();
                if (item) {
                    this._inbox().remove(item.id);
                }
                return this._refreshMessageList(cb);
            },
            replySelectedMessage: (formData, extraArgs, cb) => {
                return this._replyToSelectedMessage(cb);
            },
            exitMessages: (formData, extraArgs, cb) => {
                this.removeViewController('messages');
                return this._displayMainPage(true, cb);
            },
        };
    }

    //
    //  The base implementation paints every queued item full-screen with a
    //  pause prompt. At the WFC that is an ambush on the way in -- anything
    //  that piled up while the op was elsewhere lands before the dashboard is
    //  even drawn. Route them instead; only what the config actually sends to
    //  Interrupt is displayed.
    //
    displayQueuedInterruptions(cb) {
        const queue = this.client.interruptQueue;
        if (!queue || !queue.hasItems()) {
            return cb(null);
        }

        const passthrough = [];
        queue.queue.forEach(item => {
            if (!this._routeInterruptItem(item)) {
                passthrough.push(item);
            }
        });
        queue.queue = passthrough;

        return super.displayQueuedInterruptions(cb);
    }

    //
    //  Nothing paints over the dashboard. Items are routed by type and eaten;
    //  only a type routed to Interrupt is handed back to the queue.
    //
    attemptInterruptNow(interruptItem, cb) {
        if (this._routeInterruptItem(interruptItem)) {
            //  Reflect new counts without waiting for the next refresh tick.
            this._refreshAll();
            return cb(null, true); //  handled; do not queue
        }
        return cb(null, false); //  queue it for the next menu, as before
    }

    //  Returns true when the item was consumed here.
    _sinksFor(type) {
        const configured = _.get(this.config, ['notifications', type, 'sinks']);
        if (Array.isArray(configured)) {
            return configured;
        }
        const fallback = DefaultNotificationSinks[type];
        return Array.isArray(fallback)
            ? fallback
            : DefaultNotificationSinks[InterruptType.System];
    }

    _routeInterruptItem(interruptItem) {
        const type = interruptItem.type || InterruptType.System;
        const sinks = this._sinksFor(type);

        //  Interrupt means "behave as though we had never looked at it".
        if (sinks.includes(Sinks.Interrupt)) {
            return false;
        }

        if (sinks.includes(Sinks.Inbox)) {
            WfcInbox.forClient(this.client, this.config.inboxMaxItems).add(interruptItem);
            if (false !== this.config.messageAlert) {
                this.client.term.rawWrite('\x07'); //  BEL
            }
        }

        if (sinks.includes(Sinks.Ticker)) {
            this._pushTicker((interruptItem.text || '').replace(/\r?\n/g, ' ').trim());
        }

        //  StatusBar needs no work of its own -- _refreshStats() reads the
        //  inbox straight through on the next tick. Log is handled at the
        //  source (achievements log themselves for every op), so naming it
        //  here means "already in the log; surface nothing further".

        return true; //  eaten: sinks: [] means "drop it", which is still eaten
    }

    initSequence() {
        async.series(
            [
                callback => {
                    return this.displayQueuedInterruptions(callback);
                },
                callback => {
                    return this.beforeArt(callback);
                },
                callback => {
                    return this._displayMainPage(false, callback);
                },
            ],
            () => {
                this.finishedLoading();
            }
        );
    }

    _displayMainPage(clearScreen, cb) {
        async.series(
            [
                callback => {
                    return this.displayArtAndPrepViewController(
                        'main',
                        FormIds.main,
                        { clearScreen },
                        callback
                    );
                },
                callback => {
                    const quickLogView = this.getView(
                        'main',
                        MciViewIds.main.quickLogView
                    );
                    if (!quickLogView) {
                        return callback(null);
                    }

                    if (!this.logRingBuffer) {
                        const logLevel =
                            this.config.quickLogLevel || //  WFC specific
                            _.get(Config(), 'logging.rotatingFile.level') || //  ...or system setting
                            'info'; //  ...or default to info

                        this.logRingBuffer = new bunyan.RingBuffer({
                            limit: quickLogView.dimens.height || 24,
                        });
                        Log.log.addStream({
                            name: 'wfc-ringbuffer',
                            type: 'raw',
                            level: logLevel,
                            stream: this.logRingBuffer,
                        });
                    }

                    const nodeStatusView = this.getView(
                        'main',
                        MciViewIds.main.nodeStatus
                    );
                    const nodeStatusSelectionView = this.getView(
                        'main',
                        MciViewIds.main.selectedNodeStatusInfo
                    );

                    if (nodeStatusView && nodeStatusSelectionView) {
                        nodeStatusView.on('index update', index => {
                            const item = nodeStatusView.getItem(index);
                            this._updateNodeStatusSelection(
                                nodeStatusSelectionView,
                                item
                            );
                        });
                    }

                    return callback(null);
                },
                callback => {
                    return this._refreshAll(callback);
                },
                callback => {
                    this._bindTicker();
                    return callback(null);
                },
            ],
            err => {
                if (!err) {
                    this._startRefreshing();
                }
                return cb(err);
            }
        );
    }

    enter() {
        this.client.stopIdleMonitor();
        this._applyOpVisibility();

        //  Form 0 takes no typed input, and every refresh leaves the cursor
        //  wherever the last view finished. Park it out of sight; a ticker
        //  (phase 5) would otherwise drag it around ten times a second.
        if (false !== this.config.hideCursor) {
            this.client.term.rawWrite(ansi.hideCursor());
        }

        Events.on(
            Events.getSystemEvents().ClientDisconnected,
            this._onClientDisconnectedBound
        );
        Events.on(Events.getSystemEvents().UserPagedSysop, this._onUserPagedSysopBound);

        this._startActivityFeed();

        super.enter();
    }

    //
    //  MenuModule.prevMenu() flushes the interrupt queue *before* menuStack.prev()
    //  gets as far as leave(), so without this the refresh timer is still painting
    //  the dashboard over the interrupt art, and our form is still attached to
    //  'key press' -- pausePrompt() waits on a non-exclusive once('key press'), so
    //  the key that dismisses an interrupt also reaches our action keys, where 'k'
    //  opens the kick-node confirm. Shut both down before handing off.
    //
    prevMenu(cb) {
        this._stopRefreshing();
        this.detachViewControllers();
        return super.prevMenu(cb);
    }

    leave() {
        //  Remove by stream identity, not by name: every WFC instance adds a
        //  stream under the same 'wfc-ringbuffer' name, so a name match removed
        //  *every* op's stream and silently froze the quick log of anyone else
        //  still at the dashboard. bunyan shallow-copies the descriptor, so the
        //  RingBuffer we passed is still the identity to match on.
        if (this.logRingBuffer) {
            _.remove(Log.log.streams, stream => stream.stream === this.logRingBuffer);
        }

        Events.removeListener(
            Events.getSystemEvents().ClientDisconnected,
            this._onClientDisconnectedBound
        );
        Events.removeListener(
            Events.getSystemEvents().UserPagedSysop,
            this._onUserPagedSysopBound
        );

        this._stopActivityFeed();

        this._restoreOpVisibility();

        if (false !== this.config.hideCursor) {
            this.client.term.rawWrite(ansi.showCursor());
        }

        this._stopRefreshing();
        this.client.startIdleMonitor();

        super.leave();
    }

    _updateNodeStatusSelection(nodeStatusSelectionView, item) {
        if (item) {
            const nodeStatusSelectionFormat =
                this.config.nodeStatusSelectionFormat || '{text}';

            const s = stringFormat(nodeStatusSelectionFormat, item);

            if (nodeStatusSelectionView instanceof MultiLineEditTextView) {
                nodeStatusSelectionView.setAnsi(pipeToAnsi(s, this.client));
            } else {
                nodeStatusSelectionView.setText(s);
            }
        }
    }

    _displayHelpPage(cb) {
        this._stopRefreshing();

        this.displayAsset(this.menuConfig.config.art.help, { clearScreen: true }, () => {
            this.client.waitForKeyPress(() => {
                return this._displayMainPage(true, cb);
            });
        });
    }

    _getSelectedNodeItem() {
        const nodeStatusView = this.getView('main', MciViewIds.main.nodeStatus);
        if (!nodeStatusView) {
            return null;
        }

        return nodeStatusView.getItem(nodeStatusView.getFocusItemIndex());
    }

    _confirmKickSelectedNode(cb) {
        const nodeItem = this._getSelectedNodeItem();
        if (!nodeItem) {
            return cb(null);
        }

        const confirmView = this.getView('main', MciViewIds.main.confirmXy);
        if (!confirmView) {
            return cb(
                Errors.MissingMci(`Missing prompt XY${MciViewIds.main.confirmXy} MCI`)
            );
        }

        //  disallow kicking self
        if (this.client.node === parseInt(nodeItem.node)) {
            return cb(null);
        }

        const promptOptions = {
            clearAtSubmit: true,
            submitNotify: () => {
                if (false !== this.config.hideCursor) {
                    this.client.term.rawWrite(ansi.hideCursor());
                }
                this._startRefreshing();
            },
        };

        if (confirmView.dimens.width) {
            promptOptions.clearWidth = confirmView.dimens.width;
        }

        this._stopRefreshing();
        if (false !== this.config.hideCursor) {
            this.client.term.rawWrite(ansi.showCursor());
        }
        return this.promptForInput(
            {
                formName: 'confirmKickPrompt',
                formId: FormIds.confirmKickPrompt,
                promptName: this.config.confirmKickNodePrompt || 'confirmKickNodePrompt',
                prevFormName: 'main',
                position: confirmView.position,
            },
            promptOptions,
            err => {
                return cb(err);
            }
        );
    }

    _onUserPagedSysop({ user, nodeId, sessionId, message }) {
        this.pendingPages.unshift({
            sessionId,
            userName: user.username,
            nodeId,
            message,
            timestamp: Date.now(),
        });

        //  BEL to grab the sysop's attention
        this.client.term.rawWrite('\x07');

        //  Refresh so pending page info appears in any custom MCI tokens
        this._refreshAll();
    }

    _chatWithSelectedNode(cb) {
        const nodeItem = this._getSelectedNodeItem();
        if (!nodeItem) {
            return cb(null);
        }

        const nodeId = parseInt(nodeItem.node);

        //  Disallow chatting with self
        if (this.client.node === nodeId) {
            return cb(null);
        }

        const targetClient = getConnectionByNodeId(nodeId);
        if (!targetClient) {
            return cb(null);
        }

        //  Find a pending session for this node, or create a sysop-initiated one
        let sessionId = SysopChat.getPendingSessionForNode(nodeId);
        if (!sessionId) {
            sessionId = SysopChat.createSession(targetClient, '');
        }

        SysopChat.activateSession(sessionId, this.client);

        //  Remove from pending pages list if present
        this.pendingPages = this.pendingPages.filter(p => p.sessionId !== sessionId);

        const chatMenuName = this.config.chatMenuName || 'sysopChat';

        //  Sysop transitions from WFC into the chat mod.
        //  User navigation happens from sysop_chat._initChat once sysop is set up,
        //  avoiding a race between the two concurrent menu transitions.
        this._stopRefreshing();
        return this.gotoMenu(
            chatMenuName,
            { extraArgs: { sessionId, role: 'sysop' } },
            cb
        );
    }

    _kickSelectedNode(cb) {
        const nodeItem = this._getSelectedNodeItem();
        if (!nodeItem) {
            return cb(Errors.UnexpectedState('Expecting a selected node'));
        }

        const client = getConnectionByNodeId(parseInt(nodeItem.node));
        if (!client) {
            return cb(
                Errors.UnexpectedState(`Expecting a client for node ID ${nodeItem.node}`)
            );
        }

        //  :TODO: optional kick art

        removeClient(client);
        return cb(null);
    }

    _applyOpVisibility() {
        this.restoreUserIsVisible = this.client.user.isVisible();

        const vis = this.config.opVisibility || 'current';
        switch (vis) {
            case 'hidden':
                this.client.user.setVisibility(false);
                break;
            case 'visible':
                this.client.user.setVisibility(true);
                break;
            default:
                break;
        }
    }

    _restoreOpVisibility() {
        if (!this.visibilityToggled) {
            this.client.user.setVisibility(this.restoreUserIsVisible);
        }
    }

    //
    //  Activity ticker. Subscribes through addMultipleEventListener(), which
    //  hands back removable handles -- the .bind() shape that leaked a
    //  ClientDisconnected listener per visit is exactly what this avoids.
    //
    _startActivityFeed() {
        if (this._activityListeners) {
            return;
        }

        this.tickerFeed = this.tickerFeed || [];

        const formats = Object.assign(
            {},
            DefaultTickerEventFormats,
            _.get(this.config, 'ticker.events', {})
        );

        this._activityListeners = Events.addMultipleEventListener(
            Object.keys(TickerEventKeys),
            (event, eventName) => {
                const key = TickerEventKeys[eventName];
                const format = key && formats[key];
                if (!format) {
                    return; //  not configured: not shown
                }
                this._pushTicker(stringFormat(format, this._tickerFormatObj(event)));
            }
        );
    }

    _stopActivityFeed() {
        if (this._activityListeners) {
            Events.removeMultipleEventListener(this._activityListeners);
            delete this._activityListeners;
        }
    }

    _tickerFormatObj(event) {
        const user = event.user || {};
        const files = Array.isArray(event.files) ? event.files : [];
        return {
            userName: user.username || '',
            realName: _.isFunction(user.realName) ? user.realName(false) || '' : '',
            nodeId: _.get(event, 'client.node', this.client.node),
            title: event.title || '',
            points: _.isUndefined(event.points) ? '' : event.points,
            achievementTag: event.achievementTag || '',
            areaTag: event.areaTag || '',
            doorTag: event.doorTag || '',
            fileCount: files.length,
            minutesOnline: event.minutesOnline || 0,
            boardName: _.get(Config(), 'general.boardName', ''),
        };
    }

    _pushTicker(text) {
        if (!text) {
            return;
        }
        const max = _.get(this.config, 'ticker.maxItems', DefaultTickerMaxItems);
        this.tickerFeed = this.tickerFeed || [];
        this.tickerFeed.push(text);
        while (this.tickerFeed.length > max) {
            this.tickerFeed.shift();
        }

        //  If the view is sitting on idle text, bring this up now rather than
        //  waiting for a cycle that may be a full scroll away.
        if (this._tickerIdle) {
            this._advanceTicker();
        }
    }

    //  Called once per _displayMainPage() so the handler follows the new view.
    _bindTicker() {
        const view = this.getView('main', MciViewIds.main.ticker);
        if (!view || !_.isFunction(view.setText)) {
            return;
        }

        const rotateOn = _.get(this.config, 'ticker.rotateOn', 'cycle');
        if (_.isNumber(rotateOn) && rotateOn > 0) {
            //  bounce over short text never reaches a boundary; a timer is the
            //  documented escape hatch.
            clearInterval(this._tickerTimer);
            this._tickerTimer = setInterval(() => this._advanceTicker(), rotateOn);
        } else if (_.isFunction(view.on)) {
            view.removeAllListeners('cycle complete');
            view.on('cycle complete', () => this._advanceTicker());
        }

        this._advanceTicker();
    }

    _advanceTicker() {
        const view = this.getView('main', MciViewIds.main.ticker);
        if (!view || !_.isFunction(view.setText)) {
            return;
        }

        const next = (this.tickerFeed || []).shift();
        if (next) {
            this._tickerIdle = false;
            return view.setText(next);
        }

        const idle = _.get(this.config, 'ticker.idleText');
        this._tickerIdle = true;
        if (idle) {
            view.setText(stringFormat(idle, this.stats || {}));
        }
    }

    _startRefreshing() {
        if (this.mainRefreshTimer) {
            this._stopRefreshing();
        }

        this.mainRefreshTimer = setInterval(() => {
            this._refreshAll();
        }, MainStatRefreshTimeMs);
    }

    _stopRefreshing() {
        if (this.mainRefreshTimer) {
            clearInterval(this.mainRefreshTimer);
            delete this.mainRefreshTimer;
        }
        if (this._tickerTimer) {
            clearInterval(this._tickerTimer);
            delete this._tickerTimer;
        }
    }

    _clientDisconnected({ client } = {}) {
        //  Prune pending pages for the disconnected client
        if (client) {
            this.pendingPages = this.pendingPages.filter(p => p.nodeId !== client.node);
            SysopChat.clearSessionsForClient(client);
        }

        const nodeStatusSelectionView = this.getView(
            'main',
            MciViewIds.main.selectedNodeStatusInfo
        );
        if (nodeStatusSelectionView) {
            nodeStatusSelectionView.setText('');
        }

        this.selectedNodeStatusIndex = 0; // will select during refresh
        this._refreshAll();

        // have to update the selection view here
        if (nodeStatusSelectionView) {
            const nodeStatusView = this.getView('main', MciViewIds.main.nodeStatus);
            if (nodeStatusView) {
                const item = nodeStatusView.getItem(this.selectedNodeStatusIndex);
                this._updateNodeStatusSelection(nodeStatusSelectionView, item);
            }
        }
    }

    _refreshAll(cb) {
        //  Don't touch form 0 views while a sub-viewer owns the screen
        if (this.viewControllers.fullLog || this.viewControllers.messages) {
            if (cb) {
                return cb(null);
            }
            return;
        }

        if (this.refreshing) {
            if (cb) {
                return cb(null);
            }
            return;
        }

        this.refreshing = true;

        async.series(
            [
                callback => {
                    return this._refreshStats(callback);
                },
                callback => {
                    return this._refreshNodeStatus(callback);
                },
                callback => {
                    return this._refreshQuickLog(callback);
                },
                callback => {
                    this.updateCustomViewTextsWithFilter(
                        'main',
                        MciViewIds.main.customRangeStart,
                        this.stats
                    );
                    return callback(null);
                },
            ],
            err => {
                this.refreshing = false;
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    _getStatusStrings(isAvailable, isVisible) {
        const availIndicators = Array.isArray(this.config.statusAvailableIndicators)
            ? this.config.statusAvailableIndicators
            : this.client.currentTheme.helpers.getStatusAvailIndicators();
        const visIndicators = Array.isArray(this.config.statusVisibleIndicators)
            ? this.config.statusVisibleIndicators
            : this.client.currentTheme.helpers.getStatusVisibleIndicators();

        return [
            isAvailable ? availIndicators[1] || 'Y' : availIndicators[0] || 'N',
            isVisible ? visIndicators[1] || 'Y' : visIndicators[0] || 'N',
        ];
    }

    _refreshStats(cb) {
        const fileAreaStats = StatLog.getSystemStat(SysProps.FileBaseAreaStats) || {};
        const sysMemStats = StatLog.getSystemStat(SysProps.SystemMemoryStats) || {};
        const sysLoadStats = StatLog.getSystemStat(SysProps.SystemLoadStats) || {};
        const lastLoginStats = StatLog.getSystemStat(SysProps.LastLogin);
        const processTrafficStats =
            StatLog.getSystemStat(SysProps.ProcessTrafficStats) || {};

        const now = moment();

        const [availIndicator, visIndicator] = this._getStatusStrings(
            this.client.user.isAvailable(),
            this.client.user.isVisible()
        );

        this.stats = {
            //  Date/Time
            nowDate: now.format(this.getDateFormat()),
            nowTime: now.format(this.getTimeFormat()),
            now: now.format(this._dateTimeFormat('now')),

            //  Current process (our Node.js service)
            processUptimeSeconds: process.uptime(),

            //  Totals
            totalCalls: StatLog.getSystemStatNum(SysProps.LoginCount),
            totalPosts: StatLog.getSystemStatNum(SysProps.MessageTotalCount),
            totalUsers: StatLog.getSystemStatNum(SysProps.TotalUserCount),
            totalFiles: fileAreaStats.totalFiles || 0,
            totalFileBytes: fileAreaStats.totalBytes || 0,

            //  Today's Stats
            callsToday: StatLog.getSystemStatNum(SysProps.LoginsToday),
            postsToday: StatLog.getSystemStatNum(SysProps.MessagesToday),
            uploadsToday: StatLog.getSystemStatNum(SysProps.FileUlTodayCount),
            uploadBytesToday: StatLog.getSystemStatNum(SysProps.FileUlTodayBytes),
            downloadsToday: StatLog.getSystemStatNum(SysProps.FileDlTodayCount),
            downloadBytesToday: StatLog.getSystemStatNum(SysProps.FileDlTodayBytes),
            newUsersToday: StatLog.getSystemStatNum(SysProps.NewUsersTodayCount),

            //  Current
            currentUserName: this.client.user.username,
            currentUserRealName: this.client.user.realName(false) || 'N/A',
            availIndicator: availIndicator,
            visIndicator: visIndicator,
            lastLoginUserName: lastLoginStats.userName,
            lastLoginRealName: lastLoginStats.realName,
            lastLoginDate: moment(lastLoginStats.timestamp).format(this.getDateFormat()),
            lastLoginTime: moment(lastLoginStats.timestamp).format(this.getTimeFormat()),
            lastLogin: moment(lastLoginStats.timestamp).format(
                this._dateTimeFormat('lastLogin')
            ),
            totalMemoryBytes: sysMemStats.totalBytes || 0,
            freeMemoryBytes: sysMemStats.freeBytes || 0,
            systemAvgLoad: sysLoadStats.average || 0,
            systemCurrentLoad: sysLoadStats.current || 0,
            newPrivateMail: StatLog.getUserStatNumByClient(
                this.client,
                UserProps.NewPrivateMailCount,
                MailCountTTLSeconds
            ),
            newMessagesAddrTo: StatLog.getUserStatNumByClient(
                this.client,
                UserProps.NewAddressedToMessageCount,
                MailCountTTLSeconds
            ),
            processBytesIngress: processTrafficStats.ingress || 0,
            processBytesEgress: processTrafficStats.egress || 0,

            //  Sysop page / break-into-chat
            pendingPageCount: this.pendingPages.length,
            pendingPageUser:
                this.pendingPages.length > 0 ? this.pendingPages[0].userName : '',
            pendingPageNode:
                this.pendingPages.length > 0 ? this.pendingPages[0].nodeId : '',
            pendingPageMessage:
                this.pendingPages.length > 0 ? this.pendingPages[0].message : '',

            //  Inbox -- same shape as the pendingPage* set above.
            ...this._inboxStats(),
        };

        this._updateStatusBarPanels();

        return cb(null);
    }

    _inbox() {
        return WfcInbox.forClient(this.client, this.config.inboxMaxItems);
    }

    //  Note: every default format string here stays plain ASCII. These go
    //  straight to a CP437 terminal, where a UTF-8 middle dot or ellipsis
    //  renders as mojibake -- 'Â·' in testing.
    _inboxStats() {
        const inbox = this._inbox();
        const latest = inbox.latestUnread();
        const preview = latest ? latest.text.replace(/\r?\n/g, ' ').trim() : '';
        const maxPreview = this.config.messagePreviewLength || 40;

        return {
            pendingNodeMessageCount: inbox.unreadCount(),
            pendingNodeMessageTotal: inbox.count(),
            pendingNodeMessageUser: latest ? latest.from.userName || '' : '',
            pendingNodeMessageNode: latest ? latest.from.nodeId || '' : '',
            pendingNodeMessagePreview:
                preview.length > maxPreview
                    ? `${preview.slice(0, maxPreview - 3)}...`
                    : preview,
        };
    }

    //
    //  Status bar (%SB) panels are driven from code: a panel's own `text`
    //  template only resolves predefined MCI, so it cannot see these.
    //  Panels are addressed by name and are all optional.
    //
    _updateStatusBarPanels() {
        const view = this.getView('main', MciViewIds.main.statusBar);
        if (!view || !_.isFunction(view.setPanels)) {
            return;
        }

        const inbox = this._inbox();
        const fmt = name => this.config[`statusBar${_.upperFirst(name)}Format`];

        const msgFmt = fmt('messages') || 'MSG {count}';
        const pageFmt = fmt('pages') || 'PAGE {count}';

        view.setPanels({
            messages: stringFormat(msgFmt, { count: inbox.unreadCount() }),
            pages: stringFormat(pageFmt, { count: this.pendingPages.length }),
        });
    }

    _getNodeStatusIndexByNodeId(nodeStatusView, nodeId) {
        return nodeStatusView.getItems().findIndex(entry => entry.node == nodeId);
    }

    _selectNodeByIndex(nodeStatusView, index) {
        if (index >= 0 && nodeStatusView.getFocusItemIndex() !== index) {
            nodeStatusView.setFocusItemIndex(index);
        } else {
            nodeStatusView.redraw();
        }
    }

    _refreshNodeStatus(cb) {
        const nodeStatusView = this.getView('main', MciViewIds.main.nodeStatus);
        if (!nodeStatusView) {
            return cb(null);
        }

        const nodeStatusItems = getActiveConnectionList(AllConnections)
            .slice(0, nodeStatusView.dimens.height)
            .map(ac => {
                //  Handle pre-authenticated
                if (!ac.authenticated) {
                    ac.text = ac.userName = '*Pre Auth*';
                    ac.action = 'Logging In';
                }

                const [availIndicator, visIndicator] = this._getStatusStrings(
                    ac.isAvailable,
                    ac.isVisible
                );

                const timeOn = ac.timeOn || moment.duration(0);

                //  Page indicator — non-empty when this node has a pending chat page
                const hasPendingPage = this.pendingPages.some(p => p.nodeId === ac.node);
                const pageIndicator = hasPendingPage
                    ? this.config.pageIndicator || '!'
                    : '';

                return Object.assign(ac, {
                    availIndicator,
                    visIndicator,
                    timeOnMinutes: timeOn.asMinutes(),
                    timeOn: _.upperFirst(timeOn.humanize()), //  make friendly
                    affils: ac.affils || 'N/A',
                    realName: ac.realName || 'N/A',
                    pageIndicator,
                });
            });

        // If this is our first pass, we'll also update the selection
        const firstStatusRefresh = nodeStatusView.getCount() === 0;

        //  :TODO: Currently this always redraws due to setItems(). We really need painters alg.; The alternative now is to compare items... yuk.
        nodeStatusView.setItems(nodeStatusItems);
        this._selectNodeByIndex(nodeStatusView, this.selectedNodeStatusIndex); // redraws

        if (firstStatusRefresh) {
            const nodeStatusSelectionView = this.getView(
                'main',
                MciViewIds.main.selectedNodeStatusInfo
            );
            if (nodeStatusSelectionView) {
                const item = nodeStatusView.getItem(0);
                this._updateNodeStatusSelection(nodeStatusSelectionView, item);
            }
        }

        return cb(null);
    }

    _refreshQuickLog(cb) {
        const quickLogView = this.viewControllers.main.getView(
            MciViewIds.main.quickLogView
        );
        if (!quickLogView) {
            return cb(null);
        }

        const records = this.logRingBuffer.records;
        if (records.length === 0) {
            return cb(null);
        }

        const hasChanged = this.lastLogTime !== records[records.length - 1].time;
        this.lastLogTime = records[records.length - 1].time;

        if (!hasChanged) {
            return cb(null);
        }

        const quickLogTimestampFormat =
            this.config.quickLogTimestampFormat || this.getDateTimeFormat('short');

        const levelIndicators = this.config.quickLogLevelIndicators || {
            trace: 'T',
            debug: 'D',
            info: 'I',
            warn: 'W',
            error: 'E',
            fatal: 'F',
        };

        const makeLevelIndicator = level => {
            return levelIndicators[level] || '?';
        };

        const quickLogLevelMessagePrefixes =
            this.config.quickLogLevelMessagePrefixes || {};
        const prefixMssage = (message, level) => {
            const prefix = quickLogLevelMessagePrefixes[level] || '';
            return `${prefix}${message}`;
        };

        const logItems = records.map(rec => {
            const level = bunyan.nameFromLevel[rec.level];
            return {
                timestamp: moment(rec.time).format(quickLogTimestampFormat),
                level: rec.level,
                levelIndicator: makeLevelIndicator(level),
                nodeId: rec.nodeId || '*',
                sessionId: rec.sessionId || '',
                message: prefixMssage(rec.msg, level),
            };
        });

        quickLogView.setItems(logItems);
        quickLogView.redraw();

        return cb(null);
    }

    //
    //  Message viewer -- mirrors the full-log viewer: its own form, refresh
    //  stopped while it is up, and _displayMainPage(true) on the way out.
    //
    _displayMessagesPage(cb) {
        this._stopRefreshing();

        const artSpec = _.get(this.menuConfig, 'config.art.messages');
        if (!artSpec) {
            //  Usable before the theme has art for it: plain list + pause.
            return this._displayMessagesFallback(cb);
        }

        async.series(
            [
                callback =>
                    this.displayArtAndPrepViewController(
                        'messages',
                        FormIds.messages,
                        { clearScreen: true },
                        callback
                    ),
                callback => {
                    const listView = this.getView(
                        'messages',
                        MciViewIds.messages.messageList
                    );
                    const detailView = this.getView(
                        'messages',
                        MciViewIds.messages.messageDetail
                    );
                    if (listView && detailView) {
                        listView.on('index update', idx =>
                            this._updateMessageDetail(detailView, this._messageAt(idx))
                        );
                    }
                    return callback(null);
                },
                callback => this._refreshMessageList(callback),
            ],
            err => {
                if (err) {
                    //  Art named but not present, or missing its MCI: fall back
                    //  to the plain list rather than bouncing the op straight
                    //  back to the dashboard with nothing shown.
                    this.client.log.debug(
                        { error: err.message, art: artSpec },
                        'WFC message viewer art unavailable; using text fallback'
                    );
                    this.removeViewController('messages');
                    return this._displayMessagesFallback(cb);
                }
                return cb(null);
            }
        );
    }

    _displayMessagesFallback(cb) {
        const items = this._inbox().all();
        const fmt =
            this.config.messageListFormat ||
            '|08[|07{index}|08] |15{userName}|08/|07{nodeId} |08- |07{timestamp}\r\n    |07{text}';

        let out = '';
        if (!items.length) {
            out += pipeToAnsi(
                this.config.noMessagesText || '|08No messages.|07',
                this.client
            );
        } else {
            items.forEach((item, i) => {
                out += pipeToAnsi(
                    stringFormat(fmt, this._messageFormatObj(item, i)),
                    this.client
                );
                out += '\r\n';
            });
        }

        //  rawWrite() for the escape sequence, write() for the text: write()
        //  is what runs the string through iconv into the client's encoding.
        //  rawWrite()ing text emits UTF-8 at a CP437 terminal, which is how a
        //  middle dot arrived on screen as 'A-circumflex dot'.
        this.client.term.rawWrite(ansi.resetScreen());
        this.client.term.write(`${out}\r\n`, true, () => {
            this._inbox().markAllRead();
            return this.pausePrompt({ row: this.client.term.termHeight }, () =>
                this._displayMainPage(true, cb)
            );
        });
        return;
    }

    _messageFormatObj(item, index) {
        return {
            index: index + 1,
            id: item.id,
            userName: item.from.userName || 'System',
            realName: item.from.realName || '',
            nodeId: item.from.nodeId || '',
            type: item.type,
            read: item.read,
            timestamp: moment(item.timestamp).format(this.getDateTimeFormat('short')),
            text: (item.text || '').replace(/\r?\n/g, ' ').trim(),
        };
    }

    _messageAt(index) {
        return this._inbox().all()[index];
    }

    _selectedMessage() {
        const listView = this.getView('messages', MciViewIds.messages.messageList);
        if (!listView) {
            return null;
        }
        return this._messageAt(listView.getFocusItemIndex());
    }

    _updateMessageDetail(detailView, item) {
        if (!detailView || !item) {
            return;
        }
        this._inbox().markRead(item.id);

        const fmt = this.config.messageDetailFormat || '{text}';
        const text = stringFormat(fmt, this._messageFormatObj(item, 0));

        if (detailView instanceof MultiLineEditTextView) {
            detailView.setAnsi(pipeToAnsi(text, this.client));
        } else {
            detailView.setText(text);
        }
    }

    _refreshMessageList(cb) {
        const listView = this.getView('messages', MciViewIds.messages.messageList);
        if (!listView) {
            return cb ? cb(null) : undefined;
        }

        const fmt = this.config.messageListFormat || '{userName}: {text}';
        const items = this._inbox()
            .all()
            .map((item, i) =>
                Object.assign({}, this._messageFormatObj(item, i), {
                    text: stringFormat(fmt, this._messageFormatObj(item, i)),
                })
            );

        listView.setItems(items);
        listView.redraw();

        const detailView = this.getView('messages', MciViewIds.messages.messageDetail);
        if (detailView) {
            this._updateMessageDetail(detailView, this._messageAt(0));
        }

        return cb ? cb(null) : undefined;
    }

    //
    //  Send a node message to whichever node is selected in the node list,
    //  which is #438's "select a node and send a message".
    //
    _sendMessageToSelectedNode(cb) {
        const nodeItem = this._getSelectedNodeItem();
        let nodeId = nodeItem ? parseInt(nodeItem.node) : NaN;

        //  Selecting your own node and pressing send means "to everyone":
        //  node_msg filters our own node out of its list anyway, so passing it
        //  would silently land on -ALL-. Be explicit about that rather than
        //  relying on the fallback.
        if (this.client.node === nodeId) {
            nodeId = NaN;
        }

        this._stopRefreshing();
        return this.gotoMenu(
            this.config.nodeMessageMenuName || 'nodeMessage',
            { extraArgs: { toNodeId: isNaN(nodeId) ? undefined : nodeId } },
            cb
        );
    }

    _replyToSelectedMessage(cb) {
        const item = this._selectedMessage();
        const toNodeId = item && item.from ? item.from.nodeId : undefined;
        if (!toNodeId) {
            return cb(null); //  nothing to reply to (system notice, or sender gone)
        }

        this.removeViewController('messages');
        this._stopRefreshing();
        return this.gotoMenu(
            this.config.nodeMessageMenuName || 'nodeMessage',
            { extraArgs: { toNodeId } },
            cb
        );
    }

    _dateTimeFormat(element) {
        const format = this.config[`${element}DateTimeFormat`];
        return format || this.getDateFormat();
    }

    _readLogSnapshot(cb) {
        //  Note: Log.getRotatingFilePath() rather than reading
        //  logging.rotatingFile.path off the config -- that key is injected into
        //  the live config object by Log.init() at startup and is lost the first
        //  time config.hjson is hot-reloaded, which left this viewer empty.
        const logFilePath = Log.getRotatingFilePath();
        if (!logFilePath) {
            return cb(null, []);
        }

        const limit = this.config.fullLogLimit || 500;

        fs.readFile(logFilePath, 'utf8', (err, data) => {
            if (err) {
                return cb(null, []); //  graceful fallback — show empty viewer
            }

            const records = data
                .split('\n')
                .filter(line => line.trim().length > 0)
                .slice(-limit)
                .reduce((acc, line) => {
                    try {
                        acc.push(JSON.parse(line));
                    } catch (_) {
                        //  skip malformed lines
                    }
                    return acc;
                }, []);

            return cb(null, records);
        });
    }

    _formatLogListItem(rec) {
        const levelName = bunyan.nameFromLevel[rec.level] || 'unknown';
        const ts = moment(rec.time).format(
            this.config.quickLogTimestampFormat || this.getDateTimeFormat('short')
        );
        const levelIndicators = this.config.quickLogLevelIndicators || {
            trace: 'T',
            debug: 'D',
            info: 'I',
            warn: 'W',
            error: 'E',
            fatal: 'F',
        };
        const prefixes = this.config.quickLogLevelMessagePrefixes || {};
        return {
            timestamp: ts,
            level: rec.level,
            levelIndicator: levelIndicators[levelName] || '?',
            nodeId: rec.nodeId || '*',
            sessionId: rec.sessionId || '',
            message: `${prefixes[levelName] || ''}${rec.msg || ''}`,
        };
    }

    _formatLogDetailText(rec) {
        const levelName = bunyan.nameFromLevel[rec.level] || 'unknown';
        const ts = moment(rec.time).format(
            this.config.quickLogTimestampFormat || this.getDateTimeFormat('short')
        );
        const levelIndicators = this.config.quickLogLevelIndicators || {
            trace: 'T',
            debug: 'D',
            info: 'I',
            warn: 'W',
            error: 'E',
            fatal: 'F',
        };
        const levelPrefixes = this.config.quickLogLevelMessagePrefixes || {};
        const levelPrefix = levelPrefixes[levelName] || '|07';
        const levelIndicator = levelIndicators[levelName] || '?';

        //  Header: [timestamp] INDICATOR LEVEL  node:N  session:S
        let header = `|08[|07${ts}|08] ${levelIndicator} ${levelName.toUpperCase()}|08`;
        if (rec.nodeId) {
            header += `  node:|07${rec.nodeId}|08`;
        }
        if (rec.sessionId) {
            header += `  session:|07${rec.sessionId}|08`;
        }

        //  Message line in level color
        const msgLine = `${levelPrefix}${rec.msg || '(no message)'}|00`;

        //  Per-field format — tokens: {name}, {sep}, {value}
        const fieldFmt =
            this.config.logDetailFieldFormat || '|08{name}|07{sep}|07{value}';
        const fmtField = (name, value) =>
            stringFormat(fieldFmt, { name, sep: ': ', value: String(value) });

        const parts = [header, msgLine];

        if (rec.err) {
            if (rec.err.message) {
                parts.push(fmtField('Error', rec.err.message));
            }
            if (rec.err.stack) {
                parts.push(`|08${rec.err.stack}|00`);
            }
        }

        const STANDARD_FIELDS = new Set([
            'v',
            'name',
            'hostname',
            'pid',
            'level',
            'time',
            'msg',
            'nodeId',
            'sessionId',
            'err',
        ]);
        const extra = Object.entries(rec).filter(([k]) => !STANDARD_FIELDS.has(k));
        if (extra.length > 0) {
            parts.push('');
            for (const [k, v] of extra) {
                const val =
                    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
                parts.push(fmtField(k, val));
            }
        }

        return parts.join('\n');
    }

    _updateFullLogDetail(detailView, rec) {
        detailView.setAnsi(pipeToAnsi(this._formatLogDetailText(rec), this.client));
    }

    _displayFullLogPage(cb) {
        this._stopRefreshing();

        //  Detach the main VC so its key handler doesn't compete with fullLog's
        if (this.viewControllers.main) {
            this.viewControllers.main.detachClientEvents();
        }

        //  Remove any stale fullLog VC from a previous visit
        this.removeViewController('fullLog');

        let records = [];

        async.series(
            [
                callback => {
                    this._readLogSnapshot((err, recs) => {
                        if (!err) {
                            records = recs;
                        }
                        return callback(null); //  non-fatal: empty viewer on error
                    });
                },
                callback => {
                    return this.displayArtAndPrepViewController(
                        'fullLog',
                        FormIds.fullLog,
                        { clearScreen: true },
                        callback
                    );
                },
                callback => {
                    const logListView = this.getView(
                        'fullLog',
                        MciViewIds.fullLog.logList
                    );
                    if (!logListView) {
                        return callback(null);
                    }

                    this._fullLogRecords = records;

                    logListView.setItems(
                        records.map(rec => this._formatLogListItem(rec))
                    );

                    const detailView = this.getView(
                        'fullLog',
                        MciViewIds.fullLog.entryDetail
                    );
                    if (detailView) {
                        detailView.acceptsFocus = false;
                        detailView.acceptsInput = false;

                        logListView.on('index update', index => {
                            const rec =
                                this._fullLogRecords && this._fullLogRecords[index];
                            if (rec) {
                                this._updateFullLogDetail(detailView, rec);
                            }
                        });
                    }

                    if (records.length > 0) {
                        //  Start at newest (last) entry
                        logListView.setFocusItemIndex(records.length - 1);
                        if (detailView) {
                            this._updateFullLogDetail(
                                detailView,
                                records[records.length - 1]
                            );
                        }
                    } else {
                        //  Nothing to navigate or submit: keep the empty list out
                        //  of the form data path and tell the op why it's blank.
                        logListView.acceptsInput = false;

                        if (detailView) {
                            detailView.setAnsi(
                                pipeToAnsi(
                                    this.config.fullLogEmptyMessage ||
                                        '|08No log entries available|00',
                                    this.client
                                )
                            );
                        }
                    }

                    logListView.redraw();
                    return callback(null);
                },
            ],
            err => cb(err)
        );
    }
};
