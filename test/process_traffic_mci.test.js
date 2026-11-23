'use strict';

//
//  #1149: %PE (process bytes egress) showed the ingress count, and with the
//  traffic stat unset it read .ingress off a fallback that has only
//  .egress, so it threw (logged; nothing shown).
//

const { strict: assert } = require('assert');

describe('%PI / %PE process traffic MCI codes (#1149)', () => {
    let mci;
    let StatLog;
    let SysProps;
    let savedGet;
    let savedMciEntry;
    let stats;
    const mciPath = require.resolve('../core/predefined_mci.js');

    before(() => {
        //  a fresh predefined_mci.js, so it shares the StatLog cached now
        //  (other test files evict stat_log.js)
        savedMciEntry = require.cache[mciPath];
        delete require.cache[mciPath];
        mci = require('../core/predefined_mci.js');
        StatLog = require('../core/stat_log.js');
        SysProps = require('../core/system_property.js');

        savedGet = StatLog.getSystemStat;
        StatLog.getSystemStat = function (name) {
            if (name === SysProps.ProcessTrafficStats) {
                return stats;
            }
            return savedGet.apply(this, arguments);
        };
    });

    after(() => {
        StatLog.getSystemStat = savedGet;
        if (savedMciEntry) {
            require.cache[mciPath] = savedMciEntry;
        } else {
            delete require.cache[mciPath];
        }
    });

    const client = { user: { isAuthenticated: () => true }, term: {} };
    const value = code => mci.getPredefinedMCIValue(client, code);

    it('%PE shows the bytes sent, %PI the bytes received', () => {
        stats = { ingress: 1234, egress: 5678 };
        assert.equal(value('PI'), (1234).toLocaleString());
        assert.equal(value('PE'), (5678).toLocaleString());
    });

    it('with the stat unset, both show 0', () => {
        stats = undefined;
        assert.equal(value('PI'), '0');
        assert.equal(value('PE'), '0');
    });
});
