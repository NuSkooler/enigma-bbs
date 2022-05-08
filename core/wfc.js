//  ENiGMA½
const { MenuModule } = require('./menu_module');

const { getActiveConnectionList } = require('./client_connections');
const StatLog = require('./stat_log');
const SysProps = require('./system_property');
const UserProps = require('./user_property');
const Log = require('./logger');
const Config = require('./config.js').get;

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const bunyan = require('bunyan');

exports.moduleInfo = {
    name        : 'WFC',
    desc        : 'Semi-Traditional Waiting For Caller',
    author      : 'NuSkooler',
};

const FormIds = {
    main : 0,
};

const MciViewIds = {
    main : {
        nodeStatus          : 1,
        quickLogView        : 2,

        customRangeStart    : 10,
    }
};

//  Secure + 2FA + root user + 'wfc' group.
const DefaultACS = 'SCAF2ID1GM[wfc]';
const MainStatRefreshTimeMs = 5000; // 5s

exports.getModule = class WaitingForCallerModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });

        this.config.acs = this.config.acs || DefaultACS;
        if (!this.config.acs.includes('SC')) {
            this.config.acs = 'SC' + this.config.acs;    //  secure connection at the very least
        }
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    (callback) => {
                        return this.prepViewController('main', FormIds.main, mciData.menu, callback);
                    },
                    (callback) => {
                        const quickLogView = this.viewControllers.main.getView(MciViewIds.main.quickLogView);
                        if (!quickLogView) {
                            return callback(null);
                        }

                        const logLevel = this.config.quickLogLevel ||           //  WFC specific
                            _.get(Config(), 'logging.rotatingFile.level') ||    //  ...or system setting
                            'info';                                             //  ...or default to info

                        this.logRingBuffer = new bunyan.RingBuffer({ limit : quickLogView.dimens.height || 24 });
                        Log.log.addStream({
                            name    : 'wfc-ringbuffer',
                            type    : 'raw',
                            level   : logLevel,
                            stream  : this.logRingBuffer
                        });

                        return callback(null);
                    },
                    (callback) => {
                        return this._refreshAll(callback);
                    }
                ],
                err => {
                    if (!err) {
                        this._startRefreshing();
                    }
                    return cb(err);
                }
            );
        });
    }

    enter() {
        this.client.stopIdleMonitor();
        super.enter();
    }

    leave() {
        _.remove(Log.log.streams, stream => {
            return stream.name === 'wfc-ringbuffer';
        });

        this._stopRefreshing();
        this.client.startIdleMonitor();

        super.leave();
    }

    _startRefreshing() {
        this.mainRefreshTimer = setInterval( () => {
            this._refreshAll();
        }, MainStatRefreshTimeMs);
    }

    _stopRefreshing() {
        if (this.mainRefreshTimer) {
            clearInterval(this.mainRefreshTimer);
            delete this.mainRefreshTimer;
        }
    }

    _refreshAll(cb) {
        async.series(
            [
                (callback) => {
                    return this._refreshStats(callback);
                },
                (callback) => {
                    return this._refreshNodeStatus(callback);
                },
                (callback) => {
                    return this._refreshQuickLog(callback);
                },
                (callback) => {
                    this.updateCustomViewTextsWithFilter(
                        'main',
                        MciViewIds.main.customRangeStart,
                        this.stats
                    );
                    return callback(null);
                }
            ],
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    _refreshStats(cb) {
        const fileAreaStats     = StatLog.getSystemStat(SysProps.FileBaseAreaStats) || {};
        const sysMemStats       = StatLog.getSystemStat(SysProps.SystemMemoryStats) || {};
        const sysLoadStats      = StatLog.getSystemStat(SysProps.SystemLoadStats) || {};
        const lastLoginStats    = StatLog.getSystemStat(SysProps.LastLogin);

        const now = moment();

        this.stats = {
            //  Date/Time
            nowDate                 : now.format(this.getDateFormat()),
            nowTime                 : now.format(this.getTimeFormat()),
            now                     : now.format(this._dateTimeFormat('now')),

            //  Current process (our Node.js service)
            processUptimeSeconds    : process.uptime(),

            //  Totals
            totalCalls              : StatLog.getSystemStatNum(SysProps.LoginCount),
            totalPosts              : StatLog.getSystemStatNum(SysProps.MessageTotalCount),
            totalUsers              : StatLog.getSystemStatNum(SysProps.TotalUserCount),
            totalFiles              : fileAreaStats.totalFiles || 0,
            totalFileBytes          : fileAreaStats.totalFileBytes || 0,

            // totalUploads            :
            // totalUploadBytes        :
            // totalDownloads          :
            // totalDownloadBytes      :

            //  Today's Stats
            callsToday              : StatLog.getSystemStatNum(SysProps.LoginsToday),
            postsToday              : StatLog.getSystemStatNum(SysProps.MessagesToday),
            uploadsToday            : StatLog.getSystemStatNum(SysProps.FileUlTodayCount),
            uploadBytesToday        : StatLog.getSystemStatNum(SysProps.FileUlTodayBytes),
            downloadsToday          : StatLog.getSystemStatNum(SysProps.FileDlTodayCount),
            downloadBytesToday      : StatLog.getSystemStatNum(SysProps.FileDlTodayBytes),
            newUsersToday           : StatLog.getSystemStatNum(SysProps.NewUsersTodayCount),

            //  Current
            currentUserName         : this.client.user.username,
            currentUserRealName     : this.client.user.getProperty(UserProps.RealName) || this.client.user.username,
            lastLoginUserName       : lastLoginStats.userName,
            lastLoginRealName       : lastLoginStats.realName,
            lastLoginDate           : moment(lastLoginStats.timestamp).format(this.getDateFormat()),
            lastLoginTime           : moment(lastLoginStats.timestamp).format(this.getTimeFormat()),
            lastLogin               : moment(lastLoginStats.timestamp).format(this._dateTimeFormat('lastLogin')),

            totalMemoryBytes        : sysMemStats.totalBytes || 0,
            freeMemoryBytes         : sysMemStats.freeBytes || 0,
            systemAvgLoad           : sysLoadStats.average || 0,
            systemCurrentLoad       : sysLoadStats.current || 0,
        };

        return cb(null);
    }

    _refreshNodeStatus(cb) {
        const nodeStatusView = this.getView('main', MciViewIds.main.nodeStatus);
        if (!nodeStatusView) {
            return cb(null);
        }

        const nodeStatusItems = getActiveConnectionList(false)
            .slice(0, nodeStatusView.dimens.height)
            .map(ac => {
                //  Handle pre-authenticated
                if (!ac.authenticated) {
                    ac.text     = ac.userName = '*Pre Auth*';
                    ac.action   = 'Logging In';
                }

                return Object.assign(ac, {
                    timeOn : _.upperFirst((ac.timeOn || moment.duration(0)).humanize()),    //  make friendly
                });
        });

        nodeStatusView.setItems(nodeStatusItems);
        nodeStatusView.redraw();

        return cb(null);
    }

    _refreshQuickLog(cb) {
        const quickLogView = this.viewControllers.main.getView(MciViewIds.main.quickLogView);
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
            this.config.quickLogTimestampFormat ||
            this.getDateTimeFormat('short');

        const levelIndicators = this.config.quickLogLevelIndicators ||
            {
                trace   : 'T',
                debug   : 'D',
                info    : 'I',
                warn    : 'W',
                error   : 'E',
                fatal   : 'F',
            };


        const makeLevelIndicator = (level) => {
            return levelIndicators[level] || '?';
        };

        const quickLogLevelMessagePrefixes = this.config.quickLogLevelMessagePrefixes || {};
        const prefixMssage = (message, level) => {
            const prefix = quickLogLevelMessagePrefixes[level] || '';
            return `${prefix}${message}`;
        };

        const logItems = records.map(rec => {
            const level = bunyan.nameFromLevel[rec.level];
            return {
                timestamp       : moment(rec.time).format(quickLogTimestampFormat),
                level           : rec.level,
                levelIndicator  : makeLevelIndicator(level),
                nodeId          : rec.nodeId || '*',
                sessionId       : rec.sessionId || '',
                message         : prefixMssage(rec.msg, level),
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

