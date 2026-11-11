'use strict';

//
//  Themes bound to the session's terminal emulation (#593).
//
//  ANSI is the only emulation ENiGMA implements, so most of what is pinned
//  here is "an ANSI-only board behaves exactly as before". The non-ANSI paths
//  are driven with stand-in clients whose term reports a made-up emulation
//  name: nothing in core/theme.js checks that an emulation is implemented,
//  only that a theme and a session agree.
//

const { strict: assert } = require('assert');
const paths = require('path');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const UserProps = require('../core/user_property.js');

//  Late bound: required in before(), after the config below is in place
let theme;
let art;

const THEMES_DIR = '/themes';

let currentConfig;
function makeConfig(themeOverrides = {}) {
    return {
        debug: { assertsEnabled: false },
        menus: { cls: false },
        general: { boardName: 'Test Board' },
        paths: { themes: THEMES_DIR, art: '/art/general' },
        theme: Object.assign(
            {
                default: 'ansi_one',
                preLogin: 'ansi_one',
                passwordChar: '*',
                dateFormat: { short: 'MM/DD/YYYY' },
                timeFormat: { short: 'h:mm a' },
                dateTimeFormat: { short: 'MM/DD/YYYY h:mm a' },
            },
            themeOverrides
        ),
    };
}

//  A loaded theme as ThemeManager keeps it
function makeThemeConfig(themeId, info) {
    const raw = { info: Object.assign({ name: themeId, author: 'Tester' }, info) };
    const finalized = { info: Object.assign({}, raw.info, { themeId }) };
    return { getRaw: () => raw, get: () => finalized };
}

//
//  Installs a ThemeManager with |themes| ({ themeId: info }) without reading
//  anything from disk: ThemeManager.create() with init() stubbed out.
//  |rejected| are themes that loaded but are not available (disabled).
//
function installThemes(themes, rejected = {}) {
    const { ThemeManager } = theme;
    const realInit = ThemeManager.prototype.init;
    ThemeManager.prototype.init = function (cb) {
        Object.entries(themes).forEach(([themeId, info]) => {
            const themeConfig = makeThemeConfig(themeId, info);
            this.loadedThemeConfigs.set(themeId, themeConfig);
            this.availableThemes.set(themeId, themeConfig);
        });
        Object.entries(rejected).forEach(([themeId, info]) => {
            this.loadedThemeConfigs.set(themeId, makeThemeConfig(themeId, info));
        });
        return cb(null);
    };

    try {
        ThemeManager.create(err => assert.ifError(err));
    } finally {
        ThemeManager.prototype.init = realInit;
    }
}

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return quietLog;
    },
};

//  Enough of a Client: a term with an emulation, a user, a log and the
//  currentTheme accessor (core/client.js)
function makeClient({ emulation, themeId, noTerm } = {}) {
    const client = {
        log: quietLog,
        user: {
            properties: {},
            isAuthenticated: () => false,
        },
        currentThemeConfig: {
            get: () => ({ info: { name: 'N/A', description: 'None' } }),
        },
    };
    if (!noTerm) {
        client.term = emulation ? { emulation: { name: emulation } } : {};
    }
    if (undefined !== themeId) {
        client.user.properties[UserProps.ThemeId] = themeId;
    }
    Object.defineProperty(client, 'currentTheme', {
        get: () => client.currentThemeConfig.get(),
        set: tc => {
            client.currentThemeConfig = tc;
        },
    });
    return client;
}

const sessionThemeId = client => client.currentTheme.info.themeId;

//  Two ANSI themes (one implicit, one explicit) and two for a made-up emulation
const MIXED = {
    ansi_one: {},
    ansi_two: { emulation: 'ansi' },
    fake_one: { emulation: 'fakemu' },
    fake_two: { emulation: 'FakEmu ' }, //  case and whitespace do not matter
};

