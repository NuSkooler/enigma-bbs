'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const InputCapture = require('../core/input_capture.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');

//
//  The per-client input capture stack (core/input_capture.js): while a
//  capture is active only the top capture's handler gets a key, and no
//  ViewController's key handler does anything. client.waitForKeyPress() is a
//  capture, so the key that ends a pause or a help page does not also reach
//  a form left attached under it (#1136, #1137).
//

function makeTerm() {
    const term = {
        termWidth: 80,
        termHeight: 25,
        out: [],
        disconnect() {},
    };
    term.write = s => term.out.push(String(s));
    term.rawWrite = term.write;
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    return term;
}

function makeLog() {
    const log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = () => {};
    });
    return log;
}

//  A mock client: what the views and forms use, and the capture methods
//  from Client.prototype, as a real client has them
function makeClient() {
    const client = new events.EventEmitter();
    client.log = makeLog();
    client.term = makeTerm();
    client.currentMenuModule = { menuName: 'someMenu', menuConfig: {}, menuMethods: {} };
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    return client;
}

//  A form with one focused command field, like a menu's prompt ET1
function makeForm(client) {
    const vc = new ViewController({ client });
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
    return { vc, field };
}

function type(client, chars) {
    for (const ch of chars) {
        client.emit('key press', ch);
    }
}

