'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { TickerView } = require('../core/ticker_view.js');

//
//  The screens shown over a menu whose forms stay attached are covers
//  (core/screen_cover.js): while one is up the menu's ticker draws nothing
//  over it, the key that ends it reaches only the cover (no form field, no
//  action key), and the menu is repainted after.
//

const MENU_CONFIG = { debug: { assertsEnabled: false }, menus: { cls: false } };
const MENU_TICKER_GOTO = '\x1b[2;10H';

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
        restore() {
            Object.assign(global, saved);
        },
    };
}

//  A menu's form: a ticker and a focused field with Escape bound
function attachMenuForm(client) {
    const vc = new ViewController({ client });
    const ticker = new TickerView({
        client,
        id: 9,
        position: { row: 2, col: 10 },
        dimens: { width: 20, height: 1 },
        text: 'Welcome to the board -- news, files and doors',
        motion: 'left',
    });
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

function makeModule(client, configPatch = {}) {
    const { MenuModule } = require('../core/menu_module.js');
    const mod = new MenuModule({
        menuName: 'testMenu',
        menuConfig: { config: configPatch, art: null },
        client,
    });
    client.currentMenuModule = mod;
    return mod;
}

describe('Screens shown over a menu are covers', () => {
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

    describe('MenuModule.coverScreen()', () => {
        it('is coverScreen() for the menu client', done => {
            const client = makeClient();
            const mod = makeModule(client);
            const { field } = attachMenuForm(client);
            mod.coverScreen(
                finish => {
                    assert.equal(View.isBackgroundDrawSuspended(client), true);
                    client.emit('key press', 'q');
                    finish(null, 'result');
                },
                (err, result) => {
                    assert.ifError(err);
                    assert.equal(result, 'result');
                    assert.equal(field.getData(), '', 'the key went nowhere');
                    assert.equal(View.isBackgroundDrawSuspended(client), false);
                    return done();
                }
            );
        });
    });

    describe('gotoMenuOrShowMessage(), the error path', () => {
        it('message and pause over the attached menu, then prevMenu() uncovered', done => {
            const client = makeClient();
            const mod = makeModule(client);
            const { field, submits } = attachMenuForm(client);

            mod.gotoMenu = (name, options, cb) => cb(new Error('no such menu'));
            let pauseKey = null;
            mod.pausePrompt = cb => {
                client.waitForKeyPress((ch, key) => {
                    pauseKey = key;
                    cb(null);
                });
            };
            mod.prevMenu = cb => {
                assert.equal(View.isBackgroundDrawSuspended(client), false);
                assert.equal(client.hasInputCapture(), false);
                return cb(null);
            };

            const n = client.term.out.length;
            mod.gotoMenuOrShowMessage('nowhere', 'Not today', err => {
                assert.ifError(err);
                assert.deepEqual(pauseKey, { name: 'escape' });
                assert.equal(submits.n, 0, 'Escape did not run the form action');
                assert.equal(field.getData(), '');
                //  prevMenu() repaints: the ticker is not redrawn first
                assert.ok(!client.term.since(n).includes(MENU_TICKER_GOTO));
                return done();
            });

            assert.ok(client.term.since(n).includes('Not today'));
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(MENU_TICKER_GOTO), 'no ticker');
            client.emit('key press', '\x1b', { name: 'escape' });
        });
    });
});
