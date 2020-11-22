
//  deps
const SysInfo = require('systeminformation');
const _ = require('lodash');

exports.getSystemInfoStats = getSystemInfoStats;

function getSystemInfoStats(cb) {
    const basicSysInfo = {
        mem         : 'total, free',
        currentLoad : 'avgload, currentLoad',
    };

    SysInfo.get(basicSysInfo)
        .then(sysInfo => {
            return cb(null, {
                totalMemoryBytes    : sysInfo.mem.total,
                freeMemoryBytes     : sysInfo.mem.free,

                //  Not avail on BSD, yet.
                systemAvgLoad       : _.get(sysInfo, 'currentLoad.avgload', 0),
                systemCurrentLoad   : _.get(sysInfo, 'currentLoad.currentLoad', 0),
            });
        })
        .catch(err => {
            return cb(err);
        });
}
