/* jslint node: true */
'use strict';

const userDb = require('./database.js').dbs.user;

exports.getGroupsForUser = getGroupsForUser;
exports.addUserToGroup = addUserToGroup;
exports.addUserToGroups = addUserToGroups;
exports.removeUserFromGroup = removeUserFromGroup;

function getGroupsForUser(userId, cb) {
    try {
        const groups = [];
        for (const row of userDb
            .prepare(
                `SELECT group_name
                FROM user_group_member
                WHERE user_id=?;`
            )
            .iterate(userId)) {
            groups.push(row.group_name);
        }
        return cb(null, groups);
    } catch (err) {
        return cb(err);
    }
}

function addUserToGroup(userId, groupName, cb) {
    try {
        userDb
            .prepare(
                `REPLACE INTO user_group_member (group_name, user_id)
                VALUES(?, ?);`
            )
            .run(groupName, userId);
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

function addUserToGroups(userId, groups, cb) {
    try {
        const stmt = userDb.prepare(
            `REPLACE INTO user_group_member (group_name, user_id) VALUES(?, ?);`
        );
        for (const groupName of groups) {
            stmt.run(groupName, userId);
        }
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

function removeUserFromGroup(userId, groupName, cb) {
    try {
        userDb
            .prepare(
                `DELETE FROM user_group_member
                WHERE group_name=? AND user_id=?;`
            )
            .run(groupName, userId);
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}
