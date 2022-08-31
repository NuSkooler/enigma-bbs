//  ENiGMA½
const { MenuModule } = require('./menu_module');
const stringFormat = require('./string_format');
const Events = require('./events');

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

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const bunyan = require('bunyan');

exports.moduleInfo = {
    name: 'WFC',
    desc: 'Semi-Traditional Waiting For Caller',
    author: 'NuSkooler',
};

const FormIds = {
    main: 0,
    help: 1,
    fullLog: 2,
    confirmKickPrompt: 3,
};

const MciViewIds = {
    main: {
        nodeStatus: 1,
        quickLogView: 2,
        selectedNodeStatusInfo: 3,
        confirmXy: 4,

        customRangeStart: 10,
    },
};

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
        this.config.acs = this.config.acs;
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

        this.menuMethods = {
            toggleAvailable: (formData, extraArgs, cb) => {
                const avail = this.client.user.isAvailable();
                this.client.user.setAvailability(!avail);
                return this._refreshAll(cb);
            },
            toggleVisible: (formData, extraArgs, cb) => {
                const visible = this.client.user.isVisible();
                this.client.user.setVisibility(!visible);
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
                        const item = nodeStatusView.getItems()[index];
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
        };
    }

    initSequence() {
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
                            const item = nodeStatusView.getItems()[index];
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
        Events.on(
            Events.getSystemEvents().ClientDisconnected,
            this._clientDisconnected.bind(this)
        );
        super.enter();
    }

    leave() {
        _.remove(Log.log.streams, stream => {
            return stream.name === 'wfc-ringbuffer';
        });

        Events.removeListener(
            Events.getSystemEvents().ClientDisconnected,
            this._clientDisconnected
        );

        this._restoreOpVisibility();

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
                this._startRefreshing();
            },
        };

        if (confirmView.dimens.width) {
            promptOptions.clearWidth = confirmView.dimens.width;
        }

        this._stopRefreshing();
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
        this.client.user.setVisibility(this.restoreUserIsVisible);
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
    }

    _clientDisconnected() {
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
                const item = nodeStatusView.getItems()[this.selectedNodeStatusIndex];
                this._updateNodeStatusSelection(nodeStatusSelectionView, item);
            }
        }
    }

    _refreshAll(cb) {
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
            currentUserRealName:
                this.client.user.getProperty(UserProps.RealName) ||
                this.client.user.username,
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
        };

        return cb(null);
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

                return Object.assign(ac, {
                    availIndicator,
                    visIndicator,
                    timeOnMinutes: timeOn.asMinutes(),
                    timeOn: _.upperFirst(timeOn.humanize()), //  make friendly
                    affils: ac.affils || 'N/A',
                    realName: ac.realName || 'N/A',
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
                const item = nodeStatusView.getItems()[0];
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

    _dateTimeFormat(element) {
        const format = this.config[`${element}DateTimeFormat`];
        return format || this.getDateFormat();
    }
};
