'use strict';

const { strict: assert } = require('assert');

const { ClientTerminal } = require('../core/client_term.js');
const { selectClientEmulation } = require('../core/term/select.js');
const { TickerView } = require('../core/ticker_view.js');

//
//  Output while baud emulated art drips (C11): a write or a committed batch
//  made while a drip is in flight is held and sent, in call order, when the
//  drip is done and before its callback runs. Sent at once, it landed
//  between two pieces of the art (a ticker tick's goto moved where the rest
//  of the art was drawn), and for PETSCII / ATASCII, whose translator works
//  from the cursor and had translated the whole art up front, it was
//  translated against where the art ends. A drip started during another
//  waits its turn.
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
    const sent = () => Buffer.concat(writes).toString('latin1');
    return { term, client, output, writes, sent, wire: () => Buffer.concat(writes) };
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

describe('Output during a drip (baud emulation) is held until it is done', function () {
    let timers;
    beforeEach(() => {
        timers = fakeTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    //  62.5 bytes a second: one byte every 16 ms piece
    const SLOW = 62.5;

    it('ANSI: a write and a committed batch wait for the art, in call order, before its callback', () => {
        const s = session();
        const events = [];
        s.term.dripWrite(Buffer.from('ARTWORK'), SLOW, err => {
            assert.ifError(err);
            events.push(`done:${s.sent()}`);
        });
        assert.equal(s.sent(), 'A');

        timers.tick(); //  'R'
        //  a ticker tick: one batch
        s.term.beginWrite();
        s.term.rawWrite('\x1b[2;5H');
        s.term.rawWrite('tick');
        s.term.commitWrite(() => events.push('batch cb'));
        s.term.rawWrite('<raw>', () => events.push('raw cb'));
        assert.equal(s.sent(), 'AR', 'nothing between the pieces');
        assert.deepEqual(events, [], 'their callbacks wait too');

        timers.runAll();
        assert.equal(s.sent(), 'ARTWORK\x1b[2;5Htick<raw>');
        assert.deepEqual(events, [
            'batch cb',
            'raw cb',
            'done:ARTWORK\x1b[2;5Htick<raw>',
        ]);

        //  and once it is done, writes go straight out again
        s.term.rawWrite('!');
        assert.equal(s.sent(), 'ARTWORK\x1b[2;5Htick<raw>!');
    });

    it('a batch open across the drip is held when committed during it', () => {
        const s = session();
        s.term.beginWrite();
        s.term.rawWrite('<pre>');
        s.term.dripWrite(Buffer.from('ART'), SLOW, () => {});
        assert.equal(s.sent(), '<pre>A', 'what the batch held went first');
        s.term.rawWrite('<post>');
        s.term.commitWrite();
        assert.equal(s.sent(), '<pre>A');
        timers.runAll();
        assert.equal(s.sent(), '<pre>ART<post>');
    });

    ['petscii', 'atascii'].forEach(kind => {
        it(`${kind}: a write during the drip is translated against the end of the art, where it lands`, () => {
            const ART = 'HELLO\r\nWORLD';
            const TICK = '\x1b[2;3HX\x1b[1;1H';

            //  as if the tick had been written after the art, no drip
            const reference = session(kind);
            reference.term.rawWrite(ART);
            reference.term.rawWrite(TICK);

            const s = session(kind);
            s.term.dripWrite(Buffer.from(ART), SLOW, () => {});
            timers.tick();
            s.term.rawWrite(TICK);
            timers.runAll();

            assert.equal(s.wire().toString('hex'), reference.wire().toString('hex'));
        });
    });

    it('a drip started during another waits its turn; callbacks in order', () => {
        const s = session();
        const events = [];
        s.term.dripWrite(Buffer.from('one'), SLOW, () => events.push('one'));
        s.term.rawWrite('|');
        s.term.dripWrite(Buffer.from('two'), SLOW, () => events.push('two'));
        s.term.rawWrite('.');
        assert.equal(s.sent(), 'o');
        timers.runAll();
        assert.equal(s.sent(), 'one|two.');
        assert.deepEqual(events, ['one', 'two']);
    });

    it('a connection closed during the drip: its callback gets the error, held output is dropped', () => {
        const s = session();
        let error;
        let rawCb = 0;
        s.term.dripWrite(Buffer.from('ART'), SLOW, err => {
            error = err;
        });
        s.term.rawWrite('late', () => ++rawCb);
        s.output.writable = false;
        assert.doesNotThrow(() => timers.runAll());
        assert.ok(error, 'the drip reports the closed connection');
        assert.equal(s.sent(), 'A');
        assert.equal(rawCb, 0, 'as for any write to a closed connection');
        //  not stuck holding
        s.output.writable = true;
        s.term.rawWrite('again');
        assert.equal(s.sent(), 'Aagain');
    });

    it("a ticker's tick during art drawn at a baud rate goes after the art", () => {
        const s = session();
        const ticker = new TickerView({
            client: s.client,
            id: 1,
            position: { row: 2, col: 5 },
            dimens: { width: 4, height: 1 },
            text: 'news',
            motion: 'bounce',
        });
        s.term.dripWrite(Buffer.from('ART!'), SLOW, () => {});
        timers.fireInterval(ticker._timer);
        assert.equal(s.sent(), 'A');
        timers.runAll();
        const sent = s.sent();
        assert.ok(sent.startsWith('ART!\x1b[2;5H'), JSON.stringify(sent));
        assert.ok(sent.includes('news'));
        ticker.destroy();
    });

    it('a drip of nothing holds nothing', () => {
        const s = session();
        let called = 0;
        s.term.dripWrite(Buffer.alloc(0), SLOW, () => ++called);
        s.term.rawWrite('x');
        assert.equal(called, 1);
        assert.equal(s.sent(), 'x');
    });
});
