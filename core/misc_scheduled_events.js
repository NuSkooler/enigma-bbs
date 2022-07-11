/* jslint node: true */
'use strict';

const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');

exports.dailyMaintenanceScheduledEvent = dailyMaintenanceScheduledEvent;

function dailyMaintenanceScheduledEvent(args, cb) {
    //
    //  Various stats need reset daily
    //
    [SysProps.LoginsToday, SysProps.MessagesToday].forEach(prop => {
        StatLog.setNonPersistentSystemStat(prop, 0);
    });

    return cb(null);
}
