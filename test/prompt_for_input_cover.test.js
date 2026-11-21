'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { TextView } = require('../core/text_view.js');
const { TickerView } = require('../core/ticker_view.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const FormState = require('../core/form_state.js');

//
//  promptForInput({ prevFormName }) covers the previous form while its
//  prompt is up (F3b, C15): no key reaches it and its views do not draw in
//  the background, but they and their listeners are kept. On submit it is
//  uncovered and gets the keys back, its focused field focused again,
//  without a full redraw. Before, the previous form was torn down
//  (setFocus(false)): a ticker in it stopped for good, and its view
//  listeners were dropped, so modules bound them again after every prompt
//  (msg_list), which would now bind them twice.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
};

const TICKER_GOTO = '\x1b[2;60H';
const STATIC_GOTO = '\x1b[5;1H';
const DOWN = { name: 'down arrow' };

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
    return client;
}

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

function type(client, s) {
    for (const ch of s) {
        client.emit('key press', ch, undefined);
    }
}

//
//  theme.displayThemedPrompt() stand-in: the prompt form gets one field,
//  and its submit runs submitNotify, as loadFromPromptConfig() wires it
//
function stubThemedPrompt(theme, prompts) {
    const saved = theme.displayThemedPrompt;
    theme.displayThemedPrompt = (name, client, options, cb) => {
        const vc = options.viewController;
        const field = new EditTextView({
            client,
            id: 1,
            position: { row: 20, col: 10 },
            dimens: { width: 3 },
            maxLength: 3,
        });
        vc.addView(field);
        vc.setViewOrder();
        vc.on('submit', () => options.submitNotify());
        vc.switchFocus(1);
        prompts.push({ vc, field });
        return cb(null, { height: 1 });
    };
    return () => {
        theme.displayThemedPrompt = saved;
    };
}

//  A list menu (as msg_list's allViews): a ticker, a static label and the
//  focused list, whose 'index update' a module listens to
function makeMenu(client) {
    const { MenuModule } = require('../core/menu_module.js');
    const mod = new MenuModule({
        menuName: 'listMenu',
        menuConfig: { config: {} },
        client,
    });
    client.currentMenuModule = mod;

    const vc = mod.addViewController('allViews', new ViewController({ client }));
    const ticker = new TickerView({
        client,
        id: 9,
        position: { row: 2, col: 60 },
        dimens: { width: 8, height: 1 },
        text: 'NEWS -- FILES -- DOORS',
        motion: 'left',
        holdTicks: 1,
    });
    const label = new TextView({
        client,
        id: 5,
        position: { row: 5, col: 1 },
        dimens: { width: 10 },
        text: 'STATIC',
    });
    const list = new VerticalMenuView({
        client,
        id: 1,
        position: { row: 8, col: 1 },
        dimens: { width: 20, height: 5 },
        items: ['one', 'two', 'three', 'four'],
    });
    [ticker, label, list].forEach(view => vc.addView(view));
    vc.setViewOrder();
    vc.redrawAll();
    vc.switchFocus(1);

    const indexUpdates = [];
    list.on('index update', idx => indexUpdates.push(idx));
    return { mod, vc, ticker, label, list, indexUpdates };
}

