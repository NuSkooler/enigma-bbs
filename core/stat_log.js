/* jslint node: true */
'use strict';

const sysDb = require('./database.js').dbs.system;
const { getISOTimestampString } = require('./database.js');
const Errors = require('./enig_error.js');
const SysProps = require('./system_property.js');
const UserProps = require('./user_property');
const Message = require('./message');
const { getActiveConnections, AllConnections } = require('./client_connections');

//  deps
const _ = require('lodash');
const moment = require('moment');
const SysInfo = require('systeminformation');

/*
    System Event Log & Stats
    ------------------------

    System & user specific:
    * Events for generating various statistics, logs such as last callers, etc.
    * Stats such as counters

    User specific stats are simply an alternate interface to user properties, while
    system wide entries are handled on their own. Both are read accessible non-blocking
    making them easily available for MCI codes for example.
*/
class StatLog {
    constructor() {
        this.systemStats = {};
        this.lastSysInfoStatsRefresh = 0;
    }

    init(cb) {
        //
        //  Load previous state/values of |this.systemStats|
        //
        const self = this;

        sysDb.each(
            `SELECT stat_name, stat_value
            FROM system_stat;`,
            (err, row) => {
                if (row) {
                    self.systemStats[row.stat_name] = row.stat_value;
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    get KeepDays() {
        return {
            Forever: -1,
        };
    }

    get KeepType() {
        return {
            Forever: 'forever',
            Days: 'days',
            Max: 'max',
            Count: 'max',
        };
    }

    get Order() {
        return {
            Timestamp: 'timestamp_asc',
            TimestampAsc: 'timestamp_asc',
            TimestampDesc: 'timestamp_desc',
            Random: 'random',
        };
    }

    setNonPersistentSystemStat(statName, statValue) {
        this.systemStats[statName] = statValue;
    }

    incrementNonPersistentSystemStat(statName, incrementBy) {
        incrementBy = incrementBy || 1;

        let newValue = parseInt(this.systemStats[statName]);
        if (!isNaN(newValue)) {
            newValue += incrementBy;
        } else {
            newValue = incrementBy;
        }
        this.setNonPersistentSystemStat(statName, newValue);
        return newValue;
    }

    setSystemStat(statName, statValue, cb) {
        //  live stats
        this.systemStats[statName] = statValue;

        //  persisted stats
        sysDb.run(
            `REPLACE INTO system_stat (stat_name, stat_value)
            VALUES (?, ?);`,
            [statName, statValue],
            err => {
                //  cb optional - callers may fire & forget
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    getSystemStat(statName) {
        const stat = this.systemStats[statName];

        //  Some stats are refreshed periodically when they are
        //  being accessed (e.g. "looked at"). This is handled async.
        this._refreshSystemStat(statName);

        return stat;
    }

    getFriendlySystemStat(statName, defaultValue) {
        return (this.getSystemStat(statName) || defaultValue).toLocaleString();
    }

    getSystemStatNum(statName) {
        return parseInt(this.getSystemStat(statName)) || 0;
    }

    incrementSystemStat(statName, incrementBy, cb) {
        const newValue = this.incrementNonPersistentSystemStat(statName, incrementBy);
        return this.setSystemStat(statName, newValue, cb);
    }

    //
    //  User specific stats
    //  These are simply convenience methods to the user's properties
    //
    setUserStatWithOptions(user, statName, statValue, options, cb) {
        //  note: cb is optional in PersistUserProperty
        user.persistProperty(statName, statValue, cb);

        if (!options.noEvent) {
            const Events = require('./events.js'); //  we need to late load currently
            Events.emit(Events.getSystemEvents().UserStatSet, {
                user,
                statName,
                statValue,
            });
        }
    }

    setUserStat(user, statName, statValue, cb) {
        return this.setUserStatWithOptions(user, statName, statValue, {}, cb);
    }

    getUserStat(user, statName) {
        return user.getProperty(statName);
    }

    getUserStatByClient(client, statName) {
        const stat = this.getUserStat(client.user, statName);
        this._refreshUserStat(client, statName);
        return stat;
    }

    getUserStatNum(user, statName) {
        return parseInt(this.getUserStat(user, statName)) || 0;
    }

    getUserStatNumByClient(client, statName, ttlSeconds = 10) {
        const stat = this.getUserStatNum(client.user, statName);
        this._refreshUserStat(client, statName, ttlSeconds);
        return stat;
    }

    incrementUserStat(user, statName, incrementBy, cb) {
        incrementBy = incrementBy || 1;

        const oldValue = user.getPropertyAsNumber(statName) || 0;
        const newValue = oldValue + incrementBy;

        this.setUserStatWithOptions(user, statName, newValue, { noEvent: true }, err => {
            if (!err) {
                const Events = require('./events.js'); //  we need to late load currently
                Events.emit(Events.getSystemEvents().UserStatIncrement, {
                    user,
                    statName,
                    oldValue,
                    statIncrementBy: incrementBy,
                    statValue: newValue,
                });
            }

            if (cb) {
                return cb(err);
            }
        });
    }

    //  the time "now" in the ISO format we use and love :)
    get now() {
        return getISOTimestampString();
    }

    appendSystemLogEntry(logName, logValue, keep, keepType, cb) {
        sysDb.run(
            `INSERT INTO system_event_log (timestamp, log_name, log_value)
            VALUES (?, ?, ?);`,
            [this.now, logName, logValue],
            () => {
                //
                //  Handle keep
                //
                if (-1 === keep) {
                    if (cb) {
                        return cb(null);
                    }
                    return;
                }

                switch (keepType) {
                    //  keep # of days
                    case 'days':
                        sysDb.run(
                            `DELETE FROM system_event_log
                            WHERE log_name = ? AND timestamp <= DATETIME("now", "-${keep} day");`,
                            [logName],
                            err => {
                                //  cb optional - callers may fire & forget
                                if (cb) {
                                    return cb(err);
                                }
                            }
                        );
                        break;

                    case 'count':
                    case 'max':
                        //  keep max of N/count
                        sysDb.run(
                            `DELETE FROM system_event_log
                            WHERE id IN(
                                SELECT id
                                FROM system_event_log
                                WHERE log_name = ?
                                ORDER BY id DESC
                                LIMIT -1 OFFSET ${keep}
                            );`,
                            [logName],
                            err => {
                                if (cb) {
                                    return cb(err);
                                }
                            }
                        );
                        break;

                    case 'forever':
                    default:
                        //  nop
                        break;
                }
            }
        );
    }

    //
    //  Find System Log entry(s) by |filter|:
    //
    //  - logName: Name of log (required)
    //  - resultType: 'obj' | 'count' (default='obj')
    //  - limit: Limit returned results
    //  - date: exact date to filter against
    //  - order: 'timestamp' | 'timestamp_asc' | 'timestamp_desc' | 'random'
    //           (default='timestamp')
    //
    findSystemLogEntries(filter, cb) {
        return this._findLogEntries('system_event_log', filter, cb);
    }

    getSystemLogEntries(logName, order, limit, cb) {
        if (!cb && _.isFunction(limit)) {
            cb = limit;
            limit = 0;
        } else {
            limit = limit || 0;
        }

        const filter = {
            logName,
            order,
            limit,
        };
        return this.findSystemLogEntries(filter, cb);
    }

    appendUserLogEntry(user, logName, logValue, keepDays, cb) {
        sysDb.run(
            `INSERT INTO user_event_log (timestamp, user_id, session_id, log_name, log_value)
            VALUES (?, ?, ?, ?, ?);`,
            [this.now, user.userId, user.sessionId, logName, logValue],
            err => {
                if (err) {
                    if (cb) {
                        cb(err);
                    }
                    return;
                }
                //
                //  Handle keepDays
                //
                if (-1 === keepDays) {
                    if (cb) {
                        return cb(null);
                    }
                    return;
                }

                sysDb.run(
                    `DELETE FROM user_event_log
                    WHERE user_id = ? AND log_name = ? AND timestamp <= DATETIME("now", "-${keepDays} day");`,
                    [user.userId, logName],
                    err => {
                        //  cb optional - callers may fire & forget
                        if (cb) {
                            return cb(err);
                        }
                    }
                );
            }
        );
    }

    initUserEvents(cb) {
        const systemEventUserLogInit = require('./sys_event_user_log.js');
        systemEventUserLogInit(this);
        return cb(null);
    }

    //
    //  Find User Log entry(s) by |filter|:
    //
    //  - logName: Name of log (required)
    //  - userId: User ID in which to restrict entries to (missing=all)
    //  - sessionId: Session ID in which to restrict entries to (missing=any)
    //  - resultType: 'obj' | 'count' (default='obj')
    //  - limit: Limit returned results
    //  - date: exact date to filter against
    //  - order: 'timestamp' | 'timestamp_asc' | 'timestamp_desc' | 'random'
    //           (default='timestamp')
    //
    findUserLogEntries(filter, cb) {
        return this._findLogEntries('user_event_log', filter, cb);
    }

    _refreshSystemStat(statName) {
        switch (statName) {
            case SysProps.SystemLoadStats:
            case SysProps.SystemMemoryStats:
                return this._refreshSysInfoStats();

            case SysProps.ProcessTrafficStats:
                return this._refreshProcessTrafficStats();
        }
    }

    _refreshSysInfoStats() {
        const now = Math.floor(Date.now() / 1000);
        if (now < this.lastSysInfoStatsRefresh + 5) {
            return;
        }

        this.lastSysInfoStatsRefresh = now;

        const basicSysInfo = {
            mem: 'total, free',
            currentLoad: 'avgLoad, currentLoad',
        };

        SysInfo.get(basicSysInfo)
            .then(sysInfo => {
                const memStats = {
                    totalBytes: sysInfo.mem.total,
                    freeBytes: sysInfo.mem.free,
                };

                this.setNonPersistentSystemStat(SysProps.SystemMemoryStats, memStats);

                const loadStats = {
                    //  Not avail on BSD, yet.
                    average: parseFloat(
                        _.get(sysInfo, 'currentLoad.avgLoad', 0).toFixed(2)
                    ),
                    current: parseFloat(
                        _.get(sysInfo, 'currentLoad.currentLoad', 0).toFixed(2)
                    ),
                };

                this.setNonPersistentSystemStat(SysProps.SystemLoadStats, loadStats);
            })
            .catch(err => {
                //  :TODO: log me
            });
    }

    _refreshProcessTrafficStats() {
        const trafficStats = getActiveConnections(AllConnections).reduce(
            (stats, conn) => {
                stats.ingress += conn.rawSocket.bytesRead;
                stats.egress += conn.rawSocket.bytesWritten;
                return stats;
            },
            { ingress: 0, egress: 0 }
        );

        this.setNonPersistentSystemStat(SysProps.ProcessTrafficStats, trafficStats);
    }

    _refreshUserStat(client, statName, ttlSeconds) {
        switch (statName) {
            case UserProps.NewPrivateMailCount:
                this._wrapUserRefreshWithCachedTTL(
                    client,
                    statName,
                    this._refreshUserPrivateMailCount,
                    ttlSeconds
                );
                break;

            case UserProps.NewAddressedToMessageCount:
                this._wrapUserRefreshWithCachedTTL(
                    client,
                    statName,
                    this._refreshUserNewAddressedToMessageCount,
                    ttlSeconds
                );
                break;
        }
    }

    _wrapUserRefreshWithCachedTTL(client, statName, updateMethod, ttlSeconds) {
        client.statLogRefreshCache = client.statLogRefreshCache || new Map();

        const now = Math.floor(Date.now() / 1000);
        const old = client.statLogRefreshCache.get(statName) || 0;
        if (now < old + ttlSeconds) {
            return;
        }

        updateMethod(client);
        client.statLogRefreshCache.set(statName, now);
    }

    _refreshUserPrivateMailCount(client) {
        const MsgArea = require('./message_area');
        MsgArea.getNewMessageCountInAreaForUser(
            client.user.userId,
            Message.WellKnownAreaTags.Private,
            (err, count) => {
                if (!err) {
                    client.user.setProperty(UserProps.NewPrivateMailCount, count);
                }
            }
        );
    }

    _refreshUserNewAddressedToMessageCount(client) {
        const MsgArea = require('./message_area');
        MsgArea.getNewMessageCountAddressedToUser(client, (err, count) => {
            if (!err) {
                client.user.setProperty(UserProps.NewAddressedToMessageCount, count);
            }
        });
    }

    _findLogEntries(logTable, filter, cb) {
        filter = filter || {};
        if (!_.isString(filter.logName)) {
            return cb(Errors.MissingParam('filter.logName is required'));
        }

        filter.resultType = filter.resultType || 'obj';
        filter.order = filter.order || 'timestamp';

        let sql;
        if ('count' === filter.resultType) {
            sql = `SELECT COUNT() AS count
                FROM ${logTable}`;
        } else {
            sql = `SELECT timestamp, log_value
                FROM ${logTable}`;
        }

        sql += ' WHERE log_name = ?';

        if (_.isNumber(filter.userId)) {
            sql += ` AND user_id = ${filter.userId}`;
        }

        if (filter.sessionId) {
            sql += ` AND session_id = ${filter.sessionId}`;
        }

        if (filter.date) {
            filter.date = moment(filter.date);
            sql += ` AND DATE(timestamp, "localtime") = DATE("${filter.date.format(
                'YYYY-MM-DD'
            )}")`;
        }

        if ('count' !== filter.resultType) {
            switch (filter.order) {
                case 'timestamp':
                case 'timestamp_asc':
                    sql += ' ORDER BY timestamp ASC';
                    break;

                case 'timestamp_desc':
                    sql += ' ORDER BY timestamp DESC';
                    break;

                case 'random':
                    sql += ' ORDER BY RANDOM()';
                    break;
            }
        }

        if (_.isNumber(filter.limit) && 0 !== filter.limit) {
            sql += ` LIMIT ${filter.limit}`;
        }

        sql += ';';

        if ('count' === filter.resultType) {
            sysDb.get(sql, [filter.logName], (err, row) => {
                return cb(err, row ? row.count : 0);
            });
        } else {
            sysDb.all(sql, [filter.logName], (err, rows) => {
                return cb(err, rows);
            });
        }
    }
}

module.exports = new StatLog();
