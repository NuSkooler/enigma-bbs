'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { ViewController } = require('../core/view_controller.js');
const { TickerView } = require('../core/ticker_view.js');
const { HorizontalMenuView } = require('../core/horizontal_menu_view.js');
const { TextView } = require('../core/text_view.js');
const FormState = require('../core/form_state.js');

//
//  The ActivityPub message viewer gives every key to its footer menu; the
//  body (the note and its %TL10+ fields) stays on screen. It is deactivated
//  (F3b), not torn down: a ticker in the body art keeps running and its
//  views keep their listeners. Before, setFocus(false) destroyed them.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
};

const BODY_TICKER = '\x1b[3;60H';

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
        restore() {
            Object.assign(global, saved);
        },
    };
}

describe('ActivityPub message viewer form states (F3b)', () => {
    let previousConfig;
    let timers;
    let Viewer;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
        Viewer = require('../core/activitypub/activity_pub_msg_viewer.js').getModule;
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

    //  initSequence() with its art and note stubbed: the body and footer
    //  forms are built from views, as prepViewController() builds them
    function openViewer() {
        const client = makeClient();
        const inst = Object.create(Viewer.prototype);
        inst.client = client;
        inst.viewControllers = {};
        inst.menuConfig = { config: { art: { body: 'B', footer: 'F' } } };
        client.currentMenuModule = inst;

        const v = {
            ticker: new TickerView({
                client,
                id: 9,
                position: { row: 3, col: 60 },
                dimens: { width: 8, height: 1 },
                text: 'BOOSTED -- FAVOURITED',
                motion: 'left',
                holdTicks: 1,
            }),
            from: new TextView({
                client,
                id: 10,
                position: { row: 2, col: 1 },
                dimens: { width: 20 },
            }),
            menu: new HorizontalMenuView({
                client,
                id: 1,
                position: { row: 24, col: 1 },
                items: ['prev', 'next', 'reply', 'quit'],
            }),
        };

        //  a module's listener on a body view, bound as it is built
        v.from.on('custom', () => {});

        inst.beforeArt = cb => cb(null);
        inst.displayAsset = (art, opts, cb) => cb(null, { height: 20, mciMap: {} });
        inst.prepViewController = (name, formId, mciMap, cb) => {
            const vc = new ViewController({ client, formId });
            const views = 'body' === name ? [v.ticker, v.from] : [v.menu];
            views.forEach(view => vc.addView(view));
            vc.setViewOrder();
            vc.redrawAll();
            vc.switchFocus(views[views.length - 1].id);
            inst.viewControllers[name] = vc;
            return cb(null, vc, true);
        };
        inst._displayNote = cb => cb(null);
        inst.finishedLoading = () => {
            inst.loaded = true;
        };

        inst.initSequence();
        assert.ok(inst.loaded);
        return { client, inst, v, vcs: inst.viewControllers };
    }

    it('the footer has the keys; the body is inactive, kept, and its ticker draws', () => {
        const { client, v, vcs } = openViewer();

        assert.equal(vcs.footer.attached, true);
        assert.equal(vcs.body.attached, false);
        assert.ok(FormState.isFormInactive(vcs.body));
        assert.ok(!FormState.isFormDestroyed(vcs.body));
        assert.equal(View.isDestroyed(v.ticker), false);
        assert.equal(View.isDestroyed(v.from), false);
        assert.equal(View.getInputFocusView(client), v.menu);

        const before = v.menu.getData();
        client.emit('key press', undefined, { name: 'right arrow' });
        assert.notEqual(v.menu.getData(), before, 'the footer menu takes the keys');

        const n = client.term.out.length;
        timers.fireAll();
        assert.ok(client.term.since(n).includes(BODY_TICKER), 'body ticker drew');
    });

    it('one key listener; the body view listeners are kept', () => {
        const { client, v } = openViewer();
        assert.equal(client.listeners('key press').length, 1);
        assert.equal(v.from.listenerCount('custom'), 1, 'kept (was removed)');
    });
});
