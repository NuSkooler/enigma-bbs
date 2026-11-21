'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { coverScreen } = require('../core/screen_cover.js');
const InputCapture = require('../core/input_capture.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');

//
//  coverScreen(): capture input + suspend background drawing, run fn,
//  optionally restore, then release + resume, once, whatever fn does.
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
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    return client;
}

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

function makeCountingView(client) {
    const view = new View({ client, id: 7, position: { row: 3, col: 1 } });
    view.redraws = 0;
    view.redraw = () => ++view.redraws;
    return view;
}

const isCovered = client => ({
    input: InputCapture.hasInputCapture(client),
    background: View.isBackgroundDrawSuspended(client),
});

describe('coverScreen()', () => {
    it('captures input and suspends background drawing while fn runs', () => {
        const client = makeClient();
        let during;
        coverScreen(client, done => {
            during = isCovered(client);
            done();
        });
        assert.deepEqual(during, { input: true, background: true });
        assert.deepEqual(isCovered(client), { input: false, background: false });
    });

    it('drops keys typed while the cover draws, and the form keeps them out', () => {
        const client = makeClient();
        const { field } = makeForm(client);
        let finish;
        coverScreen(client, done => (finish = done));

        client.emit('key press', 'x');
        assert.equal(field.getData(), '');

        finish();
        client.emit('key press', 'y');
        assert.equal(field.getData(), 'y');
    });

    it('gives the dismissing key to a wait inside fn, and nothing to the form', () => {
        const client = makeClient();
        const { field } = makeForm(client);
        let result;
        coverScreen(
            client,
            done => client.waitForKeyPress(ch => done(null, `got ${ch}`)),
            (err, r) => (result = { err, r })
        );

        client.emit('key press', 'q');
        assert.deepEqual(result, { err: null, r: 'got q' });
        assert.equal(field.getData(), '');
        assert.deepEqual(isCovered(client), { input: false, background: false });

        client.emit('key press', 'z');
        assert.equal(field.getData(), 'z');
    });

    it('redraws a view that missed a draw once, after restore', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        const order = [];
        coverScreen(
            client,
            {
                restore: cb => {
                    order.push(`restore:${view.redraws}`);
                    assert.deepEqual(isCovered(client), {
                        input: true,
                        background: true,
                    });
                    cb();
                },
            },
            done => {
                view.drawInBackground(() => order.push('drew'));
                done();
            },
            () => order.push(`cb:${view.redraws}`)
        );
        assert.deepEqual(order, ['restore:0', 'cb:1']);
    });

    it('redrawMissed: false uncovers without the redraws (the caller repaints)', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        let redrawsAtCb = null;
        coverScreen(
            client,
            { redrawMissed: false },
            done => {
                view.drawInBackground(() => {});
                done();
            },
            () => (redrawsAtCb = view.redraws)
        );
        assert.equal(redrawsAtCb, 0);
        assert.deepEqual(isCovered(client), { input: false, background: false });
    });

    it('a view the cover itself creates draws as usual', () => {
        const client = makeClient();
        coverScreen(
            client,
            done => {
                const inside = makeCountingView(client);
                let ran = 0;
                inside.drawInBackground(() => ++ran);
                assert.equal(ran, 1);
                done();
            },
            () => {}
        );
    });

    it('its capture is dropped, not passed through, if the menu changes under it', () => {
        const client = makeClient();
        const { field } = makeForm(client);
        const events = [];
        //  the real path: a pause in the cover waits with waitForKeyPress()
        coverScreen(
            client,
            { restore: cb => (events.push('restore'), cb()) },
            done =>
                client.waitForKeyPress(ch => {
                    events.push(`pause:${ch}`);
                    done(null, 'result');
                }),
            () => events.push('cb')
        );
        //  what MenuStack._settleCovers() does on a sysop break-in
        assert.deepEqual(InputCapture.menuChanged(client), {
            dropped: 1,
            passThrough: 1,
        });
        View.dropBackgroundDrawSuspends(client);

        client.emit('key press', 'z');
        assert.deepEqual(events, ['pause:z'], 'no restore, no cb for a gone menu');
        assert.equal(field.getData(), 'z', 'the form (the new menu’s) gets the key');
        assert.deepEqual(isCovered(client), { input: false, background: false });
        client.emit('key press', 'y');
        assert.equal(field.getData(), 'zy');
        assert.deepEqual(events, ['pause:z']);
    });

    it('is abandoned when the client ends: no restore, no cb, nothing held', () => {
        const client = makeClient();
        const events = [];
        let finish;
        coverScreen(
            client,
            { restore: cb => (events.push('restore'), cb()) },
            done => (finish = done),
            () => events.push('cb')
        );
        InputCapture.dropAllInput(client); //  what Client.end() does
        finish(); //  something inside the cover finishing late
        assert.deepEqual(events, []);
        assert.equal(View.isBackgroundDrawSuspended(client), false, 'resumed');
    });

    it('a menu change during restore: restore finishes, cb is skipped', () => {
        const client = makeClient();
        const events = [];
        coverScreen(
            client,
            {
                restore: cb => {
                    events.push('restore');
                    InputCapture.menuChanged(client); //  break-in mid-repaint
                    cb();
                },
            },
            done => done(),
            () => events.push('cb')
        );
        assert.deepEqual(events, ['restore']);
        assert.deepEqual(isCovered(client), { input: false, background: false });
    });

    it('a plain waitForKeyPress() outside any cover still passes through, as before', () => {
        const client = makeClient();
        const { field } = makeForm(client);
        const got = [];
        client.waitForKeyPress(ch => got.push(ch));
        InputCapture.menuChanged(client);
        client.emit('key press', 'p');
        assert.deepEqual(got, ['p'], 'its callback still runs');
        assert.equal(field.getData(), 'p');
    });

    it('passes fn’s results and error to cb, and skips restore on error', () => {
        const client = makeClient();
        let restored = false;
        let got;
        coverScreen(
            client,
            { restore: cb => ((restored = true), cb()) },
            done => done(new Error('nope'), 1),
            (err, n) => (got = { message: err.message, n })
        );
        assert.deepEqual(got, { message: 'nope', n: 1 });
        assert.equal(restored, false);
        assert.deepEqual(isCovered(client), { input: false, background: false });
    });

    it('passes a restore error on', () => {
        const client = makeClient();
        let got;
        coverScreen(
            client,
            { restore: cb => cb(new Error('repaint failed')) },
            done => done(),
            err => (got = err && err.message)
        );
        assert.equal(got, 'repaint failed');
    });

    it('uncovers once when fn throws, or calls done twice', () => {
        const client = makeClient();
        let calls = 0;
        coverScreen(
            client,
            () => {
                throw new Error('thrown');
            },
            err => {
                ++calls;
                assert.equal(err.message, 'thrown');
            }
        );
        assert.equal(calls, 1);
        assert.deepEqual(isCovered(client), { input: false, background: false });

        let twice = 0;
        coverScreen(
            client,
            done => {
                done();
                done();
            },
            () => ++twice
        );
        assert.equal(twice, 1);
    });

    it('does not swallow an exception thrown by cb', () => {
        const client = makeClient();
        assert.throws(
            () =>
                coverScreen(
                    client,
                    done => done(),
                    () => {
                        throw new Error('from cb');
                    }
                ),
            /from cb/
        );
        assert.deepEqual(isCovered(client), { input: false, background: false });
    });

    it('nests: the inner cover leaves the outer one in place', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        let finishOuter;
        coverScreen(client, done => (finishOuter = done));
        coverScreen(client, done => {
            view.drawInBackground(() => {});
            done();
        });
        assert.deepEqual(isCovered(client), { input: true, background: true });
        assert.equal(view.redraws, 0, 'still covered by the outer cover');

        finishOuter();
        assert.equal(view.redraws, 1);
        assert.deepEqual(isCovered(client), { input: false, background: false });
    });

    it('can capture input only, so background views keep drawing', () => {
        const client = makeClient();
        let during;
        coverScreen(client, { suspendBackground: false }, done => {
            during = isCovered(client);
            done();
        });
        assert.deepEqual(during, { input: true, background: false });
    });

    it('can suspend background drawing only', () => {
        const client = makeClient();
        let during;
        coverScreen(client, { captureInput: false }, done => {
            during = isCovered(client);
            done();
        });
        assert.deepEqual(during, { input: false, background: true });
    });
});
