'use strict';

//
//  Native PETSCII art (#593): the art parser (core/term/petscii/art_parser.js),
//  the screen rules it shares with the output translator
//  (core/term/petscii/screen_rules.js), the translator's writeNative(), and
//  ClientTerminal.nativeWrite(). Selection and display through core/art.js are
//  in test/art_native_petscii.test.js.
//
const { strict: assert } = require('assert');

const {
    Controls,
    Colors,
    AnsiToPetsciiColor,
    encode,
} = require('../core/term/petscii/charset.js');
const {
    PetsciiArtParser,
    petsciiArtToText,
    sgrFor,
} = require('../core/term/petscii/art_parser.js');
const {
    Effect,
    createScreenState,
    applyByte,
} = require('../core/term/petscii/screen_rules.js');
const { createPetsciiTranslator } = require('../core/term/petscii/output_translator.js');
const { ClientTerminal } = require('../core/client_term.js');
const { selectClientEmulation } = require('../core/term/select.js');
const { PetsciiScreen } = require('./term_petscii_screens.js');

const C = Controls;
const lower = s => [...encode(s, 'lower')];
const upper = s => [...encode(s, 'upper')];
const times = (n, b) => new Array(n).fill(b);

function parse(bytes, opts = {}) {
    const p = new PetsciiArtParser(
        Object.assign({ termWidth: 40, termHeight: 25, mciReplaceChar: ' ' }, opts)
    );
    const ev = { literal: [], control: [], mci: [], clear: 0, scroll: 0, insert: [] };
    const out = [];
    p.on('literal', b => {
        ev.literal.push(b);
        out.push(b);
    });
    p.on('control', b => {
        ev.control.push(b);
        out.push(b);
    });
    p.on('mci', m => ev.mci.push(m));
    p.on('clear screen', () => ++ev.clear);
    p.on('scroll', n => (ev.scroll += n));
    p.on('insert columns', (r, c, n) => ev.insert.push([r, c, n]));
    p.on('complete', info => (ev.complete = info));
    p.reset(Buffer.from(bytes));
    p.parse();
    ev.wire = Buffer.concat(out);
    ev.at = [ev.complete.row, ev.complete.column];
    ev.parser = p;
    return ev;
}

function makeOutput() {
    const written = [];
    return {
        writable: true,
        written,
        write(data, cb) {
            written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            if (cb) {
                cb(null);
            }
        },
    };
}

const wire = output => Buffer.concat(output.written);

function petsciiTerm() {
    const output = makeOutput();
    const term = new ClientTerminal(output);
    const client = { term, log: { info() {}, debug() {}, warn() {} } };
    selectClientEmulation(client, {
        firstMenu: 'telnetConnected',
        listener: { name: 'c64', emulation: 'petscii' },
    });
    term.termWidth = 40;
    term.termHeight = 25;
    term.emulation.probes.forEach(probe => probe.run(client, () => {}));
    return { term, client, output };
}

