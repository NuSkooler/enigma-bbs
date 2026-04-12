'use strict';

const { strict: assert } = require('assert');

const { ClientTerminal } = require('../core/client_term.js');
const { display } = require('../core/art.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

//  Build a mock writable output that accumulates all chunks written to it.
function makeMockOutput() {
    const chunks = [];
    const output = {
        writable: true,
        write(chunk, cb) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            if (cb) cb(null);
        },
        get data() {
            return Buffer.concat(chunks);
        },
        get writeCount() {
            return chunks.length;
        },
    };
    return output;
}

//  Build a minimal client mock suitable for art.display().
//  |drip| is an optional spy function; when supplied it replaces dripWrite
//  and immediately calls cb so tests don't have to wait for real timers.
function makeMockClient({ dripSpy } = {}) {
    const written = [];
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            syncTermFontsEnabled: false,
            encode(s /*, convertLineFeeds */) {
                //  Minimal encode: just return a Buffer of the string as-is.
                return Buffer.from(s || '', 'binary');
            },
            rawWrite(data) {
                written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            },
            get rawWritten() {
                return Buffer.concat(written);
            },
            dripWrite: dripSpy || null,
        },
        log: { warn: () => {}, debug: () => {}, trace: () => {} },
    };
}

// ─── ClientTerminal.dripWrite ─────────────────────────────────────────────────

describe('ClientTerminal.dripWrite', () => {
    it('calls cb immediately for an empty buffer', done => {
        const term = new ClientTerminal(makeMockOutput());
        term.dripWrite(Buffer.alloc(0), 960, err => {
            assert.ifError(err);
            done();
        });
    });

    it('calls cb immediately for a null buffer', done => {
        const term = new ClientTerminal(makeMockOutput());
        term.dripWrite(null, 960, err => {
            assert.ifError(err);
            done();
        });
    });

    it('delivers all bytes to output', done => {
        const output = makeMockOutput();
        const term = new ClientTerminal(output);
        const data = Buffer.from('Hello, ENiGMA½!');
        //  Use a high rate so the test finishes quickly.
        term.dripWrite(data, 115200, err => {
            assert.ifError(err);
            assert.deepStrictEqual(output.data, data);
            done();
        });
    });

    it('delivers bytes in correct order across multiple ticks', done => {
        const output = makeMockOutput();
        const term = new ClientTerminal(output);
        //  240 bytes/sec (2400 baud equivalent) → 4 bytes/tick at 16ms → 8 ticks for 32 bytes.
        const data = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
        term.dripWrite(data, 240, err => {
            assert.ifError(err);
            assert.deepStrictEqual(output.data, data);
            //  Confirm it actually chunked (more than one write call).
            assert.ok(output.writeCount > 1, 'expected multiple write calls');
            done();
        });
    });

    it('propagates socket write errors through cb', done => {
        const output = {
            writable: true,
            write(_chunk, cb) {
                cb(new Error('socket gone'));
            },
        };
        const term = new ClientTerminal(output);
        term.dripWrite(Buffer.from('test'), 9600, err => {
            assert.ok(err instanceof Error);
            assert.strictEqual(err.message, 'socket gone');
            done();
        });
    });

    it('errors when output becomes unwritable between ticks', done => {
        let calls = 0;
        const output = {
            get writable() {
                return calls === 0;
            },
            write(chunk, cb) {
                calls++;
                cb(null);
            },
        };
        const term = new ClientTerminal(output);
        //  Very slow rate forces multiple ticks; output goes unwritable after tick 1.
        const data = Buffer.alloc(200, 0x41);
        term.dripWrite(data, 10, err => {
            assert.ok(err instanceof Error);
            done();
        });
    });
});

// ─── art.display() baud rate path ─────────────────────────────────────────────

describe('art.display() baud rate emulation', () => {
    //  Plain art with no MCI codes and no ANSI escapes — purely literal text.
    const PLAIN_ART = 'Hello BBS\r\nSecond line\r\n';

    it('without baudRate: writes directly via rawWrite, cb fires synchronously', done => {
        const client = makeMockClient();
        display(client, PLAIN_ART, {}, (err, mciMap) => {
            assert.ifError(err);
            assert.ok(client.term.rawWritten.length > 0, 'expected bytes written');
            assert.ok(typeof mciMap === 'object');
            done();
        });
    });

    it('with baudRate: calls dripWrite instead of rawWrite', done => {
        let dripBuf = null;
        let dripBytesPerSec = null;

        const dripSpy = (buf, bytesPerSec, cb) => {
            dripBuf = buf;
            dripBytesPerSec = bytesPerSec;
            cb(null); //  resolve immediately
        };

        const client = makeMockClient({ dripSpy });
        display(client, PLAIN_ART, { baudRate: 2400 }, (err, mciMap) => {
            assert.ifError(err);
            //  dripWrite should have been called
            assert.ok(dripBuf !== null, 'dripWrite was not called');
            //  2400 baud → 240 bytes/sec
            assert.strictEqual(dripBytesPerSec, 240);
            //  The drip buffer should contain the art content
            assert.ok(dripBuf.length > 0);
            //  rawWrite should not have been called for art content
            assert.strictEqual(client.term.rawWritten.length, 0);
            assert.ok(typeof mciMap === 'object');
            done();
        });
    });

    it('with baudRate: cb fires only after dripWrite completes', done => {
        const events = [];
        const dripSpy = (_buf, _bps, cb) => {
            events.push('dripStart');
            setImmediate(() => {
                events.push('dripEnd');
                cb(null);
            });
        };

        const client = makeMockClient({ dripSpy });
        display(client, PLAIN_ART, { baudRate: 9600 }, err => {
            assert.ifError(err);
            assert.deepStrictEqual(events, ['dripStart', 'dripEnd']);
            done();
        });
    });

    it('with baudRate: dripWrite error is forwarded to cb', done => {
        const dripSpy = (_buf, _bps, cb) => cb(new Error('drip failed'));

        const client = makeMockClient({ dripSpy });
        display(client, PLAIN_ART, { baudRate: 9600 }, err => {
            assert.ok(err instanceof Error);
            assert.strictEqual(err.message, 'drip failed');
            done();
        });
    });

    it('with baudRate: mciMap is still populated correctly', done => {
        //  Art with a single MCI code embedded.
        const artWithMci = 'Before %TI1 after\r\n';
        const dripSpy = (_buf, _bps, cb) => cb(null);

        const client = makeMockClient({ dripSpy });
        display(client, artWithMci, { baudRate: 9600 }, (err, mciMap) => {
            assert.ifError(err);
            //  %TI1 → key 'TI1'
            assert.ok('TI1' in mciMap, 'mciMap should contain TI1');
            done();
        });
    });

    it('baudRate 0 falls through to immediate write (no drip)', done => {
        let dripCalled = false;
        const dripSpy = (_buf, _bps, cb) => {
            dripCalled = true;
            cb(null);
        };

        const client = makeMockClient({ dripSpy });
        display(client, PLAIN_ART, { baudRate: 0 }, err => {
            assert.ifError(err);
            assert.strictEqual(
                dripCalled,
                false,
                'dripWrite should not be called for baudRate 0'
            );
            done();
        });
    });
});
