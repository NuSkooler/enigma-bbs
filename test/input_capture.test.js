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
//  ViewController's key handler does anything. Covers (an interrupt, a help
//  page) hold one, so the key that ends them does not also reach a form
//  left attached under it (#1136, #1137). client.waitForKeyPress() is not a
//  capture: it is a plain once('key press'), as it always was.
//

//  A capture that takes one key and lets go, as a help page's does
function captureOnce(client, cb) {
    const token = client.captureInput((ch, key) => {
        client.releaseInput(token);
        cb(ch, key);
    });
    return token;
}

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

        it('a capture opened while a key is delivered does not hide that key from later listeners', () => {
            //  Before captures, every 'key press' listener saw every key. A
            //  form whose action opens a help page takes it for the next
            //  key; a form attached after it still sees this one.
            const client = makeClient();
            client.releaseInput(client.captureInput(() => {})); //  dispatcher in
            const got = [];
            client.on('key press', ch => {
                if (InputCapture.isKeyPressCaptured(client)) {
                    return got.push('vc1 ignored');
                }
                got.push(`vc1 ${ch}`);
                captureOnce(client, () => got.push('help'));
            });
            client.on('key press', ch => {
                got.push(
                    InputCapture.isKeyPressCaptured(client) ? 'vc2 ignored' : `vc2 ${ch}`
                );
            });

            client.emit('key press', 'x', {});
            assert.deepEqual(got, ['vc1 x', 'vc2 x']);
            client.emit('key press', 'y', {});
            assert.deepEqual(
                got,
                ['vc1 x', 'vc2 x', 'help', 'vc1 ignored', 'vc2 ignored'],
                'the next key is the help page’s, and no form’s'
            );
        });

        it('a form whose action opens a help page: a later form still gets that key, the help page the next', () => {
            const client = makeClient();
            client.releaseInput(client.captureInput(() => {}));
            const first = makeForm(client);
            const second = makeForm(client); //  attached after the first
            let paused = 0;
            first.vc.mapActionKeys([{ keys: ['x'], viewId: 1 }], 'form');
            first.vc.on('submit', () => captureOnce(client, () => ++paused));

            type(client, 'x');
            assert.equal(second.field.getData(), 'x', 'the later form saw it, as before');
            assert.equal(paused, 0);
            type(client, 'z');
            assert.equal(paused, 1, 'the help page got the next key');
            assert.equal(first.field.getData(), '');
            assert.equal(second.field.getData(), 'x', 'and no form did');
        });

        it('a mock client with no dispatcher: every capture held counts', () => {
            const client = new events.EventEmitter();
            client.prependListener = undefined; //  a stand-in that cannot
            InputCapture.captureInput(client, () => {});
            assert.equal(InputCapture.isKeyPressCaptured(client), true);
        });

        it('lets the forms have keys when nothing was ever captured', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            type(client, 'ok');
            assert.equal(field.getData(), 'ok');
            assert.equal(InputCapture.isKeyPressCaptured(client), false);
        });
    });

    describe('waitForKeyPress() (a plain once(), not a capture)', () => {
        it('calls back once, with the key, which also reaches the form', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            const got = [];
            client.waitForKeyPress((ch, key) => got.push({ ch, key }));
            assert.equal(client.hasInputCapture(), false, 'a wait is not a capture');

            const key = { name: 'x' };
            client.emit('key press', 'x', key);
            assert.deepEqual(got, [{ ch: 'x', key }]);
            assert.equal(field.getData(), 'x', 'the form hears it too, as always');

            type(client, 'y');
            assert.equal(got.length, 1, 'called back once');
            assert.equal(field.getData(), 'xy');
        });

        it('runs in registration order with direct listeners', () => {
            const client = makeClient();
            client.releaseInput(client.captureInput(() => {})); //  dispatcher in
            const order = [];
            let mode = 'paused';
            client.on('key press', () => order.push(`direct(${mode})`));
            client.waitForKeyPress(() => {
                order.push('wait');
                mode = 'list';
            });
            client.on('key press', () => order.push(`later(${mode})`));

            type(client, 'x');
            assert.deepEqual(order, ['direct(paused)', 'wait', 'later(list)']);
        });

        it('a wait callback that throws does not keep the key from earlier listeners', () => {
            const client = makeClient();
            const seen = [];
            client.on('key press', () => seen.push('direct'));
            client.waitForKeyPress(() => {
                throw new Error('boom');
            });
            assert.throws(() => type(client, 'x'), /boom/);
            assert.deepEqual(seen, ['direct']);
        });

        it('an abandoned wait fires on the next key, which still reaches the form', () => {
            const client = makeClient();
            const got = [];
            client.waitForKeyPress(() => got.push('stale wait'));
            //  the operation it waited on ended by itself: back to the form
            const { field } = makeForm(client);
            type(client, 'abc');
            assert.equal(field.getData(), 'abc');
            assert.deepEqual(got, ['stale wait']);
        });

        it('two pending waits both get the one key, oldest first, and so does the form', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            const got = [];
            client.waitForKeyPress(ch => got.push(`outer:${ch}`));
            client.waitForKeyPress(ch => got.push(`inner:${ch}`));

            type(client, '1');
            assert.deepEqual(got, ['outer:1', 'inner:1']);
            assert.equal(field.getData(), '1');
        });

        it('a wait started from a wait callback gets the next key, not this one', () => {
            const client = makeClient();
            const got = [];
            client.waitForKeyPress(ch => {
                got.push(`a:${ch}`);
                client.waitForKeyPress(ch2 => got.push(`b:${ch2}`));
            });
            type(client, '12');
            assert.deepEqual(got, ['a:1', 'b:2']);
        });

        it('under a capture, a wait still hears its key; the forms do not', () => {
            //  a cover's pause: the cover holds a capture, its pause waits
            const client = makeClient();
            const { field } = makeForm(client);
            const got = [];
            const cover = client.captureInput(() => got.push('cover'));
            client.waitForKeyPress(ch => {
                got.push(`wait:${ch}`);
                client.releaseInput(cover); //  the cover ends on this key
            });
            const { field: later } = makeForm(client);

            type(client, 'q');
            assert.deepEqual(got, ['cover', 'wait:q']);
            assert.equal(field.getData(), '', 'form attached before the wait');
            assert.equal(later.getData(), '', 'form attached after it');
            type(client, 'r');
            assert.equal(field.getData(), 'r', 'the cover has gone');
        });
    });

    describe('the dispatcher', () => {
        it('is put back by the next capture if something removed it', () => {
            const client = makeClient();
            const { field } = makeForm(client);
            client.captureInput(() => {}); //  installs it
            client.removeAllListeners('key press'); //  a mod tidying up

            //  forms re-attach their own handler as they do; the capture
            //  must still win the key
            const form = makeForm(client);
            const got = [];
            captureOnce(client, ch => got.push(ch));
            assert.equal(client.listeners('key press')[0].name, 'dispatcher');
            type(client, 'x');
            assert.deepEqual(got, ['x'], 'the capture gets its key: no hang');
            assert.equal(form.field.getData(), '');
            assert.equal(field.getData(), '');
        });

        it('is put back, and its claim reset, when a form attaches', () => {
            const client = makeClient();
            const got = [];
            captureOnce(client, ch => got.push(ch)); //  installs it
            type(client, 'a'); //  claimed by the capture
            client.removeAllListeners('key press'); //  a mod tidying up

            const { field } = makeForm(client); //  attaches: dispatcher back
            assert.equal(client.listeners('key press')[0].name, 'dispatcher');
            type(client, 'b');
            assert.equal(field.getData(), 'b', 'not left silent by a stale claim');
            captureOnce(client, ch => got.push(ch));
            type(client, 'c');
            assert.deepEqual(got, ['a', 'c'], 'a later capture still hears its key');
            assert.equal(field.getData(), 'b');
        });

        it('is put back when a capture is released', () => {
            const client = makeClient();
            const token = client.captureInput(() => {});
            const held = client.captureInput(() => {});
            client.removeAllListeners('key press');
            client.releaseInput(token);
            assert.equal(client.listeners('key press')[0].name, 'dispatcher');
            const got = [];
            client.releaseInput(held);
            captureOnce(client, ch => got.push(ch));
            type(client, 'k');
            assert.deepEqual(got, ['k']);
        });

        it('a leftover handler that releases another leftover stops its delivery', () => {
            const client = makeClient();
            const got = [];
            let second = null;
            client.captureInput(ch => {
                got.push(`first:${ch}`);
                client.releaseInput(second);
            });
            second = client.captureInput(ch => got.push(`second:${ch}`));
            InputCapture.menuChanged(client); //  both are leftovers now

            type(client, 'a');
            assert.deepEqual(got, ['first:a'], 'the released one hears nothing');
        });

        it('is not installed twice', () => {
            const client = makeClient();
            client.captureInput(() => {});
            client.captureInput(() => {});
            assert.equal(client.listenerCount('key press'), 1);
        });
    });

    describe('when the menu changes under a capture (menuChanged())', () => {
        it('a capture left held hears keys without taking them from the new menu', () => {
            const client = makeClient();
            const got = [];
            const token = client.captureInput(ch => got.push(ch));
            const res = InputCapture.menuChanged(client);
            assert.deepEqual(res, { dropped: 0, passThrough: 1 });
            assert.equal(client.hasInputCapture(), false);

            const { field } = makeForm(client); //  the next menu's form
            type(client, 'ab');
            assert.deepEqual(got, ['a', 'b'], 'it keeps hearing keys');
            assert.equal(field.getData(), 'ab', 'and the new form gets them too');
            client.releaseInput(token);
            type(client, 'c');
            assert.deepEqual(got, ['a', 'b'], 'until it is released');
        });

        it('leaves a pending wait alone: it fires on the next key, which the new menu gets too', () => {
            const client = makeClient();
            const got = [];
            client.waitForKeyPress(ch => got.push(`before:${ch}`));
            InputCapture.menuChanged(client);
            const { field } = makeForm(client);
            type(client, 'h');
            assert.deepEqual(got, ['before:h']);
            assert.equal(field.getData(), 'h');
        });

        it('a wait the old menu’s flow takes after the change does not steal the new menu’s keys', () => {
            //  pause: pageBreak art, several page prompts to go, when a
            //  break-in moves the caller to chat
            const client = makeClient();
            client.releaseInput(client.captureInput(() => {})); //  dispatcher in
            let pages = 3;
            let fired = 0;
            const nextPage = () => {
                client.waitForKeyPress(() => {
                    ++fired;
                    if (--pages > 0) {
                        nextPage();
                    }
                });
            };
            nextPage();
            InputCapture.menuChanged(client);
            const { field } = makeForm(client);
            type(client, 'hello');
            assert.equal(field.getData(), 'hello');
            assert.equal(fired, 3);
        });

        it("drops a capture taken with onMenuChange: 'drop', calling onDrop", () => {
            const client = makeClient();
            let calls = 0;
            let drops = 0;
            client.captureInput(() => ++calls, {
                onMenuChange: 'drop',
                onDrop: () => ++drops,
            });
            assert.deepEqual(InputCapture.menuChanged(client), {
                dropped: 1,
                passThrough: 0,
            });
            assert.equal(drops, 1);
            const { field } = makeForm(client);
            type(client, 'z');
            assert.equal(calls, 0);
            assert.equal(field.getData(), 'z');
        });

        it('a capture taken by the new menu works as usual over a leftover', () => {
            const client = makeClient();
            const got = [];
            client.captureInput(ch => got.push(`old:${ch}`));
            InputCapture.menuChanged(client);
            const { field } = makeForm(client);
            client.captureInput(ch => got.push(`new:${ch}`));
            type(client, 'q');
            assert.deepEqual(got, ['old:q', 'new:q']);
            assert.equal(
                field.getData(),
                '',
                'the new capture still keeps it from the form'
            );
        });

        it('finds nothing to do when nothing is held', () => {
            assert.deepEqual(InputCapture.menuChanged(makeClient()), {
                dropped: 0,
                passThrough: 0,
            });
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

        it('has the capture methods; waitForKeyPress() is not a capture', () => {
            const token = client.captureInput(() => {});
            assert.equal(client.hasInputCapture(), true);
            assert.equal(client.releaseInput(token), true);

            const got = [];
            client.waitForKeyPress(ch => got.push(ch));
            assert.equal(client.hasInputCapture(), false);
            client.emit('key press', 'a');
            client.emit('key press', 'b');
            assert.deepEqual(got, ['a']);
        });

        it('drops every capture when the client ends', () => {
            let calls = 0;
            client.captureInput(() => ++calls);
            client.captureInput(() => ++calls);

            client.end();
            assert.equal(client.hasInputCapture(), false);

            client.emit('key press', 'a');
            assert.equal(calls, 0);
        });

        it('gives a dropped capture its onDrop() when the client ends', () => {
            let drops = 0;
            client.captureInput(() => {}, { onDrop: () => ++drops });
            client.end();
            assert.equal(drops, 1);
        });
    });
});
