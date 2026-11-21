'use strict';

const { strict: assert } = require('assert');

const { ClientTerminal } = require('../core/client_term.js');
const { selectClientEmulation } = require('../core/term/select.js');
const { TickerView } = require('../core/ticker_view.js');
const { View } = require('../core/view.js');

//
//  A drip (baud emulated art) covers background drawing (C11). While a
//  drip is in flight, a view that existed when it began (a %TK ticker, a
//  %SB status bar) does not draw on its own: a tick drawn between two
//  pieces of the art moved the cursor the art carried on from, and on
//  PETSCII / ATASCII was translated against where the art ends. A view
//  that missed a draw is drawn once when the drip is over, before the
//  drip's callback. Everything else written during a drip goes out at
//  once, as it always has. However the drip ends (done, a closed
//  connection, a throwing output filter, disconnect()), the cover ends
//  with it.
//

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return quietLog;
    },
};

function session(kind = 'ansi') {
    const writes = [];
    const output = {
        writable: true,
        write(data, cb) {
            writes.push(
                'string' === typeof data ? Buffer.from(data, 'latin1') : Buffer.from(data)
            );
            if (cb) {
                cb(null);
            }
        },
    };
    const term = new ClientTerminal(output);
    const client = {
        term,
        log: quietLog,
        user: { properties: {}, isAuthenticated: () => false },
        currentThemeConfig: { get: () => ({ info: { name: 'N/A' } }) },
    };
    if ('petscii' === kind || 'atascii' === kind) {
        selectClientEmulation(client, {
            firstMenu: 'telnetConnected',
            listener: { name: kind, emulation: kind },
        });
        term.termWidth = 40;
        term.termHeight = 'petscii' === kind ? 25 : 24;
        term.emulation.probes.forEach(probe => probe.run(client, () => {}));
    } else {
        term.outputEncoding = 'cp437';
        term.termWidth = 80;
        term.termHeight = 25;
    }
    const wire = () => Buffer.concat(writes);
    const sent = () => wire().toString('latin1');
    return { term, client, output, writes, sent, wire };
}

