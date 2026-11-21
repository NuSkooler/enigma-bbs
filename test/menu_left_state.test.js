'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

//
//  A menu that has been left stays left (#F2 lifecycle hooks):
//
//  *   leave() marks it (hasLeftMenu()); initSequence() stops after any
//      async step that finishes later -- no forms, no ticker timers, no
//      pause, no autoNext for a menu that is gone.
//  *   setMenuTimeout() timers (autoNext's nextTimeout, prevMenuOnTimeout())
//      are cleared by leave().
//  *   prepViewController() and friends stop quietly once it is left.
//
//  Real MenuStack, MenuModule and menu_util.loadMenu (the harness of
//  menu_stack_guards.test.js); only the module loader is stubbed.
//

let MenuStack;
let MenuModule;
let moduleUtil;
let originalLoadModuleEx;
let previousLog;
let previousConfig;
let loggerSwapped = false;
let configPushed = false;
let savedModules;

//
//  menu_util.js (and its neighbours) capture logger.log, and menu_module.js
//  config.js's get(), when they load. Run alone, this file would load them
//  before anything sets either up, and loadMenu()'s Log.trace() would throw
//  (#1122). Give them a silent logger with every level and a minimal config,
//  loading them fresh, and put everything back afterwards.
//
const FreshModules = [
    '../core/menu_util.js',
    '../core/menu_stack.js',
    '../core/menu_module.js',
].map(m => require.resolve(m));

const SilentLog = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].reduce(
    (log, level) => Object.assign(log, { [level]: () => {} }),
    { child: () => SilentLog }
);

//  name -> getModule class; set per test
let fakeModules = {};
let loadHook = null; //  (modLoadOpts, done) => void, to run something mid-load

function makeLog() {
    const entries = [];
    const log = {
        entries,
        child: () => log,
        level: () => 30, //  info: goto() skips its trace-only stack dump
    };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => {
            entries.push({ level, obj, msg });
        };
    });
    log.at = level => entries.filter(e => e.level === level);
    return log;
}

function makeClient(menus) {
    const client = new EventEmitter();
    client.clientEnded = false;
    client.lastActivityTime = 1000;
    client.currentTheme = { menus };
    client.log = makeLog();
    client.acs = {
        hasMenuModuleAccess: () => true,
        getConditionalValue: () => undefined,
    };
    client.interruptQueue = { hasItems: () => false };
    client.term = { rawWrite: () => {}, write: () => {} };
    client.defaultHandlerMissingMod = () => {
        return err => {
            throw new Error(`default handler reached: ${err.message}`);
        };
    };
    client.menuStack = new MenuStack(client);
    Object.defineProperty(client, 'currentMenuModule', {
        get: () => client.menuStack.currentModule,
    });
    return client;
}

//  a menu's flow runs through async.waterfall; let it all play out
function settle(cb) {
    let n = 0;
    const spin = () => (++n < 20 ? setImmediate(spin) : cb());
    setImmediate(spin);
}

//  counts per menu name, so tests can see what was created / entered / left
function makeCounters() {
    return { created: {}, entered: {}, left: {} };
}

function bump(map, name) {
    map[name] = (map[name] || 0) + 1;
}

//
//  A menu with no art. |fails| makes its init sequence fail (as LastCallers
//  does with no art: an error from mciReady). |maxInstances| stops a runaway
//  loop from hanging the test if the guard does not work.
//
function defineMenu(counters, name, { fails = false } = {}) {
    return class extends MenuModule {
        constructor(options) {
            super(options);
            bump(counters.created, name);
            if (counters.created[name] > 50) {
                throw new Error(`runaway: ${name} created over 50 times`);
            }
        }

        enter() {
            bump(counters.entered, name);
            return super.enter();
        }

        leave() {
            bump(counters.left, name);
            return super.leave();
        }

        mciReady(mciData, cb) {
            if (fails) {
                return cb(new Error(`${name} cannot load`));
            }
            return cb(null);
        }
    };
}

