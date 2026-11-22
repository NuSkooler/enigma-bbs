'use strict';

const { strict: assert } = require('assert');

const { AnsiCanvas, applyTransparency } = require('../core/ansi_canvas.js');
const AnsiDiff = require('../core/ansi_diff.js');
const { ClientTerminal } = require('../core/client_term.js');

//
//  The diff writer: the bytes that turn one canvas on screen into the next.
//  Expected strings are pinned whole.
//

const ESC = '\x1b';
const RED = `${ESC}[0;31m`;
const WHITE = `${ESC}[0;1;37m`;
const BLUE = `${ESC}[0;34m`;
const goto = (r, c) => `${ESC}[${r};${c}H`;

//  a one-row canvas, |width| wide, of pipe coded |text|
const row = (text, width = 16) => AnsiCanvas.fromPipe(text, { width, height: 1 });

const render = (prev, next, options = {}) =>
    AnsiDiff.render(AnsiDiff.transition(prev, next, options), options);

describe('AnsiDiff', function () {
    describe('transitions (pinned bytes)', function () {
        it('writes only the changed cells, with one goto and the SGR they need', function () {
            const a = row('|04abcdefgh');
            const b = row('|04abcXefgh');
            assert.equal(render(a, b), `${goto(1, 4)}${RED}X`);
        });

        it('nothing changed: nothing written', function () {
            const a = row('|04abc');
            assert.equal(render(a, row('|04abc')), '');
        });

        it('a run of changed cells is one goto', function () {
            assert.equal(
                render(row('|04abcdefgh'), row('|04aXYZefgh')),
                `${goto(1, 2)}${RED}XYZ`
            );
        });

        it('joins two runs when the gap costs less than a goto', function () {
            //  gap of 7 unchanged cells (7 bytes) < goto (8): joined
            assert.equal(
                render(row('|04a1234567bcdef'), row('|04X1234567Ycdef')),
                `${goto(1, 1)}${RED}X1234567Y`
            );
            //  gap of 8 (8 bytes) is not cheaper than a goto: two runs
            assert.equal(
                render(row('|04a12345678bcde'), row('|04X12345678Ycde')),
                `${goto(1, 1)}${RED}X${goto(1, 10)}Y`
            );
        });

        it('counts the SGR a gap would need against joining it', function () {
            //  3-cell gap in another colour: 3 + two SGR changes > goto
            const a = row('|04a|15123|04b');
            const b = row('|04X|15123|04Y');
            assert.equal(render(a, b), `${goto(1, 1)}${RED}X${goto(1, 5)}Y`);
        });

        it('writes SGR only when it changes, also across runs and rows', function () {
            const a = AnsiCanvas.fromPipe('|04aa|15bb\n|15cc|04dd', { width: 4 });
            const b = AnsiCanvas.fromPipe('|04AA|15BB\n|15CC|04DD', { width: 4 });
            assert.equal(
                render(a, b),
                `${goto(1, 1)}${RED}AA${WHITE}BB${goto(2, 1)}CC${RED}DD`
            );
        });

        it('a changed attr with the same character is a change', function () {
            assert.equal(
                render(row('|04abc'), row('|04a|01b|04c')),
                `${goto(1, 2)}${BLUE}b`
            );
        });

        it('full redraw: every cell, a goto per row', function () {
            const c = AnsiCanvas.fromPipe('|04ab\n|15cd', { width: 3 });
            const expected = `${goto(1, 1)}${RED}ab${ESC}[0m ${goto(2, 1)}${WHITE}cd${ESC}[0m `;
            assert.equal(render(null, c), expected);
            assert.equal(render(c, c, { full: true }), expected);
        });

        it('never writes a masked (transparent) cell; a run cannot cross one', function () {
            const frames = [
                AnsiCanvas.fromPipe('|04a~b', { width: 3, height: 1 }),
                AnsiCanvas.fromPipe('|04c~d', { width: 3, height: 1 }),
            ];
            const { mask } = applyTransparency(frames, '~');
            assert.equal(
                render(frames[0], frames[1], { mask }),
                `${goto(1, 1)}${RED}c${goto(1, 3)}d`
            );
            assert.equal(
                render(null, frames[0], { mask }),
                `${goto(1, 1)}${RED}a${goto(1, 3)}b`
            );
        });

        it('rejects canvases of different sizes', function () {
            assert.throws(
                () => AnsiDiff.transition(row('a', 3), row('a', 4)),
                /differ in size/
            );
        });
    });

    describe('render()', function () {
        const t = AnsiDiff.transition(
            null,
            AnsiCanvas.fromPipe('|04ab\n|15cd', { width: 2 })
        );

        it('applies a screen origin at write time: one transition, any position', function () {
            assert.equal(
                AnsiDiff.render(t, { origin: { row: 5, col: 10 } }),
                `${goto(5, 10)}${RED}ab${goto(6, 10)}${WHITE}cd`
            );
            assert.equal(
                AnsiDiff.render(t, { origin: { row: 20, col: 70 } }),
                `${goto(20, 70)}${RED}ab${goto(21, 70)}${WHITE}cd`
            );
        });

        it('clips to the terminal, keeping SGR right', function () {
            assert.equal(
                AnsiDiff.render(t, {
                    origin: { row: 25, col: 80 },
                    termWidth: 80,
                    termHeight: 25,
                }),
                `${goto(25, 80)}${RED}a`
            );
            //  first row gone: the second still sets its SGR
            assert.equal(
                AnsiDiff.render(t, {
                    origin: { row: 0, col: 1 },
                    termWidth: 80,
                    termHeight: 25,
                }),
                `${goto(1, 1)}${WHITE}cd`
            );
        });

        it('a full redraw of iCE frames turns iCE on first', function () {
            assert.equal(
                AnsiDiff.render(t, { iceColors: true }),
                `${ESC}[?33h${goto(1, 1)}${RED}ab${goto(2, 1)}${WHITE}cd`
            );
            const step = AnsiDiff.transition(row('|04a', 1), row('|04b', 1));
            assert.equal(
                AnsiDiff.render(step, { iceColors: true }),
                `${goto(1, 1)}${RED}b`
            );
        });
    });

    describe('write(): encoded per session', function () {
        function term(encoding) {
            const writes = [];
            const t = new ClientTerminal({
                writable: true,
                write(data, cb) {
                    writes.push(Buffer.from(data));
                    if (cb) {
                        cb(null);
                    }
                },
            });
            t.outputEncoding = encoding;
            return { t, wire: () => Buffer.concat(writes).toString('hex') };
        }

        it('CP437 and UTF-8 sessions get the same frame in their own bytes', function () {
            const prev = AnsiCanvas.fromAnsi(' ', { width: 1, height: 1 });
            const next = AnsiCanvas.fromAnsi('█', { width: 1, height: 1 });
            const step = AnsiDiff.transition(prev, next);

            const cp437 = term('cp437');
            assert.equal(AnsiDiff.write(cp437.t, step), `${goto(1, 1)}${ESC}[0m█`);
            assert.equal(cp437.wire(), '1b5b313b31481b5b306d' + 'db');

            const utf8 = term('utf8');
            AnsiDiff.write(utf8.t, step);
            assert.equal(utf8.wire(), '1b5b313b31481b5b306d' + 'e29688');
        });

        it('line feeds are not converted (written with convertLineFeeds false)', function () {
            const calls = [];
            const fake = { write: (s, convert) => calls.push([s, convert]) };
            AnsiDiff.write(fake, AnsiDiff.transition(null, row('|04a', 1)));
            assert.deepEqual(calls, [[`${goto(1, 1)}${RED}a`, false]]);
            //  nothing to write: no call
            AnsiDiff.write(fake, AnsiDiff.transition(row('a', 1), row('a', 1)));
            assert.equal(calls.length, 1);
        });
    });

    describe('FrameTransitions', function () {
        const frames = ['|04a', '|04b', '|04c'].map(f => row(f, 1));

        it('works out each step forward and the wrap when built', function () {
            const ft = new AnsiDiff.FrameTransitions(frames);
            assert.equal(ft.size, 3);
            assert.equal(ft._steps.size, 3);
            assert.equal(AnsiDiff.render(ft.get(0, 1)), `${goto(1, 1)}${RED}b`);
            assert.equal(AnsiDiff.render(ft.get(2, 0)), `${goto(1, 1)}${RED}a`);
            assert.equal(ft.get(1, 2), ft.get(1, 2)); //  the same object each time
        });

        it('other orders are worked out on first use and kept', function () {
            const ft = new AnsiDiff.FrameTransitions(frames);
            const back = ft.get(2, 1);
            assert.equal(ft._steps.size, 4);
            assert.equal(ft.get(2, 1), back);
            assert.equal(AnsiDiff.render(back), `${goto(1, 1)}${RED}b`);
        });

        it('full(i), or nothing known on screen, draws frame i whole', function () {
            const ft = new AnsiDiff.FrameTransitions(frames);
            assert.equal(ft.get(null, 2), ft.full(2));
            assert.equal(ft.full(2).full, true);
            assert.equal(AnsiDiff.render(ft.full(2)), `${goto(1, 1)}${RED}c`);
        });

        it('carries the transparency mask into every transition', function () {
            const masked = [
                AnsiCanvas.fromPipe('|04a~', { width: 2, height: 1 }),
                AnsiCanvas.fromPipe('|04b~', { width: 2, height: 1 }),
            ];
            const { mask } = applyTransparency(masked, '~');
            const ft = new AnsiDiff.FrameTransitions(masked, { mask });
            assert.equal(AnsiDiff.render(ft.full(0)), `${goto(1, 1)}${RED}a`);
            assert.equal(AnsiDiff.render(ft.get(0, 1)), `${goto(1, 1)}${RED}b`);
        });
    });
});
