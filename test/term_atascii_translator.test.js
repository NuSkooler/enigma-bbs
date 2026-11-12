'use strict';

//  ATASCII output translator (#593 step 7b): core/term/atascii/output_translator.js
//
//  The core style is equivalence, as for PETSCII: the same ANSI input goes to the
//  ANSI screen model and, through translate(), to the ATASCII screen model (both in
//  test/term_atascii_screens.js); the grids must match cell by cell (character and
//  inverse video; colour does not exist), and the cursors too. The ATASCII model
//  throws on bytes the translator must never send, so every test also checks that.

const { strict: assert } = require('assert');

const { Controls, isControlByte } = require('../core/term/atascii/charset.js');
const {
    Effect,
    createScreenState,
    applyByte,
} = require('../core/term/atascii/screen_rules.js');
const {
    createAtasciiTranslator,
    MAX_COLS,
    MAX_ROWS,
} = require('../core/term/atascii/output_translator.js');
const { AnsiScreen, AtasciiScreen, diffScreens } = require('./term_atascii_screens.js');

const ESC = '\x1b';
const CSI = '\x1b[';
const RESET = `${CSI}0m${CSI}2J${CSI}H`; //  ansi_term.resetScreen()

const C = Controls;
const UP = C.cursorUp;
const DOWN = C.cursorDown;
const LEFT = C.cursorLeft;
const RIGHT = C.cursorRight;
const EOL = C.eol;
const CLEAR = C.clear;

function run(input, { cols = 40, rows = 24, quoted = true, start, edges } = {}) {
    const t = createAtasciiTranslator({ cols, rows, quoted });
    const ansi = new AnsiScreen(cols, rows).write(input);
    const out = t.translate(Buffer.from(input, 'utf8'));
    const ata = new AtasciiScreen(cols, rows, { ...start, quoted, edges }).write(out);
    return { t, ansi, ata, out };
}

function assertEquivalent(input, opts = {}) {
    const r = run(input, opts);
    const diffs = diffScreens(r.ansi, r.ata, opts);
    assert.deepEqual(diffs, [], `screens differ for ${JSON.stringify(input)}`);
    return r;
}

//  a translator whose position is known: (0,0) after a clear
function known(opts) {
    const t = createAtasciiTranslator(opts);
    assert.deepEqual([...t.translate(RESET)], [CLEAR]);
    return t;
}

const bytes = (t, s) => [...t.translate(s)];