//  setTimeout() (the drip's pacing) and setInterval() (a ticker) run by hand
function fakeTimers() {
    const saved = {
        setTimeout: global.setTimeout,
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    const queue = [];
    const intervals = new Map();
    let nextId = 1;
    global.setTimeout = fn => {
        queue.push(fn);
        return { unref() {} };
    };
    global.setInterval = fn => {
        const id = nextId++;
        intervals.set(id, fn);
        return id;
    };
    global.clearInterval = id => intervals.delete(id);
    return {
        tick() {
            queue.shift()();
        },
        runAll() {
            while (queue.length > 0) {
                queue.shift()();
            }
        },
        fireInterval(id) {
            intervals.get(id)();
        },
        get pending() {
            return queue.length;
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

function ticker(client, row = 2, col = 5) {
    return new TickerView({
        client,
        id: 1,
        position: { row, col },
        dimens: { width: 4, height: 1 },
        text: 'breaking news ',
        motion: 'left',
    });
}

function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

//  62.5 bytes a second: one byte every 16 ms piece
const SLOW = 62.5;
const GOTO_TICKER = '\x1b[2;5H';

describe('A drip (baud emulation) covers background drawing', function () {
    let timers;
    beforeEach(() => {
        timers = fakeTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    it('ANSI: no tick is drawn during the art; the ticker is drawn once after it, before the callback', () => {
        const s = session();
        const tk = ticker(s.client);
        const events = [];
        s.term.dripWrite(Buffer.from('ARTWORK'), SLOW, err => {
            assert.ifError(err);
            events.push(`done:${s.sent()}`);
        });
        assert.equal(s.sent(), 'A');

        //  many ticks while the art drips
        for (let i = 0; i < 5; ++i) {
            timers.fireInterval(tk._timer);
            timers.tick();
        }
        assert.equal(s.sent(), 'ARTWORK'.slice(0, 6), 'nothing but the art');
        assert.ok(View.isBackgroundDrawSuspended(s.client));

        timers.runAll();
        const sent = s.sent();
        assert.ok(sent.startsWith('ARTWORK' + GOTO_TICKER), JSON.stringify(sent));
        assert.equal(count(sent, GOTO_TICKER), 1, 'one redraw, not one per tick');
        assert.deepEqual(events, [`done:${sent}`], 'the redraw goes before the callback');
        assert.ok(!View.isBackgroundDrawSuspended(s.client));

        //  and it ticks as usual afterwards
        timers.fireInterval(tk._timer);
        assert.equal(count(s.sent(), GOTO_TICKER), 2);
        tk.destroy();
    });

    it('no tick during the drip: nothing is redrawn after it', () => {
        const s = session();
        const tk = ticker(s.client);
        s.term.dripWrite(Buffer.from('ART'), SLOW, () => {});
        timers.runAll();
        assert.equal(s.sent(), 'ART', 'no tick was missed, so no redraw');
        tk.destroy();
    });

    it('other output during a drip goes out at once, as before', () => {
        const s = session();
        const events = [];
        s.term.dripWrite(Buffer.from('ART'), SLOW, () => events.push('drip cb'));
        s.term.rawWrite('<raw>', () => events.push('raw cb'));
        s.term.beginWrite();
        s.term.rawWrite('<batch>');
        s.term.commitWrite(() => events.push('batch cb'));
        assert.equal(s.sent(), 'A<raw><batch>');
        assert.deepEqual(events, ['raw cb', 'batch cb']);
        timers.runAll();
        assert.equal(s.sent(), 'A<raw><batch>RT');
        assert.deepEqual(events, ['raw cb', 'batch cb', 'drip cb']);
    });

    ['petscii', 'atascii'].forEach(kind => {
        it(`${kind}: no tick lands in the art, which goes out as translated up front`, () => {
            const ART = 'HELLO\r\nWORLD';

            //  the art alone
            const reference = session(kind);
            reference.term.rawWrite(ART);
            const artBytes = reference.wire();

            const s = session(kind);
            const tk = ticker(s.client);
            let done = false;
            s.term.dripWrite(Buffer.from(ART), SLOW, () => (done = true));
            while (timers.pending > 0) {
                timers.fireInterval(tk._timer);
                const now = s.wire();
                assert.equal(
                    now.toString('hex'),
                    artBytes.subarray(0, now.length).toString('hex'),
                    'only art on the wire while it drips'
                );
                timers.tick();
            }
            assert.ok(done);

            const wire = s.wire();
            assert.equal(
                wire.subarray(0, artBytes.length).toString('hex'),
                artBytes.toString('hex')
            );
            assert.ok(wire.length > artBytes.length, 'the ticker is drawn after the art');
            tk.destroy();
        });
    });

    it('nested drips: covered until the last is over, then one redraw', () => {
        const s = session();
        const tk = ticker(s.client);
        const events = [];
        s.term.dripWrite(Buffer.from('one'), SLOW, () => events.push('one'));
        timers.fireInterval(tk._timer);
        s.term.dripWrite(Buffer.from('two!!'), SLOW, () => events.push('two'));
        //  (they interleave, as they always have)
        while (timers.pending > 0) {
            timers.fireInterval(tk._timer);
            timers.tick();
            if (events.includes('one') && !events.includes('two')) {
                assert.ok(View.isBackgroundDrawSuspended(s.client), 'two still covers');
                assert.equal(count(s.sent(), GOTO_TICKER), 0);
            }
        }
        assert.deepEqual(events, ['one', 'two']);
        const sent = s.sent();
        assert.equal(count(sent, GOTO_TICKER), 1);
        assert.equal(sent.indexOf(GOTO_TICKER), 'onetwo!!'.length, 'after all the art');
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
        tk.destroy();
    });

    it('a view created during the drip draws as usual', () => {
        const s = session();
        s.term.dripWrite(Buffer.from('ART'), SLOW, () => {});
        const tk = ticker(s.client, 3, 1);
        timers.fireInterval(tk._timer);
        assert.ok(s.sent().includes('\x1b[3;1H'));
        timers.runAll();
        tk.destroy();
    });

    it('an output filter that throws on the first piece ends the cover', () => {
        const s = session();
        const tk = ticker(s.client);
        s.term._filterOutput = () => {
            throw new Error('filter fault');
        };
        assert.throws(
            () => s.term.dripWrite(Buffer.from('ART'), SLOW, () => {}),
            /filter fault/
        );
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
        delete s.term._filterOutput;
        timers.fireInterval(tk._timer);
        assert.ok(s.sent().includes(GOTO_TICKER), 'the ticker draws again');
        tk.destroy();
    });

    it('an output filter that throws on a later piece ends the cover', () => {
        const s = session();
        const tk = ticker(s.client);
        const filter = s.term._filterOutput.bind(s.term);
        let pieces = 0;
        s.term._filterOutput = chunk => {
            if (2 === ++pieces) {
                throw new Error('filter fault');
            }
            return filter(chunk);
        };
        let called = 0;
        s.term.dripWrite(Buffer.from('ART'), SLOW, () => ++called);
        timers.fireInterval(tk._timer);
        assert.ok(View.isBackgroundDrawSuspended(s.client));
        assert.throws(() => timers.tick(), /filter fault/);
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
        assert.equal(called, 0, 'as before: a throw is not a callback');
        assert.equal(count(s.sent(), GOTO_TICKER), 1, 'the missed tick is made up');
        tk.destroy();
    });

    it('a connection closed during the drip ends the cover; the callback gets the error', () => {
        const s = session();
        const tk = ticker(s.client);
        let error;
        s.term.dripWrite(Buffer.from('ART'), SLOW, err => (error = err));
        timers.fireInterval(tk._timer);
        s.output.writable = false;
        assert.doesNotThrow(() => timers.runAll());
        assert.ok(error);
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
        tk.destroy();
    });

    it('disconnect() during the drip ends the cover at once', () => {
        const s = session();
        const tk = ticker(s.client);
        let error;
        s.term.dripWrite(Buffer.from('ART'), SLOW, err => (error = err));
        timers.fireInterval(tk._timer);
        assert.ok(View.isBackgroundDrawSuspended(s.client));
        s.term.disconnect();
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
        assert.doesNotThrow(() => timers.runAll());
        assert.ok(error, 'the drip still reports the closed connection');
        tk.destroy();
    });

    it('suspends dropped by a menu change mid-drip: the drip still ends cleanly', () => {
        const s = session();
        const tk = ticker(s.client);
        let called = 0;
        s.term.dripWrite(Buffer.from('ART'), SLOW, () => ++called);
        assert.equal(View.dropBackgroundDrawSuspends(s.client), 1);
        tk.destroy(); //  the old menu's views go
        timers.runAll();
        assert.equal(called, 1, 'the drip carries on, as before');
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
    });

    it('a drip of nothing covers nothing', () => {
        const s = session();
        const tk = ticker(s.client);
        let called = 0;
        s.term.dripWrite(Buffer.alloc(0), SLOW, () => ++called);
        assert.equal(called, 1);
        assert.ok(!View.isBackgroundDrawSuspended(s.client));
        tk.destroy();
    });
});
