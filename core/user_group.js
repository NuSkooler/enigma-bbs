/* jslint node: true */
'use strict';

var userDb			= require('./database.js').dbs.user;
var Config			= require('./config.js').config;

var async			= require('async');
var _				= require('lodash');

exports.getGroupsForUser	 	= getGroupsForUser;
exports.getGroupsByName			= getGroupsByName;
exports.addUserToGroup			= addUserToGroup;
exports.addUserToGroups			= addUserToGroups;
exports.removeUserFromGroup		= removeUserFromGroup;


//
//	user_group
//	group_id	| group_name
//
//
//	user_group_member
//	group_id	| user_id
//	
//	


function getGroupsForUser(userId, cb) {
	var sql =
		'SELECT g.group_id, g.group_name ' +
		'FROM user_group g, user_group_member gm ' +
		'WHERE g.group_id = gm.group_id AND gm.user_id = ?;';

	var groups = {};	//	id:name

	userDb.each(sql, [ userId ], function dbRow(err, row) {
		if(err) {
			cb(err);
			return;
		} else {
			console.log(row);
			//groups[row.group_id]
		}
	},
	function complete() {
		cb(null, groups);
	});
}

function getGroupsByName(groupNames, cb) {
	var sql =
		'SELECT group_id, group_name ' +
		'FROM user_group ' +
		'WHERE group_name IN ("' + groupNames.join('","') + '");';

	userDb.all(sql, function allRows(err, rows) {
		if(err) {
			cb(err);
			return;
		} else {
			var groups = {};
			rows.forEach(function row(r) {
				groups[r.group_id] = r.group_name;
			});
			cb(null, groups);
		}
	});
}

function addUserToGroup(userId, groupId, cb) {
	userDb.run(
		'REPLACE INTO user_group_member (group_id, user_id) ' +
		'VALUES(?, ?);',
		[ groupId, userId ],
		function complete(err) {
			cb(err);
		}
	);
}

function addUserToGroups(userId, groups, cb) {
	async.each(Object.keys(groups), function item(groupId, nextItem) {
		addUserToGroup(userId, groupId, function added(err) {
			nextItem(err);
		});
	}, function complete(err) {
		cb(err);
	});
}

function removeUserFromGroup(userId, groupId, cb) {
	userDb.run(
		'DELETE FROM user_group_member ' +
		'WHERE group_id = ? AND user_id = ?;', 
		[ groupId, userId ],
		function complete(err) {
			cb(err);
		}
	);
}
