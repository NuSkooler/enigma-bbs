'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');

//
//  user_time.js reads config.js's |get| on every call rather than capturing
//  it, so a pushed test config reaches it however this file's modules were
//  loaded -- and they reach it by three different routes: acs_parser.js
//  require()s it from inside its parse function, predefined_mci.js captures
//  it at load, and this file requires it directly.
//
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS' },
    users: {},
};

const UserProps = require('../core/user_property.js');
const ACS = require('../core/acs.js');
const UserTime = require('../core/user_time.js');
const { getPredefinedMCIValue } = require('../core/predefined_mci.js');
const acsParser = require('../core/acs_parser.js');

//  ---------------------------------------------------------------------------

function makeUser(opts = {}) {
    const props = Object.assign({}, opts.properties);
    return {
        userId: opts.userId || 42,
        username: 'someuser',
        groups: opts.groups || ['users'],
        properties: props,
        isAuthenticated: () => false !== opts.authenticated,
        isRoot: () => true === opts.root,
        isGroupMember(names) {
            if (!Array.isArray(names)) {
                names = [names];
            }
            return names.some(n => this.groups.includes(n));
        },
        getProperty: name => props[name],
        getPropertyAsNumber: name => parseInt(props[name], 10),
        getAge: () => 25,
        persistProperty(name, value, cb) {
            props[name] = value;
            if (cb) {
                return cb(null, value);
            }
        },
    };
}

function makeClient(user) {
    const client = {
        user,
        node: 1,
        freeTimeDepth: 0,
        term: { termHeight: 25, termWidth: 80, termType: 'ansi' },
        currentTheme: { name: 'luciano_blocktronics' },
        isLocal: () => false,
        log: { warn() {}, info() {} },
    };
    client.acs = new ACS({ client, user });
    return client;
}

const today = () => moment().format('YYYY-MM-DD');

function usedToday(minutes) {
    return {
        [UserProps.TimeUsedTodayMinutes]: minutes,
        [UserProps.TimeUsedTodayDate]: today(),
    };
}

const setBands = bands => {
    TEST_CONFIG.users = { timeLimits: bands };
};

const checkAcs = (acs, client) =>
    acsParser.parse(acs, { subject: { client, user: client ? client.user : null } });

//  ---------------------------------------------------------------------------

describe('ML ACS code', () => {
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

    it('passes when nothing is configured', () => {
        const client = makeClient(makeUser());
        assert.equal(checkAcs('ML30', client), true);
        assert.equal(checkAcs('ML99999', client), true);
    });

    it('passes with no session at all -- NNTP, the web API', () => {
        setBands([{ minutesPerDay: 10 }]);
        assert.equal(
            acsParser.parse('ML30', { subject: { client: null, user: null } }),
            true
        );
    });

    it('passes for an exempt user even with a band configured', () => {
        setBands([{ minutesPerDay: 10 }]);
        const client = makeClient(
            makeUser({ groups: ['users', 'sysops'], properties: usedToday(9) })
        );
        assert.equal(checkAcs('ML30', client), true);
    });

    it('compares >=, like every other numeric ACS code', () => {
        setBands([{ minutesPerDay: 60 }]);
        const client = makeClient(makeUser({ properties: usedToday(30) })); //  30 left
        assert.equal(checkAcs('ML29', client), true);
        assert.equal(checkAcs('ML30', client), true);
        assert.equal(checkAcs('ML31', client), false);
    });

    it('fails once the budget is spent', () => {
        setBands([{ minutesPerDay: 60 }]);
        const client = makeClient(makeUser({ properties: usedToday(60) }));
        assert.equal(checkAcs('ML1', client), false);
    });

    it('honours the per-account override', () => {
        setBands([{ minutesPerDay: 60 }]);
        const client = makeClient(
            makeUser({
                properties: Object.assign(usedToday(30), {
                    [UserProps.TimeMinutesPerDay]: 300,
                }),
            })
        );
        assert.equal(checkAcs('ML200', client), true);
    });

    it('composes with the rest of the grammar', () => {
        setBands([{ minutesPerDay: 60 }]);
        const client = makeClient(makeUser({ properties: usedToday(55) })); //  5 left
        assert.equal(checkAcs('GM[users] & ML10', client), false);
        assert.equal(checkAcs('GM[users] & ML5', client), true);
        assert.equal(checkAcs('GM[nobody] | ML5', client), true);
        assert.equal(checkAcs('!ML10', client), true);
    });

    //
    //  A band whose acs contains ML is circular on its face, but ACS strings
    //  compose and the failure mode without the guard is a stack overflow
    //  that takes the board down rather than an error a sysop can see.
    //
    it('terminates on a band that refers back to ML', () => {
        setBands([{ acs: 'ML30', minutesPerDay: 60 }]);
        const client = makeClient(makeUser({ properties: usedToday(10) }));
        assert.equal(UserTime.getTimeLeftMinutes(client), 50);
        assert.equal(checkAcs('ML30', client), true);
    });
});

describe('TR / TA / TD MCI codes', () => {
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

    const mci = (code, client) => getPredefinedMCIValue(client, code);

    it('renders minutes when a band applies', () => {
        setBands([{ minutesPerDay: 90 }]);
        const client = makeClient(makeUser({ properties: usedToday(20) }));
        assert.equal(mci('TR', client), '70');
        assert.equal(mci('TA', client), '90');
        assert.equal(mci('TD', client), '20');
    });

    it('renders the unlimited text for TR and TA when nothing applies', () => {
        const client = makeClient(makeUser({ properties: usedToday(20) }));
        assert.equal(mci('TR', client), 'Unlimited');
        assert.equal(mci('TA', client), 'Unlimited');
    });

    it('honours users.unlimitedTimeText', () => {
        TEST_CONFIG.users = { timeLimits: [], unlimitedTimeText: 'No limit' };
        const client = makeClient(makeUser());
        assert.equal(mci('TR', client), 'No limit');
        assert.equal(mci('TA', client), 'No limit');
    });

    //  tracking runs even where nothing is enforced
    it('still reports TD as a real figure when unlimited', () => {
        const client = makeClient(makeUser({ properties: usedToday(41) }));
        assert.equal(mci('TD', client), '41');
    });

    it('reports TD as 0 for a user with no properties at all', () => {
        assert.equal(mci('TD', makeClient(makeUser())), '0');
    });

    it('renders the unlimited text for an exempt user', () => {
        setBands([{ minutesPerDay: 90 }]);
        const client = makeClient(makeUser({ groups: ['users', 'sysops'] }));
        assert.equal(mci('TR', client), 'Unlimited');
        assert.equal(mci('TA', client), 'Unlimited');
    });

    it('floors TR at zero rather than going negative', () => {
        setBands([{ minutesPerDay: 30 }]);
        const client = makeClient(makeUser({ properties: usedToday(99) }));
        assert.equal(mci('TR', client), '0');
    });
});
