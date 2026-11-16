'use strict';

//
//  The string_util / color_codes measuring helpers measure pipe-coded text
//  the way pipeToAnsi() draws it (#1022). See also pipe_codes.test.js.
//

const { strict: assert } = require('assert');
const P = require('../core/pipe_codes.js');
const {
    renderStringLength,
    renderSubstr,
    renderTruncate,
    renderSplitPos,
    ansiRenderStringLength,
    pad,
    isFormattedLine,
    renderFirstChar,
} = require('../core/string_util.js');
const {
    pipeToAnsi,
    stripMciColorCodes,
    pipeStringLength,
} = require('../core/color_codes.js');
const { wordWrapText } = require('../core/word_wrap.js');
const stringFormat = require('../core/string_format.js');
const { resolveMci, KNOWN_MCI } = require('./helpers/pipe_mci_stub.js');

const ESC = '\x1b';

//  What a terminal shows: escapes dropped, ESC[nC as n spaces
function visible(s) {
    return pipeToAnsi(s)
        .replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat(parseInt(n, 10) || 0))
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

describe('pipe code measuring (#1022)', () => {
    let previous;
    before(() => {
        previous = P.setMciResolver(resolveMci, KNOWN_MCI);
    });
    after(() => {
        P.setMciResolver(previous.resolver, previous.knownMci);
    });

    describe('renderSubstr()', () => {
        it('starts at the right column after a pipe code', () => {
            assert.equal(visible(renderSubstr('abc|07defgh', 4, 3)), 'efg');
            assert.equal(visible(renderSubstr('|02No tasks|08.', 2, 7)), ' tasks.');
        });

        it('starts at the right column after an SGR', () => {
            const r = `${ESC}[1mab${ESC}[0mcdef`;
            assert.equal(renderSubstr(r, 3, 2), `${ESC}[1m${ESC}[0mde`);
        });

        it('keeps the leading codes', () => {
            assert.equal(renderSubstr('|15|16abcdef', 2, 2), '|15|16cd');
        });

        it('starts inside and beyond the first segment', () => {
            assert.equal(visible(renderSubstr('|07abc|08def', 1, 4)), 'bcde');
            assert.equal(visible(renderSubstr('|07abc|08def', 4, 2)), 'ef');
            assert.equal(visible(renderSubstr('|07abc', 5, 2)), '');
        });

        it('counts wide characters in columns', () => {
            assert.equal(visible(renderSubstr('|08[|15日本語|08]', 0, 4)), '[日');
            assert.equal(visible(renderSubstr('|08[|15日本語|08]', 1, 4)), '日本');
        });

        it('a literal pipe stays literal', () => {
            assert.equal(visible(renderSubstr('x||07y', 0, 3)), 'x|0');
            assert.equal(visible(renderSubstr('|0|01', 0, 1)), '|');
        });

        it('keeps a literal pipe in its source form unless it would start a code', () => {
            assert.equal(renderSubstr('a|bcd', 0, 3), 'a|b');
            assert.equal(renderSubstr('a||bcd', 0, 4), 'a||bc');
            assert.equal(renderSubstr('|', 0, 1), '|'); //  a fillChar
            //  "|CU" alone would read as a cursor code the input did not have
            assert.equal(renderSubstr('|CU0', 0, 3), '||CU');
        });

        it('without a length takes the rest', () => {
            assert.equal(visible(renderSubstr('|07abcdef', 2)), 'cdef');
        });
    });

    describe('renderStringLength()', () => {
        it('measures what pipeToAnsi() shows', () => {
            assert.equal(renderStringLength('a || b'), 5);
            assert.equal(renderStringLength('||07'), 3);
            assert.equal(renderStringLength('|ZZ'), 3);
            assert.equal(renderStringLength('|1A'), 3);
            assert.equal(renderStringLength('|15Name|07'), 4);
        });

        it('an MCI or cursor code is literal text without a client', () => {
            assert.equal(renderStringLength('|UN!'), 4);
            assert.equal(renderStringLength('|CF05x'), 6);
        });

        it('measures MCI values when given the client', () => {
            assert.equal(renderStringLength('|UN!', { client: {} }), 7);
            assert.equal(renderStringLength('|CF05x', { client: {} }), 6);
        });

        it('editor text: only |## codes are zero width', () => {
            const editor = { dialect: 'color' };
            assert.equal(renderStringLength('a||b', editor), 4);
            assert.equal(renderStringLength('||07', editor), 1);
            assert.equal(renderStringLength('|07|UN', editor), 3);
        });

        it('ansiRenderStringLength() ignores pipes', () => {
            assert.equal(ansiRenderStringLength(`|07a${ESC}[3Cb`), 8);
        });
    });

    describe('pad()', () => {
        it('pads to the columns the text takes', () => {
            for (const s of ['|15a||b||c|07', '|1A thing', '|15日本|07']) {
                assert.equal(renderStringLength(pad(s, 20, '.')), 20, s);
            }
        });

        it('pads a WFC-escaped string to the right width', () => {
            const out = pad('|15a||b||c|07', 20, '.');
            assert.equal(visible(out), 'a|b|c' + '.'.repeat(15));
        });
    });

    describe('already rendered text (views)', () => {
        it('a literal pipe is cut as text, never doubled', () => {
            const ANSI = { dialect: 'ansi' };
            assert.equal(renderSubstr('a | b', 0, 79, ANSI), 'a | b');
            assert.equal(renderSubstr(`${ESC}[1ma|07b`, 1, 3, ANSI), `${ESC}[1m|07`);
            assert.equal(
                renderTruncate('a | b c d e f', { length: 8, dialect: 'ansi' }),
                'a | b...'
            );
        });

        it('TextView keeps a literal pipe in its text', () => {
            const { TextView } = require('../core/text_view.js');
            const client = { term: { termWidth: 80, termHeight: 25, write() {} } };
            const view = new TextView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
                dimens: { width: 20 },
            });
            view.setText('Quit | Next', false);
            assert.equal(view.text, 'Quit | Next');
        });
    });

    describe('renderTruncate()', () => {
        it('compares widths, not lengths', () => {
            assert.equal(renderTruncate('|15abc|07', { length: 3 }), '|15abc|07');
            assert.equal(visible(renderTruncate('|15abcdefgh', { length: 6 })), 'abc...');
            assert.equal(
                visible(renderTruncate('日本語日本語', { length: 7 })),
                '日本...'
            );
        });
    });

    describe('renderSplitPos()', () => {
        it('skips codes; a literal pipe is a column', () => {
            assert.equal(renderSplitPos('|07abc', 2), 5);
            assert.equal(renderSplitPos('a||bc', 2), 3);
            assert.equal(renderSplitPos('|07abc', 2, false), 2);
        });

        it('editor text keeps the |##-only grammar', () => {
            assert.equal(renderSplitPos('||07ab', 2, { dialect: 'color' }), 5);
        });
    });

    describe('stripMciColorCodes() / pipeStringLength()', () => {
        it('drops what pipeToAnsi() consumes and keeps what it shows', () => {
            assert.equal(stripMciColorCodes('a || b'), 'a || b'); //  re-renderable
            assert.equal(stripMciColorCodes('|CF05x'), '     x');
            assert.equal(stripMciColorCodes('|ZZ top'), '|ZZ top');
            assert.equal(stripMciColorCodes('|1Ahello'), '|1Ahello');
            assert.equal(stripMciColorCodes('|07hi |UN there'), 'hi  there');
        });

        it('pipeStringLength() is the display width', () => {
            assert.equal(pipeStringLength('|15a||b'), 3);
        });
    });

    describe('stringFormat()', () => {
        it('pads and cuts pipe-coded values by columns', () => {
            assert.equal(stringFormat('{v:<8}|', { v: 'a||b' }), 'a||b     |');
            assert.equal(stringFormat('{v:.3}|', { v: '日本語' }), '日|');
        });

        it('leaves a literal pipe in a value as it is', () => {
            assert.equal(stringFormat('{a:<6}', { a: 'a|b' }), 'a|b   ');
            assert.equal(stringFormat('{a:.3}', { a: 'a|bcd' }), 'a|b');
        });
    });

    describe('wordWrapText() with pipeCodeSupport', () => {
        it('keeps "||" whole and does not read "||07" as a colour', () => {
            const { wrapped } = wordWrapText('x||07yyyy', {
                width: 3,
                pipeCodeSupport: true,
            });
            assert.deepEqual(wrapped, ['x||0', '7yy', 'yy']);
        });

        it('continuation lines carry the last real colour', () => {
            const { wrapped } = wordWrapText('|15aaa ||07 bbb', {
                width: 4,
                pipeCodeSupport: true,
            });
            assert.deepEqual(wrapped, ['|15aaa ', '|15||07 ', '|15bbb']);
        });
    });

    describe('isFormattedLine()', () => {
        it('measures with the message body grammar', () => {
            assert.equal(isFormattedLine('|07hello'), true);
            assert.equal(isFormattedLine('a||b'), false);
        });
    });

    describe('measured with the client the text is rendered with', () => {
        const CL = {};
        let saved;
        before(() => {
            saved = P.setMciResolver(
                (client, code) => ({ LO: '', UN: 'bryan' })[code],
                new Set(['LO', 'UN'])
            );
        });
        after(() => {
            P.setMciResolver(saved.resolver, saved.knownMci);
        });
        const drawn = s =>
            pipeToAnsi(s, CL)
                .replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat('' === n ? 1 : +n))
                .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

        it('stringFormat() pads by what MCI codes show for the client', () => {
            const opts = { client: CL };
            assert.equal(
                drawn(stringFormat('[{text:<10}]', { text: 'x |LO y' }, opts)),
                '[x  y      ]'
            );
            assert.equal(
                drawn(stringFormat('[{text:<10}]', { text: '|UN!' }, opts)),
                '[bryan!    ]'
            );
            //  without a client the code is drawn as typed, and measured so
            assert.equal(stringFormat('[{text:<6}]', { text: '|UN!' }), '[|UN!  ]');
        });

        it('wordWrapText() measures with the client', () => {
            const { wrapped } = wordWrapText('a |LO b c d e', {
                width: 8,
                pipeCodeSupport: true,
                client: CL,
            });
            //  |LO is empty for this client: wrapped as "a  b c d e" is
            assert.deepEqual(wrapped, ['a |LO b c ', 'd e']);
            assert.deepEqual(
                wordWrapText('a  b c d e', { width: 8, pipeCodeSupport: true }).wrapped,
                ['a  b c ', 'd e']
            );
        });
    });

    describe('colour codes after a cut', () => {
        it('are kept, so the colour state matches the end of the string', () => {
            assert.equal(
                renderTruncate('|15Hello |07world|00', { length: 8 }),
                '|15Hello...|07|00'
            );
            assert.equal(
                renderSubstr(`${ESC}[31mred${ESC}[0m text`, 0, 3, { dialect: 'ansi' }),
                `${ESC}[31mred${ESC}[0m`
            );
            //  only colours: no text, cursor or MCI codes
            assert.equal(renderSubstr('|15ab|07cd|CF05|UNx|00', 0, 1), '|15a|07|00');
            //  ...unless they would join the text before them into a code
            assert.equal(P.substr('U@0D D@X1F', 0, 4, { dialect: 'body' }), 'U@0D');
            assert.equal(renderSubstr('a|b|07', 0, 2), 'a|||07');
            //  renderTruncate(): the cut, the omission and the colours after it
            //  are escaped together, so a literal pipe stays literal
            assert.equal(
                renderTruncate('a|b|07cdefgh', { length: 2, omission: '' }),
                'a|||07'
            );
            assert.equal(
                P.truncate('ab|07cd|CF05|07ef', { length: 5, omission: '' }),
                'ab|07cd|||07'
            );
            assert.equal(
                renderTruncate('abcdefgh|07', { length: 4, omission: '|' }),
                'abc|||07'
            );
            //  a code in the omission keeps its meaning
            assert.equal(
                renderTruncate('abcdefgh|07', { length: 4, omission: '||' }),
                'abc|||07'
            );
            //  the body dialect has no escape: the colours are left out instead
            assert.equal(
                P.truncate('xxyyyy@X1F', { length: 5, omission: '@0D', dialect: 'body' }),
                'xx@0D'
            );
        });
    });

    describe('strip for text that is rendered again', () => {
        it('keeps a literal pipe a literal pipe', () => {
            assert.equal(stripMciColorCodes('x||07y'), 'x||07y');
            assert.equal(stripMciColorCodes('x|0|071'), 'x||01');
            assert.equal(visible(stripMciColorCodes('x|0|071')), 'x|01');
        });

        it('turns |CF## into at most as many spaces as the code is long', () => {
            assert.equal(stripMciColorCodes('|CF99x'), '     x');
            assert.equal(stripMciColorCodes('|CF5x'), '    x');
            assert.equal(P.strip('a |CF99 b', { dialect: 'body' }), 'a       b');
        });
    });

    describe('non-string input, as before', () => {
        it('measures 0, pads in full and truncates to nothing', () => {
            assert.equal(renderStringLength(5), 0);
            assert.equal(renderStringLength(null), 0);
            assert.equal(pad(5, 4, '.'), '5....');
            assert.equal(renderTruncate(5, { length: 3 }), '');
        });
    });

    describe('a cut through a cursor code', () => {
        //  without a client |CF05 is text and is cut as text; with one it is
        //  a cursor-forward, and the part in the window moves that far
        it('cuts the cells it shows, in both modes', () => {
            const CLIENT = { client: {} }; //  the stub resolver moves the cursor
            assert.equal(renderSubstr('|CF05abc', 1, 100), 'CF05abc');
            assert.equal(renderSubstr('|CF05abc', 0, 3), '||CF');
            assert.equal(visible(renderSubstr('|CF05abc', 0, 3)), '|CF');
            assert.equal(renderSubstr('ab|CF05cd', 3, 2), 'CF');
            assert.equal(renderSubstr('|CF05abc', 1, 100, CLIENT), `${ESC}[4Cabc`);
            assert.equal(renderSubstr('|CF05abc', 0, 3, CLIENT), `${ESC}[3C`);
            assert.equal(renderSubstr('ab|CF05cd', 3, 2, CLIENT), `${ESC}[2C`);
        });
    });

    describe('MCI codes measured with a client', () => {
        let calls;
        let saved;
        before(() => {
            saved = P.setMciResolver(
                (client, code) => ('RR' === code ? `rumor${++calls}` : undefined),
                new Set(['RR'])
            );
        });
        after(() => {
            P.setMciResolver(saved.resolver, saved.knownMci);
        });
        beforeEach(() => {
            calls = 0;
        });

        it('are resolved once per distinct code per measuring call', () => {
            const client = {};
            wordWrapText(Array(20).fill('|RR').join(' '), {
                width: 20,
                pipeCodeSupport: true,
                client,
            });
            assert.equal(calls, 1);
            calls = 0;
            stringFormat('{a:<10}', { a: '|RR' }, { client });
            assert.equal(calls, 1);
            calls = 0;
            renderStringLength('|RR|RR|RR', { client });
            assert.equal(calls, 1);
            calls = 0;
            renderTruncate('|RR|RR|RR|RR', { length: 8, client });
            assert.equal(calls, 1);
        });
    });

    describe('renderFirstChar()', () => {
        it('keeps a wide character and the codes in front of it', () => {
            assert.equal(renderFirstChar('日x'), '日');
            assert.equal(renderFirstChar('|08.'), '|08.');
            assert.equal(renderFirstChar(' '), ' ');
            assert.equal(renderFirstChar('ab'), 'a');
        });
    });
});