describe('Input capture stack', () => {
    describe('dispatch', () => {
        it('gives a key only to the top capture', () => {
            const client = makeClient();
            const got = { a: [], b: [] };
            client.captureInput(ch => got.a.push(ch));
            client.captureInput(ch => got.b.push(ch));

            type(client, 'x');

            assert.deepEqual(got, { a: [], b: ['x'] });
        });

        it('passes the key object with the character', () => {
            const client = makeClient();
            let got;
            client.captureInput((ch, key) => (got = { ch, key }));
            const key = { name: 'escape' };
            client.emit('key press', '\x1b', key);
            assert.equal(got.ch, '\x1b');
            assert.equal(got.key, key);
        });

        it('goes back to the capture underneath when the top one is released', () => {
            const client = makeClient();
            const got = { a: [], b: [] };
            client.captureInput(ch => got.a.push(ch));
            const top = client.captureInput(ch => got.b.push(ch));

            type(client, '1');
            assert.equal(client.releaseInput(top), true);
            type(client, '2');

            assert.deepEqual(got, { a: ['2'], b: ['1'] });
            assert.equal(client.hasInputCapture(), true);
        });

        it('releases a token that is not on top without disturbing the top', () => {
            const client = makeClient();
            const got = { a: [], b: [] };
            const lower = client.captureInput(ch => got.a.push(ch));
            const top = client.captureInput(ch => got.b.push(ch));

            assert.equal(client.releaseInput(lower), true);
            type(client, '1');
            assert.deepEqual(got, { a: [], b: ['1'] });

            client.releaseInput(top);
            assert.equal(client.hasInputCapture(), false);
            type(client, '2');
            assert.deepEqual(got, { a: [], b: ['1'] }, 'nothing captures now');
        });

        it('ignores a token released twice, or one it never gave out', () => {
            const client = makeClient();
            const token = client.captureInput(() => {});
            assert.equal(client.releaseInput(token), true);
            assert.equal(client.releaseInput(token), false);
            assert.equal(client.releaseInput({ handler() {} }), false);
            assert.equal(client.releaseInput(null), false);
            assert.equal(InputCapture.releaseInput(makeClient(), token), false);
        });

        it('requires a handler function', () => {
            assert.throws(() => makeClient().captureInput(), TypeError);
        });

        it('still delivers to direct key press listeners on the client', () => {
            //  a door's or WFC's own key handling is not a form; phase 1
            //  leaves those listeners as they were
            const client = makeClient();
            const direct = [];
            client.on('key press', ch => direct.push(ch));
            client.captureInput(() => {});

            type(client, 'q');
            assert.deepEqual(direct, ['q']);
        });

        it('keeps each client separate', () => {
            const a = makeClient();
            const b = makeClient();
            const { field } = makeForm(b);
            a.captureInput(() => {});

            type(b, 'hi');
            assert.equal(field.getData(), 'hi');
        });
    });

    describe('forms under a capture', () => {
        it('gives a focused field nothing while captured, and keys again after', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            type(client, 'a');

            const token = client.captureInput(() => {});
            type(client, 'bc');
            assert.equal(field.getData(), 'a', 'captured keys do not reach the field');

            client.releaseInput(token);
            type(client, 'd');
            assert.equal(field.getData(), 'ad');
        });

        it('fires no action key while captured', () => {
            const client = makeClient();
            const { vc } = makeForm(client);
            let submits = 0;
            vc.on('submit', () => ++submits);
            vc.mapActionKeys([{ keys: ['escape'], viewId: 1 }], 'form');

            const token = client.captureInput(() => {});
            client.emit('key press', '\x1b', { name: 'escape' });
            assert.equal(submits, 0);

            client.releaseInput(token);
            client.emit('key press', '\x1b', { name: 'escape' });
            assert.equal(submits, 1, 'the binding works again after release');
        });

        it('silences a form attached after the capture began', () => {
            //  its 'key press' listener comes after the capture dispatcher
            const client = makeClient();
            const token = client.captureInput(() => {});
            const { field } = makeForm(client);

            type(client, 'x');
            assert.equal(field.getData(), '');

            client.releaseInput(token);
            type(client, 'y');
            assert.equal(field.getData(), 'y');
        });

        it('keeps the key from a form when the capture releases itself on it', () => {
            //  the form's handler runs after the capture has gone
            const client = makeClient();
            const { field } = makeForm(client);
            const token = client.captureInput(() => client.releaseInput(token));
            const { field: later } = makeForm(client);

            type(client, 'x');
            assert.equal(field.getData(), '', 'form attached before the capture');
            assert.equal(later.getData(), '', 'form attached after the capture');
            assert.equal(client.hasInputCapture(), false);
        });

        it('lets the forms have keys when nothing was ever captured', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            type(client, 'ok');
            assert.equal(field.getData(), 'ok');
            assert.equal(InputCapture.isKeyPressCaptured(client), false);
        });
    });

    describe('waitForKeyPress()', () => {
        it('calls back once, with the key, and not the form', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            const got = [];
            client.waitForKeyPress((ch, key) => got.push({ ch, key }));

            const key = { name: 'x' };
            client.emit('key press', 'x', key);
            assert.deepEqual(got, [{ ch: 'x', key }]);
            assert.equal(field.getData(), '', 'the dismissing key is not typed');

            type(client, 'y');
            assert.equal(got.length, 1, 'called back once');
            assert.equal(field.getData(), 'y', 'the next key is the form’s');
        });

        it('lets a second key in the same burst reach the form', () => {
            //  a paste: two keys decoded from one read, one after the other
            const client = makeClient();
            const { field } = makeForm(client);
            let calls = 0;
            client.waitForKeyPress(() => ++calls);

            type(client, 'ab');
            assert.equal(calls, 1);
            assert.equal(field.getData(), 'b');
        });

        it('returns a token that abandons the wait', () => {
            const client = makeClient();
            let calls = 0;
            const token = client.waitForKeyPress(() => ++calls);
            assert.equal(client.releaseInput(token), true);
            type(client, 'a');
            assert.equal(calls, 0);
        });

        it('waits for the next key when started from a capture handler', () => {
            const client = makeClient();
            const got = [];
            client.waitForKeyPress(ch => {
                got.push(`first:${ch}`);
                client.waitForKeyPress(ch2 => got.push(`second:${ch2}`));
            });

            type(client, '12');
            assert.deepEqual(got, ['first:1', 'second:2']);
        });

        it('a nested wait on top gets the key; the one under it the next', () => {
            const client = makeClient();
            const got = [];
            client.waitForKeyPress(ch => got.push(`outer:${ch}`));
            client.waitForKeyPress(ch => got.push(`inner:${ch}`));

            type(client, '12');
            assert.deepEqual(got, ['inner:1', 'outer:2']);
        });
    });

    describe('a real Client', () => {
        let client;
        beforeEach(() => {
            client = new Client();
            client.log = makeLog();
            client.term = makeTerm();
            client.disconnect = () => {};
        });
        afterEach(() => {
            client.end(); //  removes its theme listener; safe to repeat
        });

        it('has the capture methods, and waitForKeyPress() captures', () => {
            const got = [];
            client.waitForKeyPress(ch => got.push(ch));
            assert.equal(client.hasInputCapture(), true);

            client.emit('key press', 'a');
            client.emit('key press', 'b');
            assert.deepEqual(got, ['a']);
            assert.equal(client.hasInputCapture(), false);
        });

        it('drops every capture when the client ends', () => {
            let calls = 0;
            client.captureInput(() => ++calls);
            client.waitForKeyPress(() => ++calls);

            client.end();
            assert.equal(client.hasInputCapture(), false);

            client.emit('key press', 'a');
            assert.equal(calls, 0);
        });
    });
});
