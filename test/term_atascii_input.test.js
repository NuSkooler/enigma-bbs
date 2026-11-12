'use strict';

//  ATASCII input decoder (#593 step 7c): core/term/atascii/input_decoder.js.
//  Expected bytes come from the facts in charset.js (SyncTERM cterm.c atascii_keys,
//  icy_term ATASCII_KEY_MAP); parity tests run the ANSI decoder for the
//  equivalent key.

const { strict: assert } = require('assert');

const {
    createAtasciiInputDecoder,
    StandIns,
} = require('../core/term/atascii/input_decoder.js');
const { createAnsiInputDecoder } = require('../core/term/ansi/input_decoder.js');
const { KeyBytes, EscPrefixedKeys } = require('../core/term/atascii/charset.js');

const HOST = { isNixTerm: () => false };

function run(decoder, data) {
    const events = [];
    decoder.decode('string' === typeof data ? data : Buffer.from(data), HOST, (n, ...a) =>
        events.push([n, ...a])
    );
    return events;
}

function keys(decoder, data) {
    return run(decoder, data).map(e => {
        assert.equal(e[0], 'key press');
        const key = e[2] ? Object.assign({}, e[2]) : e[2];
        if (key) {
            delete key.seq;
            delete key.code;
        }
        return [e[1], key];
    });
}

const names = list => list.map(([ch, key]) => (key ? key.name : ch));

const ansi = createAnsiInputDecoder();
const mk = opts => createAtasciiInputDecoder(opts);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function plain(name, mods) {
    return Object.assign({ name, ctrl: false, meta: false, shift: false }, mods);
}