describe('PETSCII native art', () => {
    describe('art parser: cursor', () => {
        it('glyphs advance; the last column wraps at once', () => {
            assert.deepEqual(parse(lower('ab')).at, [1, 3]);
            assert.deepEqual(parse(times(39, 0x41)).at, [1, 40]);
            assert.deepEqual(parse(times(40, 0x41)).at, [2, 1]);
            assert.deepEqual(parse(times(81, 0x41)).at, [3, 2]);
        });

        it('RETURN and shift-RETURN: column 1 of the next row', () => {
            assert.deepEqual(parse([0x41, C.return, 0x41]).at, [2, 2]);
            assert.deepEqual(parse([0x41, C.shiftReturn, 0x41]).at, [2, 2]);
        });

        it('RETURN turns reverse off, shift-RETURN does not', () => {
            const pct = lower('%tl1');
            let ev = parse([C.reverseOn, C.return, ...pct]);
            assert.equal(ev.mci[0].petscii.reverse, false);
            ev = parse([C.reverseOn, C.shiftReturn, ...pct]);
            assert.equal(ev.mci[0].petscii.reverse, true);
        });

        it('DOWN, UP (clamped at the top), RIGHT and LEFT with line wrap', () => {
            assert.deepEqual(parse([0x41, C.cursorDown]).at, [2, 2]);
            assert.deepEqual(parse([C.cursorUp, C.cursorUp, 0x41]).at, [1, 2]);
            assert.deepEqual(parse([C.cursorDown, C.cursorDown, C.cursorUp]).at, [2, 1]);
            assert.deepEqual(parse([...times(39, C.cursorRight)]).at, [1, 40]);
            assert.deepEqual(parse([...times(40, C.cursorRight)]).at, [2, 1]);
            assert.deepEqual(parse([C.cursorDown, C.cursorLeft]).at, [1, 40]);
            assert.deepEqual(parse([C.cursorLeft]).at, [1, 1], 'nothing at HOME');
        });

        it('DELETE moves like LEFT; INSERT stays and reports the shift', () => {
            assert.deepEqual(parse([0x41, 0x41, C.delete]).at, [1, 2]);
            assert.deepEqual(parse([C.cursorDown, C.delete]).at, [1, 40]);
            const ev = parse([0x41, 0x41, C.insert]);
            assert.deepEqual(ev.at, [1, 3]);
            assert.deepEqual(ev.insert, [[1, 3, 1]]);
        });

        it('HOME and CLR go to 1,1; CLR reports a clear', () => {
            let ev = parse([C.cursorDown, 0x41, 0x41, C.home]);
            assert.deepEqual(ev.at, [1, 1]);
            assert.equal(ev.clear, 0);
            ev = parse([C.cursorDown, 0x41, 0x41, C.clear]);
            assert.deepEqual(ev.at, [1, 1]);
            assert.equal(ev.clear, 1);
        });

        it('colour, reverse and charset bytes do not move the cursor', () => {
            const ev = parse([
                Colors.red,
                C.reverseOn,
                C.reverseOff,
                C.charsetUpper,
                C.charsetLower,
                0x0a, //  not a C64 control: ignored
                0x07,
            ]);
            assert.deepEqual(ev.at, [1, 1]);
            assert.equal(ev.literal.length, 0);
        });

        it('scrolls at the bottom: glyph wrap, RETURN, DOWN, RIGHT', () => {
            let ev = parse(times(40, 0x41), { startRow: 25 });
            assert.deepEqual([ev.at, ev.scroll], [[25, 1], 1]);
            ev = parse([C.return, 0x41], { startRow: 25 });
            assert.deepEqual([ev.at, ev.scroll], [[25, 2], 1]);
            ev = parse([C.cursorDown, 0x41], { startRow: 25 });
            assert.deepEqual([ev.at, ev.scroll], [[25, 2], 1]);
            ev = parse([...times(40, C.cursorRight)], { startRow: 25 });
            assert.deepEqual([ev.at, ev.scroll], [[25, 1], 1]);
        });

        it('a final RETURN that would scroll is dropped by default', () => {
            let ev = parse([0x41, C.return], { startRow: 25 });
            assert.deepEqual([ev.at, ev.scroll], [[25, 2], 0]);
            assert.deepEqual([...ev.wire], [0x41]);

            ev = parse([0x41, C.return], { startRow: 25, trailingLF: 'yes' });
            assert.deepEqual([ev.at, ev.scroll], [[25, 1], 1]);

            ev = parse([0x41, C.return]);
            assert.deepEqual(ev.at, [2, 1], 'kept when it does not scroll');

            ev = parse([0x41, C.return], { trailingLF: 'omit' });
            assert.deepEqual(ev.at, [1, 2]);
        });

        it('completion reports the final position and the extent drawn', () => {
            const ev = parse([
                C.clear,
                ...lower('hello'),
                C.return,
                C.cursorDown,
                ...times(9, C.cursorRight),
                0x41,
                C.return,
            ]);
            assert.deepEqual(ev.complete, {
                row: 4,
                column: 1,
                extent: { rows: 3, cols: 10 },
            });
            assert.equal(ev.parser.row, 4);
            assert.equal(ev.parser.column, 1);
        });

        it('literal and control runs are the art bytes, in order', () => {
            const art = [C.clear, Colors.red, ...lower('Hi'), C.return, 0xa0, 0xb0];
            const ev = parse(art);
            assert.deepEqual([...ev.wire], art);
            assert.deepEqual(
                ev.control.map(b => [...b]),
                [[C.clear], [Colors.red], [C.return]] //  CLR ends a run: it is reported
            );
            assert.deepEqual(
                ev.literal.map(b => [...b]),
                [lower('Hi'), [0xa0, 0xb0]]
            );
        });
    });

    describe('art parser: MCI codes', () => {
        const at = (bytes, opts) => parse(bytes, opts).mci.map(m => [m.mci, m.id]);

        it('lower/upper: unshifted, shifted and mirrored letters all match', () => {
            //  0x54 0x4c draw "tl", 0xd4 0xcc and 0x74 0x6c draw "TL"
            assert.deepEqual(at([0x25, 0x54, 0x4c, 0x31]), [['TL', 1]]);
            assert.deepEqual(at([0x25, 0xd4, 0xcc, 0x31]), [['TL', 1]]);
            assert.deepEqual(at([0x25, 0x74, 0x6c, 0x31]), [['TL', 1]]);
            assert.deepEqual(at([0x25, 0x54, 0xcc, 0x31]), [['TL', 1]], 'mixed case');
        });

        it('upper/graphics: unshifted letters match, shifted ones are graphics', () => {
            const opts = { charset: 'upper' };
            assert.deepEqual(at([0x25, 0x54, 0x4c, 0x31], opts), [['TL', 1]]);
            assert.deepEqual(at([0x25, 0xd4, 0xcc, 0x31], opts), []);
        });

        it('follows a character set switch inside the art', () => {
            assert.deepEqual(at([C.charsetUpper, 0x25, 0xd4, 0xcc, 0x31]), []);
            assert.deepEqual(
                at([C.charsetUpper, C.charsetLower, 0x25, 0xd4, 0xcc, 0x31]),
                [['TL', 1]]
            );
            assert.deepEqual(at([C.charsetUpper, 0x25, 0x54, 0x4c]), [['TL', null]]);
        });

        it('ids and arguments', () => {
            const ev = parse(upper('%VM12(2,3)%BN'), { charset: 'upper' });
            assert.deepEqual(
                ev.mci.map(m => [m.mci, m.id, m.args]),
                [
                    ['VM', 12, ['2', '3']],
                    ['BN', null, []],
                ]
            );
        });

        it('is not fooled by graphics, a lone percent, or one letter', () => {
            assert.deepEqual(at([0x25, 0xa0, 0xa0]), []);
            assert.deepEqual(at([0x25]), []);
            assert.deepEqual(at([0x25, 0x41, 0x20]), []);
            assert.deepEqual(at([0x25, 0x41, C.return, 0x42]), [], 'a control ends it');
        });

        it('reports the 1-based position where the code was found', () => {
            const ev = parse([
                C.clear,
                C.cursorDown,
                C.cursorDown,
                ...times(5, C.cursorRight),
                ...lower('%tl1'),
                C.return,
                ...lower('ab%et2'),
            ]);
            assert.deepEqual(
                ev.mci.map(m => [m.mci, m.position]),
                [
                    ['TL', [3, 6]],
                    ['ET', [4, 3]],
                ]
            );
        });

        it('positions follow a scroll and are cleared by CLR (via art.display)', () => {
            const ev = parse([...lower('%tl1'), C.return], {
                startRow: 25,
                trailingLF: 'yes',
            });
            assert.deepEqual(ev.mci[0].position, [25, 1]);
            assert.equal(ev.scroll, 1, 'art.display moves it up a row');
        });

        it('the code bytes are replaced, one byte per character', () => {
            let ev = parse([0x41, ...lower('%tl1(5)'), 0x42]);
            assert.deepEqual([...ev.wire], [0x41, ...times(7, 0x20), 0x42]);
            assert.deepEqual(ev.at, [1, 10]);

            ev = parse([0x41, ...lower('%tl1'), 0x42], { mciReplaceChar: '' });
            assert.deepEqual([...ev.wire], [0x41, ...lower('%tl1'), 0x42]);

            ev = parse([...lower('%tl1')], { mciReplaceChar: '.' });
            assert.deepEqual([...ev.wire], times(4, 0x2e));
        });

        it('colour and reverse at the code, as PETSCII and as ANSI SGR', () => {
            let ev = parse([Colors.red, C.reverseOn, ...lower('%tl1')]);
            assert.deepEqual(ev.mci[0].petscii, {
                color: Colors.red,
                reverse: true,
                charset: 'lower',
            });
            assert.equal(ev.mci[0].SGR, '\x1b[0;31;7m');

            ev = parse([Colors.lightBlue, ...lower('%tl1')]);
            assert.equal(ev.mci[0].SGR, '\x1b[0;1;34m');

            ev = parse(lower('%tl1'));
            assert.equal(ev.mci[0].petscii.color, Colors.lightGrey, 'default');
        });

        it('every SGR maps back to the same colour and reverse in the translator', () => {
            AnsiToPetsciiColor.forEach(color => {
                [false, true].forEach(reverse => {
                    const t = createPetsciiTranslator({ cols: 40, rows: 25 });
                    t.translate(`${sgrFor(color, reverse)}x`);
                    const st = t.state();
                    assert.equal(st.terminalColour, color);
                    assert.equal(st.terminalReverse, reverse);
                });
            });
        });
    });

    describe('art as text', () => {
        it('decodes glyphs, turns RETURN and wraps into CRLF, drops controls', () => {
            const text = petsciiArtToText(
                Buffer.from([
                    C.clear,
                    Colors.red,
                    ...lower('Hi'),
                    C.cursorRight,
                    0x41,
                    C.return,
                    C.reverseOn,
                    0xc1,
                    C.charsetUpper,
                    0x41,
                ])
            );
            assert.equal(text, 'Hi a\r\nAA');
            assert.equal(
                petsciiArtToText(Buffer.from(times(41, 0x41)), { cols: 40 }),
                `${'a'.repeat(40)}\r\na`
            );
        });
    });

    describe('shared screen rules', () => {
        it('HOME and CLR make the position known; CLR keeps attributes', () => {
            const s = createScreenState({
                row: 5,
                col: 5,
                color: Colors.red,
                reverse: true,
            });
            assert.equal(applyByte(s, C.home, 40, 25), Effect.Homed);
            assert.equal(applyByte(s, C.clear, 40, 25), Effect.Cleared | Effect.Homed);
            assert.deepEqual(s, {
                row: 0,
                col: 0,
                color: Colors.red,
                reverse: true,
                charset: null,
            });
        });

        it('the parser and the translator follow the same bytes to the same state', () => {
            const art = Buffer.from([
                C.clear,
                Colors.green,
                ...lower('Hello'),
                C.return,
                C.reverseOn,
                ...times(45, 0xa0),
                C.cursorUp,
                C.cursorLeft,
                C.charsetUpper,
                Colors.yellow,
                0x41,
            ]);
            const ev = parse(art, { mciReplaceChar: '' });
            const t = createPetsciiTranslator({ cols: 40, rows: 25 });
            t.writeNative(art);
            const st = t.state();
            assert.deepEqual(
                [st.terminalRow + 1, st.terminalCol + 1],
                [ev.parser.row, ev.parser.column]
            );
            assert.equal(st.terminalColour, ev.parser.state.color);
            assert.equal(st.terminalReverse, ev.parser.state.reverse);
            assert.equal(st.terminalCharset, ev.parser.state.charset);
        });
    });

    describe('translator writeNative()', () => {
        const art = Buffer.from([C.clear, Colors.red, ...lower('Name:'), C.return]);

        it('sends the art as it is once the character set is known', () => {
            const t = createPetsciiTranslator();
            t.translate('x');
            assert.deepEqual(t.writeNative(art), art);
        });

        it('selects the character set first when the terminal is not in it', () => {
            let t = createPetsciiTranslator();
            assert.deepEqual([...t.writeNative(art)], [C.charsetLower, ...art]);
            t = createPetsciiTranslator();
            t.translate('x');
            assert.deepEqual(
                [...t.writeNative(art, { charset: 'upper' })],
                [C.charsetUpper, ...art]
            );
        });

        it('settles a held CR before the art', () => {
            const t = createPetsciiTranslator();
            t.translate('\x1b[2Jab\r');
            const out = [...t.writeNative(Buffer.from([0x41]))];
            assert.equal(out[out.length - 1], 0x41);
            assert.deepEqual(t.state().terminalCol, 1, 'the CR went to column 0 first');
        });

        it('ENiGMA output after the art lands where the screen model says', () => {
            const t = createPetsciiTranslator();
            const screen = new PetsciiScreen(40, 25);
            screen.write(t.translate('\x1b[0m'));
            screen.write(t.writeNative(art));
            const st = t.state();
            assert.deepEqual([st.terminalRow, st.terminalCol], [screen.row, screen.col]);
            assert.equal(st.terminalColour, screen.color);
            assert.equal(st.terminalReverse, screen.reverse);
            assert.equal(st.terminalCharset, screen.charset);

            screen.write(t.translate('\x1b[1;7Hbob'));
            assert.equal(screen.actual(0, 0).ch, 'N');
            assert.equal(screen.actual(0, 6).ch, 'b');
            assert.equal(screen.actual(0, 8).ch, 'b');
            assert.equal(screen.actual(0, 6).color, Colors.lightGrey, "ENiGMA's colour");
            screen.write(t.translate('more'));
            assert.equal(screen.actual(0, 9).ch, 'm');
        });

        it('art in upper/graphics keeps its set until the next clear screen', () => {
            const t = createPetsciiTranslator();
            const screen = new PetsciiScreen(40, 25);
            screen.write(t.translate('\x1b[2J'));
            screen.write(t.writeNative(Buffer.from([0xb0, 0xae]), { charset: 'upper' }));
            assert.equal(screen.charset, 'upper');
            assert.equal(t.state().activeCharset, 'upper');

            //  text in the meantime is written in that set: lower case folds to upper
            const text = t.translate('ok');
            //  after ENiGMA's own reverse and colour are put back
            assert.deepEqual([...text], [C.reverseOff, Colors.lightGrey, 0x4f, 0x4b]);
            screen.write(text);
            assert.equal(screen.actual(0, 2).ch, 'O');

            //  the clear brings the session's set back, after the screen is blank
            const cls = [...t.translate('\x1b[2J')];
            assert.deepEqual(cls, [C.clear, C.charsetLower]);
            screen.write(Buffer.from(cls));
            assert.equal(screen.charset, 'lower');
            assert.equal(t.state().activeCharset, 'lower');
            assert.deepEqual([...t.translate('ok')], [0x4f, 0x4b]);
            assert.deepEqual([...t.translate('OK')], [0xcf, 0xcb]);
        });

        it('art that switches set itself is followed', () => {
            let t = createPetsciiTranslator();
            t.translate('x');
            t.writeNative(Buffer.from([C.charsetUpper, 0xb0]));
            assert.equal(t.state().activeCharset, 'upper');

            t = createPetsciiTranslator();
            t.translate('x');
            t.writeNative(Buffer.from([C.charsetUpper, 0xb0, C.charsetLower]));
            assert.equal(t.state().activeCharset, 'lower');
        });

        it('passThrough() forgets the art set as well', () => {
            const t = createPetsciiTranslator();
            t.writeNative(Buffer.from([0xb0]), { charset: 'upper' });
            t.passThrough(Buffer.from('x'));
            assert.equal(t.state().activeCharset, 'lower');
            assert.equal(t.translate('a')[0], C.charsetLower);
        });
    });

    describe('ClientTerminal.nativeWrite()', () => {
        const art = Buffer.from([C.clear, Colors.red, ...lower('Name:'), C.return]);

        it('an ANSI terminal takes no native bytes', done => {
            const output = makeOutput();
            const term = new ClientTerminal(output);
            assert.equal(term.canWriteNative(), false);
            assert.throws(() => term.nativeWrite(art), /does not take native output/);
            term.nativeWrite(art, {}, err => {
                assert.match(err.message, /ansi emulation/);
                term.nativeDripWrite(art, {}, 1000, err => {
                    assert.ok(err);
                    assert.equal(output.written.length, 0);
                    return done();
                });
            });
        });

        it('a PETSCII terminal sends them through writeNative()', () => {
            const { term, output } = petsciiTerm();
            assert.equal(term.canWriteNative(), true);
            term.nativeWrite(art);
            assert.deepEqual([...wire(output)], [C.charsetLower, ...art]);
        });

        it('a batch keeps native and translated output in order', () => {
            const ops = term => {
                term.write('\x1b[2JA');
                term.nativeWrite(art);
                term.write('\x1b[1;7Hbob');
                term.passThroughWrite(Buffer.from([0x41]));
                term.write('\x1b[3;1HC');
            };
            const plain = petsciiTerm();
            ops(plain.term);

            const batched = petsciiTerm();
            batched.term.beginWrite();
            ops(batched.term);
            assert.equal(batched.output.written.length, 0);
            batched.term.commitWrite();

            assert.equal(batched.output.written.length, 1);
            assert.deepEqual(wire(batched.output), wire(plain.output));

            const screen = new PetsciiScreen(40, 25);
            screen.write(wire(batched.output));
            assert.equal(screen.actual(0, 0).ch, 'N');
            assert.equal(screen.actual(0, 6).ch, 'b');
            assert.equal(screen.actual(2, 0).ch, 'C');
        });

        it('nativeDripWrite() sends the same bytes', done => {
            const plain = petsciiTerm();
            plain.term.nativeWrite(art, { charset: 'upper' });
            const dripped = petsciiTerm();
            dripped.term.nativeDripWrite(art, { charset: 'upper' }, 1000000, err => {
                assert.ifError(err);
                assert.deepEqual(wire(dripped.output), wire(plain.output));
                return done();
            });
        });
    });
});
