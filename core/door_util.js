/* jslint node: true */
'use strict';

const UserProps     = require('./user_property.js');
const Events        = require('./events.js');
const StatLog       = require('./stat_log.js');

const moment        = require('moment');

exports.trackDoorRunBegin   = trackDoorRunBegin;
exports.trackDoorRunEnd     = trackDoorRunEnd;


function trackDoorRunBegin(client, doorTag) {
    const startTime = moment();

    //  door must be running for >= 45s for us to officially record it
    const timeout   = setTimeout( () => {
        StatLog.incrementUserStat(client.user, UserProps.DoorRunTotalCount, 1);

        const eventInfo = { user : client.user };
        if(doorTag) {
            eventInfo.doorTag = doorTag;
        }
        Events.emit(Events.getSystemEvents().UserRunDoor, eventInfo);
    }, 45 * 1000);

    return { startTime, timeout, client, doorTag };
}

function trackDoorRunEnd(trackInfo) {
    const { startTime, timeout, client } = trackInfo;

    clearTimeout(timeout);

    const endTime = moment();
    const runTimeMinutes = Math.floor(moment.duration(endTime.diff(startTime)).asMinutes());
    if(runTimeMinutes > 0) {
        StatLog.incrementUserStat(client.user, UserProps.DoorRunTotalMinutes, runTimeMinutes);
    }
}