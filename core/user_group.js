/* jslint node: true */
'use strict';

var userDb			= require('./database.js').dbs.user;
var Config			= require('./config.js').config;

var async			= require('async');
var _				= require('lodash');

exports.getGroupsForUser	 	= getGroupsForUser;
exports.addUserToGroup			= addUserToGroup;
exports.addUserToGroups			= addUserToGroups;
exports.removeUserFromGroup		= removeUserFromGroup;

function getGroupsForUser(userId, cb) {
	var sql =
		'SELECT group_name '		+
		'FROM user_group_member '	+
		'WHERE user_id=?;';

	var groups = [];

	userDb.each(sql, [ userId ], function rowData(err, row) {
		if(err) {
			cb(err);
			return;
		} else {
			groups.push(row.group_name);
		}
	},
	function complete() {
		cb(null, groups);
	});
}

function addUserToGroup(userId, groupName, transOrDb, cb) {
	if(!_.isFunction(cb) && _.isFunction(transOrDb)) {
		cb = transOrDb;
		transOrDb = userDb;
	}

	transOrDb.run(
		'REPLACE INTO user_group_member (group_name, user_id) ' +
		'VALUES(?, ?);',
		[ groupName, userId ],
		function complete(err) {
			cb(err);
		}
	);
}

function addUserToGroups(userId, groups, transOrDb, cb) {

	async.each(groups, function item(groupName, next) {
		addUserToGroup(userId, groupName, transOrDb, next);
	}, function complete(err) {
		cb(err);
	});
}

function removeUserFromGroup(userId, groupName, cb) {
	userDb.run(
		'DELETE FROM user_group_member ' +
		'WHERE group_name=? AND user_id=?;', 
		[ groupName, userId ],
		function complete(err) {
			cb(err);
		}
	);
}
