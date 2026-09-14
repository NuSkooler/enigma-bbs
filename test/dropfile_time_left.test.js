'use strict';

const { strict: assert } = require('assert');
const os = require('os');
const moment = require('moment');

const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS', language: 'en-US' },
    users: {},
};

const DropFile = require('../core/dropfile.js');
const UserProps = require('../core/user_property.js');
const ACS = require('../core/acs.js');

//
//  The documented ceiling, and the reason for it: 546 x 60 = 32760, which
//  fits a signed 16-bit integer. A door converting minutes to seconds
//  cannot overflow.
//
const Cap = 546;

//  DOOR.SYS is positional; these are the lines this file cares about
const DoorSys = { SecondsLeft: 18, MinutesLeft: 19, TimeCredits: 42 };
const Door32 = { MinutesLeft: 9 };
const DorInfo = { MinutesLeft: 12 };
const BbsDev = { Logoff: 11 };

function makeClient(props = {}) {
    const properties = Object.assign({ login_count: '5', location: 'Anywhere' }, props);

    const user = {
        userId: 1,
        username: 'testuser',
        groups: properties.__groups || ['users'],
        properties,
        getSanitizedName: which => ('real' === which ? 'Test User' : 'testuser'),
        getLegacySecurityLevel: () => 30,
        isSysOp: () => false,
        isRoot: () => true === properties.__root,
        isGroupMember(names) {
            if (!Array.isArray(names)) {
                names = [names];
            }
            return names.some(n => this.groups.includes(n));
        },
        isAuthenticated: () => true,
        getProperty: name => properties[name],
        getPropertyAsNumber: name => parseInt(properties[name], 10),
        persistProperty: (name, value) => {
            properties[name] = value;
        },
    };

    const client = {
        node: 1,
        term: {
            termHeight: 25,
            termWidth: 80,
            outputEncoding: 'cp437',
            ctermVersion: null,
        },
        user,
    };
    client.acs = new ACS({ client, user });
    return client;
}

function lines(fileType, client) {
    const dropFile = new DropFile(client, { fileType, baseDir: os.tmpdir() });
    const encoding = 'BBSDEV' === fileType ? 'utf8' : 'latin1';
    return dropFile.getContents().toString(encoding).split('\r\n');
}

const at = (fileType, client, n) => lines(fileType, client)[n - 1];

function budget(allowed, used) {
    TEST_CONFIG.users = { timeLimits: [{ minutesPerDay: allowed }] };
    return makeClient({
        [UserProps.TimeUsedTodayMinutes]: used,
        [UserProps.TimeUsedTodayDate]: moment().format('YYYY-MM-DD'),
    });
}

//  ---------------------------------------------------------------------------

describe('Drop files state the real time budget', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig(TEST_CONFIG);
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    afterEach(() => {
        TEST_CONFIG.users = {};
    });

    describe('DOOR.SYS', () => {
        it('writes the minutes actually remaining', () => {
            const client = budget(90, 30);
            assert.equal(at('DOOR', client, DoorSys.MinutesLeft), '60');
        });

        //  Synchronet clamps these two independently and they can disagree
        //  at the boundary; deriving one from the other means they cannot.
        it('derives the seconds from the same clamped minutes', () => {
            const client = budget(90, 30);
            const l = lines('DOOR', client);
            assert.equal(l[DoorSys.SecondsLeft - 1], '3600');
            assert.equal(
                parseInt(l[DoorSys.SecondsLeft - 1], 10),
                parseInt(l[DoorSys.MinutesLeft - 1], 10) * 60
            );
        });

        it('clamps at 546 minutes / 32760 seconds', () => {
            const client = budget(5000, 0);
            const l = lines('DOOR', client);
            assert.equal(l[DoorSys.MinutesLeft - 1], String(Cap));
            assert.equal(l[DoorSys.SecondsLeft - 1], String(Cap * 60));
        });

        //  546 is a cap, not a sentinel: unlimited hits the same ceiling as
        //  any other large number rather than being a special case
        it('clamps an unlimited user to the same ceiling', () => {
            const client = makeClient();
            const l = lines('DOOR', client);
            assert.equal(l[DoorSys.MinutesLeft - 1], String(Cap));
            assert.equal(l[DoorSys.SecondsLeft - 1], String(Cap * 60));
        });

        it('writes zero once the budget is spent', () => {
            const client = budget(60, 60);
            const l = lines('DOOR', client);
            assert.equal(l[DoorSys.MinutesLeft - 1], '0');
            assert.equal(l[DoorSys.SecondsLeft - 1], '0');
        });

        //  the GAP spec has doors read this back, and there is no bank
        it('claims no time credits', () => {
            assert.equal(at('DOOR', budget(90, 30), DoorSys.TimeCredits), '0');
        });
    });

    describe('DOOR32.SYS', () => {
        //  minutes per the Revision 1 spec, not seconds as current WWIV writes
        it('writes the minutes remaining, not the seconds', () => {
            assert.equal(at('DOOR32', budget(90, 30), Door32.MinutesLeft), '60');
        });

        it('clamps at 546', () => {
            assert.equal(at('DOOR32', budget(5000, 0), Door32.MinutesLeft), String(Cap));
            assert.equal(at('DOOR32', makeClient(), Door32.MinutesLeft), String(Cap));
        });
    });

    describe('DORINFO1.DEF', () => {
        it('writes the minutes remaining', () => {
            assert.equal(at('DORINFO', budget(90, 30), DorInfo.MinutesLeft), '60');
        });

        it('clamps at 546', () => {
            assert.equal(
                at('DORINFO', budget(5000, 0), DorInfo.MinutesLeft),
                String(Cap)
            );
            assert.equal(at('DORINFO', makeClient(), DorInfo.MinutesLeft), String(Cap));
        });
    });

    describe('BBSDEV.DRP', () => {
        it('states the deadline as an absolute UTC instant', () => {
            const client = budget(90, 30); //  60 minutes from now
            const value = at('BBSDEV', client, BbsDev.Logoff);
            assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

            const minutesAway = moment.utc(value).diff(moment.utc(), 'minutes');
            assert.ok(
                minutesAway >= 59 && minutesAway <= 60,
                `expected about 60 minutes away, got ${minutesAway}`
            );
        });

        //  a timestamp, not a 16-bit field, so nothing to overflow
        it('does not clamp the deadline', () => {
            const client = budget(5000, 0);
            const value = at('BBSDEV', client, BbsDev.Logoff);
            const minutesAway = moment.utc(value).diff(moment.utc(), 'minutes');
            assert.ok(minutesAway > Cap, `expected beyond the cap, got ${minutesAway}`);
        });

        it('omits the deadline for an exempt user', () => {
            TEST_CONFIG.users = { timeLimits: [{ minutesPerDay: 60 }] };
            const exempt = makeClient({ __groups: ['users', 'sysops'] });
            assert.equal(at('BBSDEV', exempt, BbsDev.Logoff), '');
        });

        it('omits the deadline on a board with no limits at all', () => {
            assert.equal(at('BBSDEV', makeClient(), BbsDev.Logoff), '');
        });
    });

    //  the exemption reaches the doors too
    it('tells a door nothing is metered for an exempt user', () => {
        TEST_CONFIG.users = { timeLimits: [{ minutesPerDay: 10 }] };
        const exempt = makeClient({ __groups: ['users', 'sysops'] });
        assert.equal(at('DOOR32', exempt, Door32.MinutesLeft), String(Cap));
    });
});
