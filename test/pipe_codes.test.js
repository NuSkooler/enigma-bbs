'use strict';

const { strict: assert } = require('assert');
const P = require('../core/pipe_codes.js');
const ANSI = require('../core/ansi_term.js');
const { charDisplayWidth } = require('../core/display_width.js');
const { renegadeToAnsi, controlCodesToAnsi } = require('../core/color_codes.js');
const { resolveMci, KNOWN_MCI } = require('./helpers/pipe_mci_stub.js');
const FIXTURES = require('./fixtures/pipe_codes/render.json');

const ESC = '\x1b';
const CLIENT = { client: {}, resolveMci };
const withClient = opts => Object.assign({}, opts, CLIENT);
const ANSI_ONLY = { dialect: 'ansi' };

//  What a terminal shows for rendered text: SGR and other escapes dropped,
//  ESC[nC as n spaces.
function visible(rendered) {
    let out = '';
    P.walk(rendered, ANSI_ONLY, (type, a, b, v) => {
        if (P.T.ANSI === type) {
            if ('C' === v.cmd) {
                out += ' '.repeat(parseInt(v.args, 10) || 0);
            }
            return;
        }
        out += rendered.slice(a, b);
    });
    return out;
}

const shows = (s, opts) => visible(P.render(s, opts));

//  mulberry32
function prng(seed) {
    return n => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) % n;
    };
}

