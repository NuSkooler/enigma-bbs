'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const FormState = require('../core/form_state.js');

//
//  Modules that show one page of a menu at a time and switch between them
//  (F3c): the page not shown is covered (no keys, no background drawing,
//  views and listeners kept), not torn down, and is activated when shown
//  again. Before, it was torn down (setFocus(false)): a ticker or a status
//  bar in it stopped for good at the first switch, and the module bound
//  its view listeners again on every show.
//
//  Each module runs with its stock menu config and real forms built from
//  an MCI map (as art would give it), with a ticker added to each page.
//  Only the art is stubbed: it writes a marker. Pages are switched by keys
//  where the stock menu binds one. Every check repeats the switch several
//  times: keys reach only the page shown, every listener is there once and
//  fires once, a covered page draws nothing, a ticker on the page shown
//  keeps running, the outgoing page's blur draws before the incoming art,
//  and leaving the menu part-way draws nothing and throws nothing.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
};

const ESC = { name: 'escape' };
const RETURN = { name: 'return' };
const LEFT = { name: 'left arrow' };
const DOWN = { name: 'down arrow' };

const SWAPS = 3;

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    const term = { termWidth: 80, termHeight: 25, out: [] };
    term.write = (s, convertLf, cb) => {
        term.out.push(String(s));
        if (typeof convertLf === 'function') {
            convertLf();
        } else if (typeof cb === 'function') {
            cb();
        }
    };
    term.rawWrite = s => term.out.push(String(s));
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    term.since = n => term.out.slice(n).join('');
    client.term = term;
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    client.user = {
        userId: 1,
        username: 'tester',
        isSysOp: () => true,
    };
    client.currentTheme = {
        helpers: { getDateFormat: () => 'YYYY-MM-DD' },
    };
    return client;
}