describe('ATASCII input decoder', function () {
    describe('table', function () {
        const SKIP = new Set([0x1b]); //  Escape is lookahead, tested below
        for (const [b, name] of Object.entries(KeyBytes)) {
            const byte = Number(b);
            if (SKIP.has(byte)) {
                continue;
            }
            it(`KeyBytes 0x${byte.toString(16)} is ${name}`, function () {
                const k = keys(mk(), [byte]);
                //  0D is held only to swallow a following 0A / 00
                assert.equal(k.length, 1);
                assert.equal(k[0][1].name, name);
            });
        }

        for (const [b, name] of Object.entries(EscPrefixedKeys)) {
            const byte = Number(b);
            it(`ESC 0x${byte.toString(16)} is ${name}`, function () {
                const k = keys(mk(), [0x1b, byte]);
                assert.equal(k.length, 1);
                assert.equal(k[0][1].name, name);
                assert.equal(k[0][1].meta, false);
            });
        }

        it('Escape on its own (timeout 0)', function () {
            assert.deepEqual(keys(mk({ escTimeoutMs: 0 }), [0x1b]), [
                ['\x1b', plain('escape')],
            ]);
        });
    });

    describe('return', function () {
        const ret = ['\r', plain('return')];

        it('9B, 0D, 0D 0A, 0D 00 give one return each', function () {
            for (const bytes of [[0x9b], [0x0d], [0x0d, 0x0a], [0x0d, 0x00]]) {
                assert.deepEqual(keys(mk(), bytes), [ret], bytes.join());
            }
        });

        it('CR and LF in separate calls give one return', function () {
            const d = mk();
            assert.deepEqual(keys(d, [0x0d]), [ret]);
            assert.deepEqual(keys(d, [0x0a]), []);
            assert.deepEqual(keys(d, [0x0a]), [['\n', plain('line feed')]]);
        });

        it('CR and NUL in separate calls give one return', function () {
            const d = mk();
            assert.equal(keys(d, [0x0d]).length, 1);
            assert.equal(keys(d, [0x00]).length, 0);
        });

        it('a late LF (outside the window) is a line feed', async function () {
            const d = mk({ crWindowMs: 5 });
            keys(d, [0x0d]);
            await sleep(30);
            assert.deepEqual(keys(d, [0x0a]), [['\n', plain('line feed')]]);
        });

        it('CR CR is two returns; CR LF CR LF is two', function () {
            assert.equal(keys(mk(), [0x0d, 0x0d]).length, 2);
            assert.equal(keys(mk(), [0x0d, 0x0a, 0x0d, 0x0a]).length, 2);
        });

        it('bare LF is a line feed, as ANSI reports it', function () {
            assert.deepEqual(keys(mk(), [0x0a]), keys(ansi, '\n'));
        });

        it('SyncTERM and IcyTerm style input', function () {
            assert.deepEqual(names(keys(mk(), [0x48, 0x69, 0x0d, 0x0a])), [
                'shift + h',
                'i',
                'return',
            ]);
            assert.deepEqual(names(keys(mk(), [0x48, 0x69, 0x9b])), [
                'shift + h',
                'i',
                'return',
            ]);
        });
    });

    describe('escape versus prefix', function () {
        it('ESC + prefixed byte in one buffer is that key', function () {
            assert.deepEqual(names(keys(mk(), [0x1b, 0x1c])), ['up arrow']);
        });

        it('ESC + ordinary byte is escape then the byte', function () {
            assert.deepEqual(names(keys(mk(), [0x1b, 0x41])), ['escape', 'shift + a']);
            assert.deepEqual(names(keys(mk(), [0x1b, 0x1b, 0x1c])), [
                'escape',
                'up arrow',
            ]);
        });

        it('ESC at end then a prefixed byte later is that key', function () {
            const d = mk();
            assert.deepEqual(keys(d, [0x1b]), []);
            assert.deepEqual(names(keys(d, [0x9b])), ['end']);
            d.dispose();
        });

        it('ESC at end then an ordinary byte is escape then the byte, in order', function () {
            const d = mk();
            assert.deepEqual(keys(d, [0x1b]), []);
            assert.deepEqual(names(keys(d, [0x61])), ['escape', 'a']);
            d.dispose();
        });

        it('ESC at end then nothing becomes escape after the timeout', async function () {
            const d = mk({ escTimeoutMs: 10 });
            const events = run(d, [0x1b]);
            assert.equal(events.length, 0);
            await sleep(50);
            assert.equal(events.length, 1);
            assert.equal(events[0][2].name, 'escape');
            assert.equal(events[0][1], '\x1b');
        });

        it('the timer is cancelled by later input and fires once', async function () {
            const d = mk({ escTimeoutMs: 10 });
            const events = [];
            const emit = (n, ch, key) => events.push(key.name);
            d.decode(Buffer.from([0x1b]), HOST, emit);
            d.decode(Buffer.from([0x1d]), HOST, emit);
            await sleep(40);
            assert.deepEqual(events, ['down arrow']);
        });

        it('dispose cancels a pending escape', async function () {
            const d = mk({ escTimeoutMs: 10 });
            const events = run(d, [0x1b]);
            d.dispose();
            await sleep(40);
            assert.equal(events.length, 0);
            assert.deepEqual(run(d, [0x41]), []); //  a disposed decoder is inert
        });

        it('a throwing emit from the timer is contained', async function () {
            const d = mk({ escTimeoutMs: 5 });
            d.decode(Buffer.from([0x1b]), HOST, () => {
                throw new Error('boom');
            });
            await sleep(30);
        });

        it('escTimeoutMs 0 reports a trailing ESC at once', function () {
            const d = mk({ escTimeoutMs: 0 });
            assert.deepEqual(names(keys(d, [0x1b])), ['escape']);
            assert.deepEqual(names(keys(d, [0x1c])), ['up arrow']);
        });
    });

    describe('letters, inverse and graphics', function () {
        it('letters in both cases like ANSI', function () {
            for (const c of 'azAZ') {
                assert.deepEqual(keys(mk(), c), keys(ansi, c));
            }
        });

        it('digits and punctuation like ANSI', function () {
            for (const c of '09!@#$%&*()-=+[];:,./<>?\\^_|"\'') {
                assert.deepEqual(keys(mk(), c), keys(ansi, c), c);
            }
        });

        it('space like ANSI', function () {
            assert.deepEqual(keys(mk(), ' '), keys(ansi, ' '));
        });

        it('inverse video is stripped', function () {
            for (let b = 0x20; b <= 0x7c; ++b) {
                assert.deepEqual(keys(mk(), [b + 0x80]), keys(mk(), [b]), b.toString(16));
            }
        });

        it('graphics are ch only', function () {
            for (const b of [0x00, 0x60, 0x7b, 0x80, 0x81, 0x9a]) {
                const k = keys(mk(), [b]);
                assert.equal(k.length, 1);
                assert.equal(k[0][1], undefined);
                assert.equal(k[0][0].length, 1);
            }
        });
    });

    describe('ctrl and stand-ins', function () {
        const claimed = new Set([0x08, 0x09, 0x0a, 0x0d]);
        const standIn = new Set(
            Object.keys(StandIns)
                .map(Number)
                .filter(b => b < 0x20)
        );

        it('ctrl+letter matches ANSI except claimed bytes', function () {
            for (let b = 1; b <= 26; ++b) {
                if (claimed.has(b) || standIn.has(b)) {
                    continue;
                }
                const s = String.fromCharCode(b);
                assert.deepEqual(keys(mk(), [b]), keys(ansi, s), `0x${b.toString(16)}`);
            }
        });

        it('claimed bytes match ANSI', function () {
            for (const b of [0x08, 0x09, 0x0a, 0x0d]) {
                assert.deepEqual(
                    keys(mk(), [b]),
                    keys(ansi, String.fromCharCode(b)),
                    `0x${b.toString(16)}`
                );
            }
        });

        it('keys named as ANSI names them', function () {
            const cases = [
                [[0x1c], '\x1b[A'],
                [[0x1d], '\x1b[B'],
                [[0x1f], '\x1b[C'],
                [[0x1e], '\x1b[D'],
                [[0xfe], '\x1b[3~'],
                [[0xff], '\x1b[2~'],
                [[0x1b, 0x9b], '\x1b[F'],
                [[0x7e], '\b'],
                [[0x08], '\b'],
                [[0x1b, 0x7e], '\b'],
                [[0x7f], '\t'],
                [[0x09], '\t'],
            ];
            for (const [bytes, esc] of cases) {
                const a = keys(ansi, esc);
                const t = keys(mk(), bytes);
                assert.equal(t.length, 1);
                assert.equal(t[0][1].name, a[0][1].name, bytes.join());
                assert.equal(t[0][1].ctrl, a[0][1].ctrl);
                assert.equal(t[0][1].meta, a[0][1].meta);
                assert.equal(t[0][1].shift, a[0][1].shift);
                assert.equal(t[0][0], a[0][0], bytes.join());
            }
        });

        it('stand-ins give the ANSI home/end/page keys', function () {
            const cases = [
                [0x7d, '\x1b[H'],
                [0x18, '\x1b[F'],
                [0x17, '\x1b[5~'],
                [0x1a, '\x1b[6~'],
                [0x9c, '\x1b[5~'],
                [0x9d, '\x1b[6~'],
            ];
            for (const [b, esc] of cases) {
                const t = keys(mk(), [b]);
                const a = keys(ansi, esc);
                assert.equal(t[0][1].name, a[0][1].name);
                assert.equal(t[0][0], a[0][0]);
            }
        });

        it('standIns: false restores ctrl combinations', function () {
            assert.equal(keys(mk({ standIns: false }), [0x17])[0][1].name, 'ctrl + w');
            assert.deepEqual(keys(mk({ standIns: false }), [0x7d]), []);
        });

        it('other control bytes are swallowed', function () {
            for (const b of [0x9e, 0x9f, 0xfd]) {
                assert.deepEqual(keys(mk(), [b]), []);
            }
        });
    });

    describe('robustness', function () {
        it('empty, string and undefined host', function () {
            const d = mk();
            assert.deepEqual(run(d, Buffer.alloc(0)), []);
            assert.deepEqual(names(keys(d, 'Hi')), ['shift + h', 'i']);
            const ev = [];
            d.decode(Buffer.from([0x61]), undefined, (...a) => ev.push(a));
            assert.equal(ev.length, 1);
        });

        it('never emits query-reply events', function () {
            const d = mk();
            for (const e of run(d, '\x1b[1;1R\x1b[?1;2c')) {
                assert.equal(e[0], 'key press');
            }
        });

        it('emit throwing keeps the rest of the buffer and the state', function () {
            const d = mk();
            const seen = [];
            let first = true;
            assert.throws(
                () =>
                    d.decode(Buffer.from([0x61, 0x62, 0x0d]), HOST, (n, ch) => {
                        if (first) {
                            first = false;
                            throw new Error('boom');
                        }
                        seen.push(ch);
                    }),
                /boom/
            );
            assert.deepEqual(seen, ['b', '\r']);
            //  CR state survived: the LF in the next call is swallowed
            assert.deepEqual(keys(d, [0x0a]), []);
        });

        it('256-byte sweep alone and after ESC', function () {
            for (let b = 0; b < 256; ++b) {
                const alone = run(mk(), [b]);
                assert.ok(alone.length <= 1, `0x${b.toString(16)}`);
                const after = run(mk({ escTimeoutMs: 0 }), [0x1b, b]);
                assert.ok(after.length <= 2, `esc 0x${b.toString(16)}`);
                for (const e of alone.concat(after)) {
                    assert.equal(e[0], 'key press');
                    assert.ok(undefined === e[1] || 1 === e[1].length);
                }
            }
        });
    });
});
