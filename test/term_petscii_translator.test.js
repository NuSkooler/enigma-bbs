'use strict';

//  PETSCII output translator (#593 step 5b): core/term/petscii/output_translator.js
//
//  The core style is equivalence: the same ANSI input goes to an ANSI screen model
//  and, through translate(), to a PETSCII screen model (both in
//  test/term_petscii_screens.js); the grids must match cell by cell, and the
//  cursors too. The PETSCII model throws on bytes the translator must never send,
//  so every test also checks that.

const { strict: assert } = require('assert');

const {
    Charsets,
    Controls,
    Colors,
    AnsiToPetsciiColor,
} = require('../core/term/petscii/charset.js');
const { createPetsciiTranslator } = require('../core/term/petscii/output_translator.js');
const { AnsiScreen, PetsciiScreen, diffScreens } = require('./term_petscii_screens.js');

const ESC = '\x1b';
const CSI = '\x1b[';
const RESET = `${CSI}0m${CSI}2J${CSI}H`; //  ansi_term.resetScreen()

const C = Controls;

function run(input, { cols = 40, rows = 25, charset } = {}) {
    const t = createPetsciiTranslator({ cols, rows, charset });
    const ansi = new AnsiScreen(cols, rows).write(input);
    const out = t.translate(Buffer.from(input, 'utf8'));
    const pet = new PetsciiScreen(cols, rows).write(out);
    return { t, ansi, pet, out };
}

function assertEquivalent(input, opts = {}) {
    const r = run(input, opts);
    const diffs = diffScreens(r.ansi, r.pet, opts);
    assert.deepEqual(diffs, [], `screens differ for ${JSON.stringify(input)}`);
    return r;
}

//  output bytes after the leading charset select byte
function body(out) {
    assert.equal(out[0], C.charsetLower, 'output starts with the charset select');
    return [...out.subarray(1)];
}

