'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');

//  The ACS parser + ACS class both use the logger. In test context it's
//  not initialized, so we install a no-op mock before loading anything.
const loggerModule = require('../core/logger.js');
if (!loggerModule.log) {
    loggerModule.log = { warn() {}, info() {}, debug() {}, trace() {}, error() {} };
}

//  The ACS parser embeds require() calls relative to core/, so we load it
//  from there. It calls Config() at parse time via the SE/AE checks, so
//  our test/setup.js must have installed the minimal config mock first.
const acsParser = require('../core/acs_parser.js');

//  ---------------------------------------------------------------------------
//  Test helpers: build mock user / client / subject objects
//  ---------------------------------------------------------------------------

function makeUser(overrides = {}) {
    //  Property names must match the values exported from user_property.js
    const props = Object.assign(
        {
            account_status: 0,
            login_count: 10,
            post_count: 5, //  MessagePostCount
            ul_total_count: 3, //  FileUlTotalCount
            dl_total_count: 6, //  FileDlTotalCount
            ul_total_bytes: 30000, //  FileUlTotalBytes
            dl_total_bytes: 60000, //  FileDlTotalBytes
            account_created: moment().subtract(90, 'days').format(),
            achievement_total_count: 4,
            achievement_total_points: 200,
            auth_factor2_otp: null, //  AuthFactor2OTP
        },
        overrides
    );

    return {
        userId: overrides.userId || 42,
        authFactor: overrides.authFactor || 1,
        groups: overrides.groups || ['users'],
        isGroupMember(name) {
            return this.groups.includes(name);
        },
        getAge() {
            return overrides.age || 25;
        },
        getProperty(name) {
            return props[name];
        },
        getPropertyAsNumber(name) {
            const v = props[name];
            return typeof v === 'number' ? v : parseInt(v, 10) || 0;
        },
    };
}

function makeClient(overrides = {}) {
    return {
        node: overrides.node || 1,
        session: { isSecure: overrides.isSecure || false },
        term: {
            termHeight: overrides.termHeight || 25,
            termWidth: overrides.termWidth || 80,
            termType: overrides.termType || 'ansi',
            outputEncoding: overrides.outputEncoding || 'cp437',
        },
        currentTheme: { name: overrides.themeName || 'luciano_blocktronics' },
        isLocal() {
            return !!overrides.isLocal;
        },
        log: {
            warn() {},
            info() {},
        },
    };
}

function parse(acs, userOverrides, clientOverrides) {
    const user = makeUser(userOverrides || {});
    const client = makeClient(clientOverrides || {});
    return acsParser.parse(acs, { subject: { client, user } });
}

function parseNoUser(acs, clientOverrides) {
    const client = makeClient(clientOverrides || {});
    return acsParser.parse(acs, { subject: { client, user: null } });
}

//  ===========================================================================
//  Parser syntax tests — verify the grammar handles all expression forms
//  ===========================================================================

