/* jslint node: true */
'use strict';

const UserProps = require('./user_property.js');
const Events = require('./events.js');
const StatLog = require('./stat_log.js');

const moment = require('moment');

exports.trackDoorRunBegin = trackDoorRunBegin;
exports.trackDoorRunEnd = trackDoorRunEnd;

function trackDoorRunBegin(client, doorTag) {
    const startTime = moment();
    return { startTime, client, doorTag };
}

function trackDoorRunEnd(trackInfo) {
    if (!trackInfo) {
        return;
    }

    const { startTime, client, doorTag } = trackInfo;

    const diff = moment.duration(moment().diff(startTime));
    if (diff.asSeconds() >= 45) {
        StatLog.incrementUserStat(client.user, UserProps.DoorRunTotalCount, 1);
    }

    const runTimeMinutes = Math.floor(diff.asMinutes());
    if (runTimeMinutes > 0) {
        StatLog.incrementUserStat(
            client.user,
            UserProps.DoorRunTotalMinutes,
            runTimeMinutes
        );

        const eventInfo = {
            runTimeMinutes,
            user: client.user,
            doorTag: doorTag || 'unknown',
        };

        Events.emit(Events.getSystemEvents().UserRunDoor, eventInfo);
    }
}
