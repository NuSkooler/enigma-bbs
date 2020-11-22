//  ENiGMA½
const { MenuModule } = require('./menu_module');

const { getActiveConnectionList } = require('./client_connections');
const StatLog = require('./stat_log');
const SysProps = require('./system_property');

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const SysInfo = require('systeminformation');

exports.moduleInfo = {
    name        : 'WFC',
    desc        : 'Semi-Traditional Waiting For Caller',
    author      : 'NuSkooler',
};

const FormIds = {
    main    : 0,
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
                        // const requiredCodes = [
                        // ];
                        // return this.validateMCIByViewIds('main', requiredCodes, callback);
                        return callback(null);
                    },
                    (callback) => {
                        return this._refreshStats(callback);
                    },
                    (callback) => {
                        return this._refreshNodeStatus(callback);
                    }
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    _refreshStats(cb) {
        const fileAreaStats = StatLog.getSystemStat(SysProps.FileBaseAreaStats);

        //  Some stats we can just fill right away
        this.stats = {
            //  Date/Time
            date                    : moment().format(this.getDateFormat()),
            time                    : moment().format(this.getTimeFormat()),
            dateTime                : moment().format(this.getDateTimeFormat()),

            //  Current process (our Node.js service)
            processUptimeSeconds    : process.uptime(),
//            processUptime           : moment.duration(process.uptime(), 'seconds').humanize(),

            //  Totals
            totalCalls              : StatLog.getSystemStatNum(SysProps.LoginCount),
            totalPosts              : StatLog.getSystemStatNum(SysProps.MessageTotalCount),
            //totalUsers  :
            totalFiles              : fileAreaStats.totalFiles || 0,
            totalFileBytes          : fileAreaStats.totalFileBytes || 0,

            // totalUploads            :
            // totalUploadBytes        :
            // totalDownloads          :
            // totalDownloadBytes      :

            //  :TODO: lastCaller
            //  :TODO: totalMemoryBytes, freeMemoryBytes
            //  :TODO: CPU info/averages/load

            //  Today's Stats
            callsToday              : StatLog.getSystemStatNum(SysProps.LoginsToday),
            postsToday              : StatLog.getSystemStatNum(SysProps.MessagesToday),
            // uploadsToday            :
            // uploadBytesToday        :
            // downloadsToday          :
            // downloadBytesToday      :

            //  Current
            // lastCaller             :
            // lastCallerDate
            // lastCallerTime
        };

        //  Some async work required...
        const basicSysInfo = {
            mem         : 'total, free',
            currentLoad : 'avgload, currentLoad',
        };

        SysInfo.get(basicSysInfo)
            .then(sysInfo => {
                this.stats.totalMemoryBytes     = sysInfo.mem.total;
                this.stats.freeMemoryBytes      = sysInfo.mem.free;

                //  Not avail on BSD, yet.
                this.stats.systemAvgLoad        = _.get(sysInfo, 'currentLoad.avgload', 0);
                this.stats.systemCurrentLoad    = _.get(sysInfo, 'currentLoad.currentLoad', 0);
            })
            .catch(err => {
                return cb(err);
            });
    }

    _refreshNodeStatus(cb) {
        const nodeStatusView = this.getView('main', MciViewIds.main.nodeStatus);
        if (!nodeStatusView) {
            return cb(null);
        }

        const nodeStatusItems = getActiveConnectionList(false).slice(0, nodeStatusView.height).map(ac => {
            //  Handle pre-authenticated
            if (!ac.authenticated) {
                ac.text     = ac.username = 'Pre Auth';
                ac.action   = 'Logging In';
            }

            return Object.assign(ac, {
                timeOn : _.upperFirst(ac.timeOn.humanize()),    //  make friendly
            });
        });

        nodeStatusView.setItems(nodeStatusItems);
        nodeStatusView.redraw();

        return cb(null);
    }
};

