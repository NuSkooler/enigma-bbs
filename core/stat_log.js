/* jslint node: true */
'use strict';

const sysDb     = require('./database.js').dbs.system;
const {
    getISOTimestampString
}               = require('./database.js');

//  deps
const _         = require('lodash');

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
                if(row) {
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
            Forever : -1,
        };
    }

    get KeepType() {
        return {
            Forever : 'forever',
            Days    : 'days',
            Max     : 'max',
            Count   : 'max',
        };
    }

    get Order() {
        return {
            Timestamp       : 'timestamp_asc',
            TimestampAsc    : 'timestamp_asc',
            TimestampDesc   : 'timestamp_desc',
            Random          : 'random',
        };
    }

    setNonPersistentSystemStat(statName, statValue) {
        this.systemStats[statName] = statValue;
    }

    setSystemStat(statName, statValue, cb) {
        //  live stats
        this.systemStats[statName] = statValue;

        //  persisted stats
        sysDb.run(
            `REPLACE INTO system_stat (stat_name, stat_value)
            VALUES (?, ?);`,
            [ statName, statValue ],
            err => {
                //  cb optional - callers may fire & forget
                if(cb) {
                    return cb(err);
                }
            }
        );
    }

    getSystemStat(statName) { return this.systemStats[statName]; }

    getSystemStatNum(statName) {
        return parseInt(this.getSystemStat(statName)) || 0;
    }

    incrementSystemStat(statName, incrementBy, cb) {
        incrementBy = incrementBy || 1;

        let newValue = parseInt(this.systemStats[statName]);
        if(newValue) {
            if(!_.isNumber(newValue)) {
                return cb(new Error(`Value for ${statName} is not a number!`));
            }

            newValue += incrementBy;
        } else {
            newValue = incrementBy;
        }

        return this.setSystemStat(statName, newValue, cb);
    }

    //
    //  User specific stats
    //  These are simply convience methods to the user's properties
    //
    setUserStat(user, statName, statValue, cb) {
        //  note: cb is optional in PersistUserProperty
        return user.persistProperty(statName, statValue, cb);
    }

    getUserStat(user, statName) {
        return user.properties[statName];
    }

    getUserStatNum(user, statName) {
        return parseInt(this.getUserStat(user, statName)) || 0;
    }

    incrementUserStat(user, statName, incrementBy, cb) {
        incrementBy = incrementBy || 1;

        let newValue = parseInt(user.properties[statName]);
        if(newValue) {
            if(!_.isNumber(newValue)) {
                return cb(new Error(`Value for ${statName} is not a number!`));
            }

            newValue += incrementBy;
        } else {
            newValue = incrementBy;
        }

        return this.setUserStat(user, statName, newValue, cb);
    }

    //  the time "now" in the ISO format we use and love :)
    get now() {
        return getISOTimestampString();
    }

    appendSystemLogEntry(logName, logValue, keep, keepType, cb) {
        sysDb.run(
            `INSERT INTO system_event_log (timestamp, log_name, log_value)
            VALUES (?, ?, ?);`,
            [ this.now, logName, logValue ],
            () => {
                //
                //  Handle keep
                //
                if(-1 === keep) {
                    if(cb) {
                        return cb(null);
                    }
                    return;
                }

                switch(keepType) {
                    //  keep # of days
                    case 'days' :
                        sysDb.run(
                            `DELETE FROM system_event_log
                            WHERE log_name = ? AND timestamp <= DATETIME("now", "-${keep} day");`,
                            [ logName ],
                            err => {
                                //  cb optional - callers may fire & forget
                                if(cb) {
                                    return cb(err);
                                }
                            }
                        );
                        break;

                    case 'count':
                    case 'max' :
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
                            [ logName ],
                            err => {
                                if(cb) {
                                    return cb(err);
                                }
                            }
                        );
                        break;

                    case 'forever' :
                    default :
                        //  nop
                        break;
                }
            }
        );
    }

    getSystemLogEntries(logName, order, limit, cb) {
        let sql =
            `SELECT timestamp, log_value
            FROM system_event_log
            WHERE log_name = ?`;

        switch(order) {
            case 'timestamp' :
            case 'timestamp_asc' :
                sql += ' ORDER BY timestamp ASC';
                break;

            case 'timestamp_desc' :
                sql += ' ORDER BY timestamp DESC';
                break;

            case 'random'   :
                sql += ' ORDER BY RANDOM()';
        }

        if(!cb && _.isFunction(limit)) {
            cb      = limit;
            limit   = 0;
        } else {
            limit = limit || 0;
        }

        if(0 !== limit) {
            sql += ` LIMIT ${limit}`;
        }

        sql += ';';

        sysDb.all(sql, [ logName ], (err, rows) => {
            return cb(err, rows);
        });
    }

    appendUserLogEntry(user, logName, logValue, keepDays, cb) {
        sysDb.run(
            `INSERT INTO user_event_log (timestamp, user_id, session_id, log_name, log_value)
            VALUES (?, ?, ?, ?, ?);`,
            [ this.now, user.userId, user.sessionId, logName, logValue ],
            err => {
                if(err) {
                    if(cb) {
                        cb(err);
                    }
                    return;
                }
                //
                //  Handle keepDays
                //
                if(-1 === keepDays) {
                    if(cb) {
                        return cb(null);
                    }
                    return;
                }

                sysDb.run(
                    `DELETE FROM user_event_log
                    WHERE user_id = ? AND log_name = ? AND timestamp <= DATETIME("now", "-${keepDays} day");`,
                    [ user.userId, logName ],
                    err => {
                        //  cb optional - callers may fire & forget
                        if(cb) {
                            return cb(err);
                        }
                    }
                );
            }
        );
    }

    initUserEvents(cb) {
        //
        //  We map some user events directly to user stat log entries such that they
        //  are persisted for a time.
        //
        const Events = require('./events.js');
        const systemEvents = Events.getSystemEvents();

        const interestedEvents = [
            systemEvents.NewUser,
            systemEvents.UserUpload, systemEvents.UserDownload,
            systemEvents.UserPostMessage, systemEvents.UserSendMail,
            systemEvents.UserRunDoor,
        ];

        Events.addListenerMultipleEvents(interestedEvents, (eventName, event) => {
            this.appendUserLogEntry(
                event.user,
                'system_event',
                eventName.replace(/^codes\.l33t\.enigma\.system\./, ''),    //  strip package name prefix
                90
            );
        });

        return cb(null);
    }
}

module.exports = new StatLog();
