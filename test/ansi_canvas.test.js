'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const iconv = require('iconv-lite');

const {
    AnsiCanvas,
    sliceSheet,
    applyTransparency,
    DEFAULT_ATTR,
} = require('../core/ansi_canvas.js');
const { ClientTerminal } = require('../core/client_term.js');
const AnsiDiff = require('../core/ansi_diff.js');

//
//  AnsiCanvas: ANSI and pipe coded content drawn into a cell grid off
//  screen, with art.display()'s parser; vertical frame sheets cut from it;
//  transparency across frames; clipping.
//

const ROOT = paths.join(__dirname, '..');
const ESC = '\x1b';

//  Late bound: art.js captures config.js's |get| at require time
let art;

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

const rowText = (canvas, row) => canvas.chars[row].join('');

//  A SAUCE record (128 bytes) for ANSi art, with |comments| COMNT lines
//  before it and the 0x1A in front of all of it
function sauceTrailer({ width = 80, height = 0, comments = [], ice = false } = {}) {
    const rec = Buffer.alloc(128, 0x20);
    rec.write('SAUCE00', 0, 'latin1');
    rec.write('19991231', 82, 'latin1');
    rec.writeUInt32LE(0, 90);
    rec[94] = 1; //  Character
    rec[95] = 1; //  ANSi
    rec.writeUInt16LE(width, 96);
    rec.writeUInt16LE(height, 98); //  TInfo2: a hint only, never used
    rec.writeUInt16LE(0, 100);
    rec.writeUInt16LE(0, 102);
    rec[104] = comments.length;
    rec[105] = ice ? 1 : 0;
    rec.fill(0, 106);
    const parts = [Buffer.from([0x1a])];
    if (comments.length) {
        parts.push(Buffer.from('COMNT', 'latin1'));
        comments.forEach(c =>
            parts.push(Buffer.from(c.padEnd(64).slice(0, 64), 'latin1'))
        );
    }
    parts.push(rec);
    return Buffer.concat(parts);
}

const tempDirs = [];
function writeTemp(name, buf) {
    const dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-canvas-'));
    tempDirs.push(dir);
    const path = paths.join(dir, name);
    fs.writeFileSync(path, buf);
    return path;
}

const fromFile = (path, options = {}) =>
    new Promise((resolve, reject) =>
        AnsiCanvas.fromFile(path, options, (err, canvas) =>
            err ? reject(err) : resolve(canvas)
        )
    );

