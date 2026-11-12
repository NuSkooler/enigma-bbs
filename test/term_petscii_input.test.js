'use strict';

//  PETSCII input decoder (#593 step 5c): core/term/petscii/input_decoder.js.
//  Expected bytes come from SyncTERM cterm.c `petscii_keys` and the C64 keyboard,
//  not from the module; parity tests run the ANSI decoder for the equivalent key.

const { strict: assert } = require('assert');

const { createPetsciiInputDecoder } = require('../core/term/petscii/input_decoder.js');
const { createAnsiInputDecoder } = require('../core/term/ansi/input_decoder.js');
const { KeyBytes } = require('../core/term/petscii/charset.js');

const HOST = { isNixTerm: () => false };

function run(decoder, data) {
    const events = [];
    decoder.decode(
        'string' === typeof data ? data : Buffer.from(data),
        HOST,
        (name, ...args) => events.push([name, ...args])
    );
    return events;
}

const petscii = createPetsciiInputDecoder();
const ansi = createAnsiInputDecoder();

//  [ch, key] pairs, key without seq
function keys(decoder, data) {
    return run(decoder, data).map(e => {
        assert.equal(e[0], 'key press');
        const key = e[2] ? Object.assign({}, e[2]) : e[2];
        if (key) {
            //  seq is raw bytes, code is the ANSI decoder's CSI tail
            delete key.seq;
            delete key.code;
        }
        return [e[1], key];
    });
}

function one(bytes) {
    const k = keys(petscii, bytes);
    assert.equal(k.length, 1, `byte ${bytes} -> ${k.length} events`);
    return k[0];
}

function plain(name, mods) {
    return Object.assign({ name, ctrl: false, meta: false, shift: false }, mods);
}

