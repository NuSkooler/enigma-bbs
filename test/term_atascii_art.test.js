'use strict';

//
//  Native ATASCII art (#593): the .ata parser (core/term/atascii/art_parser.js),
//  its plain text conversion, and writeNative() on the ATASCII output
//  translator. Fixtures are built from bytes here.
//
const { strict: assert } = require('assert');

const {
    AtasciiArtParser,
    atasciiArtToText,
    sgrFor,
} = require('../core/term/atascii/art_parser.js');
const { Controls, INVERSE_BIT } = require('../core/term/atascii/charset.js');
const { createAtasciiTranslator } = require('../core/term/atascii/output_translator.js');
const { AtasciiScreen } = require('./term_atascii_screens.js');

const C = Controls;
const ESC = C.escape;
const EOL = C.eol;
const text = s => [...Buffer.from(s, 'latin1')];
const inv = s => text(s).map(b => b | INVERSE_BIT);

//  Run the parser over |bytes|; every event recorded in order.
function parse(bytes, options = {}) {
    const p = new AtasciiArtParser(Object.assign({ mciReplaceChar: ' ' }, options));
    const events = [];
    const bytesOut = [];
    let complete = null;
    p.on('literal', b => bytesOut.push(...b));
    p.on('control', b => bytesOut.push(...b));
    p.on('mci', m => events.push(['mci', m]));
    [
        'clear screen',
        'scroll',
        'delete line',
        'insert line',
        'erase row',
        'insert columns',
        'delete columns',
    ].forEach(name => p.on(name, (...args) => events.push([name, ...args])));
    p.on('complete', c => {
        complete = c;
    });
    p.reset(Buffer.from(bytes));
    p.parse();
    const mcis = events.filter(e => 'mci' === e[0]).map(e => e[1]);
    return { p, events, bytes: bytesOut, complete, mcis };
}

const at = r => [r.complete.row, r.complete.column];

//  a deterministic PRNG for the random streams
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