describe('Theme emulation binding (#593)', function () {
    let previousConfig;
    let realRandom;

    before(() => {
        currentConfig = makeConfig();
        previousConfig = configModule.get;
        configModule.get = () => currentConfig;
        theme = require('../core/theme.js');
        art = require('../core/art.js');
    });

    after(() => {
        configModule.get = previousConfig;
    });

    beforeEach(() => {
        currentConfig = makeConfig();
        realRandom = Math.random;
    });

    afterEach(() => {
        Math.random = realRandom;
    });

    describe('info.emulation', () => {
        it('is ansi when absent', () => {
            assert.equal(theme.getThemeEmulation({ info: { name: 'x' } }), 'ansi');
            assert.equal(theme.getThemeEmulation({}), 'ansi');
            assert.equal(theme.getThemeEmulation(undefined), 'ansi');
        });

        it('is ansi when empty or not a string', () => {
            assert.equal(theme.getThemeEmulation({ info: { emulation: '' } }), 'ansi');
            assert.equal(theme.getThemeEmulation({ info: { emulation: '  ' } }), 'ansi');
            assert.equal(theme.getThemeEmulation({ info: { emulation: 3 } }), 'ansi');
        });

        it('is the declared name, trimmed and lower-cased', () => {
            assert.equal(
                theme.getThemeEmulation({ info: { emulation: 'petscii' } }),
                'petscii'
            );
            assert.equal(
                theme.getThemeEmulation({ info: { emulation: ' PETSCII ' } }),
                'petscii'
            );
        });

        it('by id: available, disabled, and unknown themes', () => {
            installThemes(MIXED, { off_fake: { emulation: 'fakemu', enabled: false } });
            assert.equal(theme.getThemeEmulationById('ansi_one'), 'ansi');
            assert.equal(theme.getThemeEmulationById('fake_two'), 'fakemu');
            //  disabled: still answers from its theme.hjson
            assert.equal(theme.getThemeEmulationById('off_fake'), 'fakemu');
            //  names no theme: ANSI, as such an id always meant
            assert.equal(theme.getThemeEmulationById('no_such_theme'), 'ansi');
            assert.equal(theme.getThemeEmulationById(undefined), 'ansi');
            assert.equal(theme.getThemeEmulationById(''), 'ansi');
        });

        it('session emulation is ansi for a stand-in client without a term', () => {
            assert.equal(theme.getSessionEmulation(makeClient({ noTerm: true })), 'ansi');
            assert.equal(theme.getSessionEmulation(makeClient()), 'ansi');
            assert.equal(theme.getSessionEmulation(undefined), 'ansi');
            assert.equal(
                theme.getSessionEmulation(makeClient({ emulation: 'fakemu' })),
                'fakemu'
            );
        });

        it('lists themes for an emulation in load order', () => {
            installThemes(MIXED);
            assert.deepEqual(theme.getThemeIdsForEmulation('ansi'), [
                'ansi_one',
                'ansi_two',
            ]);
            assert.deepEqual(theme.getThemeIdsForEmulation('fakemu'), [
                'fake_one',
                'fake_two',
            ]);
            assert.deepEqual(theme.getThemeIdsForEmulation('nothing'), []);
        });
    });

    describe('settings', () => {
        it('with no theme.emulations, every emulation reads theme.<key>', () => {
            assert.equal(theme.getThemeSetting('ansi', 'preLogin'), 'ansi_one');
            assert.equal(theme.getThemeSetting('fakemu', 'preLogin'), 'ansi_one');
            assert.equal(theme.getThemeSetting('fakemu', 'default'), 'ansi_one');
        });

        it('theme.emulations.<name> overrides for that emulation only', () => {
            currentConfig = makeConfig({
                emulations: { fakemu: { preLogin: 'fake_two' } },
            });
            assert.equal(theme.getThemeSetting('fakemu', 'preLogin'), 'fake_two');
            assert.equal(theme.getThemeSetting('fakemu', 'default'), 'ansi_one');
            assert.equal(theme.getThemeSetting('ansi', 'preLogin'), 'ansi_one');
        });
    });

    describe('getRandomTheme()', () => {
        it('without an emulation picks among all themes, as before', () => {
            installThemes(MIXED);
            Math.random = () => 0.99;
            assert.equal(theme.getRandomTheme(), 'fake_two');
        });

        it('with an emulation picks among that emulation only', () => {
            installThemes(MIXED);
            Math.random = () => 0.99;
            assert.equal(theme.getRandomTheme('ansi'), 'ansi_two');
            assert.equal(theme.getRandomTheme('fakemu'), 'fake_two');
            Math.random = () => 0;
            assert.equal(theme.getRandomTheme('fakemu'), 'fake_one');
            assert.equal(theme.getRandomTheme('nothing'), undefined);
        });

        it('on an ANSI-only board, the emulation pick equals the old pick', () => {
            installThemes({ a: {}, b: {}, c: {} });
            //  what the code before emulations did, written out here
            const oldPick = r => {
                const themeIds = [...theme.getAvailableThemes().keys()];
                return themeIds[Math.floor(r * themeIds.length)];
            };
            const expected = { 0: 'a', 0.34: 'b', 0.5: 'b', 0.67: 'c', 0.99: 'c' };
            [0, 0.34, 0.5, 0.67, 0.99].forEach(r => {
                let calls = 0;
                Math.random = () => {
                    calls += 1;
                    return r;
                };
                const picked = theme.getRandomTheme('ansi');
                assert.equal(calls, 1, 'one Math.random() call per pick');
                assert.equal(picked, oldPick(r));
                assert.equal(picked, expected[r]);
            });
        });
    });

    describe('pre-login (LoginServerModule.prepareClient)', () => {
        let LoginServerModule;
        before(() => {
            LoginServerModule = require('../core/login_server_module.js');
        });

        const prepare = client =>
            new LoginServerModule().prepareClient(client, err => assert.ifError(err));

        it('ANSI: theme.preLogin, written to the user property as before', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({ preLogin: 'ansi_two' });
            const client = makeClient();
            prepare(client);
            assert.equal(client.user.properties[UserProps.ThemeId], 'ansi_two');
            assert.equal(sessionThemeId(client), 'ansi_two');
        });

        it('ANSI: "*" picks among ANSI themes only', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({ preLogin: '*' });
            Math.random = () => 0.99;
            const client = makeClient();
            prepare(client);
            assert.equal(client.user.properties[UserProps.ThemeId], 'ansi_two');
            assert.equal(sessionThemeId(client), 'ansi_two');
        });

        it('other emulation: its theme.emulations preLogin', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({
                emulations: { fakemu: { preLogin: 'fake_two' } },
            });
            const client = makeClient({ emulation: 'fakemu' });
            prepare(client);
            assert.equal(sessionThemeId(client), 'fake_two');
            //  ANSI callers on the same board are unaffected
            const ansiClient = makeClient();
            prepare(ansiClient);
            assert.equal(sessionThemeId(ansiClient), 'ansi_one');
        });

        it('other emulation: "*" picks among its own themes', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({ preLogin: '*' });
            Math.random = () => 0;
            const client = makeClient({ emulation: 'fakemu' });
            prepare(client);
            assert.equal(sessionThemeId(client), 'fake_one');
        });

        it('other emulation: an ANSI theme.preLogin is passed over for its default', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({
                emulations: { fakemu: { default: 'fake_two' } },
            });
            const client = makeClient({ emulation: 'fakemu' });
            prepare(client);
            assert.equal(sessionThemeId(client), 'fake_two');
        });

        it('other emulation: no setting at all gives its first theme', () => {
            installThemes(MIXED);
            const client = makeClient({ emulation: 'fakemu' });
            prepare(client);
            assert.equal(sessionThemeId(client), 'fake_one');
        });
    });

    describe('setClientTheme()', () => {
        it('ANSI: the requested theme, then theme.default, then the first theme', () => {
            installThemes({ a: {}, b: {}, c: {} });
            currentConfig = makeConfig({ default: 'b' });

            const client = makeClient();
            theme.setClientTheme(client, 'c');
            assert.equal(sessionThemeId(client), 'c');

            theme.setClientTheme(client, 'missing');
            assert.equal(sessionThemeId(client), 'b');

            currentConfig = makeConfig({ default: 'also_missing' });
            theme.setClientTheme(client, 'missing');
            assert.equal(sessionThemeId(client), 'a');
        });

        it('a saved theme for the session emulation is honoured', () => {
            installThemes(MIXED);
            const client = makeClient({ emulation: 'fakemu', themeId: 'fake_two' });
            theme.setClientTheme(client, client.user.properties[UserProps.ThemeId]);
            assert.equal(sessionThemeId(client), 'fake_two');
        });

        it('an incompatible saved theme falls back without rewriting the property', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({
                emulations: { fakemu: { default: 'fake_two' } },
            });

            //  ANSI theme saved, session is fakemu
            const client = makeClient({ emulation: 'fakemu', themeId: 'ansi_two' });
            const before = Object.assign({}, client.user.properties);
            theme.setClientTheme(client, client.user.properties[UserProps.ThemeId]);
            assert.equal(sessionThemeId(client), 'fake_two');
            assert.deepEqual(client.user.properties, before);

            //  and the other way round: fakemu theme saved, session is ANSI
            const ansiClient = makeClient({ themeId: 'fake_one' });
            theme.setClientTheme(ansiClient, 'fake_one');
            assert.equal(sessionThemeId(ansiClient), 'ansi_one');
            assert.equal(ansiClient.user.properties[UserProps.ThemeId], 'fake_one');
        });

        it('a configured default for another emulation is passed over', () => {
            installThemes(MIXED);
            currentConfig = makeConfig({
                emulations: { fakemu: { default: 'ansi_two' } },
            });
            const client = makeClient({ emulation: 'fakemu', themeId: 'ansi_one' });
            theme.setClientTheme(client, 'ansi_one');
            assert.equal(sessionThemeId(client), 'fake_one');
        });

        it('a disabled theme of another emulation counts as that emulation', () => {
            installThemes(MIXED, { off_fake: { emulation: 'fakemu' } });
            const client = makeClient({ themeId: 'off_fake' });
            theme.setClientTheme(client, 'off_fake');
            assert.equal(sessionThemeId(client), 'ansi_one');
        });

        it('no theme for the emulation: default theme, warned once', () => {
            installThemes({ ansi_one: {}, ansi_two: {} });
            currentConfig = makeConfig({ default: 'ansi_two' });

            const warnings = [];
            const realWarn = loggerModule.log.warn;
            loggerModule.log.warn = (...args) => warnings.push(args);
            try {
                const first = makeClient({ emulation: 'lonelyemu', themeId: 'ansi_one' });
                theme.setClientTheme(first, 'ansi_one');
                assert.equal(sessionThemeId(first), 'ansi_two');

                const second = makeClient({ emulation: 'lonelyemu' });
                theme.setClientTheme(second, undefined);
                assert.equal(sessionThemeId(second), 'ansi_two');

                //  no usable theme.default either: the first theme there is
                currentConfig = makeConfig({ default: 'missing' });
                const third = makeClient({ emulation: 'lonelyemu' });
                theme.setClientTheme(third, 'missing');
                assert.equal(sessionThemeId(third), 'ansi_one');
            } finally {
                loggerModule.log.warn = realWarn;
            }

            assert.equal(warnings.length, 1);
            assert.equal(warnings[0][0].emulation, 'lonelyemu');
        });
    });

    describe('getSessionThemeId()', () => {
        it('ANSI: always the user property, even one naming no theme', () => {
            installThemes(MIXED);
            const client = makeClient({ themeId: 'ansi_two' });
            theme.setClientTheme(client, 'ansi_two');
            assert.equal(theme.getSessionThemeId(client), 'ansi_two');

            //  a gone theme: the session falls back, art lookups still try it
            const gone = makeClient({ themeId: 'gone' });
            theme.setClientTheme(gone, 'gone');
            assert.equal(sessionThemeId(gone), 'ansi_one');
            assert.equal(theme.getSessionThemeId(gone), 'gone');

            assert.equal(theme.getSessionThemeId(makeClient()), undefined);
            assert.equal(theme.getSessionThemeId(makeClient({ themeId: '' })), '');
        });

        it('an incompatible property gives the session theme', () => {
            installThemes(MIXED);
            const client = makeClient({ emulation: 'fakemu', themeId: 'ansi_one' });
            theme.setClientTheme(client, 'ansi_one');
            assert.equal(theme.getSessionThemeId(client), 'fake_one');
        });
    });

    describe('getThemeArt()', () => {
        let realGetArt;
        let lookups;

        beforeEach(() => {
            lookups = [];
            realGetArt = art.getArt;
            //  miss everywhere but |hitIn|, recording where it looked
            art.getArt = (name, options, cb) => {
                lookups.push(options.basePath);
                if (options.basePath === art.__hitIn) {
                    return cb(null, { data: 'ART', basePath: options.basePath });
                }
                return cb(new Error('not found'));
            };
        });

        afterEach(() => {
            art.getArt = realGetArt;
            delete art.__hitIn;
        });

        const themeDir = id => paths.join(THEMES_DIR, id);

        it('ANSI: looks in the user property theme, then the default, then general', done => {
            installThemes(MIXED);
            const client = makeClient({ themeId: 'ansi_two' });
            theme.setClientTheme(client, 'ansi_two');
            theme.getThemeArt({ name: 'FOO', client }, () => {
                assert.deepEqual(lookups, [
                    themeDir('ansi_two'),
                    themeDir('ansi_one'),
                    '/art/general',
                ]);
                return done();
            });
        });

        it('ANSI: a theme id naming no theme is still looked in first, as before', done => {
            installThemes(MIXED);
            const client = makeClient({ themeId: 'gone' });
            theme.setClientTheme(client, 'gone');
            theme.getThemeArt({ name: 'FOO', client }, () => {
                assert.deepEqual(lookups, [
                    themeDir('gone'),
                    themeDir('ansi_one'),
                    '/art/general',
                ]);
                return done();
            });
        });

        it('no client, or no theme property: the default theme', done => {
            installThemes(MIXED);
            theme.getThemeArt({ name: 'FOO' }, () => {
                theme.getThemeArt({ name: 'FOO', client: makeClient() }, () => {
                    assert.deepEqual(lookups, [
                        themeDir('ansi_one'),
                        '/art/general',
                        themeDir('ansi_one'),
                        '/art/general',
                    ]);
                    return done();
                });
            });
        });

        it('an explicit themeId still wins', done => {
            installThemes(MIXED);
            const client = makeClient({ emulation: 'fakemu', themeId: 'ansi_two' });
            theme.setClientTheme(client, 'ansi_two');
            theme.getThemeArt({ name: 'FOO', client, themeId: 'ansi_two' }, () => {
                assert.equal(lookups[0], themeDir('ansi_two'));
                return done();
            });
        });

        it('incompatible saved theme: art comes from the session theme', done => {
            installThemes(MIXED);
            currentConfig = makeConfig({
                emulations: { fakemu: { default: 'fake_two' } },
            });
            const client = makeClient({ emulation: 'fakemu', themeId: 'ansi_two' });
            theme.setClientTheme(client, 'ansi_two');
            art.__hitIn = themeDir('fake_two');
            theme.getThemeArt({ name: 'FOO', client }, (err, artInfo) => {
                assert.ifError(err);
                assert.equal(artInfo.basePath, themeDir('fake_two'));
                assert.deepEqual(lookups, [themeDir('fake_two')]);
                return done();
            });
        });

        it("non-ANSI fallback is the emulation's default theme, not the ANSI one", done => {
            installThemes(MIXED);
            const client = makeClient({ emulation: 'fakemu', themeId: 'fake_two' });
            theme.setClientTheme(client, 'fake_two');
            theme.getThemeArt({ name: 'FOO', client }, () => {
                assert.deepEqual(lookups, [
                    themeDir('fake_two'),
                    themeDir('fake_one'),
                    '/art/general',
                ]);
                return done();
            });
        });
    });

    describe('theme selection in user config', () => {
        const ids = entries => entries.map(([themeId]) => themeId);

        it('ANSI-only board: every theme, in load order', () => {
            installThemes({ c: {}, a: {}, b: { emulation: 'ansi' } });
            assert.deepEqual(ids(theme.getSelectableThemes(makeClient())), [
                'c',
                'a',
                'b',
            ]);
        });

        it('only themes for the session emulation', () => {
            installThemes(MIXED);
            assert.deepEqual(ids(theme.getSelectableThemes(makeClient())), [
                'ansi_one',
                'ansi_two',
            ]);
            assert.deepEqual(
                ids(theme.getSelectableThemes(makeClient({ emulation: 'fakemu' }))),
                ['fake_one', 'fake_two']
            );
        });

        it('an emulation with no theme of its own is offered every theme, not none', () => {
            installThemes(MIXED);
            assert.deepEqual(
                ids(theme.getSelectableThemes(makeClient({ emulation: 'lonelyemu' }))),
                ['ansi_one', 'ansi_two', 'fake_one', 'fake_two']
            );
        });

        it('ANSI: the selection is always what gets saved', () => {
            installThemes(MIXED);
            const client = makeClient({ themeId: 'gone' });
            theme.setClientTheme(client, 'gone');
            //  session fell back to ansi_one; picking it saves it, as before
            assert.equal(theme.getThemeIdToPersist(client, 'ansi_one'), 'ansi_one');
            assert.equal(theme.getThemeIdToPersist(client, 'ansi_two'), 'ansi_two');
        });

        it('incompatible saved theme survives a save that kept the session theme', () => {
            installThemes(MIXED);
            const client = makeClient({ emulation: 'fakemu', themeId: 'ansi_two' });
            theme.setClientTheme(client, 'ansi_two');
            assert.equal(sessionThemeId(client), 'fake_one');
            //  list opens on the session theme...
            assert.equal(theme.getSessionThemeId(client), 'fake_one');
            //  ...saving it unchanged leaves the saved ANSI theme alone
            assert.equal(theme.getThemeIdToPersist(client, 'fake_one'), undefined);
            //  an actual choice is saved
            assert.equal(theme.getThemeIdToPersist(client, 'fake_two'), 'fake_two');
        });
    });
});
