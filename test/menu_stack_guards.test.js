'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

//
//  Two guards on menu navigation:
//
//  *   A session that has ended goes nowhere: goto(), next() and prev() call
//      back with an error rather than create and enter a menu for a caller
//      who is no longer there.
//
//  *   A menu whose init sequence fails falls back to the previous menu, as
//      it always has -- unless it already failed with no input from the
//      caller since, in which case the previous menu led straight back here
//      on its own and falling back again would cycle forever.
//
//  Real MenuStack, MenuModule and menu_util.loadMenu; only the module loader
//  is stubbed, so each menu name maps to a small MenuModule subclass.
//

let MenuStack;
let MenuModule;
let moduleUtil;
let ErrorReasons;
let originalLoadModuleEx;

//  name -> getModule class; set per test
let fakeModules = {};
let loadCalls = 0;
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

describe('MenuStack navigation guards', function () {
    before(() => {
        //  required lazily: these capture Config at first require
        MenuStack = require('../core/menu_stack.js');
        MenuModule = require('../core/menu_module.js').MenuModule;
        ErrorReasons = require('../core/enig_error.js').ErrorReasons;
        moduleUtil = require('../core/module_util.js');

        originalLoadModuleEx = moduleUtil.loadModuleEx;
        moduleUtil.loadModuleEx = (opts, cb) => {
            loadCalls += 1;
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

    after(() => {
        moduleUtil.loadModuleEx = originalLoadModuleEx;
    });

    beforeEach(() => {
        fakeModules = {};
        loadCalls = 0;
        loadHook = null;
    });

    describe('a session that has ended goes nowhere', () => {
        let counters;
        let client;

        beforeEach(done => {
            counters = makeCounters();
            fakeModules.home = defineMenu(counters, 'home');
            fakeModules.away = defineMenu(counters, 'away');
            client = makeClient({
                home: menuConfig('home', { next: 'away' }),
                away: menuConfig('away'),
            });
            client.menuStack.goto('home', err => {
                assert.ifError(err);
                settle(done);
            });
        });

        it('goto() creates no module and calls back with an error', done => {
            loadCalls = 0;
            client.clientEnded = true;
            client.menuStack.goto('away', err => {
                assert.ok(err);
                assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
                assert.equal(loadCalls, 0);
                assert.equal(counters.created.away, undefined);
                assert.equal(client.menuStack.top().name, 'home');
                return done();
            });
        });

        it('next() creates no module and calls back with an error', done => {
            loadCalls = 0;
            client.clientEnded = true;
            client.menuStack.next(err => {
                assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
                assert.equal(loadCalls, 0);
                assert.equal(counters.created.away, undefined);
                return done();
            });
        });

        it('prev() creates no module and calls back with an error', done => {
            client.menuStack.goto('away', err => {
                assert.ifError(err);
                loadCalls = 0;
                client.clientEnded = true;
                client.menuStack.prev(err => {
                    assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
                    assert.equal(loadCalls, 0);
                    assert.equal(counters.created.home, 1, 'home not re-created');
                    return done();
                });
            });
        });

        it('goto() without a callback does nothing and does not throw', () => {
            client.clientEnded = true;
            client.menuStack.goto('away');
            assert.equal(loadCalls, 1, 'only the initial load');
        });

        it('the menu being left gets leave() once, however often navigation is tried', done => {
            client.clientEnded = true;
            client.menuStack.goto('away', () => {
                client.menuStack.next(() => {
                    client.menuStack.prev(() => {
                        assert.equal(counters.left.home, 1);
                        return done();
                    });
                });
            });
        });

        it('a reload() after the end leaves no menu twice', done => {
            client.menuStack.goto('away', err => {
                assert.ifError(err);
                assert.equal(counters.left.home, 1, 'left on the way to away');
                client.clientEnded = true;
                client.currentMenuModule.reload(err => {
                    assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
                    assert.equal(counters.left.away, 1);
                    assert.equal(counters.left.home, 1, 'not left again');
                    assert.equal(counters.created.away, 1, 'not re-created');
                    return done();
                });
            });
        });

        it('a menu that finishes loading after the caller has gone is not entered', done => {
            loadHook = (opts, finish) => {
                client.clientEnded = true; //  hung up while loading
                return finish();
            };
            client.menuStack.goto('away', err => {
                assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
                assert.equal(counters.entered.away, undefined);
                assert.equal(client.menuStack.top().name, 'home');
                return done();
            });
        });

        it('a live session navigates as before', done => {
            client.menuStack.goto('away', err => {
                assert.ifError(err);
                assert.equal(counters.entered.away, 1);
                assert.equal(counters.left.home, 1);
                assert.deepEqual(
                    client.menuStack.stack.map(e => e.name),
                    ['home', 'away']
                );
                assert.equal(client.log.at('warn').length, 0);
                assert.equal(client.log.at('error').length, 0);
                return done();
            });
        });
    });

    describe('a failing menu cannot bounce forever', () => {
        //
        //  The reported loop: |before| shows its art, its pause prompt cannot
        //  be shown so it returns at once, and autoNext takes it straight to
        //  |broken|, which fails init and falls back to |before|...
        //
        let counters;
        let client;

        const errorsAbout = name =>
            client.log.at('error').filter(e => e.obj && e.obj.menuName === name);
        const initWarnings = () =>
            client.log.at('warn').filter(e => e.obj === 'Error during init sequence');

        function setUp(beforeExtra) {
            counters = makeCounters();
            fakeModules.before = defineMenu(counters, 'before');
            fakeModules.broken = defineMenu(counters, 'broken', { fails: true });
            client = makeClient({
                before: menuConfig(
                    'before',
                    Object.assign({ next: 'broken' }, beforeExtra)
                ),
                broken: menuConfig('broken'),
            });
        }

        it('stops at the second failure with no input in between, with one error', done => {
            setUp({ runtime: { autoNext: true } });
            client.menuStack.goto('before', err => {
                assert.ifError(err);
                settle(() => {
                    assert.equal(counters.created.broken, 2);
                    assert.equal(counters.created.before, 2);
                    assert.equal(initWarnings().length, 2);
                    assert.equal(errorsAbout('broken').length, 1);
                    assert.equal(client.log.at('error').length, 1);

                    //  left where it stopped: nothing more happens
                    assert.equal(client.menuStack.top().name, 'broken');
                    settle(() => {
                        assert.equal(counters.created.broken, 2);
                        assert.equal(client.log.at('error').length, 1);
                        return done();
                    });
                });
            });
        });

        it('gets one more attempt after the caller presses a key', done => {
            setUp({ runtime: { autoNext: true } });
            client.menuStack.goto('before', () => {
                settle(() => {
                    assert.equal(counters.created.broken, 2);

                    client.lastActivityTime += 5; //  a key press
                    client.menuStack.goto('before', () => {
                        settle(() => {
                            //  one fallback allowed, then the same stop
                            assert.equal(counters.created.broken, 4);
                            assert.equal(errorsAbout('broken').length, 2);
                            return done();
                        });
                    });
                });
            });
        });

        it('one failure per key press is not a cycle (a pause that waits)', done => {
            //  |before| waits for the caller: each key press sends them on
            setUp({});
            client.menuStack.goto('before', () => {
                let presses = 0;
                const press = () => {
                    if (++presses > 4) {
                        assert.equal(counters.created.broken, 4);
                        assert.equal(initWarnings().length, 4);
                        assert.equal(client.log.at('error').length, 0);
                        assert.equal(client.menuStack.top().name, 'before');
                        return done();
                    }
                    client.lastActivityTime += 5;
                    client.currentMenuModule.nextMenu(() => settle(press));
                };
                settle(press);
            });
        });

        it('the first failure falls back to the previous menu, as always', done => {
            setUp({});
            client.menuStack.goto('before', () => {
                client.lastActivityTime += 5;
                client.currentMenuModule.nextMenu(() => {
                    settle(() => {
                        assert.equal(counters.created.broken, 1);
                        assert.equal(client.menuStack.top().name, 'before');
                        assert.equal(client.log.at('error').length, 0);
                        return done();
                    });
                });
            });
        });

        it('a session that ends mid-bounce stops at once', done => {
            //  no trip needed: the ended guard alone ends the loop
            setUp({ runtime: { autoNext: true } });
            client.menuStack.initFailureWouldCycle = () => false; //  guard off
            const realFallback = MenuModule.prototype.initSequenceFailed;
            let failures = 0;
            fakeModules.broken.prototype.initSequenceFailed = function (err) {
                if (++failures === 3) {
                    client.clientEnded = true;
                }
                return realFallback.call(this, err);
            };
            client.menuStack.goto('before', () => {
                settle(() => {
                    assert.equal(counters.created.broken, 3);
                    assert.equal(counters.created.before, 3);
                    return done();
                });
            });
        });
    });

    describe('a healthy autoNext chain is untouched', () => {
        it('runs every menu once, in order, with nothing logged above debug', done => {
            const counters = makeCounters();
            const names = ['one', 'two', 'three', 'four'];
            const menus = {};
            names.forEach((name, i) => {
                fakeModules[name] = defineMenu(counters, name);
                const extra = names[i + 1]
                    ? { next: names[i + 1], runtime: { autoNext: true } }
                    : {};
                menus[name] = menuConfig(name, extra);
            });
            const client = makeClient(menus);

            client.menuStack.goto('one', err => {
                assert.ifError(err);
                settle(() => {
                    assert.deepEqual(
                        client.menuStack.stack.map(e => e.name),
                        names
                    );
                    names.forEach(name => assert.equal(counters.entered[name], 1));
                    ['warn', 'error', 'info'].forEach(level =>
                        assert.equal(client.log.at(level).length, 0, level)
                    );
                    assert.equal(client.menuStack.initFailures.size, 0);
                    return done();
                });
            });
        });
    });
});
