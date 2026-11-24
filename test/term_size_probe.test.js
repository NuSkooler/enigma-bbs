'use strict';

//
//  The ANSI connect probes against terminals that answer cursor position
//  queries in the ways real ones do: not at all, 1;1 to everything, too late,
//  a row off, one byte at a time, or properly (and SyncTERM's answer to both
//  CSI 255 n and CSI 6 n). The size must never end up 0, and a reply must
//  never be taken by a probe other than the one that asked for it.
//

const { strict: assert } = require('assert');
const async = require('async');

//
//  core/term/ansi/probes.js, core/client_term.js and core/client.js read
//  Config() through the getter captured when they were first required, which
//  may be any test's config by now. They are required afresh here, under a
//  config pushed for this suite, and the cached copies are put back after.
//
const FreshModules = [
    '../core/term/ansi/probes.js',
    '../core/client_term.js',
    '../core/client.js',
].map(m => require.resolve(m));

const CTERM_DA = '\x1b[=67;84;101;114;109;1;316c';

//
//  A terminal on the other end of a real Client: it reads what the probes
//  write and answers through the client's input parser, in order.
//
//  |cpr|:
//      never   answers no CPR query
//      one     answers every CSI 6 n and CSI 255 n with 1;1 (NetRunner-like)
//      normal  a real screen of |rows| x |cols|: CSI 6 n with the cursor
//              position, CSI 255 n with the screen size (SyncTERM: both)
//      vt      like normal, but CSI 255 n is ignored (modern VT terminals,
//              Procomm Plus)
//      telix   like vt, every row reported one too high
//      qmodem  ignores a cursor move beyond the screen, answers CSI 255 n
//              with the cursor position, prints a font selection as text
//
//  |lateMs| delays every answer; |bytewise| sends each byte on its own;
//  |cterm| answers CSI < c and CSI = 6 n as SyncTERM does; |zeroBased|
//  reports positions from 0,0 (ConnectBot).
//
function makeTerminal(client, opts) {
    const {
        cpr,
        rows = 25,
        cols = 80,
        lateMs = 0,
        bytewise = false,
        cterm = false,
        zeroBased = false,
    } = opts;
    const cur = { row: 1, col: 1 };
    const queries = [];
    const clamp = () => {
        cur.row = Math.max(1, Math.min(rows, cur.row));
        cur.col = Math.max(1, Math.min(cols, cur.col));
    };

    //  every answer goes out after the previous one, in order, and no sooner
    //  than |lateMs| after its query
    let chain = Promise.resolve();
    const send = text => {
        const due = Date.now() + lateMs;
        chain = chain.then(
            () =>
                new Promise(resolve => {
                    const deliver = () => {
                        const parts = bytewise ? text.split('') : [text];
                        const next = () => {
                            if (0 === parts.length) {
                                return resolve();
                            }
                            client.emit('data', Buffer.from(parts.shift(), 'latin1'));
                            setImmediate(next);
                        };
                        next();
                    };
                    const wait = due - Date.now();
                    wait > 0 ? setTimeout(deliver, wait) : setImmediate(deliver);
                })
        );
    };

    const answerCpr = kind => {
        queries.push(kind);
        let pos;
        switch (cpr) {
            case 'one':
                pos = [1, 1];
                break;
            case 'normal':
                pos = '255n' === kind ? [rows, cols] : [cur.row, cur.col];
                break;
            case 'vt':
                pos = '255n' === kind ? null : [cur.row, cur.col];
                break;
            case 'telix':
                pos = '255n' === kind ? null : [cur.row + 1, cur.col];
                break;
            case 'qmodem':
                pos = [cur.row, cur.col];
                break;
        }
        if (pos && zeroBased) {
            pos = [pos[0] - 1, pos[1] - 1];
        }
        if (pos) {
            send(`\x1b[${pos[0]};${pos[1]}R`);
        }
    };

    /* eslint-disable-next-line no-control-regex */
    const re = /\x1b\[([<=?]?)([0-9;]*)( ?)([@-~])|([\s\S])/g;
    const write = s => {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(String(s)))) {
            const [, priv, params, space, final, text] = m;
            if (undefined !== text) {
                if ('\r' === text) {
                    cur.col = 1;
                } else if ('\n' === text) {
                    cur.row += 1;
                } else if (text >= ' ') {
                    cur.col += 1;
                }
                clamp();
                continue;
            }
            const p = params.split(';').map(v => parseInt(v, 10) || 0);
            if (' ' === space) {
                //  a font selection (CSI Ps1 ; Ps2 SP D)
                if ('qmodem' === cpr) {
                    cur.col += `[${params} D`.length;
                    clamp();
                }
            } else if ('H' === final && '' === priv) {
                const row = p[0] || 1;
                const col = p[1] || 1;
                if ('qmodem' === cpr && (row > rows || col > cols)) {
                    continue;
                }
                cur.row = row;
                cur.col = col;
                clamp();
            } else if ('n' === final && '' === priv) {
                if (6 === p[0]) {
                    answerCpr('6n');
                } else if (255 === p[0]) {
                    answerCpr('255n');
                }
            } else if (cterm && 'c' === final && '<' === priv) {
                send('\x1b[<0;1;2;3;5c');
            } else if (cterm && 'n' === final && '=' === priv && 6 === p[0]) {
                send('\x1b[=6;1n');
            }
        }
    };

    return { write, queries, cur };
}