describe('ACS Parser — Grammar', () => {
    describe('simple codes', () => {
        it('parses a group membership check', () => {
            assert.equal(parse('GM[users]'), true);
            assert.equal(parse('GM[sysops]'), false);
        });

        it('parses a numeric check', () => {
            assert.equal(parse('NC5'), true); //  loginCount=10 >= 5
            assert.equal(parse('NC99'), false);
        });

        it('parses a code with no argument', () => {
            assert.equal(parse('SC', {}, { isSecure: true }), true);
            assert.equal(parse('SC', {}, { isSecure: false }), false);
        });

        it('parses a list argument with multiple values', () => {
            assert.equal(parse('ID[42,99]'), true); //  userId=42
            assert.equal(parse('ID[1,2,3]'), false);
        });
    });

    describe('operators', () => {
        it('handles OR (|)', () => {
            assert.equal(parse('GM[sysops]|NC5'), true); //  false|true
            assert.equal(parse('GM[sysops]|NC99'), false); //  false|false
        });

        it('handles AND (&)', () => {
            assert.equal(parse('GM[users]&NC5'), true); //  true&true
            assert.equal(parse('GM[users]&NC99'), false); //  true&false
        });

        it('handles implicit AND (no operator)', () => {
            assert.equal(parse('GM[users]NC5'), true);
            assert.equal(parse('GM[users]NC99'), false);
        });

        it('handles NOT (!)', () => {
            assert.equal(parse('!GM[sysops]'), true); //  !false = true
            assert.equal(parse('!GM[users]'), false); //  !true = false
        });

        it('handles grouping with parentheses', () => {
            assert.equal(parse('(GM[sysops]|NC5)&GM[users]'), true);
            assert.equal(parse('(GM[sysops]|NC99)&GM[users]'), false);
        });

        it('handles NOT with grouping', () => {
            assert.equal(parse('!(GM[sysops]|NC99)'), true);
            assert.equal(parse('!(GM[users]|NC5)'), false);
        });

        it('handles complex nested expressions', () => {
            //  (true | false) & (!false) = true & true = true
            assert.equal(parse('(GM[users]|GM[sysops])&!NC99'), true);
        });
    });

    describe('whitespace tolerance', () => {
        it('allows spaces around OR', () => {
            assert.equal(parse('GM[sysops] | NC5'), true);
        });

        it('allows spaces around AND', () => {
            assert.equal(parse('GM[users] & NC5'), true);
        });

        it('allows spaces around implicit AND', () => {
            assert.equal(parse('GM[users] NC5'), true);
        });

        it('allows spaces around NOT', () => {
            assert.equal(parse('! GM[sysops]'), true);
        });

        it('allows spaces inside parentheses', () => {
            assert.equal(parse('( GM[users] | NC5 )'), true);
        });

        it('allows leading/trailing whitespace', () => {
            assert.equal(parse('  GM[users]  '), true);
        });

        it('allows spaces in list arguments', () => {
            assert.equal(parse('ID[42, 99]'), true);
            assert.equal(parse('GM[users , sysops]'), true);
        });
    });

    describe('edge cases', () => {
        it('throws on empty string', () => {
            assert.throws(() => acsParser.parse('', { subject: {} }));
        });

        it('throws on malformed ACS code', () => {
            assert.throws(() => parse('X'));
            assert.throws(() => parse('abc'));
        });

        it('handles unknown ACS code gracefully (returns false)', () => {
            //  Unknown codes like ZZ don't exist in checkAccess — the
            //  try/catch in checkAccess catches the TypeError and returns false.
            assert.equal(parse('ZZ5'), false);
        });

        it('parses a code with zero argument', () => {
            assert.equal(parse('NC0'), true); //  loginCount=10 >= 0
        });
    });
});

//  ===========================================================================
//  Individual ACS code check tests
//  ===========================================================================

