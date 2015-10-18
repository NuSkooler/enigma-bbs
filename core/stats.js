/* jslint node: true */
'use strict';

var userDb			= require('./database.js').dbs.user;

exports.getUserLoginHistory		= getUserLoginHistory;

function getUserLoginHistory(numRequested, cb) {

	numRequested = Math.max(1, numRequested);

	var loginHistory = [];

	userDb.each(
		'SELECT user_id, user_name, timestamp '	+
		'FROM user_login_history '				+
		'ORDER BY timestamp DESC '				+
		'LIMIT ' + numRequested + ';',
		function historyRow(err, histEntry) {
			loginHistory.push( {
				userId		: histEntry.user_id,
				userName	: histEntry.user_name,
				timestamp	: histEntry.timestamp,
			} );
		},
		function complete(err, recCount) {
			cb(err, loginHistory);
		}
	);
}
