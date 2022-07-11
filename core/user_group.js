/* jslint node: true */
'use strict';

const userDb = require('./database.js').dbs.user;

const async = require('async');
const _ = require('lodash');

exports.getGroupsForUser = getGroupsForUser;
exports.addUserToGroup = addUserToGroup;
exports.addUserToGroups = addUserToGroups;
exports.removeUserFromGroup = removeUserFromGroup;

function getGroupsForUser(userId, cb) {
    const sql = `SELECT group_name
        FROM user_group_member
        WHERE user_id=?;`;

    const groups = [];

    userDb.each(
        sql,
        [userId],
        (err, row) => {
            if (err) {
                return cb(err);
            }

            groups.push(row.group_name);
        },
        () => {
            return cb(null, groups);
        }
    );
}

function addUserToGroup(userId, groupName, transOrDb, cb) {
    if (!_.isFunction(cb) && _.isFunction(transOrDb)) {
        cb = transOrDb;
        transOrDb = userDb;
    }

    transOrDb.run(
        `REPLACE INTO user_group_member (group_name, user_id)
        VALUES(?, ?);`,
        [groupName, userId],
        err => {
            return cb(err);
        }
    );
}

function addUserToGroups(userId, groups, transOrDb, cb) {
    async.each(
        groups,
        (groupName, nextGroupName) => {
            return addUserToGroup(userId, groupName, transOrDb, nextGroupName);
        },
        err => {
            return cb(err);
        }
    );
}

function removeUserFromGroup(userId, groupName, cb) {
    userDb.run(
        `DELETE FROM user_group_member
        WHERE group_name=? AND user_id=?;`,
        [groupName, userId],
        err => {
            return cb(err);
        }
    );
}