describe('ACS Parser — Check Functions', () => {
    describe('GM (Group Membership)', () => {
        it('returns true when user is in the group', () => {
            assert.equal(parse('GM[users]'), true);
        });

        it('returns true for any matching group', () => {
            assert.equal(parse('GM[sysops,users]', { groups: ['users'] }), true);
        });

        it('returns false when user is not in any listed group', () => {
            assert.equal(parse('GM[sysops,elite]'), false);
        });

        it('returns false with no user', () => {
            assert.equal(parseNoUser('GM[users]'), false);
        });
    });

    describe('ID (User ID)', () => {
        it('matches the user ID', () => {
            assert.equal(parse('ID[42]', { userId: 42 }), true);
        });

        it('matches one of multiple IDs', () => {
            assert.equal(parse('ID[1,42,99]', { userId: 42 }), true);
        });

        it('does not match when ID is absent', () => {
            assert.equal(parse('ID[1,2,3]', { userId: 42 }), false);
        });
    });

    describe('NC (Number of Calls)', () => {
        it('passes when login count meets threshold', () => {
            assert.equal(parse('NC10', { login_count: 10 }), true);
            assert.equal(parse('NC5', { login_count: 10 }), true);
        });

        it('fails when login count is below threshold', () => {
            assert.equal(parse('NC20', { login_count: 10 }), false);
        });
    });

    describe('NP (Number of Posts)', () => {
        it('passes when post count meets threshold', () => {
            assert.equal(parse('NP5', { post_count: 5 }), true);
        });

        it('fails when below threshold', () => {
            assert.equal(parse('NP10', { post_count: 5 }), false);
        });
    });

    describe('SC (Secure Connection)', () => {
        it('returns true for secure connections', () => {
            assert.equal(parse('SC', {}, { isSecure: true }), true);
        });

        it('returns false for insecure connections', () => {
            assert.equal(parse('SC', {}, { isSecure: false }), false);
        });
    });

    describe('AA (Account Age)', () => {
        it('passes when account is old enough', () => {
            const created = moment().subtract(30, 'days').format();
            assert.equal(parse('AA30', { account_created: created }), true);
        });

        it('passes when account is older than required', () => {
            const created = moment().subtract(90, 'days').format();
            assert.equal(parse('AA30', { account_created: created }), true);
        });

        it('fails when account is too new', () => {
            const created = moment().subtract(5, 'days').format();
            assert.equal(parse('AA30', { account_created: created }), false);
        });

        it('fails when account was created today', () => {
            const created = moment().format();
            assert.equal(parse('AA1', { account_created: created }), false);
        });
    });

    describe('AC (Achievement Count) — regression', () => {
        it('passes when achievement count meets threshold', () => {
            assert.equal(parse('AC3', { achievement_total_count: 4 }), true);
        });

        it('fails when below threshold', () => {
            assert.equal(parse('AC10', { achievement_total_count: 4 }), false);
        });
    });

    describe('AP (Achievement Points) — regression', () => {
        it('passes when points meet threshold', () => {
            assert.equal(parse('AP100', { achievement_total_points: 200 }), true);
        });

        it('fails when below threshold', () => {
            assert.equal(parse('AP500', { achievement_total_points: 200 }), false);
        });
    });

    describe('EC (Encoding)', () => {
        it('detects CP437', () => {
            assert.equal(parse('EC0', {}, { outputEncoding: 'cp437' }), true);
            assert.equal(parse('EC1', {}, { outputEncoding: 'cp437' }), false);
        });

        it('detects UTF-8', () => {
            assert.equal(parse('EC1', {}, { outputEncoding: 'utf-8' }), true);
            assert.equal(parse('EC0', {}, { outputEncoding: 'utf-8' }), false);
        });
    });

    describe('TH / TW (Terminal Height/Width)', () => {
        it('checks terminal height', () => {
            assert.equal(parse('TH25', {}, { termHeight: 25 }), true);
            assert.equal(parse('TH50', {}, { termHeight: 25 }), false);
        });

        it('checks terminal width', () => {
            assert.equal(parse('TW80', {}, { termWidth: 80 }), true);
            assert.equal(parse('TW132', {}, { termWidth: 80 }), false);
        });
    });

    describe('NN (Node Number)', () => {
        it('matches single node', () => {
            assert.equal(parse('NN[1]', {}, { node: 1 }), true);
            assert.equal(parse('NN[2]', {}, { node: 1 }), false);
        });

        it('matches from a list of nodes', () => {
            assert.equal(parse('NN[1,2,3]', {}, { node: 2 }), true);
        });
    });

    describe('UP / DL / BU / BD (Upload/Download stats)', () => {
        it('checks upload count', () => {
            assert.equal(parse('UP3', { ul_total_count: 3 }), true);
            assert.equal(parse('UP10', { ul_total_count: 3 }), false);
        });

        it('checks download count', () => {
            assert.equal(parse('DL5', { dl_total_count: 6 }), true);
            assert.equal(parse('DL10', { dl_total_count: 6 }), false);
        });

        it('checks bytes uploaded', () => {
            assert.equal(parse('BU1000', { ul_total_bytes: 30000 }), true);
        });

        it('checks bytes downloaded', () => {
            assert.equal(parse('BD1000', { dl_total_bytes: 60000 }), true);
        });
    });

    describe('NR / KR / PC (Ratios)', () => {
        it('checks upload/download count ratio', () => {
            //  3 uploads / 6 downloads = 50%
            assert.equal(
                parse('NR50', {
                    ul_total_count: 3,
                    dl_total_count: 6,
                }),
                true
            );
            assert.equal(
                parse('NR80', {
                    ul_total_count: 3,
                    dl_total_count: 6,
                }),
                false
            );
        });

        it('checks post/call ratio', () => {
            //  5 posts / 10 calls = 50%
            assert.equal(parse('PC50', { post_count: 5, login_count: 10 }), true);
            assert.equal(parse('PC80', { post_count: 5, login_count: 10 }), false);
        });

        it('handles zero denominator in NR (no downloads)', () => {
            //  Division by zero yields ratio 0, not Infinity
            assert.equal(parse('NR1', { ul_total_count: 5, dl_total_count: 0 }), false);
        });

        it('handles zero denominator in KR (no download bytes)', () => {
            assert.equal(
                parse('KR1', { ul_total_bytes: 5000, dl_total_bytes: 0 }),
                false
            );
        });

        it('handles zero denominator in PC (no calls)', () => {
            assert.equal(parse('PC1', { post_count: 5, login_count: 0 }), false);
        });

        it('NR0 passes even with zero denominator (ratio 0 >= 0)', () => {
            assert.equal(parse('NR0', { ul_total_count: 0, dl_total_count: 0 }), true);
        });
    });

    describe('WD (Day of Week)', () => {
        it('matches the current day', () => {
            const today = new Date().getDay();
            assert.equal(parse(`WD[${today}]`), true);
        });

        it('fails on a different day', () => {
            const notToday = (new Date().getDay() + 3) % 7;
            assert.equal(parse(`WD[${notToday}]`), false);
        });
    });

    describe('LC (Local Connection)', () => {
        it('returns true for local clients', () => {
            assert.equal(parse('LC', {}, { isLocal: true }), true);
        });

        it('returns false for remote clients', () => {
            assert.equal(parse('LC', {}, { isLocal: false }), false);
        });
    });

    describe('SE (Services Enabled)', () => {
        //  SE requires a real Config() — test/setup.js provides a minimal one.
        //  Services aren't enabled in the minimal config, so all SE checks
        //  return false by default. We test case-insensitivity and unknown
        //  services here; integration tests with real config belong elsewhere.

        it('returns false for unknown services', () => {
            assert.equal(parse('SE[ftp]'), false);
        });

        it('is case-insensitive for service names', () => {
            //  Both should check the same path — and both fail because
            //  the minimal test config has no contentServers configured.
            assert.equal(parse('SE[HTTP]'), false);
            assert.equal(parse('SE[http]'), false);
        });
    });

    describe('PV (Property Value)', () => {
        it('matches a user property', () => {
            assert.equal(parse('PV[my_prop,hello]', { my_prop: 'hello' }), true);
        });

        it('fails on mismatch', () => {
            assert.equal(parse('PV[my_prop,world]', { my_prop: 'hello' }), false);
        });

        it('fails with no user', () => {
            assert.equal(parseNoUser('PV[my_prop,hello]'), false);
        });
    });

    describe('no user / no client', () => {
        it('group checks return false with no user', () => {
            assert.equal(parseNoUser('GM[users]'), false);
        });

        it('numeric checks return false with no user', () => {
            assert.equal(parseNoUser('NC5'), false);
        });

        it('SC returns false with no secure session', () => {
            assert.equal(parse('SC'), false);
        });
    });
});

