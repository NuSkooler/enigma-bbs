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
const { wordWrapText } = require('./word_wrap');

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
    tasks: 5,
    confirmTaskPrompt: 6,
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
    tasks: {
        taskList: 1,
        taskDetail: 2,
        promptXy: 3,

        customRangeStart: 10,
    },
    taskPrompt: {
        yesNo: 1,
        question: 2,
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
    //  scheduler tasks; a failed TaskFinished is shown as 'taskFailed'
    [SysEvents.TaskStarted]: 'taskStarted',
    [SysEvents.TaskFinished]: 'taskFinished',
    [SysEvents.TaskOverdue]: 'taskOverdue',
};

const TaskSystemEvents = [
    SysEvents.TaskStarted,
    SysEvents.TaskFinished,
    SysEvents.TaskOverdue,
];

//  Shown unless the op configures otherwise. Anything without a format string
//  is simply not shown, so ops opt in to the noisier ones.
const DefaultTickerEventFormats = {
    userLogin: '|15{userName}|07 logged in on node |15{nodeId}|07',
    userAchievementEarned: '|15{userName}|07 earned |14{title}|07 (+{points})',
    userUpload: '|15{userName}|07 uploaded |15{fileCount}|07 file(s)',
    //  Only the task events that need the op. An hourly task starting and
    //  finishing fine would be noise; taskStarted / taskFinished are opt-in.
    taskFailed: '|12Task |15{taskDesc}|12 failed|07: {error}',
    taskOverdue: '|14Task |15{taskDesc}|14 is overdue|07',
};

const DefaultTickerMaxItems = 10;

//  Status bar panels that have a {count} and so work without any config.
const DefaultStatusBarPanelFormats = {
    messages: 'MSG {count}',
    pages: 'PAGE {count}',
    tasks: 'TASK {count}', //  running scheduler tasks
};

//  An unconfigured (single mode) %SB5: the old header line, plus the counts.
const DefaultStatusBarFormat =
    '{now}  {currentUserName}  Prv:{newPrivateMail} Addr:{newMessagesAddrTo}  ' +
    'Avl:{availIndicator} Vis:{visIndicator}  Msg:{pendingNodeMessageCount} ' +
    'Page:{pendingPageCount}';

//  Secure + 2FA + root user + 'wfc' group.
const DefaultACS = 'SCAF2ID1GM[wfc]';
const MainStatRefreshTimeMs = 5000; // 5s

//
//  Task screen (form 5). Formats stay plain ASCII, like the inbox ones: they
//  reach a CP437 terminal as-is.
//
const TaskRefreshRunningMs = 1000; //  while any task is running
const TaskRefreshIdleMs = 5000;

const DefaultTaskListFormat =
    '|07  {statusIndicator}|07 {desc:<26.26} |08{schedule:<16.16} |07{nextRun:<14.14} {lastResult}';
const DefaultTaskListFocusFormat =
    '|15> {statusIndicator}|15 {desc:<26.26} |07{schedule:<16.16} |15{nextRun:<14.14} {lastResult}';

const DefaultTaskStatusIndicators = {
    running: '*',
    overdue: '!',
    failed: 'X',
    ok: '+',
    never: '-',
};

const DefaultTaskActionResultFormats = {
    started: '|10Started |15{desc}|07',
    alreadyRunning: '|14{desc} is already running|07',
    disabled: '|12{desc} cannot be run by hand|07',
    unknown: '|12No such task: {name}|07',
    killed: '|14Stopping |15{desc}|14: its process was told to quit|07',
    abandoned: '|14Abandoned |15{desc}|14; it may still be running|07',
    notRunning: '|07{desc} is not running',
    unavailable: '|12The event scheduler is not running|07',
};

const DefaultTaskStopVerbs = {
    kill: 'Kill',
    abandon: 'Abandon',
};
const MailCountTTLSeconds = 10;