function menuConfig(module, extra = {}) {
    return Object.assign({ module }, extra);
}

describe('MenuModule left state', function () {
    before(() => {
        const loggerModule = require('../core/logger.js');
        previousLog = loggerModule.log;
        loggerModule.log = SilentLog;
        loggerSwapped = true;

        //  MenuModule reads Config() as it is built; push a minimal one
        previousConfig = require('../core/config.js')._pushTestConfig({
            menus: {},
            general: {},
            debug: { assertsEnabled: false },
        });
        configPushed = true;

        savedModules = FreshModules.map(path => [path, require.cache[path]]);
        FreshModules.forEach(path => delete require.cache[path]);

        //  required lazily: these capture Config at first require
        MenuStack = require('../core/menu_stack.js');
        MenuModule = require('../core/menu_module.js').MenuModule;
        moduleUtil = require('../core/module_util.js');

        originalLoadModuleEx = moduleUtil.loadModuleEx;
        moduleUtil.loadModuleEx = (opts, cb) => {
            const getModule = fakeModules[opts.name];
            const done = () => {
                if (!getModule) {
                    return cb(new Error(`no fake module ${opts.name}`));
                }
                return cb(null, { getModule, modInfo: { name: opts.name } });
            };
            if (loadHook) {
                return loadHook(opts, done);
            }
            return done();
        };
    });

    //  undoes whatever before() got to, even if it threw part-way, so a
    //  failure here never leaves the test logger or config behind for the
    //  rest of the run
    after(() => {
        try {
            if (moduleUtil && originalLoadModuleEx) {
                moduleUtil.loadModuleEx = originalLoadModuleEx;
            }
            (savedModules || []).forEach(([path, cached]) => {
                if (cached) {
                    require.cache[path] = cached;
                } else {
                    delete require.cache[path];
                }
            });
        } finally {
            if (configPushed) {
                require('../core/config.js')._popTestConfig(previousConfig);
                configPushed = false;
            }
            //  previousLog may legitimately be undefined (nothing set the
            //  logger up yet): put back exactly what was there
            if (loggerSwapped) {
                require('../core/logger.js').log = previousLog;
                loggerSwapped = false;
            }
        }
    });

    beforeEach(() => {
        fakeModules = {};
        loadHook = null;
    });

    //  Interval and timeout timers that tests fire or count by hand
    let timers;
    function captureTimers() {
        const intervals = new Map();
        const timeouts = new Map();
        let nextId = 1;
        const saved = {
            setInterval: global.setInterval,
            clearInterval: global.clearInterval,
            setTimeout: global.setTimeout,
            clearTimeout: global.clearTimeout,
        };
        global.setInterval = fn => {
            const id = nextId++;
            intervals.set(id, fn);
            return id;
        };
        global.clearInterval = id => intervals.delete(id);
        //  only the menu's own timeouts are held: async and mocha use
        //  setImmediate / their own saved timers
        global.setTimeout = (fn, ms) => {
            const id = { id: nextId++, ms };
            timeouts.set(id, fn);
            return id;
        };
        global.clearTimeout = id => timeouts.delete(id);
        return {
            intervals,
            timeouts,
            fireTimeouts() {
                [...timeouts.entries()].forEach(([id, fn]) => {
                    timeouts.delete(id);
                    fn();
                });
            },
            restore() {
                Object.assign(global, saved);
            },
        };
    }

    afterEach(() => {
        if (timers) {
            timers.restore();
            timers = null;
        }
    });

    function giveTerm(client) {
        Object.assign(client.term, {
            termWidth: 80,
            termHeight: 25,
            beginWrite() {},
            commitWrite() {},
        });
    }

    //
    //  A menu with art whose load the test finishes by hand (pendingArt),
    //  and whose mciReady() builds a form holding a ticker, as a menu with
    //  %TK in its art does.
    //
    function defineArtMenu(counters, name, state) {
        const Base = defineMenu(counters, name);
        return class extends Base {
            displayAsset(art, options, cb) {
                state.pendingArt = () => cb(null, { mciMap: {}, height: 10 });
            }

            mciReady(mciData, cb) {
                state.mciReady = (state.mciReady || 0) + 1;
                const { ViewController } = require('../core/view_controller.js');
                const { TickerView } = require('../core/ticker_view.js');
                const vc = this.addViewController(
                    'menu',
                    new ViewController({ client: this.client })
                );
                vc.addView(
                    new TickerView({
                        client: this.client,
                        id: 1,
                        position: { row: 2, col: 1 },
                        dimens: { width: 20, height: 1 },
                        text: 'news of the day',
                    })
                );
                return cb(null);
            }
        };
    }

    describe('leave() during an async step of initSequence()', () => {
        it('the art finishing after leave() builds no form and starts no ticker', done => {
            timers = captureTimers();
            const counters = makeCounters();
            const state = {};
            fakeModules.art = defineArtMenu(counters, 'art', state);
            fakeModules.away = defineMenu(counters, 'away');
            const client = makeClient({
                art: menuConfig('art', { art: 'SOMEART' }),
                away: menuConfig('away'),
            });
            giveTerm(client);

            client.menuStack.goto('art', err => {
                assert.ifError(err);
                settle(() => {
                    assert.ok(state.pendingArt, 'the art is loading');
                    const artMenu = client.currentMenuModule;
                    assert.equal(artMenu.hasLeftMenu(), false);

                    client.menuStack.goto('away', err => {
                        assert.ifError(err);
                        assert.equal(artMenu.hasLeftMenu(), true);

                        state.pendingArt(); //  the art arrives late
                        settle(() => {
                            assert.equal(state.mciReady, undefined, 'no mciReady');
                            assert.deepEqual(artMenu.viewControllers, {});
                            assert.equal(timers.intervals.size, 0, 'no ticker timer');
                            assert.equal(counters.left.art, 1);
                            assert.equal(client.currentMenuModule.menuName, 'away');
                            //  stopped quietly: a debug note, no warning
                            assert.equal(client.log.at('warn').length, 0);
                            assert.ok(
                                client.log
                                    .at('debug')
                                    .some(e => e.msg === 'Menu was left; not continuing')
                            );
                            return done();
                        });
                    });
                });
            });
        });

        it('a menu not left loads as before: form, ticker timer, initSucceeded', done => {
            timers = captureTimers();
            const counters = makeCounters();
            const state = {};
            fakeModules.art = defineArtMenu(counters, 'art', state);
            const client = makeClient({ art: menuConfig('art', { art: 'SOMEART' }) });
            giveTerm(client);

            client.menuStack.goto('art', err => {
                assert.ifError(err);
                settle(() => {
                    state.pendingArt();
                    settle(() => {
                        const artMenu = client.currentMenuModule;
                        assert.equal(state.mciReady, 1);
                        assert.ok(artMenu.viewControllers.menu);
                        assert.equal(timers.intervals.size, 1);
                        artMenu.leave();
                        assert.equal(timers.intervals.size, 0, 'leave() stops it');
                        return done();
                    });
                });
            });
        });

        it('forms built by an mciReady() that finishes after leave() are torn down', done => {
            timers = captureTimers();
            const counters = makeCounters();
            const state = {};
            const Base = defineArtMenu(counters, 'slow', state);
            fakeModules.slow = class extends Base {
                displayAsset(art, options, cb) {
                    return cb(null, { mciMap: {}, height: 10 });
                }
                mciReady(mciData, cb) {
                    //  leaves during its own async work, then builds anyway
                    state.finishMciReady = () => super.mciReady(mciData, cb);
                }
            };
            fakeModules.away = defineMenu(counters, 'away');
            const client = makeClient({
                slow: menuConfig('slow', { art: 'SOMEART', config: { pause: true } }),
                away: menuConfig('away'),
            });
            giveTerm(client);

            client.menuStack.goto('slow', err => {
                assert.ifError(err);
                settle(() => {
                    const slow = client.currentMenuModule;
                    client.menuStack.goto('away', err => {
                        assert.ifError(err);
                        state.finishMciReady();
                        settle(() => {
                            assert.equal(state.mciReady, 1);
                            assert.equal(timers.intervals.size, 0, 'ticker stopped');
                            const ticker = slow.viewControllers.menu.getView(1);
                            const { View } = require('../core/view.js');
                            assert.ok(View.isDestroyed(ticker));
                            return done();
                        });
                    });
                });
            });
        });
    });

    describe('setMenuTimeout()', () => {
        it("autoNext's nextTimeout does not fire once the menu has been left", done => {
            timers = captureTimers();
            const counters = makeCounters();
            fakeModules.wait = defineMenu(counters, 'wait');
            fakeModules.later = defineMenu(counters, 'later');
            fakeModules.elsewhere = defineMenu(counters, 'elsewhere');
            const client = makeClient({
                wait: menuConfig('wait', {
                    next: 'later',
                    runtime: { autoNext: true },
                    config: { nextTimeout: 1500 },
                }),
                later: menuConfig('later'),
                elsewhere: menuConfig('elsewhere'),
            });

            client.menuStack.goto('wait', err => {
                assert.ifError(err);
                settle(() => {
                    assert.equal(timers.timeouts.size, 1, 'nextTimeout pending');
                    assert.equal([...timers.timeouts.keys()][0].ms, 1500);

                    client.menuStack.goto('elsewhere', err => {
                        assert.ifError(err);
                        assert.equal(timers.timeouts.size, 0, 'cleared by leave()');
                        timers.fireTimeouts();
                        settle(() => {
                            assert.equal(counters.created.later, undefined);
                            assert.equal(client.currentMenuModule.menuName, 'elsewhere');
                            return done();
                        });
                    });
                });
            });
        });

        it("autoNext's nextTimeout still moves on when the menu is not left", done => {
            timers = captureTimers();
            const counters = makeCounters();
            fakeModules.wait = defineMenu(counters, 'wait');
            fakeModules.later = defineMenu(counters, 'later');
            const client = makeClient({
                wait: menuConfig('wait', {
                    next: 'later',
                    runtime: { autoNext: true },
                    config: { nextTimeout: 1500 },
                }),
                later: menuConfig('later'),
            });

            client.menuStack.goto('wait', err => {
                assert.ifError(err);
                settle(() => {
                    timers.fireTimeouts();
                    settle(() => {
                        assert.equal(client.currentMenuModule.menuName, 'later');
                        return done();
                    });
                });
            });
        });

        it('prevMenuOnTimeout() does nothing once the menu has been left', done => {
            timers = captureTimers();
            const counters = makeCounters();
            fakeModules.home = defineMenu(counters, 'home');
            fakeModules.list = defineMenu(counters, 'list');
            fakeModules.other = defineMenu(counters, 'other');
            const client = makeClient({
                home: menuConfig('home'),
                list: menuConfig('list'),
                other: menuConfig('other'),
            });

            client.menuStack.goto('home', () => {
                client.menuStack.goto('list', () => {
                    settle(() => {
                        const list = client.currentMenuModule;
                        let called = 0;
                        list.prevMenuOnTimeout(1000, () => ++called);
                        assert.equal(timers.timeouts.size, 1);

                        client.menuStack.goto('other', () => {
                            timers.fireTimeouts();
                            settle(() => {
                                assert.equal(called, 0);
                                assert.equal(client.currentMenuModule.menuName, 'other');
                                assert.equal(
                                    counters.created.home,
                                    1,
                                    'home not re-entered'
                                );
                                return done();
                            });
                        });
                    });
                });
            });
        });

        it('clearMenuTimeout() cancels one; a timeout that fires is forgotten', () => {
            timers = captureTimers();
            const counters = makeCounters();
            const Menu = defineMenu(counters, 'm');
            const client = makeClient({ m: menuConfig('m') });
            const menu = new Menu({
                menuName: 'm',
                menuConfig: { config: {} },
                client,
            });
            let a = 0;
            let b = 0;
            const ha = menu.setMenuTimeout(() => ++a, 10);
            menu.setMenuTimeout(() => ++b, 20);
            menu.clearMenuTimeout(ha);
            assert.equal(timers.timeouts.size, 1);
            timers.fireTimeouts();
            assert.equal(a, 0);
            assert.equal(b, 1);
            menu.leave(); //  nothing left to clear; does not throw
            assert.equal(menu.hasLeftMenu(), true);
        });
    });

    //
    //  The prep helpers once the menu has been left: they call back with
    //  the arguments they always have (a mod's cleanup still runs), but a
    //  form built or refocused for the left menu is torn down first: no
    //  key listener, views destroyed, no ticker timer.
    //
    describe('prep helpers once the menu has been left', () => {
        let restore = [];
        afterEach(() => {
            restore.reverse().forEach(fn => fn());
            restore = [];
        });

        //  art the test finishes by hand; forms that hold a ticker
        function setup() {
            timers = captureTimers();
            const counters = makeCounters();
            const Menu = defineMenu(counters, 'm');
            const client = makeClient({ m: menuConfig('m') });
            giveTerm(client);
            const menu = new Menu({
                menuName: 'm',
                menuConfig: { config: { art: { main: 'MAIN' } } },
                client,
            });
            const pending = [];
            const artInfo = { mciMap: {}, height: 1 };
            menu.displayAsset = (art, options, cb) => pending.push(cb);

            const theme = require('../core/theme.js');
            const { ViewController } = require('../core/view_controller.js');
            const { TickerView } = require('../core/ticker_view.js');
            const savedDisplay = theme.displayThemedAsset;
            const savedLoad = ViewController.prototype.loadFromMenuConfig;
            theme.displayThemedAsset = (art, c, options, cb) => pending.push(cb);
            ViewController.prototype.loadFromMenuConfig = function (opts, cb) {
                this.addView(
                    new TickerView({
                        client: this.client,
                        id: 1,
                        position: { row: 2, col: 1 },
                        dimens: { width: 20, height: 1 },
                        text: 'news of the day',
                    })
                );
                return cb(null);
            };
            restore.push(() => {
                theme.displayThemedAsset = savedDisplay;
                ViewController.prototype.loadFromMenuConfig = savedLoad;
            });

            const finishArt = () => pending.splice(0).forEach(cb => cb(null, artInfo));
            return { client, menu, pending, artInfo, finishArt };
        }

        function assertTornDown(client, vc) {
            const { View } = require('../core/view.js');
            assert.equal(vc.attached, false, 'keys detached');
            assert.equal(client.listenerCount('key press'), 0, 'no key listener');
            Object.values(vc.views).forEach(v => assert.ok(View.isDestroyed(v)));
            assert.equal(timers.intervals.size, 0, 'no ticker timer');
        }

        it('prepViewControllerWithArt(): calls back (err, vc, true) with the form torn down', () => {
            const { client, menu, pending, finishArt } = setup();
            const calls = [];
            menu.prepViewControllerWithArt('main', 0, {}, (...args) => calls.push(args));
            assert.equal(pending.length, 1);

            menu.leave();
            finishArt();

            assert.equal(calls.length, 1, 'called back, as before');
            const [err, vc, created] = calls[0];
            assert.ifError(err);
            assert.equal(vc, menu.viewControllers.main);
            assert.equal(created, true);
            assertTornDown(client, vc);
        });

        it('prepViewControllerWithArt(): an art error after leave() is called back as before', () => {
            const { menu, pending } = setup();
            const calls = [];
            menu.prepViewControllerWithArt('main', 0, {}, (...args) => calls.push(args));
            menu.leave();
            const error = new Error('no art');
            pending.splice(0).forEach(cb => cb(error));
            assert.deepEqual(calls, [[error]]);
            assert.deepEqual(menu.viewControllers, {});
        });

        it('displayArtAndPrepViewController(): calls back (err) with the form torn down', done => {
            const { client, menu, pending, finishArt } = setup();
            menu.displayArtAndPrepViewController('main', 0, {}, (...args) => {
                assert.equal(args.length, 1, 'just (err), as before');
                assert.ifError(args[0]);
                assertTornDown(client, menu.viewControllers.main);
                return done();
            });
            assert.equal(pending.length, 1);
            menu.leave();
            finishArt();
        });

        it('prepViewController() after leave(): built and torn down, then (null, vc, true)', () => {
            const { client, menu } = setup();
            menu.leave();
            const calls = [];
            menu.prepViewController('late', 0, {}, (...args) => calls.push(args));
            assert.equal(calls.length, 1);
            const [err, vc, created] = calls[0];
            assert.ifError(err);
            assert.equal(created, true);
            assertTornDown(client, vc);
        });

        it('a form that already existed is not refocused (re-attached) after leave()', () => {
            const { client, menu, finishArt } = setup();
            let vc;
            menu.prepViewControllerWithArt('main', 0, {}, (err, v) => (vc = v));
            finishArt();
            assert.equal(vc.attached, true);
            assert.equal(timers.intervals.size, 1, 'a live form ticks');

            menu.leave();
            assertTornDown(client, vc);

            const calls = [];
            menu.prepViewController('main', 0, {}, (...args) => calls.push(args));
            assert.deepEqual(calls, [[null, vc, false]]);
            menu.displayArtAndPrepViewController('main', 0, {}, (...args) =>
                calls.push(args)
            );
            finishArt();
            assert.deepEqual(calls[1], [null]);
            assertTornDown(client, vc);
        });
    });

    describe('displayArtAndPrepViewController() calls back (err), as before', () => {
        it('built or refocused, the callback gets just err', done => {
            const counters = makeCounters();
            const Menu = defineMenu(counters, 'm');
            const client = makeClient({ m: menuConfig('m') });
            giveTerm(client);
            const menu = new Menu({
                menuName: 'm',
                menuConfig: { config: { art: { main: 'MAIN' } } },
                client,
            });
            const theme = require('../core/theme.js');
            const { ViewController } = require('../core/view_controller.js');
            const savedDisplay = theme.displayThemedAsset;
            const savedLoad = ViewController.prototype.loadFromMenuConfig;
            theme.displayThemedAsset = (art, c, options, cb) =>
                cb(null, { mciMap: {}, height: 3 });
            ViewController.prototype.loadFromMenuConfig = (opts, cb) => cb(null);
            const restore = () => {
                theme.displayThemedAsset = savedDisplay;
                ViewController.prototype.loadFromMenuConfig = savedLoad;
            };

            //  as an async.waterfall() step: the next step gets only its callback
            const async = require('async');
            async.waterfall(
                [
                    callback =>
                        menu.displayArtAndPrepViewController('main', 0, {}, callback),
                    callback => {
                        assert.equal(typeof callback, 'function');
                        assert.ok(menu.viewControllers.main);
                        return menu.displayArtAndPrepViewController(
                            'main',
                            0,
                            {},
                            (...args) => callback(null, args)
                        );
                    },
                ],
                (err, args) => {
                    restore();
                    try {
                        assert.ifError(err);
                        assert.deepEqual(args, [null]);
                        menu.leave();
                    } catch (e) {
                        return done(e);
                    }
                    return done();
                }
            );
        });
    });
});