describe('PETSCII input decoder', () => {
    it('has the same factory shape as the ANSI decoder', () => {
        assert.equal(typeof petscii.decode, 'function');
        assert.equal(typeof createPetsciiInputDecoder().decode, 'function');
    });

    describe('KeyBytes', () => {
        for (const [byte, tableName] of Object.entries(KeyBytes)) {
            //  CLR (0x93) is reported as End, F1 (0x85) as Escape, F3 and F5
            //  (0x86, 0x87) as Page Up and Page Down; see the decoder
            const name =
                { 0x93: 'end', 0x85: 'escape', 0x86: 'page up', 0x87: 'page down' }[
                    Number(byte)
                ] || tableName;
            it(`0x${Number(byte).toString(16)} is ${name}`, () => {
                const [, key] = one([Number(byte)]);
                assert.equal(key.name, name);
                assert.equal(key.ctrl, false);
                assert.equal(key.meta, false);
                assert.equal(key.shift, false);
            });
        }

        it('emits the raw byte as seq', () => {
            assert.equal(run(petscii, [0x91])[0][2].seq, '\x91');
        });
    });

    describe('letters', () => {
        for (let i = 0; i < 26; ++i) {
            const lower = String.fromCharCode(0x61 + i);
            const upper = lower.toUpperCase();
            it(`${lower}/${upper}`, () => {
                const unshifted = plain(lower);
                const shifted = plain('shift + ' + lower, { shift: true });
                assert.deepEqual(one([0x41 + i]), [lower, unshifted]);
                assert.deepEqual(one([0xc1 + i]), [upper, shifted]);
                assert.deepEqual(one([0x61 + i]), [upper, shifted]);
            });
        }
    });

    describe('printable bytes', () => {
        it('digits and punctuation are plain characters', () => {
            for (const ch of '0123456789!"#$%&\'()*+,-./:;<=>?@[]') {
                assert.deepEqual(one([ch.charCodeAt(0)]), [ch, undefined]);
            }
        });

        it('space and shifted space are the space key', () => {
            assert.deepEqual(one([0x20]), [' ', plain('space')]);
            assert.deepEqual(one([0xa0]), [' ', plain('space')]);
        });

        it('pound, up arrow and left arrow are the ASCII keys in those positions', () => {
            assert.deepEqual(one([0x5c]), ['\\', undefined]);
            assert.deepEqual(one([0x5e]), ['^', undefined]);
            assert.deepEqual(one([0x5f]), ['_', undefined]);
        });

        it('graphics glyphs are key presses with a character and no name', () => {
            const [ch, key] = one([0xc0]);
            assert.equal(ch.codePointAt(0), 0x2500);
            assert.equal(key, undefined);
            //  private-use glyph: 0xDF and 0xFF are hatches in lower/upper
            const [pua, pkey] = one([0xdf]);
            assert.equal(1, pua.length);
            assert.equal(pkey, undefined);
            assert.equal(one([0xff])[0].codePointAt(0), 0xedde);
        });

        it('every printable byte yields exactly one key press', () => {
            for (let b = 0x20; b <= 0xff; ++b) {
                if (b >= 0x80 && b <= 0x9f) {
                    continue;
                }
                assert.equal(keys(petscii, [b]).length, 1, `0x${b.toString(16)}`);
            }
        });
    });

    describe('swallowed bytes', () => {
        const swallowed = [
            0x00, 0x05, 0x0e, 0x12, 0x1c, 0x1e, 0x1f, 0x81, 0x8e, 0x90, 0x92, 0x95, 0x96,
            0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f, 0x80, 0x82, 0x83, 0x84, 0x8f,
        ];
        for (const b of swallowed) {
            it(`0x${b.toString(16)} gives no key press`, () => {
                assert.deepEqual(run(petscii, [b]), []);
            });
        }

        it('does not disturb the bytes around it', () => {
            assert.deepEqual(
                keys(petscii, [0x41, 0x1c, 0x42]).map(k => k[0]),
                ['a', 'b']
            );
        });
    });

    describe('control combinations', () => {
        it('reports free C0 bytes as ctrl + letter, like ANSI', () => {
            for (const b of [
                0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x0b, 0x0c, 0x0f, 0x10,
            ]) {
                assert.deepEqual(keys(petscii, [b]), keys(ansi, String.fromCharCode(b)));
            }
            assert.deepEqual(one([0x03]), ['\x03', plain('ctrl + c', { ctrl: true })]);
            assert.equal(one([0x18])[1].name, 'ctrl + x');
            assert.equal(one([0x1a])[1].name, 'ctrl + z');
        });

        it('0x15-0x1a are ctrl + u..z', () => {
            const names = [0x15, 0x16, 0x17, 0x18, 0x19, 0x1a].map(b => one([b])[1].name);
            assert.deepEqual(names, [
                'ctrl + u',
                'ctrl + v',
                'ctrl + w',
                'ctrl + x',
                'ctrl + y',
                'ctrl + z',
            ]);
        });

        it('bytes PETSCII uses never come out as ctrl + letter', () => {
            for (const b of [0x05, 0x0e, 0x11, 0x12, 0x13, 0x14]) {
                for (const [, key] of keys(petscii, [b])) {
                    assert.equal(key.ctrl, false);
                }
            }
        });

        it('backspace (08), tab and line feed as ANSI names them', () => {
            assert.equal(one([0x08])[1].name, 'backspace');
            assert.deepEqual(one([0x09]), ['\t', plain('tab')]);
            assert.deepEqual(one([0x0a]), ['\n', plain('line feed')]);
        });
    });

    describe('escape and high bytes', () => {
        it('ESC is an immediate escape key', () => {
            assert.deepEqual(keys(petscii, [0x1b]), keys(ansi, '\x1b'));
            assert.deepEqual(one([0x1b]), ['\x1b', plain('escape')]);
        });

        it('F1 is the escape key, exactly as ESC is', () => {
            const [ch, key] = one([0x85]);
            assert.deepEqual([ch, key], ['\x1b', plain('escape')]);
            assert.deepEqual([ch, key], one([0x1b]));
            assert.deepEqual(keys(petscii, [0x85]), keys(ansi, '\x1b'));
            //  seq is still the byte that came in
            assert.equal(run(petscii, [0x85])[0][2].seq, '\x85');
        });

        it('F1, F3 and F5 are never reported as themselves; F2, F4, F6-F8 are', () => {
            const names = [0x85, 0x89, 0x86, 0x8a, 0x87, 0x8b, 0x88, 0x8c].map(
                b => one([b])[1].name
            );
            assert.deepEqual(names, [
                'escape',
                'f2',
                'page up',
                'f4',
                'page down',
                'f6',
                'f7',
                'f8',
            ]);
            for (let b = 0; b < 256; ++b) {
                for (const [, key] of keys(petscii, [b])) {
                    assert.ok(
                        !['f1', 'f3', 'f5'].includes(key && key.name),
                        `0x${b.toString(16)}`
                    );
                }
            }
        });

        it('F3 and F5 are page up and page down, exactly as ANSI reports them', () => {
            assert.deepEqual(keys(petscii, [0x86]), keys(ansi, '\x1b[5~'));
            assert.deepEqual(keys(petscii, [0x87]), keys(ansi, '\x1b[6~'));
            assert.deepEqual(one([0x86]), [undefined, plain('page up')]);
            assert.deepEqual(one([0x87]), [undefined, plain('page down')]);
            assert.equal(run(petscii, [0x86])[0][2].seq, '\x86');
        });

        it('F1 between other keys is one escape in stream order', () => {
            assert.deepEqual(
                keys(petscii, [0x41, 0x85, 0x42]).map(k => k[1] && k[1].name),
                ['a', 'escape', 'b']
            );
        });

        it('ESC then a letter is two keys, not meta + letter', () => {
            assert.deepEqual(keys(petscii, [0x1b, 0x41]), [
                ['\x1b', plain('escape')],
                ['a', plain('a')],
            ]);
        });

        it('a lone high byte does not become ESC + char', () => {
            //  ANSI would turn 0xC1 into ESC + 'A'
            assert.deepEqual(one([0xc1]), ['A', plain('shift + a', { shift: true })]);
            assert.deepEqual(one([0x91]).length, 2);
            assert.equal(one([0x91])[1].name, 'up arrow');
            assert.equal(one([0xc0])[1], undefined);
            assert.equal(one([0xdd])[0], String.fromCodePoint(0x2502));
        });

        it('never emits query replies', () => {
            const all = [];
            for (let b = 0; b < 256; ++b) {
                all.push(b);
            }
            //  also the bytes of an ANSI CPR / DA reply
            all.push(...Buffer.from('\x1b[12;40R\x1b[?64;1;2c'));
            for (const e of run(petscii, all)) {
                assert.equal(e[0], 'key press');
            }
        });
    });

    describe('streams', () => {
        it('a buffer of several bytes yields several keys in order', () => {
            const out = keys(petscii, [0x41, 0xc2, 0x31, 0x91, 0x0d]);
            assert.deepEqual(
                out.map(k => k[0]),
                ['a', 'B', '1', undefined, '\r']
            );
            assert.equal(out[3][1].name, 'up arrow');
        });

        it('typing abc + Enter as SyncTERM sends it (41 42 43 0d)', () => {
            const out = run(petscii, Buffer.from('4142430d', 'hex'));
            assert.deepEqual(
                out.map(e => e[1]),
                ['a', 'b', 'c', '\r']
            );
            assert.deepEqual(
                out.map(e => e[2].name),
                ['a', 'b', 'c', 'return']
            );
        });

        it('accepts a latin1 string and an empty buffer', () => {
            assert.deepEqual(
                keys(petscii, '\x41\xc1').map(k => k[0]),
                ['a', 'A']
            );
            assert.deepEqual(run(petscii, Buffer.alloc(0)), []);
        });

        it('does not mutate the caller buffer', () => {
            const buf = Buffer.from([0xc1]);
            run(petscii, buf);
            assert.equal(buf[0], 0xc1);
        });
    });

    describe('parity with the ANSI decoder', () => {
        //  [description, petscii bytes, ansi input]
        const pairs = [
            ['up arrow', [0x91], '\x1b[A'],
            ['down arrow', [0x11], '\x1b[B'],
            ['right arrow', [0x1d], '\x1b[C'],
            ['left arrow', [0x9d], '\x1b[D'],
            ['home', [0x13], '\x1b[H'],
            ['end (CLR, what SyncTERM sends for End)', [0x93], '\x1b[F'],
            ['insert', [0x94], '\x1b[2~'],
            ['f1 is escape', [0x85], '\x1b'],
            ['f2', [0x89], '\x1b[12~'],
            ['f3 is page up', [0x86], '\x1b[5~'],
            ['f4', [0x8a], '\x1b[14~'],
            ['f5 is page down', [0x87], '\x1b[6~'],
            ['f6', [0x8b], '\x1b[17~'],
            ['f7', [0x88], '\x1b[18~'],
            ['f8', [0x8c], '\x1b[19~'],
            ['return', [0x0d], '\r'],
            ['shift-return', [0x8d], '\r'],
            ['backspace', [0x14], '\b'],
            ['escape', [0x1b], '\x1b'],
            ['tab', [0x09], '\t'],
            ['space', [0x20], ' '],
            ['letter', [0x41], 'a'],
            ['shifted letter', [0xc1], 'A'],
            ['mirror shifted letter', [0x7a], 'Z'],
            ['digit', [0x37], '7'],
            ['punctuation', [0x2f], '/'],
            ['ctrl-c', [0x03], '\x03'],
            ['ctrl-x', [0x18], '\x18'],
        ];

        for (const [desc, bytes, ansiIn] of pairs) {
            it(desc, () => {
                const a = keys(ansi, ansiIn);
                const p = keys(petscii, bytes);
                assert.equal(a.length, 1);
                //  ch for the sequence-based keys is undefined in both
                assert.deepEqual(p[0][1], a[0][1]);
                assert.equal(p[0][0], a[0][0]);
            });
        }

        it('key objects have the same properties apart from the ANSI-only code', () => {
            const a = run(ansi, '\x1b[A')[0][2];
            const p = run(petscii, [0x91])[0][2];
            assert.deepEqual(Object.keys(p).sort(), [
                'ctrl',
                'meta',
                'name',
                'seq',
                'shift',
            ]);
            assert.ok(Object.keys(a).includes('name'));
            assert.equal(a.name, p.name);
        });
    });
});