describe('pipe_codes', () => {
    describe('frozen render fixtures (renderer output before the tokenizer)', () => {
        const expected = (row, client) => {
            const noClient = null === row[1] ? row[0] : row[1];
            return client ? (0 === row[2] ? noClient : row[2]) : noClient;
        };

        const mismatches = (rows, fn) =>
            rows
                .filter(row => fn(row[0], false) !== expected(row, false))
                .concat(rows.filter(row => fn(row[0], true) !== expected(row, true)))
                .map(row => row[0]);

        it('ui: render() reproduces renegadeToAnsi()', () => {
            const bad = mismatches(FIXTURES.ui, (s, c) =>
                P.render(s, c ? CLIENT : undefined)
            );
            assert.deepEqual(bad, []);
        });

        it('body: render(bodyLegacy) reproduces controlCodesToAnsi()', () => {
            const bad = mismatches(FIXTURES.body, (s, c) =>
                P.render(
                    s,
                    c ? withClient({ dialect: 'bodyLegacy' }) : { dialect: 'bodyLegacy' }
                )
            );
            assert.deepEqual(bad, []);
        });

        it('ui: renegadeToAnsi() without a client matches the fixtures', () => {
            const bad = FIXTURES.ui
                .filter(row => renegadeToAnsi(row[0]) !== expected(row, false))
                .map(row => row[0]);
            assert.deepEqual(bad, []);
        });

        it('body: controlCodesToAnsi() without a client matches the fixtures', () => {
            const bad = FIXTURES.body
                .filter(row => controlCodesToAnsi(row[0]) !== expected(row, false))
                .map(row => row[0]);
            assert.deepEqual(bad, []);
        });

        describe('with a client (the stub resolver injected)', () => {
            let previous;
            before(() => {
                previous = P.setMciResolver(resolveMci, KNOWN_MCI);
            });
            after(() => {
                P.setMciResolver(previous.resolver, previous.knownMci);
            });

            it('ui: renegadeToAnsi() matches the fixtures', () => {
                const bad = FIXTURES.ui
                    .filter(row => renegadeToAnsi(row[0], {}) !== expected(row, true))
                    .map(row => row[0]);
                assert.deepEqual(bad, []);
            });

            it('body: controlCodesToAnsi() matches the fixtures', () => {
                const bad = FIXTURES.body
                    .filter(row => controlCodesToAnsi(row[0], {}) !== expected(row, true))
                    .map(row => row[0]);
                assert.deepEqual(bad, []);
            });
        });
    });

    describe('grammar', () => {
        const types = (s, opts) => P.tokenize(s, opts).map(t => [t.type, t.raw]);
        const { TEXT, COLOR, MOVE, MCI, PIPE, ANSI: A, LEGACY } = P.T;

        it('ui: cursor, colour, MCI and the pipe escape, in that order', () => {
            assert.deepEqual(types('|CF123|07|UN||x'), [
                [MOVE, '|CF12'],
                [TEXT, '3'],
                [COLOR, '|07'],
                [MCI, '|UN'],
                [PIPE, '||'],
                [TEXT, 'x'],
            ]);
        });

        it('ui: malformed and lower case codes are text', () => {
            for (const s of [
                '|',
                '|1',
                '|Z9',
                '|C',
                '|1A',
                '|A1',
                '|un',
                '|cf05',
                'x|',
            ]) {
                assert.deepEqual(types(s), [[TEXT, s]], s);
            }
        });

        it('ui: |CF without digits is an MCI code', () => {
            assert.deepEqual(types('|CF'), [[MCI, '|CF']]);
        });

        it('body: no pipe escape, legacy families are codes', () => {
            assert.deepEqual(types('||07@X1F\x034\x19c1\x11z2}', { dialect: 'body' }), [
                [TEXT, '|'],
                [COLOR, '|07'],
                [LEGACY, '@X1F'],
                [LEGACY, '\x034'],
                [LEGACY, '\x19c1'],
                [LEGACY, '\x11z2}'],
            ]);
        });

        it('bodyLegacy: |1A is colour 1 and |A1 an MCI code', () => {
            assert.deepEqual(types('|1A|A1', { dialect: 'bodyLegacy' }), [
                [COLOR, '|1A'],
                [MCI, '|A1'],
            ]);
        });

        it('color: only |## codes', () => {
            assert.deepEqual(types('|07||UN|CF05', { dialect: 'color' }), [
                [COLOR, '|07'],
                [TEXT, '||UN|CF05'],
            ]);
        });

        it('ansi: pipes are text, escapes are codes', () => {
            assert.deepEqual(types(`|07${ESC}[1;32mx`, ANSI_ONLY), [
                [TEXT, '|07'],
                [A, `${ESC}[1;32m`],
                [TEXT, 'x'],
            ]);
        });

        it('colorCodeAt() sees complete |## codes only', () => {
            assert.equal(P.colorCodeAt('a|07', 1), 7);
            assert.equal(P.colorCodeAt('|99', 0), 99);
            assert.equal(P.colorCodeAt('|0', 0), -1);
            assert.equal(P.colorCodeAt('|UN', 0), -1);
            assert.equal(P.colorCodeAt('a|07', 0), -1);
        });

        it('rejects an unknown dialect', () => {
            assert.throws(
                () => P.width('x', { dialect: 'nope' }),
                /Unknown pipe code dialect/
            );
        });
    });

    describe('render()', () => {
        it('controlCodesToAnsi() hands back a non-string as it always has', () => {
            for (const v of [5, 0, true, null, undefined, '']) {
                assert.equal(controlCodesToAnsi(v), v);
            }
        });

        it('resolves MCI and cursor codes only with a client', () => {
            assert.equal(P.render('|UN!'), '|UN!');
            assert.equal(P.render('|UN!', CLIENT), 'UNUNUN!');
            assert.equal(P.render('|CF05x'), '|CF05x');
            assert.equal(P.render('|CF05x', CLIENT), `${ESC}[5Cx`);
        });

        it('does not re-read an MCI value', () => {
            assert.equal(P.render('|PV', CLIENT), 'a|07b');
        });

        it('body: a numeric MCI value is a colour, an empty one literal', () => {
            const body = withClient({ dialect: 'bodyLegacy' });
            assert.equal(P.render('|QQx', body), `${P.pipeColorSgr(7)}x`);
            assert.equal(P.render('|EMx', body), '|EMx');
        });

        describe('empty MCI values render as nothing (a user with no location)', () => {
            //  LO and UR empty, as userStatAsString(..., '') gives them
            const blank = (client, code) => ({ LO: '', UR: '', UN: 'Bob' })[code];
            const CASES = [
                ['|LO', ''],
                ['|LO rest', ' rest'],
                ['|LO|UR rest', ' rest'],
                ['Loc: |LO', 'Loc: '],
                ['|LO rest |UN', ' rest Bob'],
            ];

            it('render()', () => {
                for (const [s, want] of CASES) {
                    assert.equal(P.render(s, { client: {}, resolveMci: blank }), want, s);
                }
            });

            it('renegadeToAnsi()', () => {
                const previous = P.setMciResolver(blank);
                try {
                    for (const [s, want] of CASES) {
                        assert.equal(renegadeToAnsi(s, {}), want, s);
                    }
                } finally {
                    P.setMciResolver(previous.resolver, previous.knownMci);
                }
            });

            it('width() and renderWithWidth() agree with what shows', () => {
                const opts = { client: {}, resolveMci: blank };
                for (const [s, want] of CASES) {
                    assert.equal(P.width(s, opts), want.length, s);
                    assert.deepEqual(P.renderWithWidth(s, opts), {
                        text: want,
                        width: want.length,
                    });
                }
            });

            it('still shows the code without a client', () => {
                assert.equal(P.render('|LO rest'), '|LO rest');
            });
        });

        it('uses the injected resolver when none is passed', () => {
            const previous = P.setMciResolver(resolveMci, KNOWN_MCI);
            try {
                assert.equal(P.render('|UN', { client: {} }), 'UNUNUN');
            } finally {
                P.setMciResolver(previous.resolver, previous.knownMci);
            }
        });
    });

    describe('width()', () => {
        it('measures what render() shows', () => {
            assert.equal(P.width('a || b'), 5);
            assert.equal(P.width('||07'), 3);
            assert.equal(P.width('|15Name|07'), 4);
            assert.equal(P.width('|08[|15日本語|08]'), 8);
            assert.equal(P.width('|ZZ'), 3);
            assert.equal(P.width('|1A'), 3);
        });

        it('an MCI or cursor code measures its value with a client, its text without', () => {
            assert.equal(P.width('|UN!'), 4);
            assert.equal(P.width('|UN!', CLIENT), 7);
            assert.equal(P.width('|CF05x'), 6);
            assert.equal(P.width('|CF05x', CLIENT), 6);
            assert.equal(P.width('|CU05x', CLIENT), 1);
        });

        it('counts ESC[nC as n columns', () => {
            assert.equal(P.width(`a${ESC}[5Cb`), 7);
            assert.equal(P.width(`a${ESC}[5Cb`, ANSI_ONLY), 7);
            assert.equal(P.width(`${ESC}[0C`), 0);
        });

        it('ansi: pipes are literal text', () => {
            assert.equal(P.width('|07x', ANSI_ONLY), 4);
        });

        it('color: only |## codes are zero width', () => {
            assert.equal(P.width('|07a||b|UN', { dialect: 'color' }), 7);
            assert.equal(P.width('||07', { dialect: 'color' }), 1);
        });

        it('body: legacy codes are zero width', () => {
            assert.equal(P.width('@X1Fhi\x034!', { dialect: 'body' }), 3);
            assert.equal(P.width('a||b', { dialect: 'body' }), 4);
        });
    });

    describe('renderWithWidth()', () => {
        it('renders and measures in one pass', () => {
            assert.deepEqual(P.renderWithWidth('|15a||b|UN'), {
                text: `${P.pipeColorSgr(15)}a|b|UN`,
                width: 6,
            });
            assert.deepEqual(P.renderWithWidth('|CF03x', CLIENT), {
                text: `${ESC}[3Cx`,
                width: 4,
            });
            assert.deepEqual(P.renderWithWidth(''), { text: '', width: 0 });
        });
    });

    describe('substr() (#1022)', () => {
        it('starts at the right cell after a code', () => {
            assert.equal(shows(P.substr('abc|07defgh', 4, 3)), 'efg');
            assert.equal(shows(P.substr('|02No tasks|08.', 2, 7)), ' tasks.');
            assert.equal(shows(P.substr('|15ab|07cd', 1, 2)), 'bc');
        });

        it('keeps the colour in effect before the window', () => {
            const out = P.substr('|15abc|04def', 4, 2);
            assert.equal(out, '|15|04ef');
        });

        it('starts past the first segment', () => {
            assert.equal(shows(P.substr('|07ab|08cd|09ef', 5, 1)), 'f');
            assert.equal(shows(P.substr('|07ab', 5, 3)), '');
        });

        it('counts wide characters in cells', () => {
            assert.equal(shows(P.substr('|08[|15日本語|08]', 0, 4)), '[日');
            assert.equal(shows(P.substr('日本語', 1, 4)), ' 本');
            assert.equal(shows(P.substr('日本語', 0, 3)), '日');
        });

        it('keeps a literal pipe literal', () => {
            assert.equal(shows(P.substr('x||07y', 0, 3)), 'x|0');
        });

        it('does not form codes the input did not have', () => {
            for (const [s, a, n] of [
                ['|CUU1', 1, 3],
                ['|CU1x5', 0, 2],
                ['|0|01', 0, 1],
                ['|C|C|FN', 2, 4],
            ]) {
                for (const opts of [undefined, CLIENT]) {
                    const want = [...shows(s, opts)].slice(a, a + n).join('');
                    assert.equal(shows(P.substr(s, a, n, opts), opts), want, s);
                }
            }
        });

        it('cuts an MCI value or cursor move at the edges', () => {
            assert.equal(shows(P.substr('ab|UNcd', 3, 4, CLIENT), CLIENT), 'NUNU');
            assert.equal(shows(P.substr('a|CF05b', 2, 3, CLIENT), CLIENT), '   ');
        });

        it('ansi: slices rendered text', () => {
            const r = P.render('|15abc|07def');
            assert.equal(visible(P.substr(r, 2, 2, ANSI_ONLY)), 'cd');
        });
    });

    describe('truncate()', () => {
        it('compares widths, not lengths', () => {
            assert.equal(P.truncate('|15abc|07', { length: 3 }), '|15abc|07');
            assert.equal(shows(P.truncate('|15abcdef', { length: 5 })), 'ab...');
            assert.equal(shows(P.truncate('日本語日本語', { length: 7 })), '日本...');
        });
    });

    describe('splitPos()', () => {
        it('skips codes and stops at the cell count', () => {
            assert.equal(P.splitPos('|07abc', 2), 5);
            assert.equal(P.splitPos('a||b', 2), 3);
            assert.equal(P.splitPos('日本', 3), 1);
            assert.equal(P.splitPos(`a${ESC}[5Cb`, 3), 1);
        });

        it('splits literal codes like text', () => {
            assert.equal(P.splitPos('|UNx', 2), 2);
            assert.equal(P.splitPos('|UNx', 2, CLIENT), 0);
        });

        it('color: |## codes skipped, everything else text', () => {
            assert.equal(P.splitPos('||07ab', 2, { dialect: 'color' }), 5);
        });
    });

    describe('strip()', () => {
        it('drops what render() consumes and keeps what it shows', () => {
            const known = { knownMci: KNOWN_MCI };
            assert.equal(P.strip('a || b'), 'a | b');
            assert.equal(P.strip('|CF05x'), '     x');
            assert.equal(P.strip('|ZZ top', known), '|ZZ top');
            assert.equal(P.strip('|1Ahello'), '|1Ahello');
            assert.equal(P.strip('|07hi |UN there', known), 'hi  there');
        });

        it('body: keeps both pipes, drops legacy codes', () => {
            assert.equal(P.strip('a||b@X1Fc', { dialect: 'body' }), 'a||bc');
        });

        it('drops ANSI escapes on request', () => {
            assert.equal(P.strip(`|07a${ESC}[1mb`, { ansi: true }), 'ab');
        });
    });

    describe('properties (seeded)', () => {
        const CASES = 5000;
        const ALPHA = [
            '|',
            '|',
            '|',
            '0',
            '7',
            '1',
            '3',
            '9',
            'A',
            'U',
            'N',
            'C',
            'F',
            'B',
            'D',
            'x',
            ' ',
            'a',
            '@',
            'X',
            '1F',
            '|QQ',
            '日',
            '─',
            '½',
            'é',
            '\u{1F600}',
            '\ud800',
            '\n',
            '\x7f',
            '[',
            `${ESC}[5C`,
            `${ESC}[1;32m`,
            `${ESC}[0m`,
            `${ESC}[;5H`,
            `${ESC}[?25l`,
            `${ESC}(B`,
            `${ESC}[2J`,
            '5',
            ';',
            '\x034',
            '\x03',
            '\x19c3',
            '\x19n1',
            '\x11z2}',
            '\x11q1',
            '@X1F',
            '@1F@',
        ];
        const strings = (() => {
            const rnd = prng(777);
            const out = [];
            for (let k = 0; k < CASES; ++k) {
                let s = '';
                for (let j = 1 + rnd(12); j > 0; --j) {
                    s += ALPHA[rnd(ALPHA.length)];
                }
                out.push([s, rnd(5), 1 + rnd(8)]);
            }
            return out;
        })();

        const OPTS = {
            ui: undefined,
            uiClient: CLIENT,
            bodyClient: withClient({ dialect: 'body' }),
            bodyLegacyClient: withClient({ dialect: 'bodyLegacy' }),
        };

        it('width(s) equals the ANSI-only width of render(s)', () => {
            for (const [name, opts] of Object.entries(OPTS)) {
                const bad = strings.filter(
                    ([s]) => P.width(s, opts) !== P.width(P.render(s, opts), ANSI_ONLY)
                );
                assert.deepEqual(
                    bad.slice(0, 3).map(b => b[0]),
                    [],
                    name
                );
            }
        });

        it('renderWithWidth(s) equals render(s) and its width', () => {
            for (const [name, opts] of Object.entries(OPTS)) {
                const bad = strings.filter(([s]) => {
                    const text = P.render(s, opts);
                    const rw = P.renderWithWidth(s, opts);
                    return rw.text !== text || rw.width !== P.width(text, ANSI_ONLY);
                });
                assert.deepEqual(
                    bad.slice(0, 3).map(b => b[0]),
                    [],
                    name
                );
            }
        });

        it('width is additive at a token boundary', () => {
            const rnd = prng(4242);
            let checked = 0;
            for (const [s] of strings) {
                const toks = P.tokenize(s);
                if (toks.length < 2) {
                    continue;
                }
                const cut = toks
                    .slice(0, 1 + rnd(toks.length - 1))
                    .reduce((n, t) => n + t.raw.length, 0);
                const a = s.slice(0, cut);
                const b = s.slice(cut);
                const rejoin = P.tokenize(a).length + P.tokenize(b).length;
                if (rejoin !== toks.length && rejoin !== toks.length + 1) {
                    continue; //  the cut formed a new token
                }
                ++checked;
                assert.equal(P.width(s), P.width(a) + P.width(b), JSON.stringify(s));
            }
            assert.ok(checked > CASES / 2);
        });

        it('width(substr(s, a, n)) <= n', () => {
            for (const opts of [undefined, CLIENT]) {
                for (const [s, a, n] of strings) {
                    assert.ok(
                        P.width(P.substr(s, a, n, opts), opts) <= n,
                        JSON.stringify([s, a, n])
                    );
                }
            }
        });

        //  cells of rendered text as [char, width]; null when a zero-width
        //  or control character makes the window ill-defined
        function cells(rendered) {
            const out = [];
            let ok = true;
            P.walk(rendered, ANSI_ONLY, (type, a, b, v) => {
                if (P.T.ANSI === type) {
                    if ('C' === v.cmd) {
                        for (let k = parseInt(v.args, 10) || 0; k > 0; --k) {
                            out.push([' ', 1]);
                        }
                    }
                    return;
                }
                for (const ch of rendered.slice(a, b)) {
                    const w = charDisplayWidth(ch);
                    if (0 === w || /[\x00-\x1f\x7f]/.test(ch)) {
                        ok = false;
                    }
                    out.push([ch, w]);
                }
            });
            return ok ? out : null;
        }

        function window(cs, a, n) {
            let col = 0;
            let out = '';
            for (const [ch, w] of cs) {
                if (col + w > a + n) {
                    break;
                }
                if (col >= a) {
                    out += ch;
                } else if (col + w > a) {
                    out += ' ';
                }
                col += w;
            }
            return out;
        }

        it('render(substr(s, a, n)) shows cells a..a+n of render(s)', () => {
            let checked = 0;
            for (const opts of [undefined, CLIENT]) {
                for (const [s, a, n] of strings) {
                    const full = cells(P.render(s, opts));
                    if (!full) {
                        continue;
                    }
                    ++checked;
                    const got = cells(P.render(P.substr(s, a, n, opts), opts));
                    assert.equal(
                        got && got.map(c => c[0]).join(''),
                        window(full, a, n),
                        JSON.stringify([s, a, n, !!opts])
                    );
                }
            }
            assert.ok(checked > CASES / 2);
        });

        it('the hand ANSI scanner agrees with ANSI.getFullMatchRegExp()', () => {
            const re = new RegExp(ANSI.getFullMatchRegExp().source, 'y');
            const CS = [ESC, '[', '[', '0', '1', '5', '9', ';', ';', '?', '(', '#', 'm'];
            CS.push('C', 'H', 'x', 'z', '=', '>', 'J', 'P', 'Q', 'S', 'R', 'Z');
            const rnd = prng(99);
            for (let k = 0; k < CASES * 4; ++k) {
                let s = ESC;
                for (let j = 1 + rnd(9); j > 0; --j) {
                    s += CS[rnd(CS.length)];
                }
                re.lastIndex = 0;
                const m = re.exec(s);
                const want = m
                    ? [re.lastIndex, m[2], undefined === m[1] ? -1 : parseInt(m[1], 10)]
                    : null;
                assert.deepEqual(P.scanAnsiAt(s, 0), want, JSON.stringify(s));
            }
        });
    });
});