describe('PETSCII output translator', function () {
    describe('interface', function () {
        it('has the translator shape', function () {
            const t = createPetsciiTranslator();
            assert.equal(t.identity, false);
            for (const fn of [
                'translate',
                'passThrough',
                'setSize',
                'setCharset',
                'reset',
                'state',
            ]) {
                assert.equal(typeof t[fn], 'function', fn);
            }
            assert.equal(t.passThrough(Buffer.from('x')), undefined);
        });

        it('returns Buffers and accepts strings the same as UTF-8 Buffers', function () {
            const s = `${RESET}Grüße ┌─┐`;
            const a = createPetsciiTranslator().translate(s);
            const b = createPetsciiTranslator().translate(Buffer.from(s, 'utf8'));
            assert.ok(Buffer.isBuffer(a));
            assert.deepEqual(a, b);
        });

        it('starts with the charset select byte, once', function () {
            const t = createPetsciiTranslator();
            assert.deepEqual([...t.translate('A')].slice(0, 1), [C.charsetLower]);
            assert.ok(!t.translate('B').includes(C.charsetLower));
            const u = createPetsciiTranslator({ charset: Charsets.UpperGraphics });
            assert.equal(u.translate('A')[0], C.charsetUpper);
        });

        it('rejects a bad charset or size', function () {
            assert.throws(
                () => createPetsciiTranslator({ charset: 'ebcdic' }),
                TypeError
            );
            assert.throws(() => createPetsciiTranslator({ cols: 0 }), RangeError);
            assert.throws(() => createPetsciiTranslator().setCharset('x'), TypeError);
        });

        it('state() is a plain snapshot', function () {
            const t = createPetsciiTranslator();
            let s = t.state();
            assert.equal(s.known, false);
            assert.equal(s.charset, 'lower');
            t.translate(`${CSI}5;10H${CSI}1;31m`);
            s = t.state();
            assert.equal(s.known, true);
            assert.equal(s.row, 4);
            assert.equal(s.col, 9);
            assert.equal(s.colour, Colors.lightRed);
            assert.equal(s.reverse, false);
            s.row = 99;
            assert.equal(t.state().row, 4);
        });

        it('setCharset() sends the new select byte with the next translate()', function () {
            const t = createPetsciiTranslator();
            t.translate('x');
            t.setCharset(Charsets.UpperGraphics);
            const out = t.translate('a');
            assert.equal(out[0], C.charsetUpper);
            assert.equal(out[out.length - 1], 0x41); //  upper/graphics has no lower case
        });

        it('reset() starts over: charset again, position unknown', function () {
            const t = createPetsciiTranslator();
            t.translate(`${RESET}hello`);
            t.reset();
            assert.equal(t.state().known, false);
            const out = [...t.translate(`${CSI}2;2H`)];
            assert.deepEqual(out, [C.charsetLower, C.home, C.cursorDown, C.cursorRight]);
        });
    });

    describe('text', function () {
        it('plain text', function () {
            assertEquivalent(`${RESET}Hello, World! 0123456789 @[]`);
        });

        it('letters in lower/upper are ASCII with case swapped', function () {
            const { out } = run(`${RESET}aZ`);
            assert.deepEqual(body(out).slice(-2), [0x41, 0xda]);
        });

        it('upper/graphics folds lower case to upper', function () {
            assertEquivalent(`${RESET}Hello`, { charset: Charsets.UpperGraphics });
        });

        it('unmappable becomes ?, one cell each; zero width is dropped', function () {
            const r = assertEquivalent(`${RESET}a漢b😀c…d`);
            assert.equal(r.pet.actual(0, 1).ch, '?');
            assert.equal(r.pet.actual(0, 3).ch, '?');
            assert.equal(r.pet.actual(0, 5).ch, '?'); //  '...' fallback is 3 bytes: not used
            assert.equal(r.pet.col, 7);
            const z = run(`${RESET}e\u0301x\u200by`);
            assert.equal(z.pet.col, 3);
        });

        it('C1 controls and DEL in text are dropped', function () {
            const { out } = run(`${RESET}a\u009b\u0085\x7fb`);
            assert.deepEqual(body(out).slice(-2), [0x41, 0x42]);
        });

        it('box-drawing text', function () {
            assertEquivalent(
                `${RESET}┌──────┐\r\n│ Menu │\r\n├──────┤\r\n└──────┘\r\n╔═╗░▒▓▀▄▌▐`
            );
        });

        it('a solid block is reverse on, 0xA0, then back', function () {
            const r = assertEquivalent(`${RESET}a█b${CSI}7m█c`);
            const b = body(r.out);
            const i = b.indexOf(0xa0);
            assert.deepEqual(b.slice(i - 2, i + 3), [
                0x41,
                C.reverseOn,
                0xa0,
                C.reverseOff,
                0x42,
            ]);
            assert.ok(r.pet.actual(0, 1).reverse);
            assert.ok(!r.pet.actual(0, 2).reverse);
        });

        it('a quote is an ordinary glyph (no quote mode in SyncTERM or icy)', function () {
            const r = assertEquivalent(`${RESET}say "hi"${CSI}31m!${CSI}2;1Hok`);
            assert.ok(body(r.out).includes(0x22));
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
                `${CSI}5;5Ha${CSI}Hb${CSI};7Hc${CSI}9Hd${CSI}12;30fe${CSI}0;0Hf${CSI}99;99Hg${CSI}25;1Hh`
            );
        });

        it('save and restore, both forms', function () {
            assertEquivalent(
                `${CSI}4;6H${ESC}7xx${CSI}20;20Hyy${ESC}8z${CSI}s${CSI}H${CSI}uw`
            );
        });

        it('goto from an unknown position is HOME + DOWNs + RIGHTs', function () {
            const t = createPetsciiTranslator();
            const out = [...t.translate(`${CSI}3;4H`)];
            assert.deepEqual(out, [
                C.charsetLower,
                C.home,
                C.cursorDown,
                C.cursorDown,
                C.cursorRight,
                C.cursorRight,
                C.cursorRight,
            ]);
        });

        it('goto from a known position is relative when that is shorter', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}10;10H`);
            assert.deepEqual([...t.translate(`${CSI}10;11H`)], [C.cursorRight]);
            assert.deepEqual([...t.translate(`${CSI}9;11H`)], [C.cursorUp]);
            assert.deepEqual([...t.translate(`${CSI}1;1H`)], [C.home]);
            //  (1,40) from HOME: DOWN then a LEFT that wraps back up to the row end
            assert.deepEqual(
                [...t.translate(`${CSI}1;40H`)],
                [C.cursorDown, C.cursorLeft]
            );
            //  same position: nothing
            assert.deepEqual([...t.translate(`${CSI}1;40H`)], []);
        });

        it('goto uses RETURN when it is the shortest way to a line start', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}5;30H`);
            assert.deepEqual([...t.translate(`${CSI}6;1H`)], [C.return]);
        });

        it('goto never leaves the screen (all corners, from all corners)', function () {
            const corners = ['1;1', '1;40', '25;1', '25;40', '13;20'];
            for (const a of corners) {
                for (const b of corners) {
                    assertEquivalent(`${RESET}${CSI}${a}Hx${CSI}${b}Hy`);
                }
            }
        });

        it('BS stops at column 0; TAB goes to the next 8 column stop', function () {
            assertEquivalent(`${CSI}3;3Hab\b\b\bX\tY\tZ${CSI}3;38H\tT\tU`);
        });

        it('RI, IND and NEL', function () {
            assertEquivalent(`${CSI}5;5Ha${ESC}Mb${ESC}Dc${ESC}Ed${CSI}H${ESC}Me`);
        });
    });

    describe('SGR', function () {
        it('each foreground, normal and bold, and 90-97', function () {
            let s = RESET;
            for (let i = 0; i < 8; ++i) s += `${CSI}${30 + i}m${i}${CSI}1m${i}${CSI}22m`;
            s += '\r\n';
            for (let i = 0; i < 8; ++i) s += `${CSI}${90 + i}m${i}`;
            const r = assertEquivalent(s);
            assert.equal(r.pet.actual(0, 0).color, AnsiToPetsciiColor[0]);
            assert.equal(r.pet.actual(0, 3).color, AnsiToPetsciiColor[9]);
            assert.equal(r.pet.actual(1, 7).color, AnsiToPetsciiColor[15]);
        });

        it('exact bytes for a colour change', function () {
            const t = createPetsciiTranslator();
            t.translate(`${RESET}a`);
            assert.deepEqual([...t.translate(`${CSI}31mA`)], [Colors.red, 0xc1]);
            assert.deepEqual([...t.translate(`${CSI}31mB`)], [0xc2]); //  no repeat
        });

        it('39 and 0 reset to light grey; bold default is white', function () {
            const r = assertEquivalent(
                `${RESET}${CSI}31ma${CSI}39mb${CSI}1mc${CSI}0md${CSI}1;32me${CSI}me`
            );
            assert.equal(r.pet.actual(0, 1).color, Colors.lightGrey);
            assert.equal(r.pet.actual(0, 2).color, Colors.white);
            assert.equal(r.pet.actual(0, 3).color, Colors.lightGrey);
        });

        it('a background colour is reverse with that colour; the foreground is dropped', function () {
            const r = assertEquivalent(
                `${RESET}${CSI}33;44mX${CSI}40mY${CSI}104mZ${CSI}49mW`
            );
            assert.deepEqual(r.pet.actual(0, 0), {
                ch: 'X',
                color: Colors.blue,
                reverse: true,
            });
            assert.deepEqual(r.pet.actual(0, 1), {
                ch: 'Y',
                color: Colors.brown,
                reverse: false,
            });
            assert.deepEqual(r.pet.actual(0, 2), {
                ch: 'Z',
                color: Colors.lightBlue,
                reverse: true,
            });
            assert.equal(r.pet.actual(0, 3).reverse, false);
        });

        it('7 and 27 toggle reverse with the foreground colour, also over a background', function () {
            const r = assertEquivalent(
                `${RESET}${CSI}32;7ma${CSI}27mb${CSI}7;41mc${CSI}0md`
            );
            assert.deepEqual(r.pet.actual(0, 0), {
                ch: 'a',
                color: Colors.green,
                reverse: true,
            });
            assert.equal(r.pet.actual(0, 1).reverse, false);
            assert.deepEqual(r.pet.actual(0, 2), {
                ch: 'c',
                color: Colors.green,
                reverse: true,
            });
        });

        it('38/48 extended colours go to the nearest of 16', function () {
            //  test convention (see the ANSI model): 2;r;g;b is followed by the index
            assertEquivalent(
                `${RESET}${CSI}38;5;12ma${CSI}48;5;1mb${CSI}0;38;2;250;10;10;1mc` +
                    `${CSI}38;2;0;0;170;4md${CSI}0m`
            );
            const t = createPetsciiTranslator();
            t.translate(`${RESET}`);
            //  xterm cube 196 (255,0,0) -> VGA red (aa0000), grey 250 (188) -> light grey
            assert.deepEqual(
                [...t.translate(`${CSI}38;5;196mx${CSI}38;5;250my`)],
                [C.reverseOff, AnsiToPetsciiColor[1], 0x58, AnsiToPetsciiColor[7], 0x59]
            );
        });

        it('conceal prints spaces; blink, underline, italic are ignored', function () {
            const r = assertEquivalent(`${RESET}${CSI}8mab${CSI}28;4;5;3mcd${CSI}0m`);
            assert.equal(r.pet.actual(0, 0).ch, ' ');
            assert.equal(r.pet.actual(0, 2).ch, 'c');
        });

        it('RETURN turns reverse off on the terminal; it is re-asserted', function () {
            const r = assertEquivalent(`${RESET}${CSI}7mab\r\ncd`);
            const b = body(r.out);
            const i = b.indexOf(C.return);
            assert.equal(b[i + 1], C.reverseOn);
        });
    });

    describe('erase', function () {
        it('ED 2 is a clear and homes', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}5;5Hx`);
            assert.deepEqual([...t.translate(`${CSI}2J`)], [C.clear]);
            assert.equal(t.state().row, 0);
            assert.equal(t.state().col, 0);
            assertEquivalent(`${CSI}5;5Hxyz${CSI}2Jabc\x0cdef`);
        });

        it('ED 0 at HOME is a clear', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}5;5Hx`);
            assert.deepEqual([...t.translate(`${CSI}H${CSI}J`)], [C.home, C.clear]);
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
            it(`${name}: spaces with reverse off, cursor stays`, function () {
                assertEquivalent(`${fill()}${CSI}7m${CSI}6;20H${seq}`);
                assertEquivalent(`${fill()}${CSI}6;20H${seq}Q`);
                assertEquivalent(`${fill()}${CSI}25;40H${seq}`);
                assertEquivalent(`${fill()}${CSI}1;1H${seq}R`);
                assertEquivalent(`${fill()}${CSI}24;40H${seq}S`);
            });
        }
    });

    describe('line control', function () {
        it('CRLF is one RETURN', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}3;10H`);
            assert.deepEqual([...t.translate('\r\n')], [C.return]);
        });

        it('bare CR is lefts on this line; bare LF is DOWN', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}3;3H`);
            assert.deepEqual(
                [...t.translate('\rx')],
                [C.cursorLeft, C.cursorLeft, C.reverseOff, Colors.lightGrey, 0x58]
            );
            //  from further right, RETURN + UP is shorter than the lefts
            t.translate(`${CSI}3;9H`);
            assert.deepEqual([...t.translate('\r')], []);
            assert.deepEqual([...t.translate('y')], [C.return, C.cursorUp, 0x59]);
            assert.deepEqual([...t.translate('\n')], [C.cursorDown]);
            assertEquivalent(`${RESET}abc\rX\ndef\n\rghi\r\r\nj\n\nk`);
        });

        it('CR held at the end of a write pairs with an LF in the next', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}3;10H`);
            assert.deepEqual([...t.translate('\r')], []);
            assert.deepEqual([...t.translate('\n')], [C.return]);
        });

        it('LF and CRLF on the bottom row scroll', function () {
            const r = assertEquivalent(
                `${RESET}top${CSI}25;5Hab\ncd\r\nef${ESC}Dg${ESC}Eh`
            );
            assert.equal(r.pet.scrolls, 4);
        });

        it('a long scrolling text', function () {
            let s = RESET;
            for (let i = 0; i < 40; ++i) s += `line ${i} ${'x'.repeat(i % 30)}\r\n`;
            assertEquivalent(s);
        });
    });

    describe('wrap', function () {
        it('a full row then CRLF does not leave a blank line', function () {
            const row = 'abcdefghij'.repeat(4);
            const r = assertEquivalent(`${RESET}${row}\r\nnext`);
            const b = body(r.out);
            //  no cursor bytes between the 40th glyph and the next text
            assert.ok(!b.includes(C.return));
            assert.equal(r.pet.actual(1, 0).ch, 'n');
        });

        it('41 characters wrap; LF after a full row keeps the column', function () {
            assertEquivalent(`${RESET}${'x'.repeat(41)}`);
            assertEquivalent(`${RESET}${'y'.repeat(40)}\nz`);
            assertEquivalent(`${RESET}${'y'.repeat(40)}\rz`);
            assertEquivalent(`${RESET}${'y'.repeat(40)}${CSI}Az${CSI}5Dw\bv`);
        });

        it('a long run wraps across many rows', function () {
            assertEquivalent(`${RESET}${CSI}3;35H${'0123456789'.repeat(20)}`);
        });

        it('the bottom-right cell is held, and written when the screen scrolls', function () {
            const r1 = run(`${RESET}${CSI}25;1H${'b'.repeat(40)}`);
            assert.deepEqual(diffScreens(r1.ansi, r1.pet), []);
            assert.equal(r1.pet.actual(24, 39).ch, ' '); //  not written (yet)
            assert.equal(r1.pet.scrolls, 0);
            assert.equal(r1.t.state().wrapPending, true);

            //  more text: the held glyph goes out and the terminal scrolls with it
            const r2 = assertEquivalent(`${RESET}${CSI}25;1H${'b'.repeat(39)}Zmore`);
            assert.equal(r2.pet.actual(23, 39).ch, 'Z');
            assert.equal(r2.pet.scrolls, 1);
            assertEquivalent(`${RESET}${CSI}25;1H${'b'.repeat(39)}Z\r\nmore`);
            assertEquivalent(
                `${RESET}${CSI}25;1H${'b'.repeat(39)}${CSI}31mZ${CSI}32m\nmore`
            );

            //  anything else drops it
            const r3 = run(`${RESET}${CSI}25;1H${'b'.repeat(39)}Z${CSI}1;1Hx`);
            assert.deepEqual(diffScreens(r3.ansi, r3.pet), []);
            assert.equal(r3.pet.actual(24, 39).ch, ' ');
            assert.equal(r3.pet.scrolls, 0);
        });
    });

    describe('dropped sequences', function () {
        const dropped = [
            `${CSI}?25l`,
            `${CSI}?25h`,
            `${CSI}?7l`,
            `${CSI}?33h`,
            `${CSI}1;24r`,
            `${CSI}6n`,
            `${CSI}255n`,
            `${CSI}c`,
            `${CSI}<0c`,
            `${CSI}=1c`,
            `${CSI}0;32 D`, //  SyncTERM font
            `${CSI}M`,
            `${CSI}2L`,
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
            '\x07\x00\x01',
        ];
        for (const seq of dropped) {
            it(`drops ${JSON.stringify(seq)}`, function () {
                const t = createPetsciiTranslator();
                t.translate(`${RESET}a`);
                assert.deepEqual([...t.translate(seq)], []);
                assert.deepEqual([...t.translate('b')], [0x42]);
            });
        }

        it('OSC 8 keeps the link text', function () {
            const r = assertEquivalent(
                `${RESET}${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\!`
            );
            assert.equal(r.pet.actual(0, 0).ch, 'l');
            assert.equal(r.pet.actual(0, 4).ch, '!');
        });

        it('an OSC with no terminator ends at the next ESC sequence', function () {
            const t = createPetsciiTranslator();
            t.translate(`${RESET}`);
            const out = [...t.translate(`${ESC}]0;oops${ESC}[2;1Hb`)];
            assert.deepEqual(out, [C.cursorDown, C.reverseOff, Colors.lightGrey, 0x42]);
        });

        it('CAN aborts a sequence', function () {
            const t = createPetsciiTranslator();
            t.translate(RESET);
            assert.deepEqual(
                [...t.translate(`${CSI}31\x18x`)],
                [C.reverseOff, Colors.lightGrey, 0x58]
            );
        });
    });

    describe('splits', function () {
        const stream =
            `${RESET}${CSI}1;33mGrüße ┌─┐ █ ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\` +
            `\r\n${CSI}44mbg${CSI}0m ${CSI}5;10H😀x\r${CSI}?25l${CSI}K\r\nend${ESC}7${CSI}2Aup${ESC}8` +
            `${CSI}25;1H${'z'.repeat(40)}\r\n${CSI}38;5;9mq\x07\t|`;

        it('identical output when cut in two at every offset (bytes)', function () {
            const bytes = Buffer.from(stream, 'utf8');
            const whole = createPetsciiTranslator().translate(bytes);
            for (let i = 0; i <= bytes.length; ++i) {
                const t = createPetsciiTranslator();
                const parts = Buffer.concat([
                    t.translate(bytes.subarray(0, i)),
                    t.translate(bytes.subarray(i)),
                ]);
                assert.deepEqual(parts, whole, `split at byte ${i}`);
            }
        });

        it('identical output fed one byte at a time', function () {
            const bytes = Buffer.from(stream, 'utf8');
            const whole = createPetsciiTranslator().translate(bytes);
            const t = createPetsciiTranslator();
            const parts = [];
            for (const b of bytes) parts.push(t.translate(Buffer.from([b])));
            assert.deepEqual(Buffer.concat(parts), whole);
        });

        it('and the stream is equivalent', function () {
            //  the ANSI model has no BEL / TAB quirks beyond these, so compare
            assertEquivalent(stream);
        });
    });

    describe('passThrough', function () {
        it('forgets the terminal: charset, colour and HOME-based goto again', function () {
            const t = createPetsciiTranslator();
            t.translate(`${RESET}${CSI}31;7mab`);
            t.passThrough(Buffer.from([0x93, 0x41, 0x92]));
            assert.equal(t.state().known, false);
            const out = [...t.translate(`${CSI}2;3Hc`)];
            assert.deepEqual(out, [
                C.charsetLower,
                C.home,
                C.cursorDown,
                C.cursorRight,
                C.cursorRight,
                C.reverseOn,
                Colors.red,
                0x43,
            ]);
        });

        it('screen equivalence after a passThrough that moved the cursor', function () {
            const input1 = `${RESET}hello`;
            const input2 = `${CSI}10;10Hworld`;
            const t = createPetsciiTranslator();
            const pet = new PetsciiScreen();
            pet.write(t.translate(input1));
            const raw = Buffer.from([
                C.cursorDown,
                C.cursorDown,
                Colors.yellow,
                C.reverseOn,
            ]);
            t.passThrough(raw);
            pet.write(raw);
            pet.write(t.translate(input2));
            const ansi = new AnsiScreen().write(input1 + input2);
            assert.deepEqual(diffScreens(ansi, pet), []);
        });

        it('a half-parsed sequence before passThrough is discarded', function () {
            const t = createPetsciiTranslator();
            t.translate(`${RESET}${CSI}3`);
            t.passThrough(Buffer.alloc(0));
            const out = [...t.translate('1mx')];
            assert.deepEqual(out, [
                C.charsetLower,
                C.reverseOff,
                Colors.lightGrey,
                0x31,
                0x4d,
                0x58,
            ]);
        });
    });

    describe('unknown position', function () {
        it('text, CRLF and relative moves still go out', function () {
            const t = createPetsciiTranslator();
            const out = [...t.translate('Hi\r\nyo\rX')];
            assert.deepEqual(out, [
                C.charsetLower,
                C.reverseOff, //  reverse on the terminal is not known yet
                Colors.lightGrey,
                0xc8,
                0x49,
                C.return,
                0x59,
                0x4f,
                C.return,
                C.cursorUp,
                0xd8,
            ]);
            assert.deepEqual(
                [...t.translate(`${CSI}2A${CSI}K`)],
                [C.cursorUp, C.cursorUp]
            );
        });
    });

    describe('setSize', function () {
        it('80x25 (C128 80 columns)', function () {
            const t = createPetsciiTranslator();
            t.setSize(80, 25);
            assert.equal(t.state().cols, 80);
            assertEquivalent(
                `${RESET}${'0123456789'.repeat(8)}\r\nrow two${CSI}25;70H${'e'.repeat(11)}${CSI}5;79Hab${CSI}K`,
                { cols: 80 }
            );
        });

        it('makes the position unknown', function () {
            const t = createPetsciiTranslator();
            t.translate(`${CSI}5;5H`);
            t.setSize(80, 25);
            assert.equal(t.state().known, false);
            assert.equal(t.translate(`${CSI}1;2H`)[0], C.home);
        });
    });

    describe('real ansi_term output', function () {
        //  Captured from core/ansi_term.js: resetScreen(), goto(5, 10), sgr('bold', 'red'),
        //  sgr(['normal', 'reset', 'cyan', 'blueBG']), normal(), eraseLine(),
        //  hideCursor(), setSyncTermFontWithAlias('c64_upper'), osc8Hyperlink(...)
        const resetScreen = '\u001b[0m\u001b[2J\u001b[H';
        const goto5x10 = '\u001b[5;10H';
        const boldRed = '\u001b[1;31m';
        const cyanOnBlue = '\u001b[22;0;36;44m';
        const normal = '\u001b[22;0m';
        const eraseLine = '\u001b[K';
        const hideCursor = '\u001b[?25l';
        const font = '\u001b[0;32 D';
        const link = '\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\';

        it('a login-ish screen', function () {
            const input =
                hideCursor +
                font +
                resetScreen +
                boldRed +
                'ENiGMA' +
                normal +
                goto5x10 +
                cyanOnBlue +
                'Login:' +
                normal +
                ' ' +
                eraseLine +
                '\r\n' +
                link;
            const r = assertEquivalent(input);
            const b = body(r.out);
            assert.equal(b[0], C.clear);
            assert.deepEqual(b.slice(1, 4), [C.reverseOff, Colors.lightRed, 0xc5]); //  'E'
            assert.deepEqual(r.pet.actual(4, 9), {
                ch: 'L',
                color: AnsiToPetsciiColor[4],
                reverse: true,
            });
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
                    () => 'é─│┌█▒"'[n(0, 6)],
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
                        ]),
                    () => `${CSI}${rows};${n(cols - 3, cols)}H${'q'.repeat(n(1, 5))}`,
                ])();
            }
            return s;
        }

        for (const [cols, rows] of [
            [40, 25],
            [80, 25],
            [22, 23],
        ]) {
            it(`equivalent on 300 random streams at ${cols}x${rows}`, function () {
                const rand = prng(cols * 1000 + rows);
                for (let k = 0; k < 300; ++k) {
                    //  a final CR would be held (it may be half of a CRLF): end with a no-op
                    const s = randomStream(rand, cols, rows) + `${CSI}?25h`;
                    const r = run(s, { cols, rows });
                    const diffs = diffScreens(r.ansi, r.pet);
                    assert.deepEqual(diffs, [], `stream ${k}: ${JSON.stringify(s)}`);
                }
            });
        }
    });
});