describe('promptForInput() covers the previous form (F3b)', () => {
    let previousConfig;
    let timers;
    let theme;
    let restorePrompt;
    let prompts;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
        theme = require('../core/theme.js');
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });
    beforeEach(() => {
        timers = captureTimers();
        prompts = [];
        restorePrompt = stubThemedPrompt(theme, prompts);
    });
    afterEach(() => {
        restorePrompt();
        timers.restore();
    });

    function ask(mod) {
        mod.promptForInput(
            {
                formName: 'delPrompt',
                formId: 1,
                promptName: 'deleteMessageFromListPrompt',
                prevFormName: 'allViews',
                position: { row: 20, col: 1 },
            },
            { clearAtSubmit: true, clearWidth: 20 },
            err => assert.ifError(err)
        );
        return prompts[prompts.length - 1];
    }

    it('while the prompt is up: keys reach the prompt only; the form is covered, kept', () => {
        const client = makeClient();
        const { mod, vc, ticker, list } = makeMenu(client);
        const prompt = ask(mod);

        assert.ok(FormState.getFormCoverToken(vc), 'covered');
        assert.equal(vc.attached, false);
        assert.equal(View.isDestroyed(ticker), false);
        assert.equal(View.isDestroyed(list), false);
        assert.equal(View.getInputFocusView(client), prompt.field);

        const focusedIndex = list.getData();
        client.emit('key press', undefined, DOWN);
        type(client, 'y');
        assert.equal(list.getData(), focusedIndex, 'the list did not move');
        assert.equal(prompt.field.getData(), 'y');

        const n = client.term.out.length;
        timers.fireAll();
        assert.ok(
            !client.term.since(n).includes(TICKER_GOTO),
            'no draw under the prompt'
        );
    });

    it('on submit: the keys and the cursor go back to the list; no full redraw; the ticker runs', () => {
        const client = makeClient();
        const { mod, vc, list } = makeMenu(client);
        const prompt = ask(mod);
        timers.fireAll(); //  the ticker misses a draw

        const n = client.term.out.length;
        prompt.vc.submitForm();
        const sent = client.term.since(n);

        assert.equal(FormState.getFormCoverToken(vc), null);
        assert.equal(vc.attached, true);
        assert.equal(list.hasFocus, true);
        assert.equal(View.getInputFocusView(client), list);
        assert.equal(mod.viewControllers.delPrompt, undefined, 'prompt form removed');
        assert.ok(sent.includes(TICKER_GOTO), 'the missed tick is drawn once');
        assert.ok(!sent.includes(STATIC_GOTO), 'the static label is not redrawn');

        const m = client.term.out.length;
        timers.fireAll();
        assert.ok(client.term.since(m).includes(TICKER_GOTO), 'ticks again');

        const before = list.getData();
        client.emit('key press', undefined, DOWN);
        assert.notEqual(list.getData(), before, 'the list takes keys again');
    });

    it('prompt cycles: one key listener; the list listener kept and fired once', () => {
        const client = makeClient();
        const { mod, list, indexUpdates } = makeMenu(client);
        const base = client.listeners('key press').length;

        for (let i = 0; i < 3; ++i) {
            const prompt = ask(mod);
            prompt.vc.submitForm();
            assert.equal(client.listeners('key press').length, base);
        }

        assert.equal(list.listenerCount('index update'), 1);
        assert.equal(list.listenerCount('action'), 1);
        indexUpdates.length = 0;
        client.emit('key press', undefined, DOWN);
        assert.equal(indexUpdates.length, 1, 'fired once per move');
        assert.equal(timers.live(), 1, 'one ticker timer');
    });

    it('a menu left while the prompt is up: submit leaves the form destroyed', () => {
        const client = makeClient();
        const { mod, vc } = makeMenu(client);
        const prompt = ask(mod);
        mod.leave();
        prompt.vc.submitForm();
        assert.ok(FormState.isFormDestroyed(vc));
        assert.equal(vc.attached, false);
        assert.equal(View.isBackgroundDrawSuspended(client), false);
        assert.equal(timers.live(), 0);
    });
});

describe('msg_list: the list listener is bound once (F3b)', () => {
    const MessageListModule = require('../core/msg_list.js').getModule;

    function makeList() {
        const mod = new MessageListModule({
            menuName: 'messageBaseMessageList',
            menuConfig: { config: { messageList: [] } },
            client: {
                log: { error: () => {}, info: () => {} },
                user: { userId: 1 },
            },
        });
        const list = new events.EventEmitter();
        mod.viewControllers.allViews = { getView: () => list };
        mod.labelled = [];
        mod.populateCustomLabelsForSelected = idx => mod.labelled.push(idx);
        return { mod, list };
    }

    it('deleteMessageNo after each prompt does not stack the listener', done => {
        const { mod, list } = makeList();
        mod.enableMessageListIndexUpdates(list); //  as the list loads

        let n = 0;
        const again = () => {
            mod.menuMethods.deleteMessageNo({}, {}, err => {
                assert.ifError(err);
                if (++n < 3) {
                    return again();
                }
                assert.equal(list.listenerCount('index update'), 1);
                list.emit('index update', 2);
                assert.deepEqual(mod.labelled, [2], 'labels updated once');
                return done();
            });
        };
        again();
    });

    it('each list module binds its own listener', () => {
        const a = makeList();
        const b = makeList();
        a.mod.enableMessageListIndexUpdates(a.list);
        b.mod.enableMessageListIndexUpdates(a.list);
        assert.equal(a.list.listenerCount('index update'), 2);
        a.list.emit('index update', 1);
        assert.deepEqual(a.mod.labelled, [1]);
        assert.deepEqual(b.mod.labelled, [1]);
    });
});