//
//  Interval timers (tickers) fired by hand, and the 500 ms timeouts (the
//  preview debounce) held until fired by hand. Other timeouts run as usual.
//
function captureTimers() {
    const intervals = [];
    const timeouts = new Map();
    let nextTimeout = 1;
    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout,
    };
    global.setInterval = fn => {
        intervals.push(fn);
        return intervals.length;
    };
    global.clearInterval = id => {
        if (typeof id === 'number' && id > 0) {
            intervals[id - 1] = null;
        }
    };
    global.setTimeout = (fn, ms, ...args) => {
        if (500 !== ms) {
            return saved.setTimeout(fn, ms, ...args);
        }
        const id = { fake: nextTimeout++ };
        timeouts.set(id, fn);
        return id;
    };
    global.clearTimeout = id => {
        if (id && id.fake) {
            timeouts.delete(id);
            return;
        }
        return saved.clearTimeout(id);
    };
    return {
        fireIntervals() {
            intervals.slice().forEach(fn => fn && fn());
        },
        liveIntervals() {
            return intervals.filter(Boolean).length;
        },
        pendingTimeouts() {
            return timeouts.size;
        },
        fireTimeouts() {
            const fns = Array.from(timeouts.values());
            timeouts.clear();
            fns.forEach(fn => fn());
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

function key(client, ch, k) {
    client.emit('key press', ch, k);
}

function type(client, s) {
    for (const ch of s) {
        key(client, ch, undefined);
    }
}

//  An MCI map entry, as art parsing gives one
function mci(code, id, row, col, args = []) {
    return {
        code,
        id,
        position: [row, col],
        SGR: '\x1b[0m',
        focusSGR: '\x1b[1m',
        args,
    };
}

function gotoFor(row, col) {
    return `\x1b[${row};${col}H`;
}

//
//  theme.displayThemedAsset() stand-in: writes <<ART:name>> and calls back
//  with that art's MCI map; held until finished by hand while |hold| is set
//
function stubArt(theme, artMaps) {
    const saved = theme.displayThemedAsset;
    const state = { hold: false, pending: [], shown: [] };
    theme.displayThemedAsset = (name, client, options, cb) => {
        client.term.rawWrite(`<<ART:${name}>>`);
        state.shown.push(name);
        const artData = {
            mciMap: JSON.parse(JSON.stringify(artMaps[name] || {})),
            height: 20,
        };
        if (state.hold) {
            state.pending.push(() => cb(null, artData));
            return;
        }
        return cb(null, artData);
    };
    state.finish = () => state.pending.splice(0).forEach(fn => fn());
    state.restore = () => {
        theme.displayThemedAsset = saved;
    };
    return state;
}

//  Marks, in the output, the moment |view|'s blur (setFocus(false)) is done
function markBlur(client, view) {
    const orig = view.setFocus;
    view.setFocus = function (focused) {
        const r = orig.call(this, focused);
        if (!focused) {
            client.term.rawWrite('<<BLURRED>>');
        }
        return r;
    };
}

function indexOfWrite(client, from, marker) {
    const out = client.term.out;
    for (let i = from; i < out.length; ++i) {
        if (out[i].includes(marker)) {
            return i;
        }
    }
    return -1;
}

function attached(menu) {
    return Object.keys(menu.viewControllers)
        .filter(name => menu.viewControllers[name].attached)
        .sort();
}

function formViews(vc) {
    return Object.values(vc.views);
}

//
//  The switch from page |from| to page |to|, by |doSwitch|: the outgoing
//  page's focused view blurs (and draws) before the incoming art, and the
//  incoming page then takes the keys
//
function switchPage(env, { from, to, art, doSwitch }) {
    const { client, menu } = env;
    const outgoing = menu.viewControllers[from].getFocusedView();
    markBlur(client, outgoing);
    const n = client.term.out.length;
    doSwitch();
    const blurred = indexOfWrite(client, n, '<<BLURRED>>');
    const artAt = indexOfWrite(client, n, `<<ART:${art}>>`);
    assert.ok(blurred >= 0, `${from}: the outgoing focused view blurred`);
    assert.ok(artAt >= 0, `${to}: its art was drawn`);
    assert.ok(blurred < artAt, `${from}: blur drew before the ${art} art`);
    assert.deepEqual(attached(menu), [to], `only ${to} takes keys`);
    assert.ok(FormState.getFormCoverToken(menu.viewControllers[from]), `${from} covered`);
    assert.equal(
        FormState.getFormCoverToken(menu.viewControllers[to]),
        null,
        `${to} not covered`
    );
    const focused = menu.viewControllers[to].getFocusedView();
    assert.ok(focused && focused.hasFocus, `${to}: its focused view has focus`);
    assert.equal(View.getInputFocusView(client), focused, `${to}: input focus`);
}

//  A covered page's ticker draws nothing; the shown page's does
function assertTickers(env, timers, { shown, hidden }) {
    const { client } = env;
    const n = client.term.out.length;
    timers.fireIntervals();
    timers.fireIntervals();
    const drawn = client.term.since(n);
    assert.ok(drawn.includes(shown), 'the shown page ticker drew');
    assert.ok(!drawn.includes(hidden), 'the covered page ticker drew nothing');
}

describe('Page swaps cover the hidden page (F3c)', () => {
    let theme;
    let previousConfig;
    let timers;
    let art;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
        theme = require('../core/theme.js');
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });
    afterEach(() => {
        if (timers) {
            timers.restore();
            timers = null;
        }
        if (art) {
            art.restore();
            art = null;
        }
    });

    //  ── onelinerz / rumorz ───────────────────────────────────────────────

    //
    //  The two share a shape: a view page (list VM1, add prompt TM2) and an
    //  add page (entry ET1, preview TL2, add/cancel TM3). A ticker TK9 sits
    //  on each page.
    //
    const VIEW_TICKER = gotoFor(3, 60);
    const ADD_TICKER = gotoFor(4, 60);

    function addFormConfig(argName, addAction, cancelAction) {
        return {
            mci: {
                ET1: { focus: true, maxLength: 70, argName },
                TL2: { width: 60 },
                TM3: {
                    argName: 'addOrCancel',
                    items: ['add', 'cancel'],
                    submit: true,
                },
                TK9: { text: 'ADD PAGE NEWS', width: 8 },
            },
            submit: {
                '*': [
                    { value: { addOrCancel: 0 }, action: addAction },
                    { value: { addOrCancel: 1 }, action: cancelAction },
                ],
            },
            actionKeys: [{ keys: ['escape'], action: cancelAction }],
        };
    }

    function viewFormConfig() {
        return {
            mci: {
                VM1: { focus: false, height: 10 },
                TM2: {
                    argName: 'addOrExit',
                    items: ['yeah!', 'nah'],
                    submit: true,
                    focus: true,
                },
                TK9: { text: 'VIEW PAGE NEWS', width: 8 },
            },
            submit: {
                '*': [{ value: { addOrExit: 0 }, action: '@method:viewAddScreen' }],
            },
        };
    }

    const VIEW_MAP = {
        VM1: mci('VM', 1, 5, 5, ['', '30']),
        TM2: mci('TM', 2, 20, 5),
        TK9: mci('TK', 9, 3, 60),
    };
    const ADD_MAP = {
        ET1: mci('ET', 1, 10, 5),
        TL2: mci('TL', 2, 12, 5),
        TM3: mci('TM', 3, 20, 5),
        TK9: mci('TK', 9, 4, 60),
    };

    function linerzEnv(which) {
        timers = captureTimers();
        const client = makeClient();
        let menu;
        let viewArt;
        let argName;
        if ('onelinerz' === which) {
            const { getModule } = require('../core/onelinerz.js');
            viewArt = 'ONELINER';
            argName = 'oneliner';
            art = stubArt(theme, { ONELINER: VIEW_MAP, ONEADD: ADD_MAP });
            menu = new getModule({
                menuName: 'onelinerzTest',
                menuConfig: {
                    config: { art: { view: 'ONELINER', add: 'ONEADD' } },
                    form: {
                        0: viewFormConfig(),
                        1: addFormConfig(
                            argName,
                            '@method:addEntry',
                            '@method:cancelAdd'
                        ),
                    },
                },
                client,
            });
            const rows = [];
            menu.db = {
                prepare: sql => ({
                    all: () => rows.slice(),
                    run: (userId, userName, oneliner, ts) => {
                        if (/INSERT/.test(sql)) {
                            rows.push({
                                user_id: userId,
                                user_name: userName,
                                oneliner,
                                timestamp: ts,
                            });
                        }
                    },
                }),
            };
            rows.push(
                {
                    user_id: 1,
                    user_name: 'a',
                    oneliner: 'first',
                    timestamp: '2026-11-01T00:00:00.000Z',
                },
                {
                    user_id: 1,
                    user_name: 'b',
                    oneliner: 'second',
                    timestamp: '2026-11-02T00:00:00.000Z',
                }
            );
        } else {
            const { getModule } = require('../core/rumorz.js');
            const StatLog = require('../core/stat_log.js');
            viewArt = 'RUMORS';
            argName = 'rumor';
            art = stubArt(theme, { RUMORS: VIEW_MAP, RUMORADD: ADD_MAP });
            menu = new getModule({
                menuName: 'rumorzTest',
                menuConfig: {
                    config: { art: { entries: 'RUMORS', add: 'RUMORADD' } },
                    form: {
                        0: viewFormConfig(),
                        1: addFormConfig(
                            argName,
                            '@method:addEntry',
                            '@method:cancelAdd'
                        ),
                    },
                },
                client,
            });
            const entries = [{ log_value: 'first' }, { log_value: 'second' }];
            const savedGet = StatLog.getSystemLogEntries;
            const savedAppend = StatLog.appendSystemLogEntry;
            StatLog.getSystemLogEntries = (logKey, order, cb) =>
                cb(null, entries.slice());
            StatLog.appendSystemLogEntry = (logKey, value, days, type, cb) => {
                entries.unshift({ log_value: value });
                return cb(null);
            };
            const restoreArt = art.restore;
            art.restore = () => {
                restoreArt();
                StatLog.getSystemLogEntries = savedGet;
                StatLog.appendSystemLogEntry = savedAppend;
            };
        }
        client.currentMenuModule = menu;
        const env = {
            client,
            menu,
            viewArt,
            addArt: 'onelinerz' === which ? 'ONEADD' : 'RUMORADD',
        };
        return env;
    }

    function showFirst(env) {
        const { menu } = env;
        let done = false;
        menu.displayViewScreen(false, err => {
            assert.ifError(err);
            done = true;
        });
        assert.ok(done, 'view page shown');
        return env;
    }

    //  view -> add, by the add prompt: "yeah!" then Enter
    function toAdd(env) {
        const { client } = env;
        switchPage(env, {
            from: 'view',
            to: 'add',
            art: env.addArt,
            doSwitch: () => {
                key(client, undefined, LEFT);
                key(client, undefined, RETURN);
            },
        });
        return env;
    }

    //  add -> view, by Escape (cancel)
    function toView(env) {
        const { client } = env;
        switchPage(env, {
            from: 'add',
            to: 'view',
            art: env.viewArt,
            doSwitch: () => key(client, undefined, ESC),
        });
        return env;
    }

    ['onelinerz', 'rumorz'].forEach(which => {
        describe(which, () => {
            it('switching back and forth: keys reach only the page shown; the hidden page is covered, not torn down', () => {
                const env = showFirst(linerzEnv(which));
                const { client, menu } = env;

                for (let i = 0; i < SWAPS; ++i) {
                    toAdd(env);
                    const add = menu.viewControllers.add;
                    const entry = add.getView(1);
                    assert.equal(entry.hasFocus, true, 'the entry field has focus');
                    type(client, 'hi');
                    assert.equal(entry.getData(), 'hi', 'typed into the entry field');

                    //  the view page is kept: not destroyed, listeners kept
                    const view = menu.viewControllers.view;
                    formViews(view).forEach(v =>
                        assert.equal(View.isDestroyed(v), false, 'view page views kept')
                    );

                    toView(env);
                    formViews(add).forEach(v =>
                        assert.equal(View.isDestroyed(v), false, 'add page views kept')
                    );
                    //  keys typed now do not reach the hidden entry field
                    type(client, 'zz');
                    assert.equal(
                        entry.getData(),
                        '',
                        'cancel cleared it; no key reached it'
                    );
                }
            });

            it('a ticker on the page shown keeps running across switches; the covered page draws nothing', () => {
                const env = showFirst(linerzEnv(which));
                for (let i = 0; i < SWAPS; ++i) {
                    assertTickers(env, timers, {
                        shown: VIEW_TICKER,
                        hidden: ADD_TICKER,
                    });
                    toAdd(env);
                    assertTickers(env, timers, {
                        shown: ADD_TICKER,
                        hidden: VIEW_TICKER,
                    });
                    toView(env);
                }
                assertTickers(env, timers, { shown: VIEW_TICKER, hidden: ADD_TICKER });
                assert.equal(
                    timers.liveIntervals(),
                    2,
                    'both tickers alive, one timer each'
                );
            });

            it('the preview listener is bound once: one preview update per pause, however many visits', () => {
                const env = showFirst(linerzEnv(which));
                const { client, menu } = env;
                for (let i = 0; i < SWAPS; ++i) {
                    toAdd(env);
                    const entry = menu.viewControllers.add.getView(1);
                    assert.equal(
                        entry.listenerCount('key press'),
                        1,
                        'one preview listener'
                    );

                    let previews = 0;
                    const preview = menu.viewControllers.add.getView(2);
                    const origSetText = preview.setText;
                    preview.setText = function (...args) {
                        ++previews;
                        return origSetText.apply(this, args);
                    };
                    type(client, `x${i}`);
                    assert.equal(timers.pendingTimeouts(), 1, 'one debounce pending');
                    timers.fireTimeouts();
                    assert.equal(previews, 1, 'the preview updated once');
                    preview.setText = origSetText;

                    toView(env);
                }
            });

            it('a preview pending at a switch is dropped: nothing drawn over the view page', () => {
                const env = showFirst(linerzEnv(which));
                const { client } = env;
                for (let i = 0; i < SWAPS; ++i) {
                    toAdd(env);
                    type(client, 'late');
                    assert.equal(timers.pendingTimeouts(), 1);
                    toView(env);
                    assert.equal(timers.pendingTimeouts(), 0, 'the debounce was cleared');
                    const n = client.term.out.length;
                    timers.fireTimeouts();
                    assert.equal(client.term.since(n), '', 'nothing drawn');
                }
            });

            it('leaving with a preview pending: nothing drawn, nothing thrown', () => {
                const env = showFirst(linerzEnv(which));
                const { client, menu } = env;
                toAdd(env);
                type(client, 'bye');
                menu.leave();
                const n = client.term.out.length;
                timers.fireTimeouts();
                assert.equal(client.term.since(n), '', 'nothing drawn');
                assert.equal(timers.liveIntervals(), 0, 'tickers stopped');
            });

            it('leaving while the add art loads (shown again): nothing drawn afterwards, called back (null), no form takes keys', () => {
                const env = toView(toAdd(showFirst(linerzEnv(which))));
                const { client, menu } = env;
                art.hold = true;
                const calls = [];
                menu.menuMethods.viewAddScreen({}, {}, (...args) => calls.push(args));
                menu.leave();
                const n = client.term.out.length;
                art.finish();
                assert.equal(client.term.since(n), '', 'nothing drawn after leave');
                assert.deepEqual(calls, [[null]], 'called back (null), as before');
                assert.deepEqual(attached(menu), [], 'no form takes keys');
            });

            //  (onelinerz builds its forms with prepViewControllerWithArt(),
            //  which still draws a form it builds after leave(), as before)
            if ('rumorz' === which) {
                it('leaving while the add art loads the first time: no form built, nothing drawn, called back (null)', () => {
                    const env = showFirst(linerzEnv(which));
                    const { client, menu } = env;
                    art.hold = true;
                    const calls = [];
                    menu.menuMethods.viewAddScreen({}, {}, (...args) => calls.push(args));
                    menu.leave();
                    const n = client.term.out.length;
                    art.finish();
                    assert.equal(client.term.since(n), '', 'nothing drawn after leave');
                    assert.deepEqual(calls, [[null]], 'called back (null), as before');
                    assert.equal(
                        menu.viewControllers.add,
                        undefined,
                        'no add form built'
                    );
                    assert.deepEqual(attached(menu), [], 'no form takes keys');
                });
            }

            it('leaving while the view art loads (shown again): nothing drawn afterwards, called back (null)', () => {
                const env = toAdd(showFirst(linerzEnv(which)));
                const { client, menu } = env;
                art.hold = true;
                const calls = [];
                menu.menuMethods.cancelAdd({}, {}, (...args) => calls.push(args));
                menu.leave();
                const n = client.term.out.length;
                art.finish();
                assert.equal(client.term.since(n), '', 'nothing drawn after leave');
                assert.deepEqual(calls, [[null]], 'called back (null), as before');
                assert.deepEqual(attached(menu), [], 'no form takes keys');
                assert.equal(timers.liveIntervals(), 0, 'tickers stopped');
            });
        });
    });

    //  ── bbs_list ─────────────────────────────────────────────────────────

    //
    //  The list page: the list VM1 and the selected entry's fields TL2-TL9;
    //  'a' adds, as the stock menu binds it. The add page: ET1-ET7, the
    //  error TL8 and save/cancel TM17; Escape cancels. A ticker on each.
    //
    const LIST_TICKER = gotoFor(2, 60);
    const BBSADD_TICKER = gotoFor(3, 60);

    function bbsListEnv() {
        timers = captureTimers();
        const client = makeClient();
        const listMap = {
            VM1: mci('VM', 1, 5, 2, ['', '20']),
            TK19: mci('TK', 19, 2, 60),
        };
        for (let id = 2; id <= 9; ++id) {
            listMap[`TL${id}`] = mci('TL', id, 3 + id, 40, ['', '20']);
        }
        const addMap = {
            TL8: mci('TL', 8, 18, 2, ['', '30']),
            TM17: mci('TM', 17, 20, 2),
            TK19: mci('TK', 19, 3, 60),
        };
        for (let id = 1; id <= 7; ++id) {
            addMap[`ET${id}`] = mci('ET', id, 5 + id, 20, ['', '20']);
        }
        art = stubArt(theme, { BBSLIST: listMap, BBSADD: addMap });

        const User = require('../core/user.js');
        const savedGetUserName = User.getUserName;
        User.getUserName = (userId, cb) => cb(null, 'sysop');
        const restoreArt = art.restore;
        art.restore = () => {
            restoreArt();
            User.getUserName = savedGetUserName;
        };

        const listMci = { VM1: { maxLength: 32 }, TK19: { text: 'LIST NEWS', width: 8 } };
        for (let id = 2; id <= 9; ++id) {
            listMci[`TL${id}`] = { maxLength: 32 };
        }
        const addMci = {
            TM17: { argName: 'submission', items: ['save', 'cancel'], submit: true },
            TK19: { text: 'ADD NEWS', width: 8 },
        };
        ['name', 'sysop', 'telnet', 'www', 'location', 'software', 'notes'].forEach(
            (argName, i) => {
                addMci[`ET${i + 1}`] = { argName, maxLength: 32 };
            }
        );

        const { getModule } = require('../core/bbs_list.js');
        const menu = new getModule({
            menuName: 'bbsListTest',
            menuConfig: {
                config: { art: { entries: 'BBSLIST', add: 'BBSADD' } },
                form: {
                    0: {
                        mci: listMci,
                        actionKeys: [{ keys: ['a'], action: '@method:addBBS' }],
                    },
                    1: {
                        mci: addMci,
                        actionKeys: [
                            { keys: ['escape'], action: '@method:cancelSubmit' },
                        ],
                        submit: {
                            '*': [
                                { value: { submission: 0 }, action: '@method:submitBBS' },
                                {
                                    value: { submission: 1 },
                                    action: '@method:cancelSubmit',
                                },
                            ],
                        },
                    },
                },
            },
            client,
        });
        const rows = ['Alpha', 'Bravo', 'Charlie'].map((name, i) => ({
            id: i + 1,
            bbs_name: name,
            sysop: `op${i}`,
            telnet: `${name.toLowerCase()}.example:23`,
            www: '',
            location: '',
            software: 'ENiGMA',
            submitter_user_id: 1,
            notes: '',
        }));
        menu.database = {
            prepare: () => ({ all: () => rows.slice(), run: () => {} }),
        };
        client.currentMenuModule = menu;
        return { client, menu, viewArt: 'BBSLIST', addArt: 'BBSADD' };
    }

    function showList(env) {
        let done = false;
        env.menu.displayBBSList(false, err => {
            assert.ifError(err);
            done = true;
        });
        assert.ok(done, 'list shown');
        return env;
    }

    function bbsToAdd(env) {
        switchPage(env, {
            from: 'view',
            to: 'add',
            art: env.addArt,
            doSwitch: () => type(env.client, 'a'),
        });
        return env;
    }

    function bbsToList(env) {
        switchPage(env, {
            from: 'add',
            to: 'view',
            art: env.viewArt,
            doSwitch: () => key(env.client, undefined, ESC),
        });
        return env;
    }

    describe('bbs_list', () => {
        it('switching back and forth: keys reach only the page shown; the hidden page is covered, not torn down', () => {
            const env = showList(bbsListEnv());
            const { client, menu } = env;
            for (let i = 0; i < SWAPS; ++i) {
                bbsToAdd(env);
                const add = menu.viewControllers.add;
                const name = add.getView(1);
                assert.equal(name.hasFocus, true, 'the name field has focus');
                type(client, 'xyz');
                assert.equal(name.getData(), 'xyz');
                formViews(menu.viewControllers.view).forEach(v =>
                    assert.equal(View.isDestroyed(v), false, 'list page views kept')
                );

                bbsToList(env);
                //  'z' and the arrow reach the list only
                type(client, 'z');
                assert.equal(name.getData(), '', 'cancel cleared it; no key reached it');
                formViews(add).forEach(v =>
                    assert.equal(View.isDestroyed(v), false, 'add page views kept')
                );
            }
        });

        it("the list's 'index update' listener is bound once: the selected entry drawn once per move", () => {
            const env = showList(bbsListEnv());
            const { client, menu } = env;
            for (let i = 0; i < SWAPS; ++i) {
                bbsToAdd(env);
                bbsToList(env);
                const list = menu.viewControllers.view.getView(1);
                assert.equal(list.listenerCount('index update'), 1, 'one listener');

                let drawn = 0;
                const orig = menu.drawSelectedEntry;
                menu.drawSelectedEntry = function (...args) {
                    ++drawn;
                    return orig.apply(this, args);
                };
                key(client, undefined, DOWN);
                menu.drawSelectedEntry = orig;
                assert.equal(drawn, 1, 'drawn once for one move');
                assert.equal(menu.selectedBBS, (i + 1) % 3, 'the selection followed');
            }
        });

        it('a ticker on the page shown keeps running across switches; the covered page draws nothing', () => {
            const env = showList(bbsListEnv());
            for (let i = 0; i < SWAPS; ++i) {
                assertTickers(env, timers, { shown: LIST_TICKER, hidden: BBSADD_TICKER });
                bbsToAdd(env);
                assertTickers(env, timers, { shown: BBSADD_TICKER, hidden: LIST_TICKER });
                bbsToList(env);
            }
            assertTickers(env, timers, { shown: LIST_TICKER, hidden: BBSADD_TICKER });
            assert.equal(timers.liveIntervals(), 2, 'both tickers alive, one timer each');
        });

        it('leaving while the add art loads, first time or again: nothing drawn afterwards, called back (null)', () => {
            [0, 1].forEach(visits => {
                const env = showList(bbsListEnv());
                const { client, menu } = env;
                for (let i = 0; i < visits; ++i) {
                    bbsToList(bbsToAdd(env));
                }
                art.hold = true;
                const calls = [];
                menu.menuMethods.addBBS({}, {}, (...args) => calls.push(args));
                menu.leave();
                const n = client.term.out.length;
                art.finish();
                assert.equal(client.term.since(n), '', 'nothing drawn after leave');
                assert.deepEqual(calls, [[null]], 'called back (null), as before');
                assert.deepEqual(attached(menu), [], 'no form takes keys');
                art.restore();
                timers.restore();
            });
            art = null;
            timers = null;
        });

        it('leaving while the list art loads (shown again): nothing drawn afterwards, called back (null)', () => {
            const env = bbsToAdd(showList(bbsListEnv()));
            const { client, menu } = env;
            art.hold = true;
            const calls = [];
            menu.menuMethods.cancelSubmit({}, {}, (...args) => calls.push(args));
            menu.leave();
            const n = client.term.out.length;
            art.finish();
            assert.equal(client.term.since(n), '', 'nothing drawn after leave');
            assert.deepEqual(calls, [[null]], 'called back (null), as before');
            assert.deepEqual(attached(menu), [], 'no form takes keys');
            assert.equal(timers.liveIntervals(), 0, 'tickers stopped');
        });

        it('the list shown again after leave() while user names load: nothing drawn', () => {
            const env = bbsToAdd(showList(bbsListEnv()));
            const { client, menu } = env;
            const User = require('../core/user.js');
            const pending = [];
            const stubbed = User.getUserName;
            User.getUserName = (userId, cb) => pending.push(() => cb(null, 'sysop'));
            const calls = [];
            menu.menuMethods.cancelSubmit({}, {}, (...args) => calls.push(args));
            menu.leave();
            const n = client.term.out.length;
            pending.splice(0).forEach(fn => fn());
            User.getUserName = stubbed;
            assert.equal(client.term.since(n), '', 'nothing drawn after leave');
            assert.deepEqual(calls, [[null]]);
        });
    });
});