//  850ms, 12.3s, 4m 05s, 1h 02m
function formatTaskDuration(ms) {
    if (!_.isFinite(ms) || ms < 0) {
        return '';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    const seconds = Math.floor(totalSeconds) % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const pad2 = n => String(n).padStart(2, '0');
    if (hours > 0) {
        return `${hours}h ${pad2(minutes)}m`;
    }
    return `${minutes}m ${pad2(seconds)}s`;
}

//  '||' is a literal '|' to pipeToAnsi(), so text from outside (an error,
//  a script's output) cannot turn into colour codes
function escapePipes(value) {
    return String(null === value || undefined === value ? '' : value).replace(
        /\|/g,
        '||'
    );
}

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
                this._scrollDetailPage('fullLog', MciViewIds.fullLog.entryDetail, -1);
                return cb(null);
            },
            scrollFullLogDetailPageDown: (formData, extraArgs, cb) => {
                this._scrollDetailPage('fullLog', MciViewIds.fullLog.entryDetail, 1);
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
            displayTasks: (formData, extraArgs, cb) => {
                return this._displayTasksPage(cb);
            },
            runSelectedTask: (formData, extraArgs, cb) => {
                return this._requestTaskAction('run', cb);
            },
            stopSelectedTask: (formData, extraArgs, cb) => {
                return this._requestTaskAction('stop', cb);
            },
            refreshTasks: (formData, extraArgs, cb) => {
                return this._refreshTasks(cb);
            },
            scrollTaskDetailPageUp: (formData, extraArgs, cb) => {
                this._scrollDetailPage('tasks', MciViewIds.tasks.taskDetail, -1);
                return cb(null);
            },
            scrollTaskDetailPageDown: (formData, extraArgs, cb) => {
                this._scrollDetailPage('tasks', MciViewIds.tasks.taskDetail, 1);
                return cb(null);
            },
            exitTasks: (formData, extraArgs, cb) => {
                this._teardownTasks();
                return this._displayMainPage(true, cb);
            },
            taskPromptYes: (formData, extraArgs, cb) => {
                this._closeTaskPrompt(true);
                return cb(null);
            },
            taskPromptNo: (formData, extraArgs, cb) => {
                this._closeTaskPrompt(false);
                return cb(null);
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

            //  The BEL is instant; the count should be too, rather than
            //  waiting up to a full refresh tick to catch up with it.
            if (this._mainFormOwnsScreen()) {
                this._updateStatusBarPanels();
            }
        }

        if (sinks.includes(Sinks.Ticker)) {
            this._pushTicker((interruptItem.text || '').replace(/\r?\n/g, ' ').trim());
        }

        //  StatusBar needs no work of its own -- the inbox branch above and
        //  _refreshStats() both read the inbox straight through. Log is handled at the
        //  source (achievements log themselves for every op), so naming it
        //  here means "already in the log; surface nothing further".

        return true; //  eaten: sinks: [] means "drop it", which is still eaten
    }

    initSequence() {
        //  No displayQueuedInterruptions() here: MenuModule.enter() drains
        //  before calling us, so a second pass would only ever find an empty
        //  queue.
        async.series(
            [
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

        this._validateNotificationConfig();
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
        this._teardownTasks();

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

    //
    //  Whatever takes over the screen (help, full log, messages, tasks) drops
    //  form 0 rather than detaching it. Detaching destroys its ticker's timer
    //  for good, so the marquee froze after a visit to the full log; leaving
    //  it attached kept its keys live (escape in the message viewer also left
    //  the WFC) and let the ticker draw over the other screen.
    //  _displayMainPage() builds it again from the art.
    //
    _releaseMainForm() {
        this.removeViewController('main');
        this.lastLogTime = null; //  so the new quick log view gets filled
    }

    _displayHelpPage(cb) {
        this._stopRefreshing();
        this._releaseMainForm();

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

        //  wfc.md has always documented this as a boolean while the code only
        //  ever matched the strings, so `opVisibility: false` was a silent
        //  no-op -- and that is the form people wrote, Xibalba included.
        //  Accept both; strings stay the canonical spelling.
        let vis = this.config.opVisibility;
        if (true === vis) {
            vis = 'visible';
        } else if (false === vis) {
            vis = 'hidden';
        }
        vis = vis || 'current';

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
    //
    //  core/config/menu_schema.js leaves a module's `config` block open
    //  (closedKeys: false) because it is module specific, so a typo in a sink
    //  name or a notification type loads silently and simply never matches.
    //  That is the failure mode #281 exists to prevent, so check our own keys.
    //
    _validateNotificationConfig() {
        const notifications = _.get(this.config, 'notifications');
        if (!_.isObject(notifications)) {
            return;
        }

        const knownTypes = Object.values(InterruptType);
        const knownSinks = Object.values(Sinks);

        Object.keys(notifications).forEach(type => {
            if (!knownTypes.includes(type)) {
                this.client.log.warn(
                    { type, known: knownTypes },
                    'WFC notifications: unknown notification type; it will never match'
                );
            }

            const sinks = _.get(notifications, [type, 'sinks']);
            if (!Array.isArray(sinks)) {
                this.client.log.warn(
                    { type },
                    'WFC notifications: "sinks" must be an array; falling back to the default'
                );
                return;
            }

            sinks.forEach(sink => {
                if (!knownSinks.includes(sink)) {
                    this.client.log.warn(
                        { type, sink, known: knownSinks },
                        'WFC notifications: unknown sink; it will be ignored'
                    );
                }
            });
        });
    }

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
                //  a %SB5 'tasks' panel counts running tasks; keep it current
                if (TaskSystemEvents.includes(eventName) && this._mainFormOwnsScreen()) {
                    this._updateStatusBarPanels();
                }

                const format = this._tickerFormatFor(formats, eventName, event);
                if (!format) {
                    return; //  not configured: not shown
                }
                this._pushTicker(stringFormat(format, this._tickerFormatObj(event)));
            }
        );
    }

    //
    //  The format for |eventName|, or nothing. A TaskFinished that failed is
    //  the derived 'taskFailed' key, falling back to 'taskFinished'.
    //
    _tickerFormatFor(formats, eventName, event) {
        const key = TickerEventKeys[eventName];
        if (!key) {
            return null;
        }
        if ('taskFinished' === key && event && false === event.ok) {
            return formats.taskFailed || formats.taskFinished || null;
        }
        return formats[key] || null;
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

            //  scheduler task events
            taskName: _.isString(event.name) ? event.name : '',
            taskDesc: event.desc || event.name || '',
            reason: event.reason || '',
            byUser: event.byUser || '',
            error: event.error || '',
            durationMs: _.isFinite(event.durationMs) ? event.durationMs : '',
            duration: _.isFinite(event.durationMs)
                ? formatTaskDuration(event.durationMs)
                : '',
            timeoutMs: _.isFinite(event.timeoutMs) ? event.timeoutMs : '',
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

        this.selectedNodeStatusIndex = 0; // will select during refresh

        //  Form 0 views are not ours to paint while a sub-viewer is up
        if (!this._mainFormOwnsScreen()) {
            return;
        }

        const nodeStatusSelectionView = this.getView(
            'main',
            MciViewIds.main.selectedNodeStatusInfo
        );
        if (nodeStatusSelectionView) {
            nodeStatusSelectionView.setText('');
        }

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

    //  False before the dashboard is drawn and while a sub-viewer (full log,
    //  messages, tasks) owns the screen: form 0 views must not be painted then.
    _mainFormOwnsScreen() {
        return (
            !!this.viewControllers.main &&
            !this.viewControllers.fullLog &&
            !this.viewControllers.messages &&
            !this._tasksMode
        );
    }

    _refreshAll(cb) {
        //  Don't touch form 0 views while a sub-viewer owns the screen, or
        //  while form 0 is gone (see _releaseMainForm())
        if (!this._mainFormOwnsScreen()) {
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
            boardName: _.get(Config(), 'general.boardName', ''),

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

            //  Scheduler tasks
            ...this._taskCountStats(),
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
    //
    //  Every named panel is filled from `statusBar<Name>Format` (e.g. a panel
    //  named `user` reads statusBarUserFormat), formatted against the stats
    //  plus {count}. `messages` and `pages` carry a count and a default
    //  format; when the count is non-zero `statusBar<Name>ActiveFormat`, if
    //  set, is used instead so the panel can light up. A panel with no format
    //  at all is left alone, so a static `text` label keeps working.
    //
    _updateStatusBarPanels() {
        const view = this.getView('main', MciViewIds.main.statusBar);
        if (!view || !_.isFunction(view.setPanels) || !_.isFunction(view.getPanelNames)) {
            return;
        }

        const panelNames = view.getPanelNames();
        if (0 === panelNames.length) {
            return this._updateSingleStatusBar(view);
        }

        const counts = {
            messages: this._inbox().unreadCount(),
            pages: this.pendingPages.length,
            //  only asked of the scheduler when a theme has the panel
            tasks: panelNames.includes('tasks') ? this._runningTaskCount() : 0,
        };

        const updates = {};
        panelNames.forEach(name => {
            const key = `statusBar${_.upperFirst(name)}`;
            const count = counts[name] || 0;
            const fmt =
                (count > 0 && this.config[`${key}ActiveFormat`]) ||
                this.config[`${key}Format`] ||
                DefaultStatusBarPanelFormats[name];
            if (!_.isString(fmt)) {
                return;
            }
            updates[name] = stringFormat(fmt, { ...(this.stats || {}), count });
        });

        if (!_.isEmpty(updates)) {
            view.setPanels(updates);
        }
    }

    //
    //  A %SB5 nobody configured -- typically a theme without its own wfc.ans,
    //  which art lookup then takes from the default theme -- gets the whole
    //  header as one line rather than sitting blank. An SB with a `text`
    //  template of its own belongs to the theme and is left alone.
    //
    _updateSingleStatusBar(view) {
        if (!_.isFunction(view.setText)) {
            return;
        }
        if (_.isFunction(view.hasTextTemplate) && view.hasTextTemplate()) {
            return;
        }

        const fmt = this.config.statusBarFormat || DefaultStatusBarFormat;
        view.setText(stringFormat(fmt, this.stats || {}));
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
        this._releaseMainForm();

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
            unreadIndicator: item.read ? '' : this.config.unreadIndicator || '*',
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
            this.config.nodeMessageMenuName || 'wfcNodeMessage',
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
            this.config.nodeMessageMenuName || 'wfcNodeMessage',
            { extraArgs: { toNodeId } },
            cb
        );
    }

    //
    //  Task screen (form 5): the event scheduler's tasks, to list, run and
    //  stop. While it is up the dashboard's form is released entirely and
    //  drawn afresh on the way out, so nothing of form 0 -- its refresh, its
    //  ticker's own timer, its keys -- can reach this screen.
    //
    //  _tasksMode is 'art' (form 5 views), 'text' (no art: a plain list), or
    //  unset when the screen is not up.
    //
    _scheduler() {
        return require('./event_scheduler.js').getInstance();
    }

    _loadTaskRows() {
        const scheduler = this._scheduler();
        if (!scheduler || !_.isFunction(scheduler.listTasks)) {
            return [];
        }
        try {
            return scheduler.listTasks();
        } catch (e) {
            this.client.log.warn({ error: e.message }, 'WFC could not list tasks');
            return [];
        }
    }

    _runningTaskCount() {
        return this._loadTaskRows().filter(r => r.running).length;
    }

    _taskCountStats() {
        const rows = this._loadTaskRows();
        return {
            runningTaskCount: rows.filter(r => r.running).length,
            overdueTaskCount: rows.filter(r => r.overdue).length,
        };
    }

    _tasksOwnScreen() {
        if ('art' === this._tasksMode) {
            return !!this.viewControllers.tasks && !this._taskPromptActive;
        }
        return 'text' === this._tasksMode && !this._taskPromptActive;
    }

    _displayTasksPage(cb) {
        this._stopRefreshing();
        this._releaseMainForm();

        this._taskRows = [];
        this._lastTaskListKey = null;
        this._lastTaskDetailText = null;
        this._lastTasksTextScreen = null;
        this._taskActionResult = '';
        this._taskPromptActive = false;
        this._pendingTaskAction = null;

        this._startTaskListeners();

        const artSpec = _.get(this.menuConfig, 'config.art.tasks');
        if (!artSpec) {
            return this._displayTasksFallback(cb);
        }

        this._tasksMode = 'art';
        async.series(
            [
                callback =>
                    this.displayArtAndPrepViewController(
                        'tasks',
                        FormIds.tasks,
                        { clearScreen: true },
                        callback
                    ),
                callback => {
                    const listView = this.getView('tasks', MciViewIds.tasks.taskList);
                    if (!listView) {
                        return callback(
                            Errors.MissingMci(
                                `Missing task list VM${MciViewIds.tasks.taskList} MCI`
                            )
                        );
                    }
                    this._applyTaskListFormats(listView);
                    listView.on('index update', index => {
                        const row = this._taskRows[index];
                        this._selectedTaskIndex = index;
                        this._selectedTaskName = row ? row.name : null;
                        this._paintTaskDetail(true);
                        this._paintTasksInfo();
                    });
                    return callback(null);
                },
                callback => this._refreshTasks(callback),
            ],
            err => {
                if (err) {
                    //  Art named but not there, or missing its list: the
                    //  plain list still lets the op run and stop tasks.
                    this.client.log.debug(
                        { error: err.message, art: artSpec },
                        'WFC task screen art unavailable; using text fallback'
                    );
                    this.removeViewController('tasks');
                    return this._displayTasksFallback(cb);
                }
                return cb(null);
            }
        );
    }

    //  taskListFormat / taskListFocusFormat win; else VM1's own item formats;
    //  else the defaults.
    _applyTaskListFormats(listView) {
        if (!_.isFunction(listView.setPropertyValue)) {
            return;
        }
        if (this.config.taskListFormat) {
            listView.setPropertyValue('itemFormat', this.config.taskListFormat);
            listView.setPropertyValue(
                'focusItemFormat',
                this.config.taskListFocusFormat || this.config.taskListFormat
            );
        } else if (!listView.itemFormat) {
            listView.setPropertyValue('itemFormat', DefaultTaskListFormat);
            if (!listView.focusItemFormat) {
                listView.setPropertyValue('focusItemFormat', DefaultTaskListFocusFormat);
            }
        }
    }

    _startTaskListeners() {
        this._stopTaskListeners();
        this._taskEventListeners = Events.addMultipleEventListener(TaskSystemEvents, () =>
            this._refreshTasks()
        );
    }

    _stopTaskListeners() {
        if (this._taskEventListeners) {
            Events.removeMultipleEventListener(this._taskEventListeners);
            delete this._taskEventListeners;
        }
    }

    _stopTasksRefreshTimer() {
        if (this._tasksRefreshTimer) {
            clearTimeout(this._tasksRefreshTimer);
            delete this._tasksRefreshTimer;
        }
    }

    _scheduleTasksRefresh() {
        this._stopTasksRefreshTimer();
        if (!this._tasksMode) {
            return;
        }
        const anyRunning = (this._taskRows || []).some(r => r.running);
        this._tasksRefreshDelayMs = anyRunning ? TaskRefreshRunningMs : TaskRefreshIdleMs;
        this._tasksRefreshTimer = setTimeout(() => {
            delete this._tasksRefreshTimer;
            this._refreshTasks();
        }, this._tasksRefreshDelayMs);
    }

    //
    //  Everything the task screen holds: called on the way back to the
    //  dashboard and from leave(). Safe to call when the screen is not up.
    //
    _teardownTasks() {
        this._stopTaskListeners();
        this._stopTasksRefreshTimer();
        this._removeTaskPromptKeyHandler();
        this._removeTasksTextKeyHandler();
        this.removeViewController('taskPrompt');
        this.removeViewController('tasks');
        this._taskPromptActive = false;
        this._pendingTaskAction = null;
        this._tasksMode = null;
    }

    //
    //  Keeps the selection on the same task by name; a task that has gone
    //  leaves it at the same position, clamped.
    //
    _resolveTaskSelection(rows) {
        let index = rows.findIndex(r => r.name === this._selectedTaskName);
        if (index < 0) {
            index = Math.min(this._selectedTaskIndex || 0, rows.length - 1);
        }
        index = Math.max(index, 0);
        this._selectedTaskIndex = index;
        this._selectedTaskName = rows[index] ? rows[index].name : null;
        return index;
    }

    _selectedTaskRow() {
        return (this._taskRows || []).find(r => r.name === this._selectedTaskName);
    }

    _refreshTasks(cb) {
        if (!this._tasksMode) {
            return cb ? cb(null) : undefined;
        }

        this._taskRows = this._loadTaskRows();
        this._resolveTaskSelection(this._taskRows);

        if (this._tasksOwnScreen()) {
            if ('art' === this._tasksMode) {
                this._paintTaskList();
                this._paintTaskDetail(false);
                this._paintTasksInfo();
            } else {
                this._paintTasksText();
            }
        }

        this._scheduleTasksRefresh();
        return cb ? cb(null) : undefined;
    }

    _taskDateTimeFormat() {
        return this.config.taskDateTimeFormat || this.getDateTimeFormat('short');
    }

    _formatTaskDate(d) {
        if (!d) {
            return '';
        }
        const m = moment(d);
        return m.isValid() ? m.format(this._taskDateTimeFormat()) : '';
    }

    _taskStatus(row) {
        if (row.running) {
            return row.overdue ? 'overdue' : 'running';
        }
        if (!row.lastRun) {
            return 'never';
        }
        return row.lastRun.ok ? 'ok' : 'failed';
    }

    _taskFormatObj(row, index) {
        const lastRun = row.lastRun || null;
        const status = this._taskStatus(row);
        const indicators = Object.assign(
            {},
            DefaultTaskStatusIndicators,
            this.config.taskStatusIndicators
        );
        const stopVerbs = Object.assign(
            {},
            DefaultTaskStopVerbs,
            this.config.taskStopVerbs
        );
        const neverText = _.isString(this.config.taskNeverRunText)
            ? this.config.taskNeverRunText
            : 'never';

        let schedule = row.schedule;
        if (!schedule) {
            schedule = _.isString(this.config.taskManualScheduleText)
                ? this.config.taskManualScheduleText
                : 'manual';
        }

        let lastResult = neverText;
        if (lastRun) {
            lastResult = lastRun.ok ? 'ok' : 'failed';
        }

        return {
            index: index + 1,
            name: row.name,
            desc: row.desc || row.name,
            schedule,
            manualOnly: !!row.manualOnly,
            nextRun: row.nextRun
                ? this._formatTaskDate(row.nextRun)
                : _.isString(this.config.taskNoNextRunText)
                  ? this.config.taskNoNextRunText
                  : '-',
            status,
            statusIndicator: indicators[status] || '',
            running: !!row.running,
            overdue: !!row.overdue,
            startedAt: this._formatTaskDate(row.startedAt),
            overdueSince: this._formatTaskDate(row.overdueSince),
            elapsed:
                row.running && row.startedAt
                    ? formatTaskDuration(Date.now() - new Date(row.startedAt).getTime())
                    : '',
            stopAction: row.stopAction || '',
            stopVerb: row.stopAction ? stopVerbs[row.stopAction] || '' : '',
            confirm: !!row.confirm,
            runCount: row.runCount || 0,
            lastRunAt: lastRun ? this._formatTaskDate(lastRun.start) : neverText,
            lastResult,
            lastError: (lastRun && lastRun.error) || '',
            durationMs:
                lastRun && _.isFinite(lastRun.durationMs) ? lastRun.durationMs : '',
            duration:
                lastRun && _.isFinite(lastRun.durationMs)
                    ? formatTaskDuration(lastRun.durationMs)
                    : '',
            byUser: (lastRun && lastRun.byUser) || '',
            reason: (lastRun && lastRun.reason) || '',
            exitCode:
                lastRun && null !== lastRun.exitCode && undefined !== lastRun.exitCode
                    ? lastRun.exitCode
                    : '',
            stoppedBy: (lastRun && lastRun.stoppedBy) || '',
            //  the VM's default '{text}', for themes that format nothing
            text: row.desc || row.name,
        };
    }

    _paintTaskList() {
        const listView = this.getView('tasks', MciViewIds.tasks.taskList);
        if (!listView) {
            return;
        }

        const items = this._taskRows.map((r, i) => this._taskFormatObj(r, i));
        const index = this._selectedTaskIndex || 0;

        //  An unchanged list is not redrawn: at one refresh a second while a
        //  task runs, that would be a needless repaint of every row. {elapsed}
        //  changes every second, so it only counts when a format shows it.
        const showsElapsed = [listView.itemFormat, listView.focusItemFormat].some(
            f => _.isString(f) && f.includes('{elapsed')
        );
        const key = JSON.stringify({
            items: showsElapsed ? items : items.map(i => _.omit(i, 'elapsed')),
            index,
        });
        if (key === this._lastTaskListKey) {
            return;
        }
        this._lastTaskListKey = key;

        const sameLength = (listView.items || []).length === items.length;
        listView.setItems(items);
        if (sameLength) {
            //  setItems() blanks the old footprint before the redraw, for a
            //  list that shrank; the same number of rows just overwrites, and
            //  skipping the blank pass stops the rows flickering
            delete listView.oldDimens;
        }
        listView.setFocusItemIndex(index); //  redraws
    }

    //  |force|: a new selection always repaints; a refresh only on change,
    //  so a scrolled detail stays put while nothing in it moves.
    _paintTaskDetail(force) {
        const detailView = this.getView('tasks', MciViewIds.tasks.taskDetail);
        if (!detailView) {
            return;
        }

        const row = this._selectedTaskRow();
        const text = row
            ? this._formatTaskDetailText(row)
            : this.config.noTasksText || '|08No tasks.|07';

        if (!force && text === this._lastTaskDetailText) {
            return;
        }
        this._lastTaskDetailText = text;
        this._setWrappedText(detailView, text);
    }

    //
    //  Wraps to the view's width before it gets there: an %MT narrower than
    //  the terminal drops characters from wrapped plain text (#968).
    //
    _setWrappedText(view, pipeText) {
        if (!(view instanceof MultiLineEditTextView)) {
            return view.setText(pipeText);
        }

        const width = view.dimens.width;
        const wrapped = pipeText
            .split('\n')
            .map(line =>
                (
                    wordWrapText(line, { width, pipeCodeSupport: true }).wrapped || ['']
                ).join('\n')
            )
            .join('\n');

        view.setAnsi(pipeToAnsi(wrapped, this.client), {
            prepped: false,
            forceLineTerm: true,
        });
    }

    _tasksInfoFormatObj() {
        const rows = this._taskRows || [];
        const selected = this._selectedTaskRow();
        return Object.assign({}, this.stats || {}, {
            now: moment().format(this._dateTimeFormat('now')),
            taskCount: rows.length,
            runningTaskCount: rows.filter(r => r.running).length,
            overdueTaskCount: rows.filter(r => r.overdue).length,
            failedTaskCount: rows.filter(r => !r.running && r.lastRun && !r.lastRun.ok)
                .length,
            selectedTaskName: selected ? selected.name : '',
            selectedTaskDesc: selected ? selected.desc || selected.name : '',
            taskActionResult: this._taskActionResult || '',
        });
    }

    _paintTasksInfo() {
        this.updateCustomViewTextsWithFilter(
            'tasks',
            MciViewIds.tasks.customRangeStart,
            this._tasksInfoFormatObj()
        );
    }

    //  Label + value lines; values are escaped so a stray '|' in an error or
    //  in script output is shown, not taken as a colour code. |compact| (the
    //  text list) leaves out what the row already shows, and blank lines.
    _formatTaskDetailText(row, { compact = false } = {}) {
        const obj = this._taskFormatObj(row, 0);
        const lastRun = row.lastRun || null;
        const fieldFmt = this.config.taskDetailFieldFormat || '|08{name}|07{sep}{value}';
        const field = (name, value) =>
            stringFormat(fieldFmt, { name, sep: ': ', value: escapePipes(value) });

        const header =
            obj.desc !== row.name
                ? `|15${escapePipes(obj.desc)} |08(${escapePipes(row.name)})|07`
                : `|15${escapePipes(obj.desc)}|07`;

        const parts = [];
        if (!compact) {
            parts.push(header);
            parts.push(field('Schedule', obj.schedule));
            if (row.nextRun) {
                parts.push(field('Next run', obj.nextRun));
            }
        }
        const blank = () => {
            if (!compact) {
                parts.push('');
            }
        };

        if (row.running) {
            let status = `running since ${obj.startedAt}`;
            if (row.overdue) {
                status += `, overdue since ${obj.overdueSince}`;
            }
            parts.push(field('Status', status));
            if (row.stopAction) {
                parts.push(
                    field(
                        'Stop',
                        'kill' === row.stopAction
                            ? 'kills its process'
                            : 'abandons it (it cannot be stopped, and may keep running)'
                    )
                );
            }
        } else {
            parts.push(field('Status', 'idle'));
        }
        parts.push(field('Runs', `${obj.runCount} since startup`));

        blank();
        if (!lastRun) {
            parts.push(field('Last run', obj.lastRunAt));
            return parts.join('\n');
        }

        parts.push(field('Last run', obj.lastRunAt));
        parts.push(
            field('Result', lastRun.ok ? 'ok' : `failed: ${lastRun.error || 'error'}`)
        );
        if ('' !== obj.duration) {
            parts.push(field('Duration', obj.duration));
        }
        if (lastRun.reason) {
            parts.push(field('Reason', lastRun.reason));
        }
        if (lastRun.byUser) {
            parts.push(field('By', lastRun.byUser));
        }
        if ('' !== obj.exitCode) {
            parts.push(field('Exit code', obj.exitCode));
        }
        if (lastRun.stoppedBy) {
            parts.push(field('Stopped by', lastRun.stoppedBy));
        }
        if (lastRun.overdue) {
            parts.push(field('Overdue', 'yes, it ran past its timeout'));
        }

        if (lastRun.outputTail) {
            blank();
            parts.push(field('Output', ''));
            parts.push(`|07${escapePipes(lastRun.outputTail)}`);
        }

        return parts.join('\n');
    }

    //  Running a task asks first only when it says so; stopping always asks.
    _taskNeedsConfirm(kind, row) {
        if ('stop' === kind) {
            return true;
        }
        return true === row.confirm;
    }

    _taskPromptQuestion(kind, row) {
        const obj = this._taskFormatObj(row, 0);
        if ('stop' === kind) {
            return stringFormat(
                this.config.stopTaskPromptFormat || '{stopVerb} {desc}?',
                obj
            );
        }
        return stringFormat(this.config.runTaskPromptFormat || 'Run {desc}?', obj);
    }

    _requestTaskAction(kind, cb) {
        if (!this._tasksMode || this._taskPromptActive) {
            return cb(null);
        }

        //  act on what the scheduler says now, not on the last refresh
        this._taskRows = this._loadTaskRows();
        this._resolveTaskSelection(this._taskRows);
        const row = this._selectedTaskRow();
        if (!row) {
            return cb(null);
        }

        if ('stop' === kind && !row.running) {
            this._setTaskActionResult(
                this._scheduler() ? 'notRunning' : 'unavailable',
                row
            );
            return this._refreshTasks(cb);
        }

        if (!this._taskNeedsConfirm(kind, row)) {
            this._doTaskAction(kind, row.name);
            return cb(null);
        }

        this._pendingTaskAction = { kind, name: row.name };
        const question = this._taskPromptQuestion(kind, row);

        const xyView = this.getView('tasks', MciViewIds.tasks.promptXy);
        const promptArt = _.get(this.menuConfig, 'config.art.taskPrompt');
        if ('art' === this._tasksMode && xyView && promptArt) {
            return this._showTaskPromptArt(question, xyView.position, cb);
        }
        return this._showTaskPrompt(question, cb);
    }

    _doTaskAction(kind, name) {
        const row = (this._taskRows || []).find(r => r.name === name) || { name };
        const scheduler = this._scheduler();
        if (!scheduler) {
            this._setTaskActionResult('unavailable', row);
            return this._refreshTasks();
        }

        const byUser = this.client.user.username;
        let status;
        if ('stop' === kind) {
            status = scheduler.stop(name, { byUser });
        } else {
            status = scheduler.runNow(name, { reason: 'wfc', byUser });
        }

        this.client.log.info(
            { task: name, action: kind, status, byUser, nodeId: this.client.node },
            `WFC task ${kind}: ${status}`
        );

        //  the row may have finished already (a synchronous @method), so
        //  re-read it for the message
        this._setTaskActionResult(status, row);
        return this._refreshTasks();
    }

    _setTaskActionResult(status, row) {
        const formats = Object.assign(
            {},
            DefaultTaskActionResultFormats,
            this.config.taskActionResultFormats
        );
        const fmt = formats[status] || '{name}: {status}';
        this._taskActionResult = stringFormat(fmt, {
            name: row.name,
            desc: row.desc || row.name,
            status,
        });
        this._showTaskActionResult();
    }

    //
    //  The result of run / stop goes to {taskActionResult} in the custom
    //  views. Art that shows none gets it at %XY3, where the prompt was.
    //
    _showTaskActionResult() {
        if ('art' !== this._tasksMode || !this.viewControllers.tasks) {
            return; //  the text screen draws it with everything else
        }

        const shown = this.getCustomViewsWithFilter(
            'tasks',
            MciViewIds.tasks.customRangeStart,
            { filter: ['{taskActionResult'] }
        );
        if (shown.length > 0) {
            return this._paintTasksInfo();
        }

        const xyView = this.getView('tasks', MciViewIds.tasks.promptXy);
        if (xyView) {
            this._writeTasksLine(xyView.position, this._taskActionResult);
        }
    }

    //  Clears from |position| to the end of the line, then writes |pipeText|
    _writeTasksLine(position, pipeText) {
        const width = Math.max(1, this.client.term.termWidth - position.col);
        this.client.term.rawWrite(
            `${ansi.goto(position.row, position.col)}${ansi.reset()}${' '.repeat(width)}`
        );
        this.client.term.rawWrite(ansi.goto(position.row, position.col));
        this.client.term.write(pipeToAnsi(pipeText || '', this.client));
    }

    _detachTasksInput() {
        if (this.viewControllers.tasks) {
            this.viewControllers.tasks.setFocus(false);
        }
        this._removeTasksTextKeyHandler();
    }

    _attachTasksInput() {
        if ('art' === this._tasksMode && this.viewControllers.tasks) {
            this.viewControllers.tasks.setFocus(true);
        } else if ('text' === this._tasksMode) {
            this._addTasksTextKeyHandler();
        }
    }

    //
    //  One prompt for run and stop: wfctaskprompt, drawn at %XY3, has a %TM1
    //  yes/no and a %TL2 that gets the question. Form 6's submit calls
    //  taskPromptYes / taskPromptNo.
    //
    _showTaskPromptArt(question, position, cb) {
        this._taskPromptActive = true;
        this._detachTasksInput();
        this.removeViewController('taskPrompt');

        this.client.term.rawWrite(ansi.goto(position.row, position.col));
        this.displayArtAndPrepViewController(
            'taskPrompt',
            FormIds.confirmTaskPrompt,
            {
                //  art MCI positions count from row 1, column 1
                viewOffsets: { row: position.row - 1, col: position.col - 1 },
            },
            err => {
                if (err) {
                    this.client.log.debug(
                        { error: err.message },
                        'WFC task prompt art unavailable; using a text prompt'
                    );
                    this.removeViewController('taskPrompt');
                    return this._showTaskPrompt(question, cb);
                }

                const questionView = this.getView(
                    'taskPrompt',
                    MciViewIds.taskPrompt.question
                );
                if (questionView) {
                    questionView.setText(question);
                }
                return cb(null);
            }
        );
    }

    //  No prompt art: the question and a y/N answer on a single line
    _showTaskPrompt(question, cb) {
        this._taskPromptActive = true;
        this._detachTasksInput();

        const position = this._taskPromptPosition();
        const suffix = _.isString(this.config.taskPromptSuffix)
            ? this.config.taskPromptSuffix
            : ' |08[|15y|08/|15N|08]|07 ';
        this._writeTasksLine(position, `|07${question}${suffix}`);

        this._removeTaskPromptKeyHandler();
        this._taskPromptKeyHandler = ch => {
            this._removeTaskPromptKeyHandler();
            this._closeTaskPrompt(_.isString(ch) && 'y' === ch.toLowerCase());
        };
        this.client.on('key press', this._taskPromptKeyHandler);
        return cb(null);
    }

    _taskPromptPosition() {
        const xyView = this.getView('tasks', MciViewIds.tasks.promptXy);
        if ('art' === this._tasksMode && xyView) {
            return xyView.position;
        }
        return { row: this.client.term.termHeight || 24, col: 1 };
    }

    _removeTaskPromptKeyHandler() {
        if (this._taskPromptKeyHandler) {
            this.client.removeListener('key press', this._taskPromptKeyHandler);
            delete this._taskPromptKeyHandler;
        }
    }

    _closeTaskPrompt(confirmed) {
        const pending = this._pendingTaskAction;
        this._pendingTaskAction = null;

        if (!this._taskPromptActive) {
            return;
        }

        this.removeViewController('taskPrompt');
        this._removeTaskPromptKeyHandler();
        this._taskPromptActive = false;

        if (!this._tasksMode) {
            return; //  the op left meanwhile
        }

        if ('art' === this._tasksMode) {
            this._writeTasksLine(this._taskPromptPosition(), '');
        } else {
            this._lastTasksTextScreen = null; //  the prompt line needs redrawing
        }

        this._attachTasksInput();

        if (confirmed && pending) {
            return this._doTaskAction(pending.kind, pending.name);
        }
        if ('art' === this._tasksMode) {
            this._showTaskActionResult(); //  put back what the prompt covered
        }
        return this._refreshTasks();
    }

    //
    //  No art: a plain list, driven by the same keys. Up / down or 1-9
    //  select, enter / R run, X stop, F refresh, Q / escape back.
    //
    _displayTasksFallback(cb) {
        this._tasksMode = 'text';
        this.client.term.rawWrite(ansi.resetScreen());
        this._addTasksTextKeyHandler();
        return this._refreshTasks(cb);
    }

    _addTasksTextKeyHandler() {
        this._removeTasksTextKeyHandler();
        this._tasksTextKeyHandler = (ch, key) => this._onTasksTextKey(ch, key);
        this.client.on('key press', this._tasksTextKeyHandler);
    }

    _removeTasksTextKeyHandler() {
        if (this._tasksTextKeyHandler) {
            this.client.removeListener('key press', this._tasksTextKeyHandler);
            delete this._tasksTextKeyHandler;
        }
    }

    _onTasksTextKey(ch, key) {
        const name = (key && key.name) || '';
        const c = _.isString(ch) ? ch.toLowerCase() : '';
        const done = () => {};

        if ('escape' === name || 'q' === c) {
            this._teardownTasks();
            return this._displayMainPage(true, done);
        }
        if ('return' === name || 'r' === c) {
            return this._requestTaskAction('run', done);
        }
        if ('x' === c) {
            return this._requestTaskAction('stop', done);
        }
        if ('f' === c) {
            return this._refreshTasks();
        }

        const rows = this._taskRows || [];
        let index = this._selectedTaskIndex || 0;
        if ('up arrow' === name) {
            index -= 1;
        } else if ('down arrow' === name) {
            index += 1;
        } else if (/^[1-9]$/.test(c)) {
            index = parseInt(c, 10) - 1;
        } else {
            return;
        }

        if (index < 0 || index >= rows.length) {
            return;
        }
        this._selectedTaskIndex = index;
        this._selectedTaskName = rows[index].name;
        return this._paintTasksText();
    }

    _paintTasksText() {
        const rows = this._taskRows || [];
        const listFmt = this.config.taskListFormat || DefaultTaskListFormat;
        const focusFmt =
            this.config.taskListFocusFormat ||
            (this.config.taskListFormat ? listFmt : DefaultTaskListFocusFormat);
        const termWidth = this.client.term.termWidth || 80;

        const lines = [
            this.config.tasksTextHeader ||
                '|15Tasks|08: |07up|08/|07down select, |15R|07un, |15X|07 stop, |15F|07 refresh, |15Q|07uit',
            '',
        ];

        if (!rows.length) {
            lines.push(this.config.noTasksText || '|08No tasks.|07');
        }
        rows.forEach((row, i) => {
            const fmt = i === this._selectedTaskIndex ? focusFmt : listFmt;
            lines.push(stringFormat(fmt, this._taskFormatObj(row, i)));
        });

        const selected = this._selectedTaskRow();
        if (selected) {
            lines.push('');
            const detailRows = Math.max(
                0,
                (this.client.term.termHeight || 24) - lines.length - 3
            );
            const detail = this._formatTaskDetailText(selected, { compact: true })
                .split('\n')
                .map(
                    line =>
                        wordWrapText(line, {
                            width: termWidth - 1,
                            pipeCodeSupport: true,
                        }).wrapped || ['']
                )
                .reduce((acc, wrapped) => acc.concat(wrapped), [])
                .slice(0, detailRows);
            lines.push(...detail);
        }

        lines.push('');
        lines.push(this._taskActionResult || '');

        const screen = lines.join('\r\n');
        if (screen === this._lastTasksTextScreen) {
            return;
        }
        this._lastTasksTextScreen = screen;

        //  write(), not rawWrite(), for the text: write() is what converts it
        //  to the client's encoding
        this.client.term.rawWrite(ansi.resetScreen());
        this.client.term.write(pipeToAnsi(`${screen}|07`, this.client));
    }

    _scrollDetailPage(formName, viewId, direction) {
        const detailView = this.getView(formName, viewId);
        if (!detailView) {
            return;
        }
        const page = detailView.dimens.height;
        if (direction < 0) {
            detailView.topVisibleIndex = Math.max(0, detailView.topVisibleIndex - page);
        } else {
            const maxTop = Math.max(0, detailView.buffer.lines.length - page);
            detailView.topVisibleIndex = Math.min(
                maxTop,
                detailView.topVisibleIndex + page
            );
        }
        detailView.redraw();
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

        //  So form 0's keys and ticker don't compete with fullLog's
        this._releaseMainForm();

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
