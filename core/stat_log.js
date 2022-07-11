/* jslint node: true */
'use strict';

const sysDb = require('./database.js').dbs.system;
const { getISOTimestampString } = require('./database.js');
const Errors = require('./enig_error.js');

//  deps
const _ = require('lodash');
const moment = require('moment');

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
        return this.systemStats[statName];
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
        return user.properties[statName];
    }

    getUserStatNum(user, statName) {
        return parseInt(this.getUserStat(user, statName)) || 0;
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

    /*
        Find System Log entries by |filter|:

        filter.logName (required)
        filter.resultType = (obj) | count
            where obj contains timestamp and log_value
        filter.limit
        filter.date - exact date to filter against
        filter.order = (timestamp) | timestamp_asc | timestamp_desc | random
    */
    findSystemLogEntries(filter, cb) {
        filter = filter || {};
        if (!_.isString(filter.logName)) {
            return cb(Errors.MissingParam('filter.logName is required'));
        }

        filter.resultType = filter.resultType || 'obj';
        filter.order = filter.order || 'timestamp';

        let sql;
        if ('count' === filter.resultType) {
            sql = `SELECT COUNT() AS count
                FROM system_event_log`;
        } else {
            sql = `SELECT timestamp, log_value
                FROM system_event_log`;
        }

        sql += ' WHERE log_name = ?';

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
}

module.exports = new StatLog();