describe('AnsiCanvas', function () {
    before(function () {
        art = require('../core/art.js');
    });

    after(function () {
        tempDirs
            .splice(0)
            .forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    });

    describe('drawing', function () {
        it('draws pipe strings through pipeToAnsi, one attr per cell', function () {
            const c = AnsiCanvas.fromPipe('|04ab|15c\n|01|17d', { width: 10 });
            assert.equal(c.width, 10);
            assert.equal(c.height, 2);
            assert.equal(rowText(c, 0), 'abc       ');
            assert.equal(rowText(c, 1), 'd         ');
            assert.equal(c.getAttr(0, 0), `${ESC}[0;31m`);
            assert.equal(c.getAttr(0, 1), `${ESC}[0;31m`);
            assert.equal(c.getAttr(0, 2), `${ESC}[0;1;37m`);
            assert.equal(c.getAttr(1, 0), `${ESC}[0;34;44m`);
            //  never drawn: blank, default
            assert.deepEqual(c.get(0, 5), { char: ' ', attr: DEFAULT_ATTR });
            assert.equal(c.get(9, 9), null);
        });

        it('keeps blink in the attr and iCE on the canvas (SAUCE or option)', function () {
            const ans = `${ESC}[0;5;1;33;41mHi${ESC}[0m!`;
            const c = AnsiCanvas.fromAnsi(ans, { iceColors: true });
            assert.equal(c.iceColors, true);
            assert.equal(c.getAttr(0, 0), `${ESC}[0;1;5;33;41m`);
            assert.equal(c.getAttr(0, 2), DEFAULT_ATTR);

            const viaSauce = AnsiCanvas.fromAnsi(ans, {
                sauce: { ansiFlags: 1, Character: { characterWidth: 40 } },
            });
            assert.equal(viaSauce.iceColors, true);
            assert.equal(viaSauce.width, 40);
            assert.equal(AnsiCanvas.fromAnsi(ans).iceColors, false);
        });

        it('normalizes SGR: off codes and default colours are the reset', function () {
            const c = AnsiCanvas.fromAnsi(
                `${ESC}[1;5;31mA${ESC}[22;25mB${ESC}[39;49mC${ESC}[6mD`
            );
            assert.equal(c.getAttr(0, 0), `${ESC}[0;1;5;31m`);
            assert.equal(c.getAttr(0, 1), `${ESC}[0;31m`);
            assert.equal(c.getAttr(0, 2), DEFAULT_ATTR);
            assert.equal(c.getAttr(0, 3), `${ESC}[0;5m`);
        });

        it('follows cursor movement, CUP and erase to end of line', function () {
            const c = AnsiCanvas.fromAnsi(
                `abc${ESC}[2;5HX${ESC}[1Dy${ESC}[3;1H${ESC}[44m${ESC}[K`,
                { width: 8 }
            );
            assert.equal(rowText(c, 0), 'abc     ');
            assert.equal(rowText(c, 1), '    y   ');
            assert.equal(c.renderedRows, 3);
            assert.equal(c.getAttr(2, 7), `${ESC}[0;44m`); //  erased in the background
        });

        it('replaces MCI codes as art.display() does, and records them', function () {
            const c = AnsiCanvas.fromAnsi(`${ESC}[1;32m>%TL1<`);
            assert.equal(rowText(c, 0).slice(0, 7), '>    < ');
            assert.equal(c.getAttr(0, 1), `${ESC}[0;1;32m`);
            assert.deepEqual(c.mci, [{ mci: 'TL', id: 1, position: [1, 2] }]);
            const literal = AnsiCanvas.fromAnsi('%TL1', { mciReplaceChar: '' });
            assert.equal(rowText(literal, 0).slice(0, 4), '%TL1');
        });

        it('ESC[J erases from the cursor column on its row, then every row below', function () {
            const grid = 'xxxxx\r\nxxxxx\r\nxxxxx';
            const c = AnsiCanvas.fromAnsi(`${grid}${ESC}[44m${ESC}[2;3H${ESC}[J`, {
                width: 5,
            });
            assert.equal(rowText(c, 0), 'xxxxx');
            assert.equal(rowText(c, 1), 'xx   ');
            assert.equal(rowText(c, 2), '     ');
            assert.equal(c.getAttr(1, 1), DEFAULT_ATTR);
            assert.equal(c.getAttr(1, 2), `${ESC}[0;44m`);
        });

        it('ESC[1J erases every row above, then its row up to the cursor column', function () {
            const grid = 'xxxxx\r\nxxxxx\r\nxxxxx';
            const c = AnsiCanvas.fromAnsi(`${grid}${ESC}[2;3H${ESC}[1J`, { width: 5 });
            assert.equal(rowText(c, 0), '     ');
            assert.equal(rowText(c, 1), '   xx');
            assert.equal(rowText(c, 2), 'xxxxx');
            //  on the first row: still only up to the cursor
            const top = AnsiCanvas.fromAnsi(`${grid}${ESC}[1;3H${ESC}[1J`, { width: 5 });
            assert.equal(rowText(top, 0), '   xx');
            assert.equal(rowText(top, 1), 'xxxxx');
        });

        it('C0 controls (TAB, BEL, BS, ...) are drawn as spaces, with a warning', function () {
            const c = AnsiCanvas.fromAnsi('a\tb\x07c\x08d\x01e', { width: 12 });
            assert.equal(rowText(c, 0), 'a b c d e   ');
            assert.ok(
                c.warnings.some(w => w.startsWith('4 control character(s)')),
                c.warnings.join('; ')
            );
            //  so the diff writer sends none
            const out = AnsiDiff.render(AnsiDiff.transition(null, c));
            assert.equal(/[\x00-\x08\x0b-\x1a\x1c-\x1f]/.test(out), false);
            assert.deepEqual(AnsiCanvas.fromAnsi('abc').warnings, []);
        });

        it('256 colour and true colour SGR are skipped whole (no blink), with a warning', function () {
            const c = AnsiCanvas.fromAnsi(
                `${ESC}[1;34mA${ESC}[38;5;196mB${ESC}[48;5;4mC${ESC}[38;2;255;0;0mD`
            );
            const bright = `${ESC}[0;1;34m`;
            assert.deepEqual(
                [0, 1, 2, 3].map(col => c.getAttr(0, col)),
                [bright, bright, bright, bright]
            );
            assert.deepEqual(c.warnings, [
                'SGR 38;5, 48;5, 38;2 (256 colour / true colour) is not modelled ' +
                    'on a canvas; ignored',
            ]);
        });

        it('aixterm bright colours are warned about', function () {
            const c = AnsiCanvas.fromAnsi(`${ESC}[91mA${ESC}[104mB${ESC}[0;90mC`);
            assert.equal(c.getAttr(0, 0), DEFAULT_ATTR);
            assert.equal(c.getAttr(0, 1), DEFAULT_ATTR);
            assert.equal(c.getAttr(0, 2), `${ESC}[0;90m`);
            assert.deepEqual(c.warnings, [
                'SGR 91, 104 (aixterm bright colours) is not modelled on a canvas; ignored',
                'SGR 90 (aixterm grey) is kept in cells as given, but not every ' +
                    'terminal shows it',
            ]);
        });

        it('a fixed height drops what is below it and says so', function () {
            const c = AnsiCanvas.fromAnsi('a\r\nb\r\nc', { height: 2, width: 4 });
            assert.equal(c.height, 2);
            assert.equal(rowText(c, 1), 'b   ');
            assert.equal(c.truncated, true);
        });
    });

    describe('rows', function () {
        it('an exactly-full line ended with CRLF takes one row', function () {
            const full = 'A'.repeat(80);
            const c = AnsiCanvas.fromAnsi(`${full}\r\n${full}\r\nB\r\n`);
            assert.equal(c.renderedRows, 3);
            assert.equal(rowText(c, 2)[0], 'B');
            //  art.display()'s parser wraps at once: two rows per full line
            const immediate = AnsiCanvas.fromAnsi(`${full}\r\n${full}\r\nB\r\n`, {
                wrap: 'immediate',
            });
            assert.equal(immediate.renderedRows, 5);
        });

        it('a full line with no line break still wraps on the next character', function () {
            const c = AnsiCanvas.fromAnsi(`${'A'.repeat(10)}B`, { width: 10 });
            assert.equal(c.renderedRows, 2);
            assert.equal(rowText(c, 1)[0], 'B');
        });

        it('a trailing newline adds no row; blank lines in the middle count', function () {
            assert.equal(AnsiCanvas.fromAnsi('a\r\nb').renderedRows, 2);
            assert.equal(AnsiCanvas.fromAnsi('a\r\nb\r\n').renderedRows, 2);
            assert.equal(AnsiCanvas.fromAnsi('a\r\n\r\nb\r\n').renderedRows, 3);
            assert.equal(AnsiCanvas.fromAnsi('a\r\nb\r\n\r\n').renderedRows, 3);
        });

        it('0x1A ends the art: SAUCE after it draws nothing', function () {
            const c = AnsiCanvas.fromAnsi('a\r\nb\r\n\x1aSAUCE00 lots of text here');
            assert.equal(c.renderedRows, 2);
        });
    });

    describe('from a file', function () {
        it('SAUCE, a COMNT block, 0x1A and a trailing newline add no row; TInfo2 is ignored', async function () {
            const body = Buffer.from('one\r\ntwo\r\nthree\r\nfour\r\n', 'latin1');
            const path = writeTemp(
                'sheet.ans',
                Buffer.concat([
                    body,
                    sauceTrailer({
                        width: 20,
                        height: 25,
                        comments: [
                            'frames=2',
                            'a second line',
                            'a third',
                            'and a fourth',
                        ],
                        ice: true,
                    }),
                ])
            );
            const c = await fromFile(path);
            assert.equal(c.width, 20); //  TInfo1
            assert.equal(c.renderedRows, 4); //  not TInfo2 (25)
            assert.equal(c.height, 4);
            assert.equal(c.iceColors, true);
            assert.equal(rowText(c, 3).trim(), 'four');
        });

        it('decodes CP437', async function () {
            const path = writeTemp('cp.ans', Buffer.from([0xdb, 0xb0, 0x41]));
            const c = await fromFile(path);
            assert.equal(rowText(c, 0).slice(0, 3), '█░A');
        });
    });

    describe('parity with art.display()', function () {
        //  The wire bytes art.display() sends for |rel|, and the art as read
        function displayArt(rel) {
            const writes = [];
            const term = new ClientTerminal({
                writable: true,
                write(data, cb) {
                    writes.push(Buffer.from(data));
                    if (cb) {
                        cb(null);
                    }
                },
            });
            term.outputEncoding = 'cp437';
            term.termWidth = 80;
            term.termHeight = 500; //  no scrolling: the whole art is on "screen"
            const client = { term, log: quietLog };

            return new Promise((resolve, reject) => {
                art.getArtFromPath(
                    paths.join(ROOT, rel),
                    { readSauce: true },
                    (err, info) => {
                        if (err) {
                            return reject(err);
                        }
                        art.display(
                            client,
                            info.data,
                            { sauce: info.sauce },
                            (err, mciMap) => {
                                if (err) {
                                    return reject(err);
                                }
                                resolve({ info, mciMap, wire: Buffer.concat(writes) });
                            }
                        );
                    }
                );
            });
        }

        [
            'art/themes/luciano_blocktronics/MATRIX.ANS',
            'art/themes/luciano_blocktronics/MMENU.ANS',
            'art/themes/luciano_blocktronics/MSGEHDR.ANS',
            'art/general/WELCOME1.ANS',
            'art/general/NEWSCAN.ANS',
        ].forEach(rel => {
            it(`same cells as the terminal is sent: ${paths.basename(rel)}`, async function () {
                const { info, mciMap, wire } = await displayArt(rel);

                //  what the terminal is sent, drawn: MCI codes already blanks
                const sent = AnsiCanvas.fromAnsi(iconv.decode(wire, 'cp437'), {
                    wrap: 'immediate',
                    mciReplaceChar: '',
                    width: 80,
                });
                //  the art itself, drawn as a canvas
                const drawn = AnsiCanvas.fromAnsi(info.data, {
                    sauce: info.sauce,
                    wrap: 'immediate',
                });

                assert.equal(
                    drawn.iceColors,
                    Boolean(info.sauce && info.sauce.ansiFlags & 1)
                );
                assert.ok(drawn.renderedRows > 5, 'art has rows');
                assert.equal(drawn.renderedRows, sent.renderedRows);
                const width = Math.min(drawn.width, sent.width);
                assert.ok(
                    drawn
                        .crop({ width, height: drawn.height })
                        .equals(sent.crop({ width, height: drawn.height })),
                    'cells differ'
                );
                //  none of these has an exactly-full line with CRLF, so the
                //  default (deferred) wrap draws them the same
                assert.ok(
                    AnsiCanvas.fromAnsi(info.data, { sauce: info.sauce }).equals(drawn)
                );

                //  the MCI codes art.display() mapped are where the canvas saw them
                Object.values(mciMap).forEach(entry => {
                    if (!entry.code) {
                        return;
                    }
                    const seen = drawn.mci.find(
                        m =>
                            m.mci === entry.code &&
                            (m.id || 0) === (entry.id < 100 ? entry.id : m.id || 0) &&
                            m.position[0] === entry.position[0] &&
                            m.position[1] === entry.position[1]
                    );
                    assert.ok(seen, `MCI ${entry.code}${entry.id} at ${entry.position}`);
                });
            });
        });
    });

    describe('sheet slicing', function () {
        //  frames of 3 rows x 4 columns, frame i drawn with digit i
        function sheetOf(
            frameCount,
            { gap = 0, height = 3, width = 4, extra = '' } = {}
        ) {
            const lines = [];
            for (let f = 0; f < frameCount; ++f) {
                for (let r = 0; r < height; ++r) {
                    lines.push(`|0${f + 1}${String(f).repeat(width)}|07 side${f}${r}`);
                }
                if (f < frameCount - 1) {
                    for (let g = 0; g < gap; ++g) {
                        lines.push('----');
                    }
                }
            }
            return AnsiCanvas.fromPipe(lines.join('\n') + extra + '\n', { width: 20 });
        }

        it('cuts frame i from rows [i*H, (i+1)*H)', function () {
            const { frames, warnings } = sliceSheet(sheetOf(3), { width: 4, height: 3 });
            assert.deepEqual(warnings, []);
            assert.equal(frames.length, 3);
            frames.forEach((frame, i) => {
                assert.equal(frame.width, 4);
                assert.equal(frame.height, 3);
                for (let r = 0; r < 3; ++r) {
                    assert.equal(rowText(frame, r), String(i).repeat(4));
                }
                //  each frame's cells carry their whole SGR
                assert.equal(
                    frame.getAttr(0, 0),
                    AnsiCanvas.fromPipe(`|0${i + 1}x`).getAttr(0, 0)
                );
                assert.notEqual(frame.getAttr(0, 0), frames[(i + 1) % 3].getAttr(0, 0));
            });
        });

        it('takes a region origin (1-based) so sprites can sit side by side', function () {
            const { frames, warnings } = sliceSheet(sheetOf(2), {
                width: 5,
                height: 3,
                row: 1,
                col: 6,
            });
            assert.deepEqual(warnings, []);
            assert.equal(rowText(frames[0], 0), 'side0');
            assert.equal(rowText(frames[1], 2), 'side1');
        });

        it('skips gap rows between frames', function () {
            const { frames, warnings } = sliceSheet(sheetOf(3, { gap: 1 }), {
                width: 4,
                height: 3,
                gap: 1,
            });
            assert.deepEqual(warnings, []);
            assert.equal(frames.length, 3);
            assert.equal(rowText(frames[2], 0), '2222');
        });

        it('frameCount caps the frames; rows below them are ignored', function () {
            const sheet = sheetOf(3, { extra: '\nnotes for the artist' });
            const capped = sliceSheet(sheet, { width: 4, height: 3, frameCount: 2 });
            assert.equal(capped.frames.length, 2);
            assert.deepEqual(capped.warnings, []);

            //  frameCount equal to the whole frames there: a note row or two
            //  below them is not a partial frame
            const repro = sliceSheet(
                AnsiCanvas.fromAnsi(
                    'aa\r\naa\r\nbb\r\nbb\r\ncc\r\ncc\r\ndd\r\ndd\r\nnote'
                ),
                { width: 2, height: 2, frameCount: 4 }
            );
            assert.equal(repro.frames.length, 4);
            assert.deepEqual(repro.warnings, []);
            const oneNote = sliceSheet(sheetOf(3, { extra: '\nnote' }), {
                width: 4,
                height: 3,
                frameCount: 3,
            });
            assert.equal(oneNote.frames.length, 3);
            assert.deepEqual(oneNote.warnings, []);
            //  without frameCount, the same row is a partial frame
            assert.match(
                sliceSheet(sheetOf(3, { extra: '\nnote' }), { width: 4, height: 3 })
                    .warnings[0],
                /partial frame/
            );

            const short = sliceSheet(sheetOf(2), { width: 4, height: 3, frameCount: 5 });
            assert.equal(short.frames.length, 2);
            assert.match(short.warnings[0], /fewer than frameCount 5/);
        });

        it('drops a partial last frame with a warning', function () {
            const sheet = sheetOf(3, { extra: '\nonly one row' }); //  10 rows, H = 3
            const { frames, warnings } = sliceSheet(sheet, { width: 4, height: 3 });
            assert.equal(frames.length, 3);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /partial frame \(1 of 3 rows\) after 3 frame/);

            const tooShort = sliceSheet(AnsiCanvas.fromAnsi('a\r\nb'), {
                width: 4,
                height: 3,
            });
            assert.equal(tooShort.frames.length, 0);
            assert.match(tooShort.warnings[0], /partial frame \(2 of 3 rows\) after 0/);
        });

        it('counts frames from rendered rows: a trailing newline is not a short frame', function () {
            const sheet = sheetOf(2); //  ends with '\n'
            assert.equal(sheet.renderedRows, 6);
            assert.deepEqual(sliceSheet(sheet, { width: 4, height: 3 }).warnings, []);
        });

        it('80-column frames with CRLF line ends do not double space', function () {
            const line = d => `${ESC}[0;3${d}m${String(d).repeat(80)}\r\n`;
            const sheet = AnsiCanvas.fromAnsi(line(1) + line(1) + line(2) + line(2));
            const { frames, warnings } = sliceSheet(sheet, { width: 80, height: 2 });
            assert.deepEqual(warnings, []);
            assert.equal(frames.length, 2);
            assert.equal(rowText(frames[1], 1), '2'.repeat(80));
        });

        it('each frame starts from a clean SGR, not the state the sheet left', function () {
            //  the colour set in frame 0 runs on into frame 1 in the sheet
            const sheet = AnsiCanvas.fromAnsi(`${ESC}[1;31mab\r\ncd\r\n`, { width: 2 });
            const { frames } = sliceSheet(sheet, { width: 2, height: 1 });
            assert.equal(frames[1].getAttr(0, 0), `${ESC}[0;1;31m`);
            const plain = AnsiCanvas.fromAnsi(`${ESC}[1;31mab${ESC}[0m\r\ncd`, {
                width: 2,
            });
            assert.equal(
                sliceSheet(plain, { width: 2, height: 1 }).frames[1].getAttr(0, 0),
                DEFAULT_ATTR
            );
        });

        it('warns when the region runs past the sheet width, and clips', function () {
            const { frames, warnings } = sliceSheet(sheetOf(1), {
                width: 18,
                height: 3,
                col: 6,
            });
            assert.equal(frames.length, 1);
            assert.match(
                warnings[0],
                /columns 6-23\) extend past the sheet's 20 columns/
            );
            assert.equal(rowText(frames[0], 0), 'side00'.padEnd(18));
        });
    });

    describe('clipping', function () {
        it('crop() clips a larger canvas and pads a smaller one', function () {
            const c = AnsiCanvas.fromPipe('|04abcdef\nghijkl', { width: 6 });
            const clipped = c.crop({ row: 0, col: 1, width: 3, height: 1 });
            assert.equal(rowText(clipped, 0), 'bcd');
            assert.equal(clipped.getAttr(0, 0), `${ESC}[0;31m`);

            const padded = c.crop({ row: 1, col: 4, width: 4, height: 2 });
            assert.equal(rowText(padded, 0), 'kl  ');
            assert.equal(rowText(padded, 1), '    ');
            assert.equal(padded.getAttr(1, 0), DEFAULT_ATTR);
        });
    });

    describe('transparency', function () {
        it('masks cells transparent in every frame; partial ones are fill, with a warning', function () {
            const frames = [
                AnsiCanvas.fromPipe('|04~a~\n~bb', { width: 3 }),
                AnsiCanvas.fromPipe('|04~c~\n~d~', { width: 3 }),
            ];
            const { mask, warnings } = applyTransparency(frames, '~');
            assert.deepEqual([...mask], [1, 0, 1, 1, 0, 0]);
            assert.equal(warnings.length, 1);
            assert.match(
                warnings[0],
                /1 cell\(s\) transparent in only some frames.*row 2, column 3/
            );
            //  drawn as fill in the frame where it was transparent, attr kept
            assert.equal(frames[1].getChar(1, 2), ' ');
            assert.equal(frames[1].getAttr(1, 2), `${ESC}[0;31m`);
            assert.equal(frames[0].getChar(1, 2), 'b');
        });

        it('the caller picks the character; none picked means no mask', function () {
            const frames = [AnsiCanvas.fromPipe('#a', { width: 2 })];
            assert.deepEqual([...applyTransparency(frames, '#').mask], [1, 0]);
            assert.equal(applyTransparency(frames, null).mask, null);
        });
    });
});
