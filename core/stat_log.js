/* jslint node: true */
'use strict';

const sysDb		= require('./database.js').dbs.system;

//	deps
const _			= require('lodash');
const moment	= require('moment');

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
		//	Load previous state/values of |this.systemStats|
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

	setNonPeristentSystemStat(statName, statValue) {
		this.systemStats[statName] = statValue;
	}

	setSystemStat(statName, statValue, cb) {
		//	live stats
		this.systemStats[statName] = statValue;

		//	persisted stats
		sysDb.run(
			`REPLACE INTO system_stat (stat_name, stat_value)
			VALUES (?, ?);`,
			[ statName, statValue ],
			err => {
				//	cb optional - callers may fire & forget
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	getSystemStat(statName) { return this.systemStats[statName]; }

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
	//	User specific stats
	//	These are simply convience methods to the user's properties
	//
	setUserStat(user, statName, statValue, cb) {
		//	note: cb is optional in PersistUserProperty
		return user.persistProperty(statName, statValue, cb);
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

	//	the time "now" in the ISO format we use and love :)
	get now() { return moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ'); }

	appendSystemLogEntry(logName, logValue, keepDays, cb) {
		sysDb.run(
			`INSERT INTO system_event_log (timestamp, log_name, log_value)
			VALUES (?, ?, ?);`,
			[ this.now, logName, logValue ],
			() => {
				//
				//	Handle keepDays
				//
				sysDb.run(
					`DELETE FROM system_event_log
					WHERE log_name = ? AND timestamp <= DATETIME("now", "-${keepDays} day");`,
					[ logName ],
					err => {
						//	cb optional - callers may fire & forget
						if(cb) {
							return cb(err);
						}
					}
				);				
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
		case 'timestamp_desc' :
			sql += ' ORDER BY timestamp DESC';
		}

		if(!cb && _.isFunction(limit)) {
			cb		= limit;
			limit	= 0;
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
			`INSERT INTO user_event_log (timestamp, user_id, log_name, log_value)
			VALUES (?, ?, ?, ?);`,
			[ this.now, user.userId, logName, logValue ],
			() => {
				//
				//	Handle keepDays
				//
				sysDb.run(
					`DELETE FROM user_event_log
					WHERE user_id = ? AND log_name = ? AND timestamp <= DATETIME("now", "-${keepDays} day");`,
					[ user.userId, logName ],
					err => {
						//	cb optional - callers may fire & forget
						if(cb) {
							return cb(err);
						}
					}
				);
			}
		);
	}	
}

module.exports = new StatLog();