describe('ATASCII native art', function () {
    describe('parser: cursor and screen', function () {
        it('glyphs advance, END OF LINE goes to column 0 of the next row', () => {
            const r = parse([...text('abc'), EOL, ...text('de')]);
            assert.deepEqual(at(r), [2, 3]);
            assert.deepEqual(r.complete.extent, { rows: 2, cols: 3 });
            assert.deepEqual(r.bytes, [...text('abc'), EOL, ...text('de')]);
        });

        it('writing the last column wraps at once (full rows need no END OF LINE)', () => {
            const row = Array(40).fill(0x41);
            const r = parse([...row, ...text('B%ET1')]);
            assert.equal(r.mcis.length, 1);
            assert.deepEqual(r.mcis[0].position, [2, 2]);
            const narrow = parse([...text('abcd'), 0x42], { termWidth: 4 });
            assert.deepEqual(at(narrow), [2, 2]);
        });

        it('wrapping or END OF LINE on the bottom row scrolls', () => {
            const r = parse([...text('ab'), EOL, ...text('cdef'), ...text('g')], {
                termWidth: 4,
                termHeight: 2,
            });
            assert.deepEqual(
                r.events.filter(e => 'scroll' === e[0]),
                [['scroll', 1]]
            );
            assert.deepEqual(at(r), [2, 2]);
        });

        it('CLEAR clears and homes', () => {
            const r = parse([...text('xx'), EOL, EOL, C.clear, ...text('%ET1')]);
            assert.deepEqual(r.events[0], ['clear screen']);
            assert.deepEqual(r.mcis[0].position, [1, 1]);
        });

        it('cursor bytes move one cell and wrap to the opposite edge (SyncTERM, a real Atari)', () => {
            const o = { termWidth: 10, termHeight: 5 };
            assert.deepEqual(at(parse([C.cursorDown, C.cursorRight], o)), [2, 2]);
            assert.deepEqual(at(parse([C.cursorUp], o)), [5, 1]);
            assert.deepEqual(at(parse([C.cursorLeft], o)), [1, 10]);
            assert.deepEqual(
                at(parse([...Array(9).fill(0x41), C.cursorRight], o)),
                [1, 1]
            );
            assert.deepEqual(
                at(parse([...Array(4).fill(C.cursorDown), C.cursorDown], o)),
                [1, 1]
            );
            //  no scroll from a cursor byte
            assert.equal(parse([C.cursorUp, C.cursorDown], o).events.length, 0);
        });

        it('BACKSPACE moves left, nothing in column 0; BELL does nothing', () => {
            assert.deepEqual(at(parse([...text('ab'), C.backspace])), [1, 2]);
            assert.deepEqual(at(parse([C.backspace, C.bell])), [1, 1]);
        });

        it('TAB: default stops every 8 columns, SET / CLEAR TAB change them, none left is the next row', () => {
            assert.deepEqual(at(parse([0x41, C.tab])), [1, 9]);
            assert.deepEqual(at(parse([...Array(33).fill(0x41), C.tab])), [2, 1]);
            //  a stop at column 3 (1-based 4), then the one at 9 cleared
            const r = parse([
                ...text('abc'),
                C.setTab,
                ...Array(5).fill(C.cursorRight),
                C.clearTab,
                EOL,
                C.tab,
                C.tab,
            ]);
            assert.deepEqual(at(r), [2, 17]);
        });

        it('DELETE / INSERT LINE: events for the MCI map, cursor to column 0', () => {
            const del = parse([EOL, ...text('ab'), C.deleteLine]);
            assert.deepEqual(del.events, [['delete line', 2, 1]]);
            assert.deepEqual(at(del), [2, 1]);
            const ins = parse([EOL, ...text('ab'), C.insertLine]);
            assert.deepEqual(ins.events, [
                ['erase row', 24, 24],
                ['insert line', 2, 1],
            ]);
            assert.deepEqual(at(ins), [2, 1]);
        });

        it('DELETE / INSERT CHARACTER: events for the MCI map, cursor stays', () => {
            const del = parse([...text('ab'), C.deleteChar]);
            assert.deepEqual(del.events, [['delete columns', 1, 3, 1]]);
            assert.deepEqual(at(del), [1, 3]);
            const ins = parse([...text('ab'), C.insertChar]);
            assert.deepEqual(ins.events, [['insert columns', 1, 3, 1]]);
            assert.deepEqual(at(ins), [1, 3]);
        });

        it('0x1A is a glyph, not an end of file', () => {
            const r = parse([0x41, 0x1a, 0x42]);
            assert.deepEqual(at(r), [1, 4]);
            assert.deepEqual(r.bytes, [0x41, 0x1a, 0x42]);
        });

        it('startRow places the art', () => {
            const r = parse(text('%ET1'), { startRow: 5 });
            assert.deepEqual(r.mcis[0].position, [5, 1]);
        });
    });

    describe('parser: ESC quoting', function () {
        it('ESC + byte is one glyph cell', () => {
            const r = parse([ESC, C.cursorUp, ESC, ESC, ESC, C.clear, ESC, 0x41]);
            assert.deepEqual(at(r), [1, 5]);
            assert.equal(r.events.length, 0); //  the quoted CLEAR does not clear
            assert.deepEqual(r.bytes, [
                ESC,
                C.cursorUp,
                ESC,
                ESC,
                ESC,
                C.clear,
                ESC,
                0x41,
            ]);
        });

        it('ESC + END OF LINE is still an end of line', () => {
            const r = parse([...text('ab'), ESC, EOL, ...text('%ET1')]);
            assert.deepEqual(r.mcis[0].position, [2, 1]);
        });

        it('a trailing ESC is dropped: it would swallow what comes next', () => {
            const r = parse([...text('ab'), ESC]);
            assert.deepEqual(r.bytes, text('ab'));
            assert.deepEqual(at(r), [1, 3]);
            assert.deepEqual(parse([ESC]).bytes, []);
            //  ESC ESC at the end is a whole glyph
            assert.deepEqual(parse([0x41, ESC, ESC]).bytes, [0x41, ESC, ESC]);
        });

        it('a quoted glyph can be part of an MCI code (ESC before a letter)', () => {
            const r = parse([...text('%E'), ESC, 0x54, ...text('1')]);
            assert.equal(r.mcis.length, 1);
            assert.equal(r.mcis[0].mci, 'ET');
            assert.deepEqual(r.bytes, Array(4).fill(0x20));
        });
    });

    describe('parser: final END OF LINE', function () {
        it('default: dropped when it would scroll, kept otherwise', () => {
            const bottom = parse([...Array(23).fill(EOL), ...text('x'), EOL]);
            assert.deepEqual(at(bottom), [24, 2]);
            assert.equal(bottom.bytes[bottom.bytes.length - 1], 0x78);
            const top = parse([...text('x'), EOL]);
            assert.deepEqual(at(top), [2, 1]);
        });

        it("'yes' keeps it, 'no' drops it; ESC + END OF LINE counts as one", () => {
            const yes = parse([...Array(23).fill(EOL), EOL], { trailingLF: 'yes' });
            assert.deepEqual(
                yes.events.filter(e => 'scroll' === e[0]),
                [['scroll', 1]]
            );
            const no = parse([...text('x'), ESC, EOL], { trailingLF: 'no' });
            assert.deepEqual(no.bytes, text('x'));
            assert.deepEqual(at(no), [1, 2]);
        });
    });

    describe('parser: MCI codes', function () {
        it('either letter case, with an id and arguments; reported upper case', () => {
            const r = parse([...text('%tl1 %Vm2(3,ab) %XY')]);
            assert.deepEqual(
                r.mcis.map(m => [m.mci, m.id, m.args, m.position]),
                [
                    ['TL', 1, [], [1, 1]],
                    ['VM', 2, ['3', 'ab'], [1, 6]],
                    ['XY', null, [], [1, 17]],
                ]
            );
            //  each code becomes as many spaces as it had cells
            assert.deepEqual(r.bytes, text(' '.repeat(19)));
        });

        it('a code inside inverse text is found; its inverse state is reported and kept', () => {
            const r = parse([...inv('Pass: '), ...inv('%ET2'), ...inv(' ')]);
            assert.equal(r.mcis.length, 1);
            const m = r.mcis[0];
            assert.deepEqual(m.position, [1, 7]);
            assert.deepEqual(m.atascii, { inverse: true });
            assert.equal(m.SGR, '\x1b[0;7m');
            //  the replacement keeps the bar whole: inverse spaces
            assert.deepEqual(r.bytes.slice(6, 10), Array(4).fill(0xa0));
            const plain = parse(text('%ET1'));
            assert.deepEqual(plain.mcis[0].atascii, { inverse: false });
            assert.equal(plain.mcis[0].SGR, '\x1b[0m');
        });

        it('a code whose letters mix inverse and normal is still found', () => {
            const r = parse([0x25, 0xc5, 0x54, 0xb1]);
            assert.equal(r.mcis[0].mci, 'ET');
            assert.deepEqual(r.bytes, [0x20, 0xa0, 0x20, 0xa0]);
        });

        it('a control byte ends a code', () => {
            assert.equal(parse([...text('%E'), EOL, ...text('T1')]).mcis.length, 0);
            assert.equal(
                parse([...text('%E'), C.cursorRight, ...text('T1')]).mcis.length,
                0
            );
        });

        it("mciReplaceChar '' leaves the code's own bytes", () => {
            const bytes = [...text('%E'), ESC, 0x54, 0xb1];
            const r = parse(bytes, { mciReplaceChar: '' });
            assert.equal(r.mcis.length, 1);
            assert.deepEqual(r.bytes, bytes);
        });

        it('a replacement character that is a control byte becomes a space', () => {
            const r = parse(inv('%ET1'), { mciReplaceChar: '\u2190' }); //  left arrow glyph
            assert.deepEqual(r.bytes, Array(4).fill(0xa0));
            const dot = parse(text('%ET1'), { mciReplaceChar: '.' });
            assert.deepEqual(dot.bytes, text('....'));
        });

        it('the SGR at a code round-trips through the output translator', () => {
            [true, false].forEach(inverse => {
                const t = createAtasciiTranslator({ cols: 40, rows: 24 });
                t.translate('\x1b[2J\x1b[7m'); //  ENiGMA's own state, overridden
                const out = [...t.translate(`${sgrFor(inverse)}X`)];
                assert.deepEqual(out, [inverse ? 0xd8 : 0x58]);
            });
        });

        it('the final cursor matches the native screen model on random art', () => {
            const rnd = prng(593);
            const pool = [
                ...text('abc %'),
                ...text('%ET1'),
                0xa5,
                0xc5,
                EOL,
                ESC,
                C.cursorUp,
                C.cursorDown,
                C.cursorLeft,
                C.cursorRight,
                C.clear,
                C.backspace,
                C.tab,
                C.setTab,
                C.clearTab,
                C.deleteLine,
                C.insertLine,
                C.deleteChar,
                C.insertChar,
                C.bell,
                0x1a,
            ];
            for (let n = 0; n < 300; ++n) {
                const len = 1 + Math.floor(rnd() * 400);
                const bytes = Array.from(
                    { length: len },
                    () => pool[Math.floor(rnd() * pool.length)]
                );
                const r = parse(bytes, {
                    termWidth: 12,
                    termHeight: 6,
                    mciReplaceChar: '',
                    trailingLF: 'yes',
                });
                assert.deepEqual(r.bytes, bytes.slice(0, unitsEnd(bytes)), `stream ${n}`);
                const model = new AtasciiScreen(12, 6, { row: 0, col: 0, native: true });
                model.write(Buffer.from(r.bytes));
                assert.deepEqual(at(r), [model.row + 1, model.col + 1], `stream ${n}`);
            }
        });
    });

    describe('plain text', function () {
        it('quoted glyphs are their characters; END OF LINE and the wrap are CRLF', () => {
            const t = atasciiArtToText(
                Buffer.from([
                    ESC,
                    C.cursorUp,
                    ESC,
                    C.clear,
                    ...text('a'),
                    EOL,
                    ...text('cdef'),
                    ...text('g'),
                    ESC,
                    EOL,
                    0x00,
                ]),
                { cols: 4 }
            );
            assert.equal(t, '\u2191\u2196a\r\ncdef\r\ng\r\n\u2665');
        });

        it('inverse and every control byte dropped; nothing that drives a terminal', () => {
            const t = atasciiArtToText(
                Buffer.from([
                    C.clear,
                    ...inv('Hi'),
                    C.cursorRight,
                    C.tab,
                    C.bell,
                    C.deleteLine,
                    0x1a,
                ])
            );
            assert.equal(t, 'Hi\u2514');
            const all = atasciiArtToText(Buffer.from([...Array(256).keys()]));
            assert.ok(!/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(all), 'controls');
        });

        it('wraps at 40 columns by default', () => {
            assert.equal(
                atasciiArtToText(Buffer.from(Array(41).fill(0x41))),
                `${'A'.repeat(40)}\r\nA`
            );
        });
    });

    describe('translator writeNative()', function () {
        function known(cols = 40, rows = 24) {
            const t = createAtasciiTranslator({ cols, rows });
            const screen = new AtasciiScreen(cols, rows, { native: true });
            screen.write(t.translate('\x1b[2J'));
            return { t, screen };
        }

        it('sends the bytes as they are and follows them', () => {
            const { t, screen } = known();
            const art = [C.clear, ...text('ab'), EOL, ESC, C.cursorUp, C.tab, C.bell];
            const out = t.writeNative(Buffer.from(art));
            assert.deepEqual([...out], art);
            screen.write(out);
            const s = t.state();
            assert.equal(s.known, true);
            assert.deepEqual([s.terminalRow, s.terminalCol], [screen.row, screen.col]);
            assert.deepEqual([s.row, s.col], [screen.row, screen.col]);
        });

        it('tracked state equals the screen model after random native art, and ANSI lands right after it', () => {
            const rnd = prng(1977);
            const pool = [
                0x41,
                0xc1,
                0x1a,
                EOL,
                ESC,
                C.cursorUp,
                C.cursorDown,
                C.cursorLeft,
                C.cursorRight,
                C.clear,
                C.backspace,
                C.tab,
                C.setTab,
                C.clearTab,
                C.deleteLine,
                C.insertLine,
                C.deleteChar,
                C.insertChar,
                C.bell,
            ];
            for (let n = 0; n < 200; ++n) {
                const { t, screen } = known(16, 8);
                const len = 1 + Math.floor(rnd() * 200);
                let art = Array.from(
                    { length: len },
                    () => pool[Math.floor(rnd() * pool.length)]
                );
                if (ESC === art[art.length - 1]) {
                    art = art.concat([0x42]);
                }
                screen.write(t.writeNative(Buffer.from(art)));
                const s = t.state();
                assert.deepEqual(
                    [s.terminalRow, s.terminalCol],
                    [screen.row, screen.col],
                    `stream ${n}`
                );
                const r = Math.floor(rnd() * 7);
                const c = Math.floor(rnd() * 15);
                screen.write(t.translate(`\x1b[${r + 1};${c + 1}H\x1b[7mZ`));
                assert.deepEqual(
                    screen.actual(r, c),
                    { ch: 'Z', inverse: true },
                    `stream ${n}`
                );
            }
        });

        it('a CR held from translated output happens first', () => {
            const { t, screen } = known();
            screen.write(t.translate('abc\r'));
            const out = t.writeNative(Buffer.from(text('X')));
            screen.write(out);
            assert.deepEqual(screen.actual(0, 0), { ch: 'X', inverse: false });
            assert.equal(screen.actual(0, 1).ch, 'b');
        });

        it('a half-parsed escape sequence is dropped', () => {
            const { t, screen } = known();
            screen.write(t.translate('\x1b['));
            screen.write(t.writeNative(Buffer.from(text('a'))));
            screen.write(t.translate('2J'));
            assert.equal(screen.clears, 1); //  only the first ESC[2J
            assert.equal(screen.actual(0, 1).ch, '2');
        });

        it('a glyph held for the bottom-right cell is dropped, not scrolled', () => {
            const { t, screen } = known(4, 2);
            screen.write(t.translate('abcdefgh'));
            assert.equal(t.state().heldBottomRight, true);
            screen.write(t.writeNative(Buffer.from([C.cursorUp, 0x5a])));
            assert.equal(t.state().heldBottomRight, false);
            assert.equal(screen.scrolls, 0);
            assert.equal(screen.actual(1, 3).ch, ' ');
            assert.equal(screen.actual(0, 3).ch, 'Z');
        });

        it('a dangling ESC at the end is closed by a space before the next byte', () => {
            const { t, screen } = known();
            const native = t.writeNative(Buffer.from([...text('ab'), ESC]));
            assert.deepEqual([...native], [...text('ab'), ESC]);
            const next = t.translate('\x1b[2;1HX');
            assert.equal(next[0], 0x20);
            screen.write(Buffer.concat([native, next]));
            assert.deepEqual(screen.actual(1, 0), { ch: 'X', inverse: false });
            assert.equal(screen.actual(0, 2).ch, ' ');
        });

        it('bytes written around us that end in an ESC quote cannot swallow the art', () => {
            const t = createAtasciiTranslator({ cols: 40, rows: 24 });
            t.passThrough(Buffer.from([0x41, ESC]));
            const out = t.writeNative(Buffer.from([C.clear, 0x41]), { anchor: true });
            assert.deepEqual([...out], [0x20, C.clear, 0x41]);
        });

        describe('position unknown', function () {
            it('anchor: CLEAR first when the art does not clear, then down to startRow', () => {
                const t = createAtasciiTranslator({ cols: 40, rows: 24 });
                assert.equal(t.state().known, false);
                const out = t.writeNative(Buffer.from(text('ab')), { anchor: true });
                assert.deepEqual([...out], [C.clear, ...text('ab')]);
                assert.equal(t.state().known, true);

                const t3 = createAtasciiTranslator({ cols: 40, rows: 24 });
                const screen = new AtasciiScreen(40, 24, { native: true });
                screen.write(
                    t3.writeNative(Buffer.from(text('ab')), { anchor: true, startRow: 3 })
                );
                assert.deepEqual(screen.actual(2, 0), { ch: 'a', inverse: false });
                assert.deepEqual([screen.row, screen.col], [2, 2]);
            });

            it('anchor: art that clears first (after BELLs) gets no extra CLEAR', () => {
                const t = createAtasciiTranslator({ cols: 40, rows: 24 });
                const art = [C.bell, C.clear, 0x41];
                assert.deepEqual(
                    [...t.writeNative(Buffer.from(art), { anchor: true })],
                    art
                );
                assert.equal(t.state().known, true);
            });

            it('anchor: nothing extra when the position is known', () => {
                const { t } = known();
                t.translate('hello');
                assert.deepEqual(
                    [...t.writeNative(Buffer.from(text('ab')), { anchor: true })],
                    text('ab')
                );
            });

            it('without anchor: the bytes alone, and the position stays unknown', () => {
                const t = createAtasciiTranslator({ cols: 40, rows: 24 });
                assert.deepEqual([...t.writeNative(Buffer.from(text('ab')))], text('ab'));
                assert.equal(t.state().known, false);
                //  a CLEAR in the art makes it known from there
                t.writeNative(Buffer.from([0x41, C.clear, 0x42, EOL]));
                assert.deepEqual(
                    [t.state().known, t.state().row, t.state().col],
                    [true, 1, 0]
                );
            });
        });
    });
});

//  where the parser stops: a trailing unquoted ESC is not sent
function unitsEnd(bytes) {
    let i = 0;
    while (i < bytes.length) {
        if (ESC === bytes[i]) {
            if (i + 1 >= bytes.length) {
                return i;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    return bytes.length;
}
