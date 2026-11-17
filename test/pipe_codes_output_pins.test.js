'use strict';

//
//  What the output side produces, byte for byte: the ticker's plain text and
//  colour map, MRC's /rainbow line and protocol sanitisers, the console
//  banner, ansi_prep's FTN export continuation columns and word wrap's long
//  word split (pipe codes PR B, #1022).
//
//  A refactor must leave every pin as it is. A fix that changes what is
//  produced changes its own pins in the same commit, so the test diff is the
//  record of the change.
//
//  Terminal output is shown with ESC written as ^[ so a pin reads as text.
//

const { strict: assert } = require('assert');

const ESC = String.fromCharCode(27);
const show = s => String(s).split(ESC).join('^[');

function makeClient() {
    const writes = [];
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: s => writes.push(String(s)),
            rawWrite: s => writes.push(String(s)),
        },
        user: { username: 'Bryan', properties: {} },
        writes,
    };
}

describe('Pipe code output pins', function () {
    describe('ticker', function () {
        let TickerView;
        let saved;

        before(function () {
            ({ TickerView } = require('../core/ticker_view.js'));
            saved = {
                setInterval: global.setInterval,
                clearInterval: global.clearInterval,
            };
            global.setInterval = () => 1;
            global.clearInterval = () => {};
        });

        after(function () {
            global.setInterval = saved.setInterval;
            global.clearInterval = saved.clearInterval;
        });

        function makeTicker(text, effect = 'normal') {
            const client = makeClient();
            const view = new TickerView({
                client,
                id: 1,
                position: { row: 2, col: 3 },
                dimens: { width: 12, height: 1 },
                text,
                effect,
                motion: 'left',
            });
            return { view, client };
        }

        function parsed(text, effect) {
            const { view } = makeTicker(text, effect);
            return { plain: show(view._plainText), colors: view._charColors.map(show) };
        }

        function frame(text) {
            const { view, client } = makeTicker(text);
            client.writes.length = 0;
            view.redraw();
            return show(client.writes.join(''));
        }

        it('plain text has no colour map', function () {
            assert.deepEqual(parsed('plain text'), { plain: 'plain text', colors: [] });
        });

        it('colours that change mid-text map per character', function () {
            assert.deepEqual(parsed('|04He|07llo'), {
                plain: 'Hello',
                colors: ['^[[22;31m', '^[[22;31m', '^[[22;37m', '^[[22;37m', '^[[22;37m'],
            });
            assert.equal(
                frame('|04He|07llo'),
                '^[[2;3H^[[0;39;49m^[[0;39;49m^[[22;31mHe^[[22;37mllo^[[0;39;49m       ' +
                    '^[[0;39;49m^[[0;39;49m'
            );
        });

        //  Left/right scroll: the gap and the wrapped copy take their colours
        //  from their own source index (the wrapped copy used to fall back to
        //  the view colour, and in the gap the colours were read from the
        //  start of the text)
        it('a scrolled window keeps each colour as the text wraps', function () {
            const { view, client } = makeTicker('|04Hello');
            const V = '^[[0;39;49m';
            const R = '^[[22;31m';
            const frames = [];
            for (let n = 1; n <= 15; n++) {
                client.writes.length = 0;
                view._advanceMotion(); //  what each tick does
                view.redraw();
                if (n >= 4) {
                    frames.push(
                        show(client.writes.join('')).replace(`^[[2;3H${V}${V}`, '')
                    );
                }
            }
            assert.deepEqual(frames, [
                `${R}o${V}          ${R}H${V}${V}`,
                `${V}          ${R}He${V}${V}`,
                `${V}         ${R}Hel${V}${V}`,
                `${V}        ${R}Hell${V}${V}`,
                `${V}       ${R}Hello${V}${V}`,
                `${V}      ${R}Hello${V} ${V}${V}`,
                `${V}     ${R}Hello${V}  ${V}${V}`,
                `${V}    ${R}Hello${V}   ${V}${V}`,
                `${V}   ${R}Hello${V}    ${V}${V}`,
                `${V}  ${R}Hello${V}     ${V}${V}`,
                `${V} ${R}Hello${V}      ${V}${V}`,
                `${R}Hello${V}       ${V}${V}`,
            ]);
        });

        it('text before the first colour takes the view colour', function () {
            assert.deepEqual(parsed('ab|12cd'), {
                plain: 'abcd',
                colors: ['', '', '^[[1;31m', '^[[1;31m'],
            });
        });

        //  F5: the colour map is built whenever a colour was seen (the text
        //  used to scroll in the view colour)
        it('a colour that only leads the text', function () {
            const RED = '^[[22;31m';
            assert.deepEqual(parsed('|04Hello'), {
                plain: 'Hello',
                colors: [RED, RED, RED, RED, RED],
            });
            assert.equal(
                frame('|04Hello'),
                '^[[2;3H^[[0;39;49m^[[0;39;49m^[[22;31mHello^[[0;39;49m       ' +
                    '^[[0;39;49m^[[0;39;49m'
            );
        });

        //  changes in the Q4 commit: ESC[nC becomes n spaces, other escapes
        //  are dropped
        it('cursor codes rendered with a client', function () {
            assert.deepEqual(parsed('|12ab|CF03|10cd'), {
                plain: 'ab^[[3Ccd',
                colors: [
                    '^[[1;31m',
                    '^[[1;31m',
                    '^[[1;31m',
                    '^[[1;31m',
                    '^[[1;31m',
                    '^[[1;31m',
                    '^[[1;32m',
                    '^[[1;32m',
                ],
            });
            assert.deepEqual(parsed('AB|CF03CD'), { plain: 'AB^[[3CCD', colors: [] });
            assert.deepEqual(parsed('|12AB|CB02CD'), {
                plain: 'AB^[[2DCD',
                colors: Array(8).fill('^[[1;31m'),
            });
        });

        it('an ESC that is not a colour stays as text', function () {
            assert.deepEqual(parsed(`x${ESC}[?25my`), { plain: 'x^[[?25my', colors: [] });
            assert.deepEqual(parsed(`a${ESC}b`), { plain: 'a^[b', colors: [] });
        });

        it('a text style effect is applied to the plain text', function () {
            assert.deepEqual(parsed('|04he|07llo', 'upper'), {
                plain: 'HELLO',
                colors: ['^[[22;31m', '^[[22;31m', '^[[22;37m', '^[[22;37m', '^[[22;37m'],
            });
        });

        it('switching to a text style effect re-bakes the plain text', function () {
            const { view } = makeTicker('|04he|07llo|CF02!');
            view.setPropertyValue('effect', 'upper');
            assert.equal(show(view._plainText), 'HELLO^[[2C!');
        });
    });

    describe('MRC', function () {
        let mrcProto;
        let muxProto;

        before(function () {
            mrcProto = require('../core/mrc.js').getModule.prototype;
            muxProto = require('../core/servers/chat/mrc_multiplexer.js').getModule
                .prototype;
        });

        //  Math.random stepped so the colours are known: 1, 8, 15, 22, ...
        function rainbow(words) {
            const saved = Math.random;
            let n = 0;
            Math.random = () => ((n++ * 7) % 31) / 31;
            const out = [];
            try {
                mrcProto.processSlashCommand.call(
                    { processOutgoingMessage: m => out.push(m), sendServerMessage() {} },
                    `/rainbow ${words.join(' ')}`
                );
            } finally {
                Math.random = saved;
            }
            assert.equal(out.length, 1);
            return out[0];
        }

        const FOUR = 'abcd efgh ijkl mnop qrst uvwx yzab cdef ghij klmn opqr stuv'.split(
            ' '
        );

        it('a short /rainbow line is sent whole', function () {
            assert.equal(rainbow(['hi', 'there']), '|01hi|00 |08there|00 ');
        });

        //  changes in the F6 commit: the cut backs off to the code's start
        it('/rainbow cuts at 140 characters, inside a code', function () {
            const prefix =
                '|01abcd|00 |08efgh|00 |15ijkl|00 |22mnop|00 |29qrst|00 |05uvwx|00 ' +
                '|12yzab|00 |19cdef|00 |26ghij|00 |02klmn|00 |09opqr|00 |16stuv|00 ';

            let line = rainbow([...FOUR, 'wxyz']);
            assert.equal(line, `${prefix}|23wxyz|`);
            assert.equal(line.length, 140);

            line = rainbow(['abc', ...FOUR.slice(1), 'wxyz']);
            assert.equal(line, `${prefix.replace('abcd', 'abc')}|23wxyz|0`);

            line = rainbow([...FOUR.slice(0, 11), 'abcdefghij', 'wxyz']);
            assert.ok(line.endsWith('|16abcdefghij|00 |2'), line);
            assert.equal(line.length, 140);
        });

        function sent(fromRoom, toUser, toSite, toRoom) {
            const out = [];
            muxProto.sendToMrcServer.call(
                { boardName: 'BBS', sendRaw: m => out.push(m) },
                'me',
                fromRoom,
                toUser,
                toSite,
                toRoom,
                'hi'
            );
            return out[0];
        }

        it('names and rooms lose codes, spaces and characters outside 33-125', function () {
            assert.equal(
                sent('lobby', 'Bob|UN a~b', 'Site', 'room|ab_c'),
                'me~BBS~lobby~Bob_ab~Site~room_c~hi~'
            );
        });

        //  changes in the F6 commit: the sanitisers repeat until nothing changes
        it('one pass can join a new code', function () {
            assert.equal(
                sent('X|0|077', 'X|0|077', 'S|A|BCD', 'r|a|bcd'),
                'me~BBS~X|07~X|07~S|AD~r|ad~hi~'
            );
        });
    });

    describe('console banner', function () {
        let consoleStyle;

        before(function () {
            ({ consoleStyle } = require('../core/server_listen.js'));
        });

        it('|00-|15 render as foreground colours', function () {
            assert.equal(
                show(consoleStyle('|07a|10b|12c|15d|00e|08f', { isTTY: true })),
                '^[[22;37ma^[[1;32mb^[[1;31mc^[[1;37md^[[22;30me^[[1;30mf^[[0m'
            );
            assert.equal(consoleStyle('|07a|10b|12c|15d', { isTTY: false }), 'abcd');
        });

        //  changes in the banner commit: rendered through pipe_codes.js
        it('|16-|99', function () {
            assert.equal(show(consoleStyle('|16x|17y|40z', { isTTY: true })), 'xyz^[[0m');
            assert.equal(consoleStyle('|16x|17y|40z', { isTTY: false }), 'xyz');
        });

        it('a pipe that is not a colour stays', function () {
            assert.equal(
                show(consoleStyle('a||b|1|UN', { isTTY: true })),
                'a||b|1|UN^[[0m'
            );
            assert.equal(consoleStyle('a||07b', { isTTY: false }), 'a|b');
        });
    });

    describe('ansi_prep FTN export', function () {
        //  The continuation column is measured in the UI dialect, where '||'
        //  is one column; a Renegade-family receiver draws both pipes. Kept
        //  on purpose (export only, receivers differ): see ansi_prep.js.
        it('a long line with "||" continues at the UI-measured column', function (done) {
            const ansiPrep = require('../core/ansi_prep.js');
            let input = '';
            for (let i = 0; i < 6; i++) {
                input += `${ESC}[1;3${i}mword${i}||x `;
            }
            input += `${ESC}[0mtail||07 and more text here to make it long enough`;
            ansiPrep(
                input,
                { cols: 80, rows: 'auto', forceLineTerm: true, exportMode: true },
                (err, out) => {
                    assert.ifError(err);
                    const lines = show(out).split('\r\n');
                    assert.equal(
                        lines[0],
                        '^[[1;30mword0||x ^[[1;31mword1||x ^[[1;32mword2||x ^[[1;33mword3||x '
                    );
                    assert.ok(
                        lines[1].startsWith('^[[A^[[32C^[[1;34mword4||x '),
                        lines[1]
                    );
                    return done();
                }
            );
        });
    });

    describe('word wrap without pipe code support', function () {
        it('a long word splits around an escape, which stays whole', function () {
            const { wordWrapText } = require('../core/word_wrap.js');
            assert.deepEqual(
                wordWrapText(`aaaa${ESC}[2Sbbbbbbbbbb`, { width: 6 }).wrapped.map(show),
                ['aaaa^[[2Sb', 'bbbbbb', 'bbb']
            );
            assert.deepEqual(
                wordWrapText(`aaaa${ESC}[2Cbbbbbbbbbb`, { width: 6 }).wrapped.map(show),
                ['aaaa^[[2C', 'bbbbbb', 'bbbb']
            );
        });
    });
});
