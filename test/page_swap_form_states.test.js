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
        properties: {},
        isSysOp: () => true,
        getProperty: () => undefined,
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
function switchPage(env, { from, to, art, doSwitch, alsoAttached = [] }) {
    const { client, menu } = env;
    //  a page with nothing to focus (an actor view) has nothing to blur
    const outgoing = menu.viewControllers[from].getFocusedView();
    if (outgoing) {
        markBlur(client, outgoing);
    }
    const n = client.term.out.length;
    doSwitch();
    const artAt = indexOfWrite(client, n, `<<ART:${art}>>`);
    assert.ok(artAt >= 0, `${to}: its art was drawn`);
    if (outgoing) {
        const blurred = indexOfWrite(client, n, '<<BLURRED>>');
        assert.ok(blurred >= 0, `${from}: the outgoing focused view blurred`);
        assert.ok(blurred < artAt, `${from}: blur drew before the ${art} art`);
    }
    assert.deepEqual(
        attached(menu),
        [to, ...alsoAttached].sort(),
        `only ${to} takes keys`
    );
    assert.ok(FormState.getFormCoverToken(menu.viewControllers[from]), `${from} covered`);
    assert.equal(
        FormState.getFormCoverToken(menu.viewControllers[to]),
        null,
        `${to} not covered`
    );
    const incoming = menu.viewControllers[to];
    if (formViews(incoming).some(v => v.acceptsFocus)) {
        const focused = incoming.getFocusedView();
        assert.ok(focused && focused.hasFocus, `${to}: its focused view has focus`);
        assert.equal(View.getInputFocusView(client), focused, `${to}: input focus`);
    } else {
        const holder = View.getInputFocusView(client);
        assert.ok(
            !holder || FormState.getViewForm(holder) !== menu.viewControllers[from],
            `${from}: none of its views keeps the input focus`
        );
    }
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

    //  ── file_area_list: browse -> details -> browse ──────────────────────

    //
    //  Browse: description TL1, nav HM2 ('v' shows details, as the stock
    //  menu binds it). Details: nav HM1 (moving it shows another section),
    //  the info area XY2/XY3, Escape back to browse. The sections are forms
    //  of their own, without input, shown below the nav: general and nfo.
    //  A ticker on browse and one on details.
    //
    const BROWSE_TICKER = gotoFor(2, 60);
    const DETAILS_TICKER = gotoFor(3, 60);

    function fileListEnv() {
        timers = captureTimers();
        const client = makeClient();
        art = stubArt(theme, {
            FBRWSE: {
                TL1: mci('TL', 1, 5, 2, ['', '40']),
                HM2: mci('HM', 2, 22, 2),
                TK19: mci('TK', 19, 2, 60),
            },
            FDETAIL: {
                HM1: mci('HM', 1, 4, 2),
                XY2: mci('XY', 2, 6, 1),
                XY3: mci('XY', 3, 20, 1),
                TK19: mci('TK', 19, 3, 60),
            },
            FDETGEN: { TL10: mci('TL', 10, 1, 2, ['', '30']) },
            FDETNFO: { TL1: mci('TL', 1, 1, 2, ['', '30']) },
        });

        const FileEntry = require('../core/file_entry.js');
        const savedLoad = FileEntry.prototype.load;
        FileEntry.prototype.load = function (fileId, cb) {
            this.fileId = fileId;
            this.desc = `file ${fileId}`;
            return cb(null);
        };
        const restoreArt = art.restore;
        art.restore = () => {
            restoreArt();
            FileEntry.prototype.load = savedLoad;
        };

        const { getModule } = require('../core/file_area_list.js');
        const menu = new getModule({
            menuName: 'fileListTest',
            extraArgs: { filterCriteria: {} },
            menuConfig: {
                config: {
                    art: {
                        browse: 'FBRWSE',
                        details: 'FDETAIL',
                        detailsGeneral: 'FDETGEN',
                        detailsNfo: 'FDETNFO',
                        detailsFileList: 'FDETLST',
                    },
                },
                form: {
                    0: {
                        mci: {
                            TL1: {},
                            HM2: {
                                focus: true,
                                items: ['prev', 'next', 'details'],
                                argName: 'navSelect',
                            },
                            TK19: { text: 'BROWSE NEWS', width: 8 },
                        },
                        actionKeys: [{ keys: ['v'], action: '@method:viewDetails' }],
                    },
                    1: {
                        mci: {
                            HM1: {
                                focus: true,
                                items: ['general', 'nfo/readme', 'file listing'],
                                argName: 'navSelect',
                            },
                            TK19: { text: 'DETAILS NEWS', width: 8 },
                        },
                        actionKeys: [{ keys: ['escape'], action: '@method:detailsQuit' }],
                    },
                    2: { mci: {} },
                    3: { mci: { TL1: {} } },
                },
            },
            client,
        });
        menu.fileList = [1, 2, 3];
        menu.fileListPosition = 0;
        menu.populateCurrentEntryInfo = cb => {
            menu.currentFileEntry.entryInfo = { descLong: 'the nfo' };
            return cb(null);
        };
        menu.updateQueueIndicator = () => {};
        client.currentMenuModule = menu;
        return { client, menu };
    }

    function showBrowse(env) {
        let done = false;
        env.menu.displayBrowsePage(false, err => {
            assert.ifError(err);
            done = true;
        });
        assert.ok(done, 'browse shown');
        return env;
    }

    function fileToDetails(env) {
        switchPage(env, {
            from: 'browse',
            to: 'details',
            art: 'FDETAIL',
            //  the section shown below the nav takes keys too, as it always has
            alsoAttached: ['detailsGeneral'],
            doSwitch: () => type(env.client, 'v'),
        });
        return env;
    }

    function fileToBrowse(env) {
        switchPage(env, {
            from: 'details',
            to: 'browse',
            art: 'FBRWSE',
            doSwitch: () => key(env.client, undefined, ESC),
        });
        //  every section is covered too
        ['detailsGeneral', 'detailsNfo'].forEach(name => {
            const vc = env.menu.viewControllers[name];
            if (vc) {
                assert.ok(FormState.getFormCoverToken(vc), `${name} covered`);
            }
        });
        return env;
    }

    describe('file_area_list', () => {
        it('browse <-> details: keys reach only the page shown; the hidden page is covered, not torn down', () => {
            const env = showBrowse(fileListEnv());
            const { client, menu } = env;
            for (let i = 0; i < SWAPS; ++i) {
                fileToDetails(env);
                formViews(menu.viewControllers.browse).forEach(v =>
                    assert.equal(View.isDestroyed(v), false, 'browse views kept')
                );
                const browseNav = menu.viewControllers.browse.getView(2);
                const before = browseNav.getFocusItemIndex();
                key(client, undefined, { name: 'right arrow' });
                assert.equal(
                    browseNav.getFocusItemIndex(),
                    before,
                    'browse nav untouched'
                );

                fileToBrowse(env);
                formViews(menu.viewControllers.details).forEach(v =>
                    assert.equal(View.isDestroyed(v), false, 'details views kept')
                );
                const detailsNav = menu.viewControllers.details.getView(1);
                const at = detailsNav.getFocusItemIndex();
                key(client, undefined, { name: 'right arrow' });
                assert.equal(detailsNav.getFocusItemIndex(), at, 'details nav untouched');
                key(client, undefined, { name: 'left arrow' });
            }
        });

        it("the details nav 'index update' listener is bound once: one section drawn per move", () => {
            const env = showBrowse(fileListEnv());
            const { client, menu } = env;
            for (let i = 0; i < SWAPS; ++i) {
                fileToDetails(env);
                const nav = menu.viewControllers.details.getView(1);
                assert.equal(nav.listenerCount('index update'), 1, 'one listener');

                const shown = [];
                const orig = menu.displayDetailsSection;
                menu.displayDetailsSection = function (name, ...args) {
                    shown.push(name);
                    return orig.call(this, name, ...args);
                };
                key(client, undefined, { name: 'right arrow' });
                menu.displayDetailsSection = orig;
                assert.deepEqual(shown, ['nfo'], 'one section drawn for one move');
                assert.deepEqual(
                    attached(menu),
                    ['details', 'detailsNfo'],
                    'the nfo section replaced general'
                );
                assert.ok(
                    FormState.getFormCoverToken(menu.viewControllers.detailsGeneral),
                    'general covered'
                );
                key(client, undefined, { name: 'left arrow' });
                fileToBrowse(env);
            }
        });

        it('a ticker on the page shown keeps running across switches; the covered page draws nothing', () => {
            const env = showBrowse(fileListEnv());
            for (let i = 0; i < SWAPS; ++i) {
                assertTickers(env, timers, {
                    shown: BROWSE_TICKER,
                    hidden: DETAILS_TICKER,
                });
                fileToDetails(env);
                assertTickers(env, timers, {
                    shown: DETAILS_TICKER,
                    hidden: BROWSE_TICKER,
                });
                fileToBrowse(env);
            }
            assertTickers(env, timers, { shown: BROWSE_TICKER, hidden: DETAILS_TICKER });
            assert.equal(timers.liveIntervals(), 2, 'both tickers alive, one timer each');
        });

        it('leaving while the details or browse art loads (shown again): nothing drawn afterwards, called back (null)', () => {
            ['viewDetails', 'detailsQuit'].forEach(method => {
                const env = showBrowse(fileListEnv());
                const { client, menu } = env;
                fileToBrowse(fileToDetails(env));
                if ('detailsQuit' === method) {
                    fileToDetails(env);
                }
                art.hold = true;
                const calls = [];
                menu.menuMethods[method]({}, {}, (...args) => calls.push(args));
                menu.leave();
                const n = client.term.out.length;
                art.finish();
                assert.equal(
                    client.term.since(n),
                    '',
                    `${method}: nothing drawn after leave`
                );
                assert.deepEqual(calls, [[null]], `${method}: called back (null)`);
                assert.deepEqual(attached(menu), [], `${method}: no form takes keys`);
                assert.equal(timers.liveIntervals(), 0, `${method}: tickers stopped`);
                art.restore();
                timers.restore();
            });
            art = null;
            timers = null;
        });
    });

    //  ── ActivityPub screens ──────────────────────────────────────────────

    //
    //  The AP screens build their pages with displayArtAndPrepViewController(),
    //  which activates a page shown again. A ticker on each page. Remote
    //  look-ups are stubbed on the instance.
    //
    const MAIN_TICKER = gotoFor(2, 60);
    const OTHER_TICKER = gotoFor(3, 60);

    function apEnv(modulePath, menuConfig, artMaps) {
        timers = captureTimers();
        const client = makeClient();
        art = stubArt(theme, artMaps);
        const { getModule } = require(modulePath);
        const menu = new getModule({ menuName: 'apTest', menuConfig, client });
        client.currentMenuModule = menu;
        return { client, menu };
    }

    function showWith(env, fn) {
        let done = false;
        fn(err => {
            assert.ifError(err);
            done = true;
        });
        assert.ok(done, 'page shown');
        return env;
    }

    //  actor search: the query (ET1, Enter searches) and the actor (TL1-7)
    function actorSearchEnv() {
        const view = { TK19: mci('TK', 19, 3, 60), MT7: mci('MT', 7, 12, 2, ['', '40']) };
        const viewMci = {
            TK19: { text: 'ACTOR NEWS', width: 8 },
            MT7: { mode: 'preview', acceptsFocus: false },
        };
        for (let id = 1; id <= 6; ++id) {
            view[`TL${id}`] = mci('TL', id, 4 + id, 2, ['', '30']);
            viewMci[`TL${id}`] = {};
        }
        const env = apEnv(
            '../core/activitypub/actor_search.js',
            {
                config: { art: { main: 'APMAIN', view: 'APVIEW' } },
                form: {
                    0: {
                        mci: {
                            ET1: { focus: true, argName: 'searchQuery', submit: true },
                            TK19: { text: 'MAIN NEWS', width: 8 },
                        },
                        submit: {
                            '*': [
                                {
                                    value: { searchQuery: null },
                                    action: '@method:search',
                                },
                            ],
                        },
                    },
                    1: {
                        mci: viewMci,
                        actionKeys: [
                            { keys: ['escape'], action: '@method:backKeyPressed' },
                        ],
                    },
                },
            },
            {
                APMAIN: {
                    ET1: mci('ET', 1, 5, 10, ['', '30']),
                    TK19: mci('TK', 19, 2, 60),
                },
                APVIEW: view,
            }
        );
        const { menu } = env;
        menu.getDateFormat = () => 'YYYY';
        menu._search = (values, cb) => {
            menu.selectedActorInfo = {
                preferredUsername: values.searchQuery.trim(),
                name: 'Some One',
                published: '',
                manuallyApprovesFollowers: false,
                summary: 'hello',
            };
            return menu._displayViewPage(cb);
        };
        menu._updateCollectionItemCount = (name, cb) => cb(null);
        menu._setFollowStatus = cb => cb(null);
        return showWith(env, cb => menu._displayMainPage(false, cb));
    }

    //  ap search: tabs HM1, query ET2 (Enter opens the actor), results VM3
    function apSearchEnv() {
        const env = apEnv(
            '../core/activitypub/ap_search.js',
            {
                config: { art: { main: 'SRCHMAIN', actorView: 'SRCHACTOR' } },
                form: {
                    0: {
                        mci: {
                            HM1: { items: ['People', 'Posts'], argName: 'tab' },
                            ET2: { focus: true, argName: 'searchQuery', submit: true },
                            VM3: { argName: 'result' },
                            TK19: { text: 'MAIN NEWS', width: 8 },
                        },
                        submit: {
                            '*': [
                                {
                                    value: { searchQuery: null },
                                    action: '@method:openActor',
                                },
                            ],
                        },
                    },
                    1: {
                        mci: {
                            MT1: {
                                mode: 'preview',
                                acceptsFocus: false,
                                acceptsInput: false,
                            },
                            TL10: {},
                            TK19: { text: 'ACTOR NEWS', width: 8 },
                        },
                        actionKeys: [
                            { keys: ['escape'], action: '@method:backKeyPressed' },
                        ],
                    },
                },
            },
            {
                SRCHMAIN: {
                    HM1: mci('HM', 1, 3, 2),
                    ET2: mci('ET', 2, 5, 10, ['', '30']),
                    VM3: mci('VM', 3, 7, 2, ['', '40']),
                    TK19: mci('TK', 19, 2, 60),
                },
                SRCHACTOR: {
                    MT1: mci('MT', 1, 8, 2, ['', '40']),
                    TL10: mci('TL', 10, 5, 2, ['', '30']),
                    TK19: mci('TK', 19, 3, 60),
                },
            }
        );
        const { menu } = env;
        menu.menuMethods.openActor = (formData, extraArgs, cb) => {
            menu._selectedActor = { id: 'https://x.example/u', summary: 'hi' };
            return menu._displayActorView(cb);
        };
        menu._setFollowStatus = cb => cb(null);
        menu._fetchActorCounts = cb => cb(null);
        menu._actorFormatObject = () => ({});
        return showWith(env, cb => menu._displayMainPage(false, cb));
    }

    //  user config: TM1 enabled (its 'index update' is listened to), BT7
    //  opens the images page; images: ET1, ET2, TM3, Escape back
    function userConfigEnv() {
        const env = apEnv(
            '../core/activitypub/user_config.js',
            {
                config: { art: { main: 'UCMAIN', images: 'UCIMAGES' } },
                form: {
                    0: {
                        mci: {
                            TM1: {
                                focus: true,
                                items: ['no', 'yes'],
                                argName: 'enabled',
                            },
                            TM2: {
                                items: ['no', 'yes'],
                                argName: 'manuallyApproveFollowers',
                            },
                            TM3: { items: ['no', 'yes'], argName: 'hideSocialGraph' },
                            TM4: { items: ['no', 'yes'], argName: 'showRealName' },
                            TL5: { argName: 'image' },
                            TL6: { argName: 'icon' },
                            BT7: {
                                text: 'images',
                                argName: 'manageImages',
                                submit: true,
                            },
                            TM8: {
                                items: ['save', 'cancel'],
                                submit: true,
                                argName: 'saveOrCancel',
                            },
                            TK19: { text: 'MAIN NEWS', width: 8 },
                        },
                        submit: {
                            '*': [
                                {
                                    value: { manageImages: null },
                                    action: '@method:mainSubmit',
                                },
                            ],
                        },
                    },
                    1: {
                        mci: {
                            ET1: { argName: 'imageUrl', focus: true },
                            ET2: { argName: 'iconUrl' },
                            TM3: {
                                items: ['save', 'cancel'],
                                submit: true,
                                argName: 'imagesSaveOrCancel',
                            },
                            TK19: { text: 'IMAGES NEWS', width: 8 },
                        },
                        actionKeys: [{ keys: ['escape'], action: '@method:backToMain' }],
                    },
                },
            },
            {
                UCMAIN: {
                    TM1: mci('TM', 1, 4, 20),
                    TM2: mci('TM', 2, 5, 20),
                    TM3: mci('TM', 3, 6, 20),
                    TM4: mci('TM', 4, 7, 20),
                    TL5: mci('TL', 5, 8, 20, ['', '30']),
                    TL6: mci('TL', 6, 9, 20, ['', '30']),
                    BT7: mci('BT', 7, 11, 20),
                    TM8: mci('TM', 8, 13, 20),
                    TK19: mci('TK', 19, 2, 60),
                },
                UCIMAGES: {
                    ET1: mci('ET', 1, 5, 10, ['', '30']),
                    ET2: mci('ET', 2, 6, 10, ['', '30']),
                    TM3: mci('TM', 3, 8, 10),
                    TK19: mci('TK', 19, 3, 60),
                },
            }
        );
        const { menu } = env;
        //  enabled, so the manage images button takes focus
        env.client.user.activityPubSettings = { enabled: true, image: '', icon: '' };
        //  (the real one builds the user's subject from the web server config)
        menu.customViewUpdates = 0;
        menu._updateCustomViews = () => ++menu.customViewUpdates;
        return showWith(env, cb => menu._displayMainPage(false, cb));
    }

    const apScreens = {
        actor_search: {
            make: actorSearchEnv,
            main: 'main',
            other: 'view',
            otherArt: 'APVIEW',
            mainArt: 'APMAIN',
            toOther: env => {
                type(env.client, 'bob');
                key(env.client, undefined, RETURN);
            },
            toMain: env => key(env.client, undefined, ESC),
            leaveCases: {
                toOther: menu => cb => menu._search({ searchQuery: 'x' }, cb),
                toMain: menu => cb => menu.menuMethods.backKeyPressed({}, {}, cb),
            },
        },
        ap_search: {
            make: apSearchEnv,
            main: 'main',
            other: 'actorView',
            otherArt: 'SRCHACTOR',
            mainArt: 'SRCHMAIN',
            toOther: env => {
                type(env.client, 'bob');
                key(env.client, undefined, RETURN);
            },
            toMain: env => key(env.client, undefined, ESC),
            leaveCases: {
                toOther: menu => cb => menu.menuMethods.openActor({}, {}, cb),
                toMain: menu => cb => menu.menuMethods.backKeyPressed({}, {}, cb),
            },
        },
        user_config: {
            make: userConfigEnv,
            main: 'main',
            other: 'images',
            otherArt: 'UCIMAGES',
            mainArt: 'UCMAIN',
            toOther: env => {
                //  to the manage images button, then Enter
                const main = env.menu.viewControllers.main;
                main.switchFocus(7);
                key(env.client, undefined, RETURN);
            },
            toMain: env => key(env.client, undefined, ESC),
            leaveCases: {
                toOther: menu => cb =>
                    menu.menuMethods.mainSubmit({ submitId: 7 }, {}, cb),
                toMain: menu => cb => menu.menuMethods.backToMain({}, {}, cb),
            },
        },
    };

    Object.keys(apScreens).forEach(name => {
        const screen = apScreens[name];

        function toOther(env) {
            switchPage(env, {
                from: screen.main,
                to: screen.other,
                art: screen.otherArt,
                doSwitch: () => screen.toOther(env),
            });
            return env;
        }

        function toMain(env) {
            switchPage(env, {
                from: screen.other,
                to: screen.main,
                art: screen.mainArt,
                doSwitch: () => screen.toMain(env),
            });
            return env;
        }

        describe(`activitypub ${name}`, () => {
            it('switching back and forth: keys reach only the page shown; the hidden page is covered, not torn down; tickers', () => {
                const env = screen.make();
                const { menu } = env;
                for (let i = 0; i < SWAPS; ++i) {
                    assertTickers(env, timers, {
                        shown: MAIN_TICKER,
                        hidden: OTHER_TICKER,
                    });
                    toOther(env);
                    formViews(menu.viewControllers[screen.main]).forEach(v =>
                        assert.equal(View.isDestroyed(v), false, 'main page views kept')
                    );
                    assertTickers(env, timers, {
                        shown: OTHER_TICKER,
                        hidden: MAIN_TICKER,
                    });
                    toMain(env);
                    formViews(menu.viewControllers[screen.other]).forEach(v =>
                        assert.equal(View.isDestroyed(v), false, 'other page views kept')
                    );
                }
                assert.equal(
                    timers.liveIntervals(),
                    2,
                    'both tickers alive, one timer each'
                );
            });

            ['toOther', 'toMain'].forEach(which => {
                it(`leaving while the art loads (${which}, shown again): nothing drawn afterwards, called back (null)`, () => {
                    const env = toMain(toOther(screen.make()));
                    const { client, menu } = env;
                    if ('toMain' === which) {
                        toOther(env);
                    }
                    art.hold = true;
                    const calls = [];
                    screen.leaveCases[which](menu)((...args) => calls.push(args));
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
    });

    describe('activitypub user_config: the enabled toggle listener', () => {
        it('is bound once: the custom views updated once per change, however many visits', () => {
            const env = userConfigEnv();
            const { client, menu } = env;
            for (let i = 0; i < SWAPS; ++i) {
                const toggle = menu.viewControllers.main.getView(1);
                assert.equal(toggle.listenerCount('index update'), 1, 'one listener');
                const before = menu.customViewUpdates;
                main(env).switchFocus(1);
                key(client, undefined, { name: 'right arrow' });
                key(client, undefined, { name: 'left arrow' });
                const updates = menu.customViewUpdates - before;
                assert.equal(updates, 2, 'once per change');

                apScreens.user_config.toOther(env);
                key(client, undefined, ESC);
            }

            function main(e) {
                return e.menu.viewControllers.main;
            }
        });
    });
});
