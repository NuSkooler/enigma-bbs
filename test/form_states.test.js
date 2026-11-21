'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { TickerView } = require('../core/ticker_view.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const FormState = require('../core/form_state.js');

//
//  ViewController form states (F3a): activate / deactivate / cover /
//  uncover / destroy; a menu's forms are destroyed (terminally) when it is
//  left (option B); removeViewController() as before (not terminal);
//  background draw suspends scoped by ownership; the pauseWhenInactive mci
//  property.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
};

const TICKER_GOTO = '\x1b[2;10H';
const OTHER_TICKER_GOTO = '\x1b[4;10H';

function makeClient() {
    const client = new events.EventEmitter();
    client.log = { debugs: [] };
    ['trace', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.debug = (obj, msg) => client.log.debugs.push({ obj, msg });
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
    return client;
}

//  Interval timers fired by hand
function captureTimers() {
    const timers = [];
    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    global.setInterval = fn => {
        timers.push(fn);
        return timers.length;
    };
    global.clearInterval = id => {
        if (id) {
            timers[id - 1] = null;
        }
    };
    return {
        fireAll() {
            timers.slice().forEach(fn => fn && fn());
        },
        live() {
            return timers.filter(Boolean).length;
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

function makeTicker(client, row = 2) {
    return new TickerView({
        client,
        id: 9,
        position: { row, col: 10 },
        dimens: { width: 20, height: 1 },
        text: 'Welcome to the board -- news, files and doors',
        motion: 'left',
    });
}

//  A form: a ticker and a focused field with Escape bound to submit
function buildForm(client, { vc, row = 2 } = {}) {
    vc = vc || new ViewController({ client });
    const ticker = makeTicker(client, row);
    const field = new EditTextView({
        client,
        id: 1,
        position: { row: 20, col: 5 },
        dimens: { width: 30 },
        maxLength: 30,
    });
    vc.addView(ticker);
    vc.addView(field);
    vc.setViewOrder();
    vc.redrawAll();
    vc.switchFocus(1);
    vc.mapActionKeys([{ keys: ['escape'], viewId: 1 }], 'form');
    const submits = { n: 0 };
    vc.on('submit', () => ++submits.n);
    return { vc, ticker, field, submits };
}

function makeModule(client, name = 'testMenu') {
    const { MenuModule } = require('../core/menu_module.js');
    const mod = new MenuModule({
        menuName: name,
        menuConfig: { config: {}, art: null },
        client,
    });
    client.currentMenuModule = mod;
    return mod;
}

function keyListeners(client) {
    return client.listeners('key press').length;
}

function type(client, s) {
    for (const ch of s) {
        client.emit('key press', ch, undefined);
    }
}

describe('Form states (ViewController)', () => {
    let previousConfig;
    let timers;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });
    beforeEach(() => {
        timers = captureTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    describe('deactivate() / activate()', () => {
        it('deactivate keeps the ticker and listeners; no keys; no destroyed mark', () => {
            const client = makeClient();
            const { vc, ticker, field } = buildForm(client);
            const indexUpdates = { n: 0 };
            field.on('custom', () => ++indexUpdates.n);

            vc.deactivate();

            assert.equal(vc.attached, false);
            assert.equal(View.getInputFocusView(client), null, 'input focus released');
            assert.equal(field.hasFocus, false, 'blurred');
            assert.equal(View.isDestroyed(ticker), false);
            assert.equal(View.isDestroyed(field), false);
            assert.equal(FormState.isFormDestroyed(vc), false);

            //  no keys
            type(client, 'abc');
            assert.equal(field.getData(), '');

            //  the ticker keeps drawing
            const n = client.term.out.length;
            timers.fireAll();
            timers.fireAll();
            assert.ok(client.term.since(n).includes(TICKER_GOTO), 'ticker drew');

            //  listeners kept
            field.emit('custom');
            assert.equal(indexUpdates.n, 1);
        });

        it('activate gives the keys back, to the same field, ticker still running', () => {
            const client = makeClient();
            const { vc, field } = buildForm(client);
            vc.deactivate();
            vc.activate();

            assert.equal(vc.attached, true);
            assert.equal(field.hasFocus, true);
            assert.equal(View.getInputFocusView(client), field);
            type(client, 'hi');
            assert.equal(field.getData(), 'hi');

            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(n).includes(TICKER_GOTO));
        });

        it('deactivate twice blurs once; attach after deactivate clears the inactive mark', () => {
            const client = makeClient();
            const { vc, field } = buildForm(client);
            const leaves = { n: 0 };
            vc.on('leave', () => ++leaves.n);
            vc.deactivate();
            vc.deactivate();
            assert.equal(leaves.n, 1);
            assert.equal(FormState.isFormInactive(vc), true);
            vc.switchFocus(1);
            assert.equal(FormState.isFormInactive(vc), false);
            assert.equal(field.hasFocus, true);
        });

        it('keeps one key listener per form across deactivate/activate cycles', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            const base = keyListeners(client);
            for (let i = 0; i < 3; ++i) {
                vc.deactivate();
                assert.equal(keyListeners(client), base - 1);
                vc.activate();
                assert.equal(keyListeners(client), base);
            }
        });
    });

    describe('setFocus() is unchanged for mods', () => {
        it('setFocus(false) still tears down: views destroyed, listeners gone, ticker stopped', () => {
            const client = makeClient();
            const { vc, ticker, field } = buildForm(client);
            field.on('custom', () => {});

            vc.setFocus(false);

            assert.equal(View.isDestroyed(ticker), true);
            assert.equal(View.isDestroyed(field), true);
            assert.equal(field.listenerCount('custom'), 0);
            assert.equal(timers.live(), 0, 'ticker timer cleared');
            //  but not terminal: a mod may setFocus(true) it again
            assert.equal(FormState.isFormDestroyed(vc), false);
            vc.setFocus(true);
            assert.equal(vc.attached, true);
            type(client, 'x');
            assert.equal(field.getData(), 'x');
        });

        it('setFocus(false) again removes listeners added since the last one (a page shown again)', () => {
            const client = makeClient();
            const { vc, field } = buildForm(client);
            const counts = [];
            for (let i = 0; i < 4; ++i) {
                field.on('custom', () => {}); //  bound each time it is shown
                vc.setFocus(false);
                counts.push(field.listenerCount('custom'));
                vc.setFocus(true);
            }
            assert.deepEqual(counts, [0, 0, 0, 0]);
        });

        it('detachClientEvents() on a deactivated form still tears it down', () => {
            const client = makeClient();
            const { vc, ticker } = buildForm(client);
            vc.deactivate();
            vc.detachClientEvents();
            assert.equal(View.isDestroyed(ticker), true);
            assert.equal(timers.live(), 0);
        });

        it('detachClientEvents() on a form that never attached is still a no-op', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            const ticker = makeTicker(client);
            vc.addView(ticker);
            vc.detachClientEvents();
            assert.equal(View.isDestroyed(ticker), false);
        });
    });

    describe('cover() / uncover()', () => {
        it('a covered form neither takes keys nor draws; another form keeps drawing', () => {
            const client = makeClient();
            const covered = buildForm(client);
            const other = new ViewController({ client });
            const otherTicker = makeTicker(client, 4);
            other.addView(otherTicker);

            covered.vc.cover();

            type(client, 'abc');
            assert.equal(covered.field.getData(), '');

            const n = client.term.out.length;
            timers.fireAll();
            const out = client.term.since(n);
            assert.ok(!out.includes(TICKER_GOTO), 'covered ticker drew nothing');
            assert.ok(out.includes(OTHER_TICKER_GOTO), 'the other form drew');
        });

        it('uncover redraws the views that missed a draw, once; still inactive', () => {
            const client = makeClient();
            const { vc, field } = buildForm(client);
            vc.cover();
            timers.fireAll();

            const n = client.term.out.length;
            vc.uncover();
            assert.ok(client.term.since(n).includes(TICKER_GOTO), 'missed draw redrawn');
            assert.equal(vc.attached, false, 'uncover does not activate');
            type(client, 'a');
            assert.equal(field.getData(), '');

            vc.activate();
            type(client, 'a');
            assert.equal(field.getData(), 'a');
        });

        it('uncover({ redraw: true }) redraws every view of the form', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.cover();
            const n = client.term.out.length;
            vc.uncover({ redraw: true });
            const out = client.term.since(n);
            assert.ok(out.includes(TICKER_GOTO), 'ticker redrawn');
            assert.ok(out.includes('\x1b[20;5H'), 'field redrawn');
        });

        it('activate() on a covered form uncovers it', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.cover();
            vc.activate();
            assert.equal(FormState.getFormCoverToken(vc), null);
            assert.equal(View.isBackgroundDrawSuspended(client), false);
        });

        it('a covered form under a screen cover is redrawn only when both are gone', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.cover();
            const screen = View.suspendBackgroundDraw(client);
            timers.fireAll();
            vc.uncover({ redraw: true });
            let n = client.term.out.length;
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(TICKER_GOTO), 'screen cover holds');
            n = client.term.out.length;
            View.resumeBackgroundDraw(client, screen);
            assert.ok(client.term.since(n).includes(TICKER_GOTO));
        });

        it('destroy() of a covered form gives its suspend back', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.cover();
            vc.destroy();
            assert.equal(View.isBackgroundDrawSuspended(client), false);
        });
    });

    describe('destroy() is terminal (option B)', () => {
        it('activate / setFocus(true) / attachClientEvents / switchFocus do nothing', () => {
            const client = makeClient();
            const { vc, field, ticker } = buildForm(client);
            const base = keyListeners(client);
            vc.destroy();
            assert.equal(keyListeners(client), base - 1);
            assert.equal(View.isDestroyed(ticker), true);

            vc.activate();
            vc.setFocus(true);
            vc.attachClientEvents();
            vc.switchFocus(1);
            vc.resetInitialFocus();

            assert.equal(keyListeners(client), base - 1, 'no key handler came back');
            assert.equal(vc.attached, false);
            assert.equal(View.getInputFocusView(client), null);
            type(client, 'abc');
            assert.equal(field.getData(), '');
            assert.ok(
                client.log.debugs.some(d => /Form was destroyed/.test(d.msg)),
                'logged at debug'
            );
        });

        it('tears down a form that never attached, and is idempotent', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            const ticker = makeTicker(client);
            vc.addView(ticker);
            vc.destroy();
            vc.destroy();
            assert.equal(View.isDestroyed(ticker), true);
            assert.equal(timers.live(), 0);
        });
    });

    describe('MenuModule: a left menu keeps its forms destroyed', () => {
        it('leave() destroys every form; a late setFocus(true) leaves keys with the new menu', () => {
            const client = makeClient();
            const oldMenu = makeModule(client, 'old');
            const old = buildForm(client, {
                vc: oldMenu.addViewController('view', new ViewController({ client })),
            });

            oldMenu.leave();
            assert.equal(FormState.isFormDestroyed(old.vc), true);

            const newMenu = makeModule(client, 'new');
            const fresh = buildForm(client, {
                vc: newMenu.addViewController('view', new ViewController({ client })),
            });
            const base = keyListeners(client);

            //  e.g. onelinerz's refocus after an art load that finished late
            oldMenu.viewControllers.view.setFocus(true);
            oldMenu.viewControllers.view.switchFocus(1);
            oldMenu.viewControllers.view.activate();

            assert.equal(keyListeners(client), base);
            type(client, 'ok');
            client.emit('key press', '\x1b', { name: 'escape' });
            assert.equal(fresh.field.getData(), 'ok');
            assert.equal(fresh.submits.n, 1);
            assert.equal(old.field.getData(), '');
            assert.equal(old.submits.n, 0, "the old menu's action key did not fire");
        });

        it('a form setFocus(false)ed before leave() is destroyed too', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const { vc } = buildForm(client, {
                vc: menu.addViewController('add', new ViewController({ client })),
            });
            vc.setFocus(false);
            menu.leave();
            const base = keyListeners(client);
            vc.setFocus(true);
            assert.equal(keyListeners(client), base);
        });

        it('a deactivated form is torn down by leave()', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const { vc, ticker } = buildForm(client, {
                vc: menu.addViewController('add', new ViewController({ client })),
            });
            vc.deactivate();
            menu.leave();
            assert.equal(View.isDestroyed(ticker), true);
            assert.equal(timers.live(), 0);
        });

        it('a new instance of the same menu (reload / prev) has working forms', () => {
            const client = makeClient();
            const first = makeModule(client, 'same');
            buildForm(client, {
                vc: first.addViewController('view', new ViewController({ client })),
            });
            first.reloading = true;
            first.leave();

            const second = makeModule(client, 'same');
            const { vc, field } = buildForm(client, {
                vc: second.addViewController('view', new ViewController({ client })),
            });
            vc.setFocus(true);
            type(client, 'yes');
            assert.equal(field.getData(), 'yes');
        });

        it('removeViewController() is not terminal: a kept form is added again and takes keys', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const { vc, field } = buildForm(client, {
                vc: menu.addViewController('popup', new ViewController({ client })),
            });
            const base = keyListeners(client);
            menu.removeViewController('popup');
            assert.equal(menu.viewControllers.popup, undefined);
            assert.equal(FormState.isFormDestroyed(vc), false);
            assert.equal(vc.attached, false);
            assert.equal(keyListeners(client), base - 1);

            menu.addViewController('popup', vc);
            vc.setFocus(true);
            assert.equal(vc.attached, true);
            assert.equal(keyListeners(client), base);
            type(client, 'hi');
            assert.equal(field.getData(), 'hi');
        });

        it('removeViewController() then setFocus(true) on a held reference attaches (as on master)', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const { vc, field } = buildForm(client, {
                vc: menu.addViewController('a', new ViewController({ client })),
            });
            vc.setFocus(false);
            menu.removeViewController('a');
            vc.setFocus(true);
            type(client, 'x');
            assert.equal(vc.attached, true);
            assert.equal(field.getData(), 'x');
        });

        it('removeViewController() on a form that never attached leaves its views alone (as on master)', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const vc = menu.addViewController(
                'pending',
                new ViewController({ client, detached: true })
            );
            const ticker = makeTicker(client);
            vc.addView(ticker);
            assert.equal(timers.live(), 1);
            menu.removeViewController('pending');
            assert.equal(timers.live(), 1, 'ticker timer still running');
            assert.equal(View.isDestroyed(ticker), false);
            assert.equal(FormState.isFormDestroyed(vc), false, 'not terminal');
            menu.addViewController('pending', vc);
            vc.setFocus(true);
            assert.equal(vc.attached, true);
            vc.destroy();
            assert.equal(timers.live(), 0);
        });

        it('leave() still destroys a form removed and added back', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const { vc } = buildForm(client, {
                vc: menu.addViewController('popup', new ViewController({ client })),
            });
            menu.removeViewController('popup');
            menu.addViewController('popup', vc);
            menu.leave();
            assert.equal(FormState.isFormDestroyed(vc), true);
        });

        it('prepViewController() after leave(): built, torn down, still calls back', done => {
            const client = makeClient();
            const menu = makeModule(client);
            menu.menuConfig.config = {};
            client.currentMenuModule = menu;
            menu.leave();
            const base = keyListeners(client);
            menu.prepViewController('late', 0, {}, (err, vc, wasCreated) => {
                assert.ifError(err);
                assert.equal(wasCreated, true);
                assert.equal(FormState.isFormDestroyed(vc), true);
                //  the module's own refocus afterwards does nothing
                vc.setFocus(true);
                assert.equal(keyListeners(client), base);
                return done();
            });
        });
    });

    describe('suspends scoped by ownership', () => {
        it('coverScreen() by default lets a form the menu builds inside it draw (F1 rule)', done => {
            const client = makeClient();
            const menu = makeModule(client);
            const { ticker } = buildForm(client, {
                vc: menu.addViewController('menu', new ViewController({ client })),
            });
            menu.coverScreen(
                finish => {
                    //  e.g. a help form the menu shows inside its own cover
                    const help = menu.addViewController(
                        'help',
                        new ViewController({ client })
                    );
                    help.addView(makeTicker(client, 6));
                    const n = client.term.out.length;
                    timers.fireAll();
                    const out = client.term.since(n);
                    assert.ok(out.includes('\x1b[6;10H'), 'the help form animates');
                    assert.ok(!out.includes(TICKER_GOTO), 'the covered form does not');
                    assert.equal(ticker.isBackgroundDrawSuspended(), true);
                    finish(null);
                },
                err => {
                    assert.ifError(err);
                    return done();
                }
            );
        });

        it('coverScreen({ scope: { menu } }) suspends a form the menu builds during the cover', done => {
            const client = makeClient();
            const menu = makeModule(client);
            let late;
            menu.coverScreen(
                { scope: { menu } },
                finish => {
                    //  art that finished loading under the cover
                    late = menu.addViewController('late', new ViewController({ client }));
                    late.addView(makeTicker(client));
                    const n = client.term.out.length;
                    timers.fireAll();
                    assert.ok(
                        !client.term.since(n).includes(TICKER_GOTO),
                        "the menu's new ticker drew nothing over the cover"
                    );
                    finish(null);
                },
                err => {
                    assert.ifError(err);
                    return done();
                }
            );
        });

        it('a { menu } suspend covers a form assigned to viewControllers directly', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const token = View.suspendBackgroundDraw(client, { menu });
            //  as msg_list, new_scan, user_config and file_transfer_protocol_select do
            menu.viewControllers.allViews = new ViewController({ client });
            const { ticker } = buildForm(client, { vc: menu.viewControllers.allViews });
            assert.equal(ticker.isBackgroundDrawSuspended(), true);
            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(TICKER_GOTO));
            //  and is no longer the menu's once it is gone from there
            delete menu.viewControllers.allViews;
            assert.equal(ticker.isBackgroundDrawSuspended(), false);
            View.resumeBackgroundDraw(client, token);
        });

        it('an owner-less view created inside the menu cover still animates (pause prompt)', done => {
            const client = makeClient();
            const menu = makeModule(client);
            buildForm(client, {
                vc: menu.addViewController('menu', new ViewController({ client })),
            });
            menu.coverScreen(
                { scope: { menu } },
                finish => {
                    //  a theme's temporary prompt form: not added to the menu
                    const promptVc = new ViewController({ client });
                    promptVc.addView(makeTicker(client, 4));
                    const n = client.term.out.length;
                    timers.fireAll();
                    const out = client.term.since(n);
                    assert.ok(out.includes(OTHER_TICKER_GOTO), 'pause ticker animates');
                    assert.ok(!out.includes(TICKER_GOTO), 'menu ticker suspended');
                    promptVc.destroy();
                    finish(null);
                },
                err => {
                    assert.ifError(err);
                    return done();
                }
            );
        });

        it('an owner-less view created before the menu cover is suspended (F1 rule)', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const bare = makeTicker(client, 4); //  a mod's bare view
            let out;
            menu.coverScreen(
                finish => {
                    const n = client.term.out.length;
                    timers.fireAll();
                    out = client.term.since(n);
                    finish(null);
                },
                () => {}
            );
            assert.ok(!out.includes(OTHER_TICKER_GOTO));
            assert.equal(View.isDestroyed(bare), false);
        });

        it('the interrupt cover is menu-scoped; its animated pause still animates', done => {
            const UserInterruptQueue = require('../core/user_interrupt_queue.js');
            const client = makeClient();
            const menu = makeModule(client);
            buildForm(client, {
                vc: menu.addViewController('menu', new ViewController({ client })),
            });
            let outDuringPause = '';
            menu.pausePrompt = (position, cb) => {
                //  the menu builds a form while the interrupt is up
                const late = menu.addViewController(
                    'late',
                    new ViewController({ client })
                );
                late.addView(makeTicker(client, 6));
                //  an animated pause prompt (owner-less temporary form)
                const promptVc = new ViewController({ client });
                promptVc.addView(makeTicker(client, 4));
                const n = client.term.out.length;
                timers.fireAll();
                outDuringPause = client.term.since(n);
                promptVc.destroy();
                return cb(null);
            };
            const queue = new UserInterruptQueue(client);
            queue.displayWithItem({ text: 'Hello', pause: true }, err => {
                assert.ifError(err);
                assert.ok(outDuringPause.includes(OTHER_TICKER_GOTO), 'pause animates');
                assert.ok(!outDuringPause.includes(TICKER_GOTO), 'menu ticker held');
                assert.ok(!outDuringPause.includes('\x1b[6;10H'), 'late menu form held');
                return done();
            });
        });

        it('seq semantics unchanged for owner-less views (nested covers)', () => {
            const client = makeClient();
            const a = makeTicker(client, 2);
            const tokenA = View.suspendBackgroundDraw(client);
            const b = makeTicker(client, 4);
            assert.equal(a.isBackgroundDrawSuspended(), true);
            assert.equal(b.isBackgroundDrawSuspended(), false);
            const tokenB = View.suspendBackgroundDraw(client);
            assert.equal(b.isBackgroundDrawSuspended(), true);
            View.resumeBackgroundDraw(client, tokenB);
            assert.equal(b.isBackgroundDrawSuspended(), false);
            assert.equal(a.isBackgroundDrawSuspended(), true);
            View.resumeBackgroundDraw(client, tokenA);
            assert.equal(a.isBackgroundDrawSuspended(), false);
        });

        it('a forms cover does not change the seq rule for anything else', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            const bare = makeTicker(client, 4);
            vc.cover();
            const after = makeTicker(client, 6);
            assert.equal(bare.isBackgroundDrawSuspended(), false);
            assert.equal(after.isBackgroundDrawSuspended(), false);
            assert.equal(vc.getView(9).isBackgroundDrawSuspended(), true);
        });

        it('a drip suspends by creation order, also with owned forms', () => {
            const client = makeClient();
            let cover = null;
            client.term.setDripCover = c => (cover = c);
            const menu = makeModule(client);
            const { ticker } = buildForm(client, {
                vc: menu.addViewController('menu', new ViewController({ client })),
            });
            const token = cover.begin();
            const later = menu.addViewController('later', new ViewController({ client }));
            const laterTicker = makeTicker(client, 6);
            later.addView(laterTicker);
            assert.equal(ticker.isBackgroundDrawSuspended(), true);
            assert.equal(laterTicker.isBackgroundDrawSuspended(), false);
            cover.end(token);
            assert.equal(ticker.isBackgroundDrawSuspended(), false);
        });
    });

    describe('pauseWhenInactive', () => {
        function pausedForm(client) {
            const form = buildForm(client);
            form.vc.getView(9).setPropertyValue('pauseWhenInactive', true);
            return form;
        }

        it('no background draws while inactive; one forced redraw on activate()', () => {
            const client = makeClient();
            const { vc } = pausedForm(client);
            vc.deactivate();
            let n = client.term.out.length;
            timers.fireAll();
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(TICKER_GOTO), 'paused');

            n = client.term.out.length;
            vc.activate();
            const out = client.term.since(n);
            assert.equal(out.split(TICKER_GOTO).length - 1, 1, 'redrawn once');

            n = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(n).includes(TICKER_GOTO), 'running again');
        });

        it('paused while covered; uncover() redraws it once; paused until activate()', () => {
            const client = makeClient();
            const { vc } = pausedForm(client);
            vc.cover();
            timers.fireAll();
            let n = client.term.out.length;
            vc.uncover();
            assert.equal(
                client.term.since(n).split(TICKER_GOTO).length - 1,
                1,
                'the make-up redraw draws'
            );
            n = client.term.out.length;
            timers.fireAll();
            assert.ok(
                !client.term.since(n).includes(TICKER_GOTO),
                'ticks paused: inactive'
            );
            n = client.term.out.length;
            vc.activate();
            assert.ok(client.term.since(n).includes(TICKER_GOTO));
        });

        it('a paused ticker does not move on unseen: its ticks are skipped', () => {
            const client = makeClient();
            const { vc, ticker } = pausedForm(client);
            const moves = { n: 0 };
            const advance = ticker._advanceMotion.bind(ticker);
            ticker._advanceMotion = () => {
                ++moves.n;
                return advance();
            };
            timers.fireAll();
            assert.equal(moves.n, 1);
            vc.deactivate();
            timers.fireAll();
            timers.fireAll();
            assert.equal(moves.n, 1, 'no motion while paused');
            vc.activate();
            timers.fireAll();
            assert.equal(moves.n, 2);
        });

        it("a screen cover's make-up redraw draws a paused view", () => {
            const client = makeClient();
            const menu = makeModule(client);
            const a = buildForm(client, {
                vc: menu.addViewController('a', new ViewController({ client })),
            });
            const b = buildForm(client, {
                vc: menu.addViewController('b', new ViewController({ client })),
                row: 4,
            });
            a.ticker.setPropertyValue('pauseWhenInactive', true);
            a.vc.deactivate();
            b.vc.activate();
            let n;
            menu.coverScreen(
                finish => {
                    timers.fireAll();
                    timers.fireAll();
                    n = client.term.out.length;
                    finish(null);
                },
                () => {}
            );
            const out = client.term.since(n);
            assert.ok(out.includes(OTHER_TICKER_GOTO), 'running ticker redrawn');
            assert.ok(out.includes(TICKER_GOTO), 'paused ticker redrawn too');
            n = client.term.out.length;
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(TICKER_GOTO), 'still paused');
        });

        it('uncover({ redraw: true }) draws a paused view', () => {
            const client = makeClient();
            const { vc } = pausedForm(client);
            vc.cover();
            timers.fireAll();
            const n = client.term.out.length;
            vc.uncover({ redraw: true });
            const out = client.term.since(n);
            assert.ok(out.includes(TICKER_GOTO));
            assert.ok(out.includes('\x1b[20;5H'), 'field redrawn');
        });

        it('a form built detached and never deactivated is not inactive: it ticks', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            const ticker = makeTicker(client);
            ticker.setPropertyValue('pauseWhenInactive', true);
            vc.addView(ticker);
            vc.redrawAll();
            assert.ok(!vc.attached);
            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(n).includes(TICKER_GOTO));
        });

        it('without the property an inactive form keeps animating', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.deactivate();
            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(n).includes(TICKER_GOTO));
        });

        it('applies from mci config', () => {
            const client = makeClient();
            client.currentMenuModule = { menuConfig: {}, menuMethods: {} };
            const vc = new ViewController({ client });
            const menuView = new VerticalMenuView({
                client,
                id: 1,
                position: { row: 5, col: 1 },
            });
            vc.addView(menuView);
            vc.setViewPropertiesFromMCIConf(menuView, { pauseWhenInactive: true });
            const { isPauseWhenInactive } = require('../core/view.js');
            assert.equal(isPauseWhenInactive(menuView), true);
        });
    });

    describe('re-attaching goes through the form states', () => {
        it('switchFocus() on a covered form uncovers and activates it', () => {
            const client = makeClient();
            const { vc, field } = buildForm(client);
            vc.cover();
            vc.switchFocus(1);
            assert.equal(FormState.getFormCoverToken(vc), null, 'cover given back');
            assert.equal(FormState.isFormInactive(vc), false);
            assert.equal(View.isBackgroundDrawSuspended(client), false);
            type(client, 'k');
            assert.equal(field.getData(), 'k');
            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(n).includes(TICKER_GOTO), 'ticker draws again');
        });

        it('attachClientEvents() on a covered form uncovers it, redrawing what it missed', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.cover();
            timers.fireAll();
            const n = client.term.out.length;
            vc.attachClientEvents();
            assert.ok(client.term.since(n).includes(TICKER_GOTO), 'missed draw made up');
            assert.equal(FormState.isFormPaused(vc), false);
            assert.equal(vc.attached, true);
        });

        it('on a form never deactivated or covered, attachClientEvents() is unchanged', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            vc.addView(makeTicker(client));
            const base = keyListeners(client);
            const n = client.term.out.length;
            vc.attachClientEvents();
            vc.attachClientEvents();
            assert.equal(keyListeners(client), base + 1);
            assert.equal(client.term.since(n), '', 'nothing drawn');
        });
    });

    describe('core does not dispatch through the new public methods', () => {
        class ModForm extends ViewController {
            activate() {
                this.modActivate = (this.modActivate || 0) + 1;
            }
            deactivate() {
                this.modDeactivate = (this.modDeactivate || 0) + 1;
            }
            cover() {
                this.modCover = true;
            }
            uncover() {
                this.modUncover = true;
            }
            destroy() {
                this.modDestroy = true;
            }
        }

        it('setFocus(true) attaches a subclass that defines its own activate()', () => {
            const client = makeClient();
            const vc = new ModForm({ client, detached: true });
            const field = new EditTextView({
                client,
                id: 1,
                position: { row: 20, col: 5 },
                dimens: { width: 30 },
                maxLength: 30,
            });
            vc.addView(field);
            vc.setViewOrder();
            vc.focusedView = field;
            const base = keyListeners(client);
            vc.setFocus(true);
            assert.equal(vc.modActivate, undefined);
            assert.equal(vc.attached, true);
            assert.ok(keyListeners(client) > base, 'key handler attached');
            assert.equal(field.hasFocus, true);
            type(client, 'ok');
            assert.equal(field.getData(), 'ok');
        });

        it('leave() destroys a subclass form without calling its destroy()', () => {
            const client = makeClient();
            const menu = makeModule(client);
            const { vc, ticker } = buildForm(client, {
                vc: menu.addViewController('mod', new ModForm({ client })),
            });
            menu.leave();
            assert.equal(vc.modDestroy, undefined);
            assert.equal(FormState.isFormDestroyed(vc), true);
            assert.equal(View.isDestroyed(ticker), true);
        });
    });

    describe('cover token hygiene', () => {
        it('cover() after a menu change dropped its suspend takes a new one', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.cover();
            View.dropBackgroundDrawSuspends(client);
            assert.equal(FormState.getFormCoverToken(vc), null, 'no longer covered');
            assert.equal(FormState.isFormInactive(vc), true, 'still inactive');
            let n = client.term.out.length;
            timers.fireAll();
            assert.ok(
                client.term.since(n).includes(TICKER_GOTO),
                'inactive forms animate'
            );

            vc.cover();
            assert.notEqual(FormState.getFormCoverToken(vc), null);
            n = client.term.out.length;
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(TICKER_GOTO), 'covered again');
            vc.uncover();
            assert.equal(View.isBackgroundDrawSuspended(client), false);
        });

        it('uncover() on a form whose suspend was dropped, and uncover(null), do not throw', () => {
            const client = makeClient();
            const { vc } = buildForm(client);
            vc.uncover(null);
            vc.cover();
            View.dropBackgroundDrawSuspends(client);
            vc.uncover(null);
            vc.uncover({ redraw: true });
            vc.activate();
            assert.equal(vc.attached, true);
        });

        it("a menu change releases a dropped owner-less form's cover", () => {
            const client = makeClient();
            for (let i = 0; i < 5; ++i) {
                buildForm(client).vc.cover(); //  never uncovered or destroyed
            }
            assert.equal(View.isBackgroundDrawSuspended(client), true);
            View.dropBackgroundDrawSuspends(client); //  MenuStack._settleCovers()
            assert.equal(View.isBackgroundDrawSuspended(client), false);
        });

        it('setFocus(false) then destroy() on a covered form', () => {
            const client = makeClient();
            const { vc, ticker } = buildForm(client);
            vc.cover();
            vc.setFocus(false);
            assert.equal(
                View.isBackgroundDrawSuspended(client),
                false,
                'teardown released it'
            );
            assert.equal(View.isDestroyed(ticker), true);
            vc.destroy();
            assert.equal(FormState.isFormDestroyed(vc), true);
            assert.equal(timers.live(), 0);
        });
    });
});
