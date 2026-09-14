'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — before requiring stat_log.js, which captures sysDb at load.
//
const configModule = require('../core/config.js');
configModule.get = () => ({ debug: { assertsEnabled: false } });

const dbModule = require('../core/database.js');
dbModule.dbs.system = new Database(':memory:');

delete require.cache[require.resolve('../core/stat_log.js')];
const StatLog = require('../core/stat_log.js');

const UserProps = require('../core/user_property.js');

//  Minimal user: updateUserUlDlRatio() only reads the two counters.
function makeUser(ulCount, dlCount) {
    const props = {
        [UserProps.FileUlTotalCount]: ulCount,
        [UserProps.FileDlTotalCount]: dlCount,
    };
    return {
        getPropertyAsNumber: name => Number(props[name]) || 0,
    };
}

//  Record what updateUserUlDlRatio() would persist, without touching the DB or
//  the event bus.
function captureWrites(fn) {
    const writes = [];
    const original = StatLog.setUserStat;
    StatLog.setUserStat = (user, statName, statValue, cb) => {
        writes.push({ statName, statValue });
        return cb ? cb(null) : undefined;
    };
    try {
        fn();
    } finally {
        StatLog.setUserStat = original;
    }
    return writes;
}

describe('StatLog.updateUserUlDlRatio()', () => {
    it('stores a 1:1 ratio as 100', () => {
        const writes = captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(10, 10)));
        assert.deepEqual(writes, [{ statName: UserProps.FileUlDlRatio, statValue: 100 }]);
    });

    it('stores 2:1 as 200 and 1:2 as 50', () => {
        assert.equal(
            captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(20, 10)))[0]
                .statValue,
            200
        );
        assert.equal(
            captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(10, 20)))[0]
                .statValue,
            50
        );
    });

    it('truncates rather than rounding, so a ratio is never flattered', () => {
        //  7/3 = 2.333... -> 233, not 234
        assert.equal(
            captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(7, 3)))[0].statValue,
            233
        );
    });

    it('writes nothing when the user has no downloads', () => {
        //  the division would be by zero
        assert.deepEqual(
            captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(5, 0))),
            []
        );
    });

    it('writes nothing when the user has no uploads', () => {
        assert.deepEqual(
            captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(0, 5))),
            []
        );
    });

    it('writes nothing for a user who has transferred neither way', () => {
        assert.deepEqual(
            captureWrites(() => StatLog.updateUserUlDlRatio(makeUser(0, 0))),
            []
        );
    });

    it('invokes the callback even when it writes nothing', () => {
        let called = false;
        captureWrites(() =>
            StatLog.updateUserUlDlRatio(makeUser(0, 5), () => {
                called = true;
            })
        );
        assert.ok(called, 'callback must run so transfer paths are not left hanging');
    });
});
