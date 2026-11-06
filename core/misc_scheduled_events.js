/* jslint node: true */
'use strict';

//  stat_log.js is required where it is used: it captures database.js's
//  dbs.system when it loads.
const SysProps = require('./system_property.js');
const Events = require('./events.js');
//  logger.log is set by Log.init(); read it when used, not at load
const logger = require('./logger.js');

exports.dailyMaintenanceScheduledEvent = dailyMaintenanceScheduledEvent;
exports.tossInboundNowScheduledEvent = tossInboundNowScheduledEvent;
exports.exportOutboundNowScheduledEvent = exportOutboundNowScheduledEvent;
exports.binkpPullNowScheduledEvent = binkpPullNowScheduledEvent;
exports.requestBinkpPull = requestBinkpPull;

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

//
//  Ask the module listening for |event| to do its work now, and wait for it.
//  |cb(err, { ran, message })|: |ran| is false when nothing was done, either
//  because no module is listening (|notRunning| says which one) or because the
//  module said so (not configured, or a run already going). Doing nothing is
//  not an error: the log says why.
//
function requestModuleWork(event, { reason, notRunning }, cb) {
    if (0 === Events.listenerCount(event)) {
        logger.log.info({ event }, notRunning);
        return cb(null, { ran: false, message: notRunning });
    }

    //  one module listens; guard against a second all the same
    let called = false;
    Events.emit(event, {
        reason,
        callback: (err, outcome) => {
            if (called) {
                return;
            }
            called = true;
            return cb(err || null, outcome || { ran: true, message: 'Done' });
        },
    });
}

//
//  Ask the FTN BSO scanner/tosser to scan and export outbound mail now, as its
//  export schedule does. Finishes when the export does. An export already in
//  progress is not started twice.
//
function exportOutboundNowScheduledEvent(args, cb) {
    requestModuleWork(
        Events.getSystemEvents().ExportBSORequested,
        {
            reason: 'Scan/export requested by the exportOutboundNow task',
            notRunning: 'The FTN BSO scanner/tosser is not running; nothing to export',
        },
        err => cb(err)
    );
}

//
//  Ask the native BinkP mailer to run its pull cycle now: dial every node the
//  binkp.pullSchedule would, plus any with mail waiting. Finishes when every
//  call has ended. A pull cycle already in progress is not started twice, and
//  the per-node .bsy lock keeps any other session from dialing a node twice.
//
function binkpPullNowScheduledEvent(args, cb) {
    requestBinkpPull('BinkP pull cycle requested by the binkpPullNow task', err =>
        cb(err)
    );
}

function requestBinkpPull(reason, cb) {
    requestModuleWork(
        Events.getSystemEvents().BinkpPullRequested,
        {
            reason,
            notRunning: 'The BinkP mailer is not running; nothing to pull',
        },
        cb
    );
}