describe('ANSI terminal size probe', function () {
    let ClientModule;
    let ClientTerminal;
    let Events;
    let Probes;
    //  read by the probes (term), ClientTerminal (term) and client.js (logging)
    const testTerm = {
        checkAnsiHomePosition: true,
        checkUtf8Encoding: true,
        probeUtf8Encoding: false,
        utf8TermList: [],
        cp437TermList: [],
    };
    let testConfig;
    let previousConfig;
    let savedModules;

    before(() => {
        const configModule = require('../core/config.js');
        testConfig = Object.assign({}, configModule.get(), {
            term: Object.assign({}, testTerm),
            logging: { traceUserKeyboardInput: false },
        });
        previousConfig = configModule._pushTestConfig(testConfig);

        savedModules = FreshModules.map(path => [path, require.cache[path]]);
        FreshModules.forEach(path => delete require.cache[path]);

        Probes = require('../core/term/ansi/probes.js');
        ClientTerminal = require('../core/client_term.js').ClientTerminal;
        ClientModule = require('../core/client.js');
        Events = require('../core/events.js');
    });

    beforeEach(() => {
        testConfig.term = Object.assign({}, testTerm);
    });

    after(() => {
        try {
            (savedModules || []).forEach(([path, cached]) => {
                if (cached) {
                    require.cache[path] = cached;
                } else {
                    delete require.cache[path];
                }
            });
        } finally {
            require('../core/config.js')._popTestConfig(previousConfig);
        }
    });

    const clients = [];
    afterEach(() => {
        clients.splice(0).forEach(client => {
            Events.removeListener(
                Events.getSystemEvents().ThemeChanged,
                client.themeChangedListener
            );
        });
    });

    //  a real Client (so replies go through its input parser) and a terminal
    function connect(terminalOpts, { width = 0, height = 0, da } = {}) {
        const client = new ClientModule.Client();
        clients.push(client);
        client.term = new ClientTerminal(null);
        client.session = { id: 1 }; //  client.node
        client.warnings = [];
        client.log = {
            info() {},
            debug() {},
            trace() {},
            warn: (obj, msg) => client.warnings.push(msg),
        };
        client.term.termWidth = width;
        client.term.termHeight = height;
        client.writes = [];
        const terminal = makeTerminal(client, terminalOpts);
        client.term.rawWrite = s => {
            client.writes.push(s);
            terminal.write(s);
        };
        client.term.write = client.term.rawWrite;
        client.term.writeUnfilteredRip = client.term.rawWrite;
        if (da) {
            client.emit('data', Buffer.from(da, 'latin1'));
        }
        return { client, terminal };
    }

    //  the ANSI probes after basicPrepWork, run as connectEntry() runs them
    function runProbes(client, cb) {
        const started = Date.now();
        const probes = Probes.probes.filter(p => 'basicPrepWork' !== p.name);
        async.series(
            probes.map(probe => callback => probe.run(client, callback)),
            () => cb(Date.now() - started)
        );
    }

    const sizeOf = client => [client.term.termWidth, client.term.termHeight];
    const sent = client => client.writes.join('');

    it('a terminal with no CPR at all gets 80x25 after one timeout', function (done) {
        this.timeout(6000);
        const { client } = connect({ cpr: 'never' });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            assert(elapsed < 2500, `no wait beyond the home probe (${elapsed}ms)`);
            assert(!sent(client).includes('\x1b[255n'), 'no size query after a timeout');
            assert.equal(client.listenerCount('cursor position report'), 0);
            return done();
        });
    });

    it('1;1 to everything: 80x25, and no wait', done => {
        const { client } = connect({ cpr: 'one' });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            assert.equal(client.listenerCount('cursor position report'), 0);
            return done();
        });
    });

    it('Qmodem: no size from its answers, 80x25, and the font probe sees its own reply', done => {
        const { client, terminal } = connect({ cpr: 'qmodem' });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            //  it prints the font selection, so the reply is 1;8: no fonts
            assert.equal(client.term.syncTermFontsEnabled, false);
            //  home, CSI 255 n, CSI 6 n, the sentinel, the font probe
            assert.deepEqual(terminal.queries, ['6n', '255n', '6n', '6n', '6n']);
            return done();
        });
    });

    it('late replies: 80x25 after one timeout; the replies reach no probe', function (done) {
        this.timeout(8000);
        const { client, terminal } = connect({ cpr: 'one', lateMs: 2300 });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            assert(elapsed < 2500, `one timeout only (${elapsed}ms)`);
            assert.deepEqual(terminal.queries, ['6n'], 'nothing more is asked');
            //  the late home reply arrives with nobody listening
            setTimeout(() => {
                assert.equal(client.listenerCount('cursor position report'), 0);
                assert.equal(client.term.syncTermFontsEnabled, false);
                return done();
            }, 800);
        });
    });

    it('late replies to the size query never reach the font probe', function (done) {
        //  without the home position probe, the size query is the first; a
        //  late 1;1 taken by the font probe would turn fonts on
        this.timeout(8000);
        testConfig.term.checkAnsiHomePosition = false;
        const { client, terminal } = connect({ cpr: 'one', lateMs: 2300 });
        runProbes(client, () => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            setTimeout(() => {
                assert.equal(client.term.syncTermFontsEnabled, false);
                assert.deepEqual(
                    terminal.queries.filter(q => '255n' === q),
                    ['255n'],
                    'one size query'
                );
                assert(!sent(client).includes(' D'), 'no font probe sent');
                return done();
            }, 1500);
        });
    });

    it('a normal 80x25 terminal is sized by CPR with no timeout', done => {
        const { client } = connect({ cpr: 'normal' });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            assert.deepEqual(client.warnings, []);
            return done();
        });
    });

    it('a terminal that ignores CSI 255 n is sized by CSI 6 n', done => {
        const { client } = connect({ cpr: 'vt', rows: 50, cols: 132 });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [132, 50]);
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            return done();
        });
    });

    it('a 0-based terminal with the home check off finds the sentinel: no timeout', done => {
        testConfig.term.checkAnsiHomePosition = false;
        const { client } = connect({ cpr: 'vt', zeroBased: true });
        runProbes(client, elapsed => {
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            assert(client.term.termWidth > 0 && client.term.termHeight > 0);
            assert(sent(client).includes(' D'), 'the font probe is still sent');
            return done();
        });
    });

    it("Telix's rows, one too high, are corrected from the sentinel", done => {
        const { client } = connect({ cpr: 'telix' });
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            return done();
        });
    });

    it('answers to both CSI 255 n and CSI 6 n stay in the size step: CTerm caps still arrive', done => {
        const { client } = connect(
            { cpr: 'normal', rows: 40, cols: 100, cterm: true },
            { da: CTERM_DA }
        );
        assert.equal(client.term.termClient, 'cterm');
        runProbes(client, elapsed => {
            assert.deepEqual(sizeOf(client), [100, 40]);
            assert(elapsed < 1000, `no timeout (${elapsed}ms)`);
            assert.deepEqual(client.term.termCapabilities.ctda, [1, 2, 3, 5]);
            assert.equal(client.term.termCapabilities.osc8, true);
            assert.equal(client.term.syncTermFontsEnabled, true);
            assert.equal(client.listenerCount('cursor position report'), 0);
            return done();
        });
    });

    it('NAWS 80x0: the probe fills in the height only', done => {
        const { client } = connect({ cpr: 'normal', rows: 30, cols: 90 }, { width: 80 });
        runProbes(client, () => {
            assert.deepEqual(sizeOf(client), [80, 30]);
            return done();
        });
    });

    it('NAWS 80x0 and no usable reply: the height defaults to 25', done => {
        const { client } = connect({ cpr: 'one' }, { width: 80 });
        runProbes(client, () => {
            assert.deepEqual(sizeOf(client), [80, 25]);
            return done();
        });
    });

    it('NAWS 132x50: no size query, the size is kept, the probe bytes are as before', done => {
        const { client } = connect({ cpr: 'normal' }, { width: 132, height: 50 });
        runProbes(client, () => {
            assert.deepEqual(sizeOf(client), [132, 50]);
            assert.deepEqual(client.writes, [
                '\x1b[H\x1b[6n',
                '\x1b[1;1H\x1b[0;0 D\x1b[6n', //  the SyncTERM font probe
            ]);
            return done();
        });
    });

    describe('a terminal that sends its replies a byte at a time', () => {
        it('has every reply read, and none of it taken as keys', done => {
            const { client } = connect({
                cpr: 'normal',
                rows: 30,
                cols: 90,
                bytewise: true,
            });
            const keys = [];
            client.on('key press', (ch, key) => keys.push(ch || (key && key.name)));
            runProbes(client, elapsed => {
                assert.deepEqual(sizeOf(client), [90, 30]);
                assert(elapsed < 1500, `no timeout (${elapsed}ms)`);
                assert.deepEqual(keys, []);
                return done();
            });
        });

        it('the decoder holds a lone ESC only while a reply is awaited', () => {
            const {
                createAnsiInputDecoder,
            } = require('../core/term/ansi/input_decoder.js');
            const decoder = createAnsiInputDecoder();
            const events = [];
            const host = { isNixTerm: () => false };
            const feed = text =>
                decoder.decode(Buffer.from(text, 'latin1'), host, (name, ...args) =>
                    events.push([name, 'key press' === name ? args[1].name : args[0]])
                );
            try {
                //  not waiting: ESC alone is the Escape key, at once
                feed('\x1b');
                assert.deepEqual(events, [['key press', 'escape']]);
                events.length = 0;

                decoder.holdLoneEsc(true);
                '\x1b[25;80R'.split('').forEach(feed);
                assert.deepEqual(events, [['cursor position report', [25, 80]]]);
                events.length = 0;

                decoder.holdLoneEsc(false);
                feed('\x1b');
                assert.deepEqual(events, [['key press', 'escape']]);
                events.length = 0;

                //  holds are counted: a probe started from another's reply
                //  holds before the first lets go (the UTF-8 probes)
                decoder.holdLoneEsc(true);
                decoder.holdLoneEsc(true);
                decoder.holdLoneEsc(false);
                '\x1b[3;7R'.split('').forEach(feed);
                assert.deepEqual(events, [['cursor position report', [3, 7]]]);
                events.length = 0;
                decoder.holdLoneEsc(false);
                feed('\x1b');
                assert.deepEqual(events, [['key press', 'escape']]);
            } finally {
                decoder.dispose();
            }
        });
    });

    describe('the art parser and views with no size', () => {
        it('the ANSI art parser takes a size of 0 as none', () => {
            const { ANSIEscapeParser } = require('../core/ansi_escape_parser.js');
            const parser = new ANSIEscapeParser({ termHeight: 0, termWidth: 0 });
            assert.equal(parser.termHeight, 25);
            assert.equal(parser.termWidth, 80);

            const rows = [];
            parser.on('position update', row => rows.push(row));
            parser.parse('one\r\ntwo\r\n');
            assert(rows.length > 0);
            assert(
                rows.every(row => row >= 1),
                `no row 0: ${rows}`
            );
        });

        it('View.setPosition() does not clamp to a size of 0', () => {
            const View = require('../core/view.js').View;
            const view = {
                position: {},
                client: { term: { termHeight: 0, termWidth: 0 } },
            };
            View.prototype.setPosition.call(view, { row: 16, col: 64 });
            assert.deepEqual(view.position, { row: 16, col: 64 });

            view.client.term = { termHeight: 25, termWidth: 80 };
            View.prototype.setPosition.call(view, { row: 99, col: 99 });
            assert.deepEqual(view.position, { row: 25, col: 80 });
        });
    });
    describe('telnet NAWS', () => {
        //  ClientTerminal's size setters take positive values only
        it('a dimension of 0 never replaces a known one', () => {
            const { EventEmitter } = require('events');
            const telnet = require('../core/servers/login/telnet.js');
            const rawSocket = new EventEmitter();
            rawSocket.write = () => true;
            rawSocket.end = () => {};
            const client = new telnet.TelnetClient(rawSocket);
            clients.push(client);
            const naws = (w, h) =>
                rawSocket.emit(
                    'data',
                    Buffer.from([
                        255,
                        250,
                        31,
                        w >> 8,
                        w & 0xff,
                        h >> 8,
                        h & 0xff,
                        255,
                        240,
                    ])
                );
            try {
                //  before the connect probes: 80x0 gives the width only
                naws(80, 0);
                assert.deepEqual(sizeOf(client), [80, 0]);

                //  after them (a probed or default height): kept
                client.term.termHeight = 25;
                naws(132, 0);
                assert.deepEqual(sizeOf(client), [132, 25]);
                assert.deepEqual(client.term.env, { COLUMNS: 132 });

                //  a real size is taken as always
                naws(100, 40);
                assert.deepEqual(sizeOf(client), [100, 40]);
            } finally {
                client.emit('end'); //  clears the terminal type timer
            }
        });
    });
});
