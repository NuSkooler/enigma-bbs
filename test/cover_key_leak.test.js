'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');
const { TickerView } = require('../core/ticker_view.js');

//
//  Regression tests, at mechanism level, for the key that ends a screen
//  shown over a form also reaching that form:
//
//  #1136  a realtime interrupt over a menu: the key that dismisses it was
//         typed into the menu's focused field.
//  #1137  FSE Ctrl-O help over the message body: the key that dismisses it
//         was inserted into the message (and Escape ran the body's action).
//
//  Both waited with client.waitForKeyPress(), a plain once('key press')
//  that the attached form's handler also heard. It is a capture now.
//

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    const term = { termWidth: 80, termHeight: 25, out: [] };
    term.write = s => term.out.push(String(s));
    term.rawWrite = term.write;
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    client.term = term;
    client.currentMenuModule = { menuName: 'someMenu', menuConfig: {}, menuMethods: {} };
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    return client;
}

//  Interval timers fired by hand (the ticker starts one in its constructor)
function captureTimers() {
    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    global.setInterval = () => 1;
    global.clearInterval = () => {};
    return () => Object.assign(global, saved);
}

describe('A key that ends a cover does not reach the form under it', () => {
    let restoreTimers;
    beforeEach(() => {
        restoreTimers = captureTimers();
    });
    afterEach(() => {
        restoreTimers();
    });

    it('#1136: a menu with a ticker and a focused field, waiting for a key', () => {
        const client = makeClient();
        const vc = new ViewController({ client });
        vc.addView(
            new TickerView({
                client,
                id: 9,
                position: { row: 2, col: 10 },
                dimens: { width: 20, height: 1 },
                text: 'Welcome to the board',
                motion: 'left',
            })
        );
        const field = new EditTextView({
            client,
            id: 1,
            position: { row: 20, col: 5 },
            dimens: { width: 30 },
            maxLength: 30,
        });
        vc.addView(field);
        vc.setViewOrder();
        vc.redrawAll();
        vc.switchFocus(1);
        client.emit('key press', 'g');

        const got = [];
        client.waitForKeyPress(ch => got.push(ch));
        client.emit('key press', 'x');

        assert.deepEqual(got, ['x'], 'the waiter has the key');
        assert.equal(field.getData(), 'g', 'the field does not');
    });

    it('#1137: the message body (MLE) waiting behind help, Escape bound on its form', () => {
        const client = makeClient();
        const body = new ViewController({ client });
        const mle = new MultiLineEditTextView({
            client,
            id: 1,
            position: { row: 3, col: 1 },
            dimens: { width: 70, height: 10 },
        });
        body.addView(mle);
        body.setViewOrder();
        body.redrawAll();
        body.switchFocus(1);
        //  as the FSE body form binds it: switch focus and submit
        body.mapActionKeys([{ keys: ['escape'], viewId: 1 }], 'form');
        let submits = 0;
        body.on('submit', () => ++submits);

        for (const ch of 'Hi') {
            client.emit('key press', ch);
        }
        const before = mle.getData();
        assert.equal(before, 'Hi', 'precondition: the body takes keys');

        //  help is up: a printable key dismisses it
        let dismissed = 0;
        client.waitForKeyPress(() => ++dismissed);
        client.emit('key press', 'q');
        assert.equal(dismissed, 1);
        assert.equal(mle.getData(), before, 'not inserted into the message');

        //  ...and Escape
        client.waitForKeyPress(() => ++dismissed);
        client.emit('key press', '\x1b', { name: 'escape' });
        assert.equal(dismissed, 2);
        assert.equal(submits, 0, 'the body form action did not run');
        assert.equal(mle.getData(), before);

        //  back in the editor, keys reach the body again
        client.emit('key press', '!');
        assert.equal(mle.getData(), 'Hi!');
    });
});
