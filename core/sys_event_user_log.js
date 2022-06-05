/* jslint node: true */
'use strict';

const Events = require('./events.js');
const LogNames = require('./user_log_name.js');

const DefaultKeepForDays = 365;

module.exports = function systemEventUserLogInit(statLog) {
    const systemEvents = Events.getSystemEvents();

    const interestedEvents = [
        systemEvents.NewUser,
        systemEvents.UserLogin,
        systemEvents.UserLogoff,
        systemEvents.UserUpload,
        systemEvents.UserDownload,
        systemEvents.UserPostMessage,
        systemEvents.UserSendMail,
        systemEvents.UserRunDoor,
        systemEvents.UserSendNodeMsg,
        systemEvents.UserAchievementEarned,
    ];

    const append = (e, n, v) => {
        statLog.appendUserLogEntry(e.user, n, v, DefaultKeepForDays);
    };

    Events.addMultipleEventListener(interestedEvents, (event, eventName) => {
        const detailHandler = {
            [systemEvents.NewUser]: e => {
                append(e, LogNames.NewUser, 1);
            },
            [systemEvents.UserLogin]: e => {
                append(e, LogNames.Login, 1);
            },
            [systemEvents.UserLogoff]: e => {
                append(e, LogNames.Logoff, e.minutesOnline);
            },
            [systemEvents.UserUpload]: e => {
                if (e.files.length) {
                    //  we can get here for dupe uploads
                    append(e, LogNames.UlFiles, e.files.length);
                    const totalBytes = e.files.reduce(
                        (bytes, fileEntry) => bytes + fileEntry.meta.byte_size,
                        0
                    );
                    append(e, LogNames.UlFileBytes, totalBytes);
                }
            },
            [systemEvents.UserDownload]: e => {
                if (e.files.length) {
                    append(e, LogNames.DlFiles, e.files.length);
                    const totalBytes = e.files.reduce(
                        (bytes, fileEntry) => bytes + fileEntry.byteSize,
                        0
                    );
                    append(e, LogNames.DlFileBytes, totalBytes);
                }
            },
            [systemEvents.UserPostMessage]: e => {
                append(e, LogNames.PostMessage, e.areaTag);
            },
            [systemEvents.UserSendMail]: e => {
                append(e, LogNames.SendMail, 1);
            },
            [systemEvents.UserRunDoor]: e => {
                append(e, LogNames.RunDoor, e.doorTag);
                append(e, LogNames.RunDoorMinutes, e.runTimeMinutes);
            },
            [systemEvents.UserSendNodeMsg]: e => {
                append(e, LogNames.SendNodeMsg, e.global ? 'global' : 'direct');
            },
            [systemEvents.UserAchievementEarned]: e => {
                append(e, LogNames.AchievementEarned, e.achievementTag);
                append(e, LogNames.AchievementPointsEarned, e.points);
            },
        }[eventName];

        if (detailHandler) {
            detailHandler(event);
        }
    });
};