describe('ATASCII output translator', function () {
    describe('interface', function () {
        it('has the translator shape', function () {
            const t = createAtasciiTranslator();
            assert.equal(t.identity, false);
            for (const fn of ['translate', 'passThrough', 'setSize', 'reset', 'state']) {
                assert.equal(typeof t[fn], 'function', fn);
            }
            assert.equal(t.passThrough(Buffer.from('x')), undefined);
            assert.equal(t.state().cols, 40);
            assert.equal(t.state().rows, 24);
        });

        it('returns Buffers and accepts strings the same as UTF-8 Buffers', function () {
            const s = `${RESET}Grüße ┌─┐ █`;
            const a = createAtasciiTranslator().translate(s);
            const b = createAtasciiTranslator().translate(Buffer.from(s, 'utf8'));
            assert.ok(Buffer.isBuffer(a));
            assert.deepEqual(a, b);
        });

        it('sends nothing ahead of the first output (no attribute or charset state)', function () {
            const t = createAtasciiTranslator();
            assert.deepEqual(bytes(t, `${CSI}1;31;44m`), []);
        });

        it('rejects a bad size or quoted option', function () {
            assert.throws(() => createAtasciiTranslator({ cols: 0 }), RangeError);
            assert.throws(() => createAtasciiTranslator({ rows: 1 }), RangeError);
            assert.throws(() => createAtasciiTranslator({ cols: 40.5 }), RangeError);
            assert.throws(() => createAtasciiTranslator({ quoted: 'no' }), TypeError);
            assert.throws(() => createAtasciiTranslator().setSize(2, 0), RangeError);
        });

        it('state() is a plain snapshot', function () {
            const t = createAtasciiTranslator({ quoted: false });
            let s = t.state();
            assert.equal(s.known, false);
            assert.equal(s.quoted, false);
            t.translate(`${CSI}5;10H${CSI}7m`);
            s = t.state();
            assert.equal(s.known, true);
            assert.equal(s.row, 4);
            assert.equal(s.col, 9);
            assert.equal(s.terminalRow, 4);
            assert.equal(s.terminalCol, 9);
            assert.equal(s.inverse, true);
            s.row = 99;
            assert.equal(t.state().row, 4);
        });

        it('reset() starts over: position unknown, attributes default', function () {
            const t = known();
            t.translate(`${CSI}7mhello`);
            t.reset();
            assert.equal(t.state().known, false);
            assert.equal(t.state().inverse, false);
            assert.deepEqual(bytes(t, `${CSI}2;2H`), [CLEAR, DOWN, RIGHT]);
        });

        it('null and undefined write nothing', function () {
            const t = known();
            t.translate('a');
            assert.equal(t.translate(null).length, 0);
            assert.equal(t.translate(undefined).length, 0);
        });
    });

    describe('screen rules', function () {
        it('glyphs advance and wrap at once; the bottom-right cell scrolls', function () {
            const s = createScreenState({ row: 23, col: 38 });
            assert.equal(applyByte(s, 0x41, 40, 24), Effect.Glyph);
            assert.equal(applyByte(s, 0xc1, 40, 24), Effect.Glyph | Effect.Scrolled);
            assert.deepEqual([s.row, s.col], [23, 0]);
        });

        it('ESC quotes the next byte, except END OF LINE', function () {
            const s = createScreenState({ row: 3, col: 5 });
            applyByte(s, C.escape, 40, 24);
            assert.equal(s.quote, true);
            assert.equal(applyByte(s, C.cursorUp, 40, 24), Effect.Glyph);
            assert.deepEqual([s.row, s.col], [3, 6]);
            applyByte(s, C.escape, 40, 24);
            applyByte(s, C.eol, 40, 24);
            assert.deepEqual([s.row, s.col, s.quote], [4, 0, false]);
        });

        it('cursor bytes wrap at the edges as SyncTERM does', function () {
            const s = createScreenState();
            applyByte(s, UP, 40, 24);
            applyByte(s, LEFT, 40, 24);
            assert.deepEqual([s.row, s.col], [23, 39]);
            applyByte(s, DOWN, 40, 24);
            applyByte(s, RIGHT, 40, 24);
            assert.deepEqual([s.row, s.col], [0, 0]);
        });

        it('CLEAR homes, EOL scrolls on the bottom row, BACKSPACE stops at column 0', function () {
            const s = createScreenState({ row: 9, col: 9 });
            assert.equal(applyByte(s, CLEAR, 40, 24), Effect.Cleared | Effect.Homed);
            assert.equal(applyByte(s, C.backspace, 40, 24), Effect.None);
            s.row = 23;
            s.col = 7;
            assert.equal(applyByte(s, EOL, 40, 24), Effect.Scrolled);
            assert.deepEqual([s.row, s.col], [23, 0]);
            assert.equal(applyByte(s, C.bell, 40, 24), Effect.Bell);
            assert.equal(applyByte(s, C.deleteLine, 40, 24), Effect.Edited);
        });

        it('TAB uses default stops, then set and cleared ones', function () {
            const s = createScreenState({ col: 3 });
            applyByte(s, C.tab, 40, 24);
            assert.equal(s.col, 8);
            s.col = 12;
            applyByte(s, C.setTab, 40, 24);
            s.col = 9;
            applyByte(s, C.tab, 40, 24);
            assert.equal(s.col, 12);
            applyByte(s, C.clearTab, 40, 24);
            applyByte(s, C.tab, 40, 24);
            assert.equal(s.col, 16);
            s.col = 39;
            applyByte(s, C.tab, 40, 24);
            assert.deepEqual([s.row, s.col], [1, 0]);
        });
    });

    describe('text', function () {
        it('plain text', function () {
            const r = assertEquivalent(`${RESET}Hello, World! 0123456789 @[]|`);
            assert.deepEqual([...r.out.subarray(1, 6)], [0x48, 0x65, 0x6c, 0x6c, 0x6f]);
        });

        it('unmappable becomes ?, one cell each; zero width is dropped', function () {
            const r = assertEquivalent(`${RESET}a漢b😀c…d☺e`);
            assert.equal(r.ata.actual(0, 1).ch, '?');
            assert.equal(r.ata.actual(0, 3).ch, '?');
            assert.equal(r.ata.actual(0, 5).ch, '?'); //  '...' fallback is 3 cells: not used
            assert.equal(r.ata.actual(0, 7).ch, '?'); //  ':)' likewise
            assert.equal(r.ata.col, 9);
            const z = run(`${RESET}e\u0301x\u200by\u00adz`);
            assert.equal(z.ata.col, 4);
        });

        it('C0, C1 controls and DEL in text are dropped', function () {
            const t = known();
            assert.deepEqual(
                bytes(t, 'a\u009b\u0085\x7f\x00\x01\x1a\x1cb'),
                [0x61, 0x62]
            );
        });

        it('accented letters lose the accent; typographic quotes fold', function () {
            const r = assertEquivalent(`${RESET}café “x” naïve – ok`);
            assert.equal(r.ata.actual(0, 3).ch, 'e');
        });

        it('box-drawing text', function () {
            assertEquivalent(
                `${RESET}┌──────┐\r\n│ Menu │\r\n├──────┤\r\n└──────┘\r\n╔═╗║╚╝░▒▓`
            );
        });

        it('solid and half blocks through complements', function () {
            const t = known();
            //  full block = inverse space; upper half = inverse lower half; right half =
            //  inverse left half; lower half and left half are plain
            assert.deepEqual(bytes(t, '█▀▐▄▌'), [0xa0, 0x95, 0x99, 0x15, 0x19]);
            //  in inverse video the sense flips: an inverse full block is a space
            assert.deepEqual(bytes(t, `${CSI}7m█▀▐▄▌`), [0x20, 0x15, 0x19, 0x95, 0x99]);
            assertEquivalent(`${RESET}█▀▐▄▌◤◥▛▜▙▟${CSI}7m█▀▐▄▌◤◥▛▜▙▟${CSI}0;44m█ ▄`);
        });

        it('quoted glyphs: arrows and triangles as ESC + byte', function () {
            const t = known();
            assert.deepEqual(bytes(t, '↑↓←→◀▶↖'), [
                ...[0x1b, C.cursorUp],
                ...[0x1b, C.cursorDown],
                ...[0x1b, C.cursorLeft],
                ...[0x1b, C.cursorRight],
                ...[0x1b, C.backspace],
                ...[0x1b, C.tab],
                ...[0x1b, C.clear],
            ]);
            //  in inverse the high half control bytes are quoted too
            assert.deepEqual(bytes(t, `${CSI}7m↑◀▶↖`), [
                ...[0x1b, C.deleteLine],
                ...[0x1b, C.deleteChar],
                ...[0x1b, C.insertChar],
                ...[0x1b, C.bell],
            ]);
            assertEquivalent(`${RESET}↑↓←→◀▶↖␛ ${CSI}7m↑↓←→◀▶↖ x`);
        });

        it('the inverse escape glyph would need ESC 0x9B: it is an inverse ?', function () {
            const t = known();
            assert.deepEqual(bytes(t, '␛'), [0x1b, 0x1b]);
            assert.deepEqual(bytes(t, `${CSI}7m␛`), [0xbf]);
            assertEquivalent(`${RESET}␛${CSI}7m␛`);
        });

        it('quoted: false never sends ESC; ASCII stands in', function () {
            const t = known({ quoted: false });
            assert.deepEqual(
                bytes(t, '↑↓←→◀▶►␛x'),
                [0x5e, 0x76, 0x3c, 0x3e, 0x3c, 0x3e, 0x3e, 0x3f, 0x78]
            );
            assertEquivalent(`${RESET}↑↓←→◀▶↖␛ ${CSI}7m↑↓←→◀▶↖ █▀ x`, { quoted: false });
        });

        it('a quote is an ordinary glyph', function () {
            const r = assertEquivalent(`${RESET}say "hi"${CSI}7m!${CSI}2;1Hok`);
            assert.ok(r.out.includes(0x22));
        });
    });

    describe('cursor', function () {
        it('CUU CUD CUF CUB with counts, defaults and clamping', function () {
            assertEquivalent(
                `${CSI}10;10HA${CSI}AB${CSI}3BC${CSI}2CD${CSI}5DE${CSI}0AF` +
                    `${CSI}99AG${CSI}99BH${CSI}99CI${CSI}99DJ`
            );
        });

        it('CNL CPL CHA HPA VPA', function () {
            assertEquivalent(
                `${CSI}10;10H${CSI}2Ea${CSI}FbX${CSI}20Gc${CSI}5\`d${CSI}3de${CSI}Gf${CSI}99Gg`
            );
        });

        it('CUP and HVP with defaults and out of range values', function () {
            assertEquivalent(
                `${CSI}5;5Ha${CSI}Hb${CSI};7Hc${CSI}9Hd${CSI}12;30fe${CSI}0;0Hf${CSI}99;99Hg${CSI}24;1Hh`
            );
        });

        it('save and restore, both forms', function () {
            assertEquivalent(
                `${CSI}4;6H${ESC}7xx${CSI}20;20Hyy${ESC}8z${CSI}s${CSI}H${CSI}uw`
            );
        });

        it('goto from a known position: relative moves, or EOL when shorter', function () {
            const t = known();
            t.translate(`${CSI}10;10H`);
            assert.deepEqual(bytes(t, `${CSI}10;11H`), [RIGHT]);
            assert.deepEqual(bytes(t, `${CSI}9;11H`), [UP]);
            assert.deepEqual(bytes(t, `${CSI}10;1H`), [EOL]);
            //  a tie goes to the relative moves
            assert.deepEqual(bytes(t, `${CSI}12;2H`), [DOWN, DOWN, RIGHT]);
            assert.deepEqual(bytes(t, `${CSI}12;2H`), []);
            assert.deepEqual(bytes(t, `${CSI}13;1H`), [EOL]);
            t.translate(`${CSI}13;31H`);
            assert.deepEqual(bytes(t, `${CSI}15;3H`), [EOL, DOWN, RIGHT, RIGHT]);
            t.translate(`${CSI}12;2H`);
            //  no home byte: from (11,1) to (0,0) is ups and a left
            assert.deepEqual(bytes(t, `${CSI}1;1H`), [...Array(11).fill(UP), LEFT]);
        });

        it('never wraps across an edge, even when that would be shorter', function () {
            const t = known();
            //  (0,0) -> (23,39): no wrapping UP or LEFT
            const out = bytes(t, `${CSI}24;40H`);
            assert.equal(out.length, 23 + 39);
            assert.ok(!out.includes(UP) && !out.includes(LEFT));
            //  back: no wrapping DOWN or RIGHT
            const back = bytes(t, `${CSI}1;1H`);
            assert.ok(!back.includes(DOWN) && !back.includes(RIGHT));
        });

        it('never sends EOL from the bottom row (it scrolls)', function () {
            const t = known();
            t.translate(`${CSI}24;30H`);
            assert.deepEqual(bytes(t, `${CSI}24;1H`), Array(29).fill(LEFT));
        });

        it('goto never leaves the screen (all corners, from all corners)', function () {
            const corners = ['1;1', '1;40', '24;1', '24;40', '12;20', '23;40', '24;39'];
            for (const a of corners) {
                for (const b of corners) {
                    assertEquivalent(`${RESET}${CSI}${a}Hx${CSI}${b}Hy`);
                }
            }
        });

        it('BS stops at column 0 and is a move, never BACKSPACE; TAB is moves', function () {
            const r = assertEquivalent(`${CSI}3;3Hab\b\b\bX\tY\tZ${CSI}3;38H\tT\tU`);
            assert.ok(!r.out.includes(C.backspace));
            assert.ok(!r.out.includes(C.tab));
        });

        it('RI, IND and NEL', function () {
            assertEquivalent(`${CSI}5;5Ha${ESC}Mb${ESC}Dc${ESC}Ed${CSI}H${ESC}Me`);
        });
    });

    describe('SGR', function () {
        it('7 and 27 are inverse video, bit 7 of each glyph', function () {
            const t = known();
            assert.deepEqual(bytes(t, `a${CSI}7mb${CSI}27mc`), [0x61, 0xe2, 0x63]);
            assertEquivalent(`${RESET}a${CSI}7mb${CSI}27mc${CSI}7md${CSI}0me`);
        });

        it('a non-black background is inverse; 40 and 49 are not', function () {
            const r = assertEquivalent(
                `${RESET}${CSI}33;44mX${CSI}40mY${CSI}104mZ${CSI}49mW${CSI}100mV${CSI}7;41mU`
            );
            assert.deepEqual(
                [0, 1, 2, 3, 4, 5].map(c => r.ata.actual(0, c).inverse),
                [true, false, true, false, true, true]
            );
        });

        it('colours and bold are dropped: no bytes, no inverse', function () {
            const t = known();
            assert.deepEqual(
                bytes(t, `${CSI}1;31mA${CSI}0;36mB${CSI}1;97mC${CSI}22;2;5;4;3;9mD`),
                [0x41, 0x42, 0x43, 0x44]
            );
        });

        it('38/48 extended colours: only a non-black 48 is inverse; 38;5;7 is not SGR 7', function () {
            const t = known();
            assert.deepEqual(bytes(t, `${CSI}38;5;7ma`), [0x61]);
            assert.deepEqual(bytes(t, `${CSI}48;5;4mb${CSI}48;5;0mc`), [0xe2, 0x63]);
            //  (10,10,10) is nearest to black; (250,10,10) to red
            assert.deepEqual(
                bytes(t, `${CSI}48;2;10;10;10md${CSI}48;2;250;10;10me${CSI}49m`),
                [0x64, 0xe5]
            );
            //  ANSI model convention: 2;r;g;b is followed by the expected index
            assertEquivalent(
                `${RESET}${CSI}38;5;12ma${CSI}48;5;1mb${CSI}0;48;2;250;10;10;1mc` +
                    `${CSI}48;2;0;0;0;0md${CSI}0m`
            );
        });

        it('conceal prints spaces (inverse on a background)', function () {
            const t = known();
            assert.deepEqual(
                bytes(t, `${CSI}8mab${CSI}44mc${CSI}28md`),
                [0x20, 0x20, 0xa0, 0xe4]
            );
            assertEquivalent(`${RESET}${CSI}8mab${CSI}44mc${CSI}28;4;5;3md${CSI}0me`);
        });

        it('inverse survives CRLF and cursor moves (there is no mode to lose)', function () {
            assertEquivalent(`${RESET}${CSI}7mab\r\ncd${CSI}5;5He${CSI}Df`);
        });
    });

    describe('erase', function () {
        it('ED 2 and FF are CLEAR and home', function () {
            const t = known();
            t.translate(`${CSI}5;5Hx`);
            assert.deepEqual(bytes(t, `${CSI}2J`), [CLEAR]);
            assert.equal(t.state().row, 0);
            assert.equal(t.state().col, 0);
            assert.deepEqual(bytes(t, 'a\x0c'), [0x61, CLEAR]);
            assertEquivalent(`${CSI}5;5Hxyz${CSI}2Jabc\x0cdef${ESC}cg`);
        });

        it('ED 0 at home is a clear', function () {
            const t = known();
            t.translate(`${CSI}5;5Hx`);
            //  (4,5) -> (0,0): EOL to (5,0), then five UPs, is shorter than 4 UPs + 5 LEFTs
            assert.deepEqual(bytes(t, `${CSI}H${CSI}J`), [
                EOL,
                ...Array(5).fill(UP),
                CLEAR,
            ]);
        });

        const fill = () => {
            let s = RESET;
            for (let r = 0; r < 24; ++r)
                s += `${CSI}${r + 1};1H${'0123456789'.repeat(4)}`;
            return s;
        };

        for (const [name, seq] of [
            ['EL 0', `${CSI}K`],
            ['EL 0 explicit', `${CSI}0K`],
            ['EL 1', `${CSI}1K`],
            ['EL 2', `${CSI}2K`],
            ['ED 0', `${CSI}J`],
            ['ED 1', `${CSI}1J`],
            ['ECH', `${CSI}5X`],
        ]) {
            it(`${name}: plain spaces, cursor stays`, function () {
                assertEquivalent(`${fill()}${CSI}7m${CSI}6;20H${seq}`);
                assertEquivalent(`${fill()}${CSI}44m${CSI}6;20H${seq}Q`);
                assertEquivalent(`${fill()}${CSI}6;20H${seq}Q`);
                assertEquivalent(`${fill()}${CSI}24;40H${seq}`);
                assertEquivalent(`${fill()}${CSI}1;1H${seq}R`);
                assertEquivalent(`${fill()}${CSI}23;40H${seq}S`);
                assertEquivalent(`${fill()}${CSI}24;1H${seq}T`);
            });
        }

        it('an erase writes plain spaces even in inverse', function () {
            const t = known();
            t.translate(`${CSI}7mabc${CSI}1;2H`);
            const out = bytes(t, `${CSI}K`);
            assert.ok(out.includes(0x20));
            assert.ok(!out.includes(0xa0));
        });
    });

    describe('line control', function () {
        it('CRLF is one EOL', function () {
            const t = known();
            t.translate(`${CSI}3;10H`);
            assert.deepEqual(bytes(t, '\r\n'), [EOL]);
        });

        it('CRLF on the bottom row is one EOL: its scroll is the ANSI scroll', function () {
            const t = known();
            t.translate(`${CSI}24;10H`);
            assert.deepEqual(bytes(t, '\r\n'), [EOL]);
            const r = assertEquivalent(
                `${RESET}top\r\nline2${CSI}24;5Hab\r\ncd\r\n\r\nef`
            );
            assert.equal(r.ata.scrolls, 3);
            assert.equal(r.ata.actual(20, 4).ch, 'a');
        });

        it('bare CR: lefts, or EOL + UP when shorter (not on the bottom row)', function () {
            const t = known();
            t.translate(`${CSI}3;3H`);
            assert.deepEqual(bytes(t, '\rx'), [LEFT, LEFT, 0x78]);
            t.translate(`${CSI}3;9H`);
            assert.deepEqual(bytes(t, '\r'), []); //  held: may be half a CRLF
            assert.deepEqual(bytes(t, 'y'), [EOL, UP, 0x79]);
            t.translate(`${CSI}24;9H`);
            assert.deepEqual(bytes(t, '\rz'), [...Array(8).fill(LEFT), 0x7a]);
        });

        it('bare LF: DOWN; on the bottom row EOL (the scroll) then back right', function () {
            const t = known();
            t.translate(`${CSI}3;5H`);
            assert.deepEqual(bytes(t, '\n'), [DOWN]);
            t.translate(`${CSI}24;5H`);
            assert.deepEqual(bytes(t, '\n'), [EOL, RIGHT, RIGHT, RIGHT, RIGHT]);
            const r = assertEquivalent(`${RESET}top${CSI}24;5Hab\ncd\nef${ESC}Dg`);
            assert.equal(r.ata.scrolls, 3);
        });

        it('mixed line ends', function () {
            assertEquivalent(`${RESET}abc\rX\ndef\n\rghi\r\r\nj\n\nk\x0bl`);
        });

        it('CR held at the end of a write pairs with an LF in the next', function () {
            const t = known();
            t.translate(`${CSI}3;10H`);
            assert.deepEqual(bytes(t, '\r'), []);
            assert.deepEqual(bytes(t, '\n'), [EOL]);
        });

        it('a long scrolling text', function () {
            let s = RESET;
            for (let i = 0; i < 40; ++i) s += `line ${i} ${'x'.repeat(i % 30)}\r\n`;
            const r = assertEquivalent(s);
            assert.ok(r.ata.scrolls > 0);
        });
    });

    describe('wrap', function () {
        it('a full row then CRLF sends nothing between: the terminal is there', function () {
            const row = 'abcdefghij'.repeat(4);
            const r = assertEquivalent(`${RESET}${row}\r\nnext`);
            assert.ok(!r.out.includes(EOL));
            assert.equal(r.ata.actual(1, 0).ch, 'n');
        });

        it('41 characters wrap; LF / CR / moves after a full row', function () {
            assertEquivalent(`${RESET}${'x'.repeat(41)}`);
            assertEquivalent(`${RESET}${'y'.repeat(40)}\nz`);
            assertEquivalent(`${RESET}${'y'.repeat(40)}\rz`);
            assertEquivalent(`${RESET}${'y'.repeat(40)}${CSI}Az${CSI}5Dw\bv`);
        });

        it('a long run wraps across many rows', function () {
            assertEquivalent(`${RESET}${CSI}3;35H${'0123456789'.repeat(20)}`);
        });

        it('the bottom-right cell is held, and written when the screen scrolls', function () {
            const r1 = run(`${RESET}${CSI}24;1H${'b'.repeat(40)}`);
            assert.deepEqual(diffScreens(r1.ansi, r1.ata), []);
            assert.equal(r1.ata.actual(23, 39).ch, ' '); //  not written (yet)
            assert.equal(r1.ata.scrolls, 0);
            assert.equal(r1.t.state().wrapPending, true);
            assert.equal(r1.t.state().heldBottomRight, true);

            const r2 = assertEquivalent(`${RESET}${CSI}24;1H${'b'.repeat(39)}Zmore`);
            assert.equal(r2.ata.actual(22, 39).ch, 'Z');
            assert.equal(r2.ata.scrolls, 1);
            assertEquivalent(`${RESET}${CSI}24;1H${'b'.repeat(39)}Z\r\nmore`);
            assertEquivalent(
                `${RESET}${CSI}24;1H${'b'.repeat(39)}${CSI}7mZ${CSI}0m\nmore`
            );
            //  a quoted glyph is held as its two bytes
            const r3 = assertEquivalent(`${RESET}${CSI}24;1H${'b'.repeat(39)}↑${ESC}Dx`);
            assert.equal(r3.ata.actual(22, 39).ch, '↑');

            //  anything else drops it
            const r4 = run(`${RESET}${CSI}24;1H${'b'.repeat(39)}Z${CSI}1;1Hx`);
            assert.deepEqual(diffScreens(r4.ansi, r4.ata), []);
            assert.equal(r4.ata.actual(23, 39).ch, ' ');
            assert.equal(r4.ata.scrolls, 0);
        });
    });

    describe('dropped sequences', function () {
        const dropped = [
            `${CSI}?25l`,
            `${CSI}?25h`,
            `${CSI}?7l`,
            `${CSI}1;24r`,
            `${CSI}6n`,
            `${CSI}c`,
            `${CSI}<0c`,
            `${CSI}=1c`,
            `${CSI}0;36 D`, //  SyncTERM font (Atari slot)
            `${CSI}M`, //  DL: 0x9C is not equivalent
            `${CSI}2L`, //  IL
            `${CSI}P`, //  DCH: 0xFE is not equivalent
            `${CSI}@`, //  ICH
            `${CSI}3S`,
            `${CSI}2 q`,
            `${ESC}]0;title\x07`,
            `${ESC}]8;;http://example.com${ESC}\\`,
            `${ESC}P1;2|data${ESC}\\`,
            `${ESC}_SyncTERM:C;L${ESC}\\`,
            `${ESC}^pm${ESC}\\`,
            `${ESC}Xsos${ESC}\\`,
            `${ESC}(B`,
            `${ESC}=`,
            '\x00\x01',
        ];
        for (const seq of dropped) {
            it(`drops ${JSON.stringify(seq)}`, function () {
                const t = known();
                t.translate('a');
                assert.deepEqual(bytes(t, seq), []);
                assert.deepEqual(bytes(t, 'b'), [0x62]);
            });
        }

        it('OSC 8 keeps the link text', function () {
            const r = assertEquivalent(
                `${RESET}${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\!`
            );
            assert.equal(r.ata.actual(0, 0).ch, 'l');
            assert.equal(r.ata.actual(0, 4).ch, '!');
        });

        it('an OSC with no terminator ends at the next ESC sequence', function () {
            const t = known();
            assert.deepEqual(bytes(t, `${ESC}]0;oops${ESC}[2;1Hb`), [DOWN, 0x62]);
        });

        it('CAN aborts a sequence', function () {
            const t = known();
            assert.deepEqual(bytes(t, `${CSI}31\x18x`), [0x78]);
        });

        it('BEL is BELL (0xFD), and keeps a held bottom-right glyph', function () {
            const t = known();
            assert.deepEqual(bytes(t, 'a\x07b'), [0x61, C.bell, 0x62]);
            const r = assertEquivalent(`${RESET}${CSI}24;40HZ\x07\r\nx`);
            assert.equal(r.ata.bells, 1);
            assert.equal(r.ata.actual(22, 39).ch, 'Z');
        });
    });

    describe('splits', function () {
        const stream =
            `${RESET}${CSI}1;7mGrüße ┌─┐ █▀ ↑ ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\` +
            `\r\n${CSI}44mbg${CSI}0m ${CSI}5;10H😀x\r${CSI}?25l${CSI}K\r\nend${ESC}7${CSI}2Aup${ESC}8` +
            `${CSI}24;1H${'z'.repeat(40)}\r\n${CSI}48;5;9mq\x07\t|${CSI}24;40H◀\nw`;

        it('identical output when cut in two at every offset (bytes)', function () {
            const buf = Buffer.from(stream, 'utf8');
            const whole = createAtasciiTranslator().translate(buf);
            for (let i = 0; i <= buf.length; ++i) {
                const t = createAtasciiTranslator();
                const parts = Buffer.concat([
                    t.translate(buf.subarray(0, i)),
                    t.translate(buf.subarray(i)),
                ]);
                assert.deepEqual(parts, whole, `split at byte ${i}`);
            }
        });

        it('identical output fed one byte at a time', function () {
            const buf = Buffer.from(stream, 'utf8');
            const whole = createAtasciiTranslator().translate(buf);
            const t = createAtasciiTranslator();
            const parts = [];
            for (const b of buf) parts.push(t.translate(Buffer.from([b])));
            assert.deepEqual(Buffer.concat(parts), whole);
        });

        it('and the stream is equivalent', function () {
            assertEquivalent(stream);
            assertEquivalent(stream, { quoted: false });
        });
    });

    describe('passThrough', function () {
        it('forgets the position: a goto clears first, then moves from home', function () {
            const t = known();
            t.translate(`${CSI}7mab`);
            t.passThrough(Buffer.from([0x41, DOWN, 0x42]));
            assert.equal(t.state().known, false);
            assert.deepEqual(bytes(t, `${CSI}2;3Hc`), [CLEAR, DOWN, RIGHT, RIGHT, 0xe3]);
        });

        it('screen equivalence after a passThrough that moved the cursor', function () {
            const input1 = `${RESET}hello`;
            const input2 = `${CSI}10;10Hworld`;
            const t = createAtasciiTranslator();
            const ata = new AtasciiScreen();
            ata.write(t.translate(input1));
            const raw = Buffer.from([DOWN, DOWN, 0x58, 0xd8]);
            t.passThrough(raw);
            ata.write(raw);
            ata.write(t.translate(input2));
            //  the clear takes 'hello' (and the door's bytes) with it
            const ansi = new AnsiScreen(40, 24).write(`${CSI}2J${input2}`);
            assert.deepEqual(diffScreens(ansi, ata), []);
        });

        it('a passThrough ending inside an ESC quote: a space absorbs it', function () {
            const t = known();
            t.passThrough(Buffer.from([0x41, 0x1b]));
            assert.deepEqual(bytes(t, `${CSI}2J`), [0x20, CLEAR]);
            //  across calls: ESC | byte completes the quote; ESC ESC | nothing pending
            t.passThrough(Buffer.from([0x1b]));
            t.passThrough(Buffer.from([0x1c]));
            assert.deepEqual(bytes(t, `${CSI}2J`), [CLEAR]);
            t.passThrough(Buffer.from([0x1b, 0x1b]));
            assert.deepEqual(bytes(t, 'x'), [0x78]);
            t.passThrough(Buffer.from([0x1b, 0x1b, 0x1b]));
            //  dropped sequences send nothing, so the absorber waits for real output
            assert.deepEqual(bytes(t, `${CSI}?25l`), []);
            assert.deepEqual(bytes(t, 'y'), [0x20, 0x79]);
        });

        it('a half-parsed sequence before passThrough is discarded', function () {
            const t = known();
            t.translate(`${CSI}3`);
            t.passThrough(Buffer.alloc(0));
            assert.deepEqual(bytes(t, '1mx'), [0x31, 0x6d, 0x78]);
        });

        it('a held CR before passThrough is discarded', function () {
            const t = known();
            t.translate('ab\r');
            t.passThrough(undefined);
            assert.deepEqual(bytes(t, 'c'), [0x63]);
        });
    });

    describe('unknown position', function () {
        it('text, CRLF, CR, LF and relative moves still go out', function () {
            const t = createAtasciiTranslator();
            assert.deepEqual(bytes(t, 'Hi\r\nyo\rX\nz'), [
                0x48,
                0x69,
                EOL,
                0x79,
                0x6f,
                EOL, //  bare CR: EOL + UP
                UP,
                0x58,
                EOL, //  bare LF: EOL (DOWN could wrap to the top)
                0x7a,
            ]);
            assert.deepEqual(bytes(t, `${CSI}2A${CSI}C${CSI}99D`), [
                UP,
                UP,
                RIGHT,
                ...Array(39).fill(LEFT),
            ]);
            assert.deepEqual(bytes(t, `${CSI}5G`), [EOL, UP, RIGHT, RIGHT, RIGHT, RIGHT]);
            assert.equal(t.state().known, false);
        });

        it('EL, ED 0/1, ECH, TAB, VPA, CNL, CPL and restore are dropped', function () {
            const t = createAtasciiTranslator();
            t.translate(`${ESC}7`);
            for (const seq of [
                `${CSI}K`,
                `${CSI}2K`,
                `${CSI}J`,
                `${CSI}1J`,
                `${CSI}4X`,
                '\t',
                `${CSI}5d`,
                `${CSI}2E`,
                `${CSI}F`,
                `${ESC}8`,
                `${CSI}u`,
            ]) {
                assert.deepEqual(bytes(t, seq), [], JSON.stringify(seq));
            }
            assert.equal(t.state().known, false);
        });

        it('an absolute goto clears first; then all is equivalent', function () {
            for (const start of [
                { row: 0, col: 0 },
                { row: 23, col: 39 },
                { row: 11, col: 0 },
            ]) {
                const r = assertEquivalent(
                    `${CSI}5;7Hhello${CSI}24;40HZ${CSI}1;1H${CSI}7mx`,
                    {
                        start,
                    }
                );
                assert.equal(r.out[0], CLEAR);
                assert.equal(r.ata.clears, 1);
            }
        });

        it('ED 2 anchors without a second clear', function () {
            const r = assertEquivalent(`${CSI}2J${CSI}3;3Hx`, {
                start: { row: 23, col: 39 },
            });
            assert.equal(r.ata.clears, 1);
        });

        it('CRLF from anywhere is exact, also from the bottom row', function () {
            for (const start of [
                { row: 0, col: 0 },
                { row: 23, col: 39 },
                { row: 5, col: 17 },
            ]) {
                const t = createAtasciiTranslator();
                const ata = new AtasciiScreen(40, 24, start).write(t.translate('\r\n'));
                assert.deepEqual([ata.row, ata.col], [Math.min(start.row + 1, 23), 0]);
            }
        });

        it('moves sent at an edge while unknown wrap or clamp, as the terminal does', function () {
            //  documented: the translator cannot know; neither terminal model throws
            for (const [edges, row] of [
                ['syncterm', 23],
                ['icy', 0],
            ]) {
                const t = createAtasciiTranslator();
                const ata = new AtasciiScreen(40, 24, { row: 0, col: 5, edges });
                ata.write(t.translate(`${CSI}Aq`));
                assert.equal(ata.actual(row, 5).ch, 'q', edges);
            }
        });

        it('text drawn while unknown is wiped by the clear a later goto needs', function () {
            const t = createAtasciiTranslator();
            const ata = new AtasciiScreen();
            ata.write(t.translate('door says bye'));
            ata.write(t.translate(`${CSI}3;3Hmenu`));
            assert.equal(ata.actual(7, 13).ch, ' ');
            assert.equal(ata.actual(2, 2).ch, 'm');
        });
    });

    describe('setSize', function () {
        it('80x25 (XEP80)', function () {
            const t = createAtasciiTranslator();
            t.setSize(80, 25);
            assert.equal(t.state().cols, 80);
            assertEquivalent(
                `${RESET}${'0123456789'.repeat(8)}\r\nrow two${CSI}25;70H${'e'.repeat(11)}` +
                    `${CSI}5;79Hab${CSI}K${CSI}25;80HZ\r\nlast`,
                { cols: 80, rows: 25 }
            );
        });

        it('makes the position unknown', function () {
            const t = known();
            t.translate(`${CSI}5;5H`);
            t.setSize(80, 25);
            assert.equal(t.state().known, false);
            assert.equal(t.translate(`${CSI}1;2H`)[0], CLEAR);
        });

        it('refuses a screen larger than any real one', function () {
            const t = createAtasciiTranslator();
            for (const [c, r] of [
                [65535, 65535],
                [MAX_COLS + 1, 24],
                [40, MAX_ROWS + 1],
                [1e9, 1e9],
            ]) {
                assert.throws(() => t.setSize(c, r), RangeError);
                assert.throws(
                    () => createAtasciiTranslator({ cols: c, rows: r }),
                    RangeError
                );
            }
            t.setSize(MAX_COLS, MAX_ROWS);
            assert.equal(t.state().cols, 160);
        });

        it('an erase on the largest screen stays small', function () {
            const t = createAtasciiTranslator({ cols: MAX_COLS, rows: MAX_ROWS });
            t.translate(`${CSI}2J${CSI}H`);
            assert.ok(t.translate(`${CSI}J`).length <= MAX_COLS * MAX_ROWS + 64);
        });
    });

    describe('real ENiGMA output', function () {
        //  Captured from core/ansi_term.js: resetScreen(), goto(5, 10), sgr(['normal',
        //  'bold', 'cyan', 'blueBG']), normal(), eraseLine(), deleteLine(),
        //  eraseData(1), hideCursor(), setSyncTermFontWithAlias(...), osc8Hyperlink(...)
        const resetScreen = '\u001b[0m\u001b[2J\u001b[H';
        const goto5x10 = '\u001b[5;10H';
        const boldCyanOnBlue = '\u001b[22;1;36;44m';
        const normal = '\u001b[22;0m';
        const eraseLine = '\u001b[K';
        const deleteLine = '\u001b[M';
        const eraseAbove = '\u001b[1J';
        const hideCursor = '\u001b[?25l';
        const font = '\u001b[0;36 D';
        const link = '\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\';

        it('a login-ish screen', function () {
            const input =
                hideCursor +
                font +
                resetScreen +
                '\u001b[1;31mENiGMA' +
                normal +
                goto5x10 +
                boldCyanOnBlue +
                'Login:' +
                normal +
                ' ' +
                eraseLine +
                '\r\n' +
                link;
            const r = assertEquivalent(input);
            assert.deepEqual([...r.out.subarray(0, 3)], [CLEAR, 0x45, 0x4e]);
            assert.deepEqual(r.ata.actual(4, 9), { ch: 'L', inverse: true });
            //  deleteLine() is dropped (the ANSI model ignores it too); eraseData(1) blanks
            const r2 = assertEquivalent(input + deleteLine + eraseAbove);
            assert.deepEqual(r2.ata.actual(4, 9), { ch: ' ', inverse: false });
        });

        //  Captured from VerticalMenuView.redraw() (core/vertical_menu_view.js), items
        //  login / apply / logoff, focus on the first, at (5, 10) width 10. The SGR
        //  pairs are the stock theme's: MATRIX.ANS VM1 focuses with bold only
        //  (0;36 -> 0;1;36); the lightbar art (CCHANGE.ANS VM1 and 31 more) with a
        //  background (0;36 -> 0;1;37;46).
        const boldOnlyMenu =
            '\u001b[5;10H\u001b[5;10H\u001b[0;1;36mlogin\u001b[0;36m     \u001b[6;10H' +
            '\u001b[0;36mapply\u001b[0;36m     \u001b[7;10H\u001b[0;36mlogoff\u001b[0;36m    ';
        const lightbarMenu =
            '\u001b[5;10H\u001b[5;10H\u001b[0;1;37;46mlogin\u001b[0;36m     \u001b[6;10H' +
            '\u001b[0;36mapply\u001b[0;36m     \u001b[7;10H\u001b[0;36mlogoff\u001b[0;36m    ';

        it('a menu focused by bold only cannot show its focus', function () {
            const r = assertEquivalent(resetScreen + boldOnlyMenu);
            const focused = r.ata.actual(4, 9);
            const other = r.ata.actual(5, 9);
            assert.equal(focused.inverse, other.inverse);
            assert.equal(focused.inverse, false);
        });

        it('a menu focused by a background shows it in inverse video', function () {
            const r = assertEquivalent(resetScreen + lightbarMenu);
            assert.deepEqual(r.ata.actual(4, 9), { ch: 'l', inverse: true });
            assert.deepEqual(r.ata.actual(5, 9), { ch: 'a', inverse: false });
            assert.deepEqual(r.ata.actual(4, 14), { ch: ' ', inverse: false });
        });
    });

    describe('injection', function () {
        //  a control byte may only appear as the second byte of ESC + byte
        function assertNoBareControl(out, what) {
            for (let i = 0; i < out.length; ++i) {
                if (0x1b === out[i]) {
                    assert.ok(i + 1 < out.length, `${what}: dangling ESC`);
                    assert.ok(isControlByte(out[i + 1]), `${what}: ESC before a glyph`);
                    assert.notEqual(out[i + 1], EOL, `${what}: ESC EOL`);
                    ++i;
                } else {
                    assert.ok(
                        !isControlByte(out[i]),
                        `${what}: control 0x${out[i].toString(16)}`
                    );
                }
            }
        }

        for (const quoted of [true, false]) {
            it(`no BMP code point produces a bare control byte (quoted: ${quoted})`, function () {
                const t = known({ quoted });
                for (let cp = 0x20; cp <= 0xffff; ++cp) {
                    if (
                        (cp >= 0xd800 && cp <= 0xdfff) ||
                        0x7f === cp ||
                        (cp >= 0x80 && cp <= 0x9f)
                    ) {
                        continue;
                    }
                    const ch = String.fromCharCode(cp);
                    for (const sgr of ['', `${CSI}7m`]) {
                        if (sgr) t.translate(sgr);
                        const out = t.translate(ch);
                        assert.ok(
                            out.length <= 2,
                            `U+${cp.toString(16)}: ${out.length} bytes`
                        );
                        assertNoBareControl(out, `U+${cp.toString(16)}`);
                        if (!quoted)
                            assert.ok(!out.includes(0x1b), `U+${cp.toString(16)}`);
                        t.translate(`${CSI}0m${CSI}H`);
                    }
                }
            });
        }

        it('C0 / C1 code points, DEL and invalid UTF-8 never reach the terminal as controls', function () {
            const t = known();
            const junk = [];
            for (let b = 0; b < 0x20; ++b)
                if (![0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(b))
                    junk.push(b);
            const out1 = t.translate(
                Buffer.from([
                    ...junk,
                    0x7f,
                    0xc2,
                    0x9b,
                    0xc2,
                    0x85,
                    0xff,
                    0xfe,
                    0xc0,
                    0xaf,
                    0xed,
                    0xa0,
                    0x80,
                    0xf8,
                    0x88,
                    0x80,
                    0x80,
                    0x80,
                ])
            );
            assertNoBareControl(out1, 'junk');
            assert.ok(
                out1.every(b => b === 0x3f),
                'only ? for invalid sequences'
            );
        });

        it('text inside OSC / DCS / APC / PM / SOS strings produces nothing', function () {
            const t = known();
            const payload = 'abc↑█\x9bÿ\x0a\x0d';
            for (const intro of [']', 'P', '_', '^', 'X']) {
                assert.deepEqual(bytes(t, `${ESC}${intro}${payload}${ESC}\\`), [], intro);
            }
            assert.deepEqual(bytes(t, `${ESC}]0;${payload}\x07`), []);
        });

        it('random bytes: the strict model never throws', function () {
            let s = 12345;
            const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
            for (let k = 0; k < 200; ++k) {
                const buf = Buffer.alloc(200);
                for (let i = 0; i < buf.length; ++i) {
                    //  weighted towards ESC, CSI bytes and controls
                    const p = rand();
                    buf[i] =
                        p < 0.1
                            ? 0x1b
                            : p < 0.2
                              ? 0x5b
                              : p < 0.35
                                ? Math.floor(rand() * 0x20)
                                : Math.floor(rand() * 256);
                }
                const t = known();
                const out = t.translate(buf);
                assertNoBareControlExceptMoves(out);
                new AtasciiScreen(40, 24, { row: 0, col: 0 }).write(out);
            }

            function assertNoBareControlExceptMoves(out) {
                const allowed = new Set([UP, DOWN, LEFT, RIGHT, CLEAR, EOL, C.bell]);
                for (let i = 0; i < out.length; ++i) {
                    if (0x1b === out[i]) {
                        ++i;
                    } else if (isControlByte(out[i])) {
                        assert.ok(allowed.has(out[i]), `0x${out[i].toString(16)}`);
                    }
                }
            }
        });
    });

    describe('random streams', function () {
        //  small seeded PRNG so failures are reproducible
        function prng(seed) {
            let s = seed >>> 0;
            return () => {
                s = (s * 1664525 + 1013904223) >>> 0;
                return s / 0x100000000;
            };
        }

        function randomStream(rand, cols, rows) {
            const pick = a => a[Math.floor(rand() * a.length)];
            const n = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
            let s = RESET;
            for (let i = 0; i < 120; ++i) {
                s += pick([
                    () => 'abc XYZ 019'.slice(0, n(1, 11)),
                    () => 'é─│┌█▀▐▒"↑◀␛♥'[n(0, 12)],
                    () => 'x'.repeat(n(1, cols + 5)),
                    () => `${CSI}${n(0, rows + 2)};${n(0, cols + 2)}H`,
                    () =>
                        `${CSI}${n(0, 5)}${pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'd', '`'])}`,
                    () => `${CSI}${pick(['', '0', '1', '2'])}${pick(['J', 'K'])}`,
                    () => `${CSI}${n(1, 8)}X`,
                    () =>
                        `${CSI}${pick(['0', '1', '7', '27', '22', '8', '28'])};${n(30, 37)};${pick([40, 41, 44, 47, 49, 104])}m`,
                    () => `${CSI}${n(90, 97)}m`,
                    () =>
                        pick([
                            '\r\n',
                            '\r',
                            '\n',
                            '\b',
                            '\t',
                            '\x0c',
                            '\x07',
                            `${ESC}D`,
                            `${ESC}E`,
                            `${ESC}M`,
                        ]),
                    () => pick([`${ESC}7`, `${ESC}8`, `${CSI}s`, `${CSI}u`]),
                    () =>
                        pick([
                            `${CSI}?25l`,
                            `${CSI}1;24r`,
                            `${ESC}]8;;u${ESC}\\`,
                            `${CSI}6n`,
                            `${CSI}M`,
                        ]),
                    () =>
                        `${CSI}${rows};${n(cols - 3, cols)}H${pick(['q', '↑', '█']).repeat(n(1, 5))}`,
                    () =>
                        `${CSI}${n(rows - 1, rows)};${n(1, cols)}H${pick(['\r\n', '\n', '\r'])}`,
                ])();
            }
            return s;
        }

        for (const [cols, rows, quoted] of [
            [40, 24, true],
            [80, 25, true],
            [40, 24, false],
            [22, 23, true],
        ]) {
            it(`equivalent on 300 random streams at ${cols}x${rows}, quoted ${quoted}`, function () {
                const rand = prng(cols * 1000 + rows + (quoted ? 0 : 7));
                for (let k = 0; k < 300; ++k) {
                    //  a final CR would be held (it may be half of a CRLF): end with a no-op
                    const s = randomStream(rand, cols, rows) + `${CSI}?25h`;
                    const r = run(s, { cols, rows, quoted });
                    const diffs = diffScreens(r.ansi, r.ata, { quoted });
                    assert.deepEqual(diffs, [], `stream ${k}: ${JSON.stringify(s)}`);
                }
            });
        }
    });
    describe('review fixes', () => {
        const hex = buf => [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');

        it('a foreign ESC left hanging by a pass-through string is seen too', () => {
            const asBuffer = createAtasciiTranslator();
            asBuffer.passThrough(Buffer.from([0x1b]));
            const asString = createAtasciiTranslator();
            asString.passThrough('\x1b');
            const next = Buffer.from('\x1b[2JA');
            assert.equal(hex(asString.translate(next)), hex(asBuffer.translate(next)));
            //  the hanging ESC is given a harmless byte to quote first
            assert.notEqual(asString.translate(Buffer.from('B'))[0], 0x1b);
        });

        it('null options mean the defaults', () => {
            const t = createAtasciiTranslator(null);
            assert.deepEqual([t.state().cols, t.state().rows], [40, 24]);
        });

        it('a glyph held at the bottom-right cell is dropped by a move, by design', () => {
            const t = createAtasciiTranslator();
            const out = t.translate(Buffer.from('\x1b[2J\x1b[24;40HX\x1b[24;1HY'));
            //  writing that cell would scroll an Atari screen: X is never sent
            assert.equal(out.includes(0x58), false);
            assert.equal(out[out.length - 1], 0x59);
        });
    });
});
