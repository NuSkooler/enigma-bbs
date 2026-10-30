/* jslint node: true */
'use strict';

//  stat_log.js is required where it is used: it captures database.js's
//  dbs.system when it loads.
const SysProps = require('./system_property.js');
const Events = require('./events.js');

exports.dailyMaintenanceScheduledEvent = dailyMaintenanceScheduledEvent;
exports.tossInboundNowScheduledEvent = tossInboundNowScheduledEvent;

function dailyMaintenanceScheduledEvent(args, cb) {
    //
    //  Various stats need reset daily
    //
    //  :TODO: files/etc. here
    const resetProps = [
        SysProps.LoginsToday,
        SysProps.MessagesToday,
        SysProps.NewUsersTodayCount,
    ];

    const StatLog = require('./stat_log.js');
    resetProps.forEach(prop => {
        StatLog.setNonPersistentSystemStat(prop, 0);
    });

    return cb(null);
}

//
//  Ask the FTN BSO scanner/tosser to import & toss its inbound directories
//  now, as a native BinkP session does when it receives files. Finishes as
//  soon as the request is made: the toss itself is logged by ftn_bso, and a
//  toss already in progress is not started twice.
//
function tossInboundNowScheduledEvent(args, cb) {
    const event = Events.getSystemEvents().NewInboundBSO;
    if (0 === Events.listenerCount(event)) {
        //  nothing would happen; say so rather than report success
        return cb(new Error('The FTN BSO scanner/tosser is not running'));
    }

    Events.emit(event, { reason: 'Import/toss requested by the tossInboundNow task' });
    return cb(null);
}