//  ===========================================================================
//  ACS class integration tests
//  ===========================================================================

describe('ACS Class', () => {
    const ACS = require('../core/acs.js');

    function makeACS(userOverrides, clientOverrides) {
        const user = makeUser(userOverrides || {});
        const client = makeClient(clientOverrides || {});
        return new ACS({ client, user });
    }

    describe('check()', () => {
        it('resolves a scoped ACS string', () => {
            const acs = makeACS();
            assert.equal(
                acs.check({ read: 'GM[users]', write: 'GM[sysops]' }, 'read'),
                true
            );
            assert.equal(
                acs.check({ read: 'GM[users]', write: 'GM[sysops]' }, 'write'),
                false
            );
        });

        it('uses the default when scope is missing', () => {
            const acs = makeACS();
            assert.equal(acs.check({}, 'read', 'GM[users]'), true);
        });

        it('uses the default when acs object is null', () => {
            const acs = makeACS();
            assert.equal(acs.check(null, 'read', 'GM[users]'), true);
        });

        it('returns false on parse error', () => {
            const acs = makeACS();
            //  ACS.check catches SyntaxError and logs via Log.warn.
            //  Our subject.client has a .log mock, but the Log module
            //  might also be called. The test just verifies it doesn't throw.
            assert.equal(acs.check({ read: 'INVALID!!!' }, 'read'), false);
        });
    });

    describe('high-level area checks', () => {
        it('hasMessageConfRead uses default for missing acs', () => {
            const acs = makeACS();
            assert.equal(acs.hasMessageConfRead({}), true); //  default: GM[users]
        });

        it('hasFileAreaWrite uses sysops default', () => {
            const acs = makeACS();
            assert.equal(acs.hasFileAreaWrite({}), false); //  default: GM[sysops], user is in [users]
        });

        it('hasFileAreaWrite passes for sysop user', () => {
            const acs = makeACS({ groups: ['users', 'sysops'] });
            assert.equal(acs.hasFileAreaWrite({}), true);
        });
    });

    describe('hasMenuModuleAccess()', () => {
        it('returns true when no ACS is configured', () => {
            const acs = makeACS();
            assert.equal(acs.hasMenuModuleAccess({ menuConfig: { config: {} } }), true);
        });

        it('returns true when ACS passes', () => {
            const acs = makeACS();
            assert.equal(
                acs.hasMenuModuleAccess({
                    menuConfig: { config: { acs: 'GM[users]' } },
                }),
                true
            );
        });

        it('returns false when ACS fails', () => {
            const acs = makeACS();
            assert.equal(
                acs.hasMenuModuleAccess({
                    menuConfig: { config: { acs: 'GM[sysops]' } },
                }),
                false
            );
        });
    });

    describe('getConditionalValue()', () => {
        it('returns the value of the first matching condition', () => {
            const acs = makeACS();
            const result = acs.getConditionalValue(
                [
                    { acs: 'GM[sysops]', next: 'sysopMenu' },
                    { acs: 'GM[users]', next: 'userMenu' },
                    { next: 'guestMenu' },
                ],
                'next'
            );
            assert.equal(result, 'userMenu');
        });

        it('returns the fallback (no acs property) when nothing matches', () => {
            const acs = makeACS({ groups: [] });
            const result = acs.getConditionalValue(
                [
                    { acs: 'GM[sysops]', next: 'sysopMenu' },
                    { acs: 'GM[users]', next: 'userMenu' },
                    { next: 'guestMenu' },
                ],
                'next'
            );
            assert.equal(result, 'guestMenu');
        });

        it('returns undefined when nothing matches and no fallback', () => {
            const acs = makeACS({ groups: [] });
            const result = acs.getConditionalValue(
                [{ acs: 'GM[sysops]', next: 'sysopMenu' }],
                'next'
            );
            assert.equal(result, undefined);
        });

        it('passes through non-array values unchanged', () => {
            const acs = makeACS();
            assert.equal(acs.getConditionalValue('plainString', 'next'), 'plainString');
        });
    });
});
