'use strict';

const { strict: assert } = require('assert');
const {
    controlCodesToAnsi,
    pipeColorToAnsi,
    pipeToAnsi,
} = require('../core/color_codes.js');

//
//  Helper: extract every SGR parameter list from an ANSI string.
//  Each ESC[p1;p2;...m sequence yields one entry — an array of numbers.
//
function sgrSequences(str) {
    const seqs = [];
    const re = /\x1b\[([^m]*)m/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        seqs.push(
            m[1]
                .split(';')
                .filter(s => s !== '')
                .map(Number)
        );
    }
    return seqs;
}

//  Flatten all SGR params from all sequences into one Set for easy membership tests.
function allSgrParams(str) {
    return new Set(sgrSequences(str).flat());
}

describe('color_codes', () => {
    describe('controlCodesToAnsi()', () => {
        it('passes through plain text unchanged', () => {
            assert.equal(controlCodesToAnsi('hello world'), 'hello world');
        });

        it('passes through empty string', () => {
            assert.equal(controlCodesToAnsi(''), '');
        });

        // ── Renegade |## pipe codes ───────────────────────────────────────────

        describe('Renegade |## pipe codes', () => {
            it('decodes a foreground color code', () => {
                const result = controlCodesToAnsi('|07hello');
                assert.ok(result.includes('\x1b['), 'should contain ANSI escape');
                assert.ok(result.includes('hello'), 'should preserve text');
            });

            it('decodes a background color code', () => {
                const result = controlCodesToAnsi('|16hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('passes through || as a literal pipe', () => {
                const result = controlCodesToAnsi('a||b');
                assert.ok(result.includes('|'));
            });

            it('handles partial/invalid code as literal', () => {
                const result = controlCodesToAnsi('no codes here');
                assert.equal(result, 'no codes here');
            });
        });

        // ── PCBoard @X## codes ────────────────────────────────────────────────

        describe('PCBoard @X## codes', () => {
            it('decodes a PCBoard color code', () => {
                const result = controlCodesToAnsi('@X07hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes PCBoard with bright background', () => {
                const result = controlCodesToAnsi('@XF0hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        // ── WildCat! @##@ codes ───────────────────────────────────────────────

        describe('WildCat! @##@ codes', () => {
            it('decodes a WildCat! color code', () => {
                const result = controlCodesToAnsi('@07@hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        // ── WWIV ^# codes ─────────────────────────────────────────────────────

        describe('WWIV ^# codes', () => {
            it('decodes WWIV color code 1 (bold cyan)', () => {
                const result = controlCodesToAnsi('\x031hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes WWIV color code 0 (black)', () => {
                const result = controlCodesToAnsi('\x030hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        // ── CNET Y-Style \x19 codes ───────────────────────────────────────────

        describe('CNET Y-Style \\x19 codes', () => {
            it('decodes CNET Y-Style foreground color', () => {
                const result = controlCodesToAnsi('\x19c7hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes CNET Y-Style background color', () => {
                const result = controlCodesToAnsi('\x19z0hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes CNET Y-Style newline (n1)', () => {
                const result = controlCodesToAnsi('\x19n1hello');
                assert.ok(result.includes('\n'));
            });
        });

        // ── CNET Q-Style \x11 codes ───────────────────────────────────────────

        describe('CNET Q-Style \\x11 codes', () => {
            it('decodes CNET Q-Style foreground color', () => {
                const result = controlCodesToAnsi('\x11c7}hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes CNET Q-Style background color', () => {
                const result = controlCodesToAnsi('\x11z0}hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        it('handles multiple mixed formats in one string', () => {
            const result = controlCodesToAnsi('|07hello @X0Fworld');
            assert.ok(result.includes('hello'));
            assert.ok(result.includes('world'));
            const escCount = (result.match(/\x1b\[/g) || []).length;
            assert.ok(escCount >= 2, `expected >= 2 escapes, got ${escCount}`);
        });
    });

    // ── pipeColorToAnsi — SGR parameter correctness (issue #555) ─────────────

    describe('pipeColorToAnsi — SGR parameter correctness', () => {
        //  Dark foreground codes (0–7) must use SGR 22 (normal intensity),
        //  NOT SGR 0 (full reset), so a previously set background survives.

        it('|00 (dark black) uses SGR 22, not SGR 0', () => {
            const params = allSgrParams(pipeColorToAnsi(0));
            assert.ok(params.has(22), 'SGR 22 (normal intensity) must be present');
            assert.ok(params.has(30), 'SGR 30 (black FG) must be present');
            assert.ok(!params.has(0), 'SGR 0 (full reset) must NOT be present');
        });

        it('|07 (dark white) uses SGR 22, not SGR 0', () => {
            const params = allSgrParams(pipeColorToAnsi(7));
            assert.ok(params.has(22), 'SGR 22 must be present');
            assert.ok(params.has(37), 'SGR 37 (white FG) must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT be present');
        });

        it('|01–|06 dark codes all use SGR 22, not SGR 0', () => {
            //  SGR values for blue/green/cyan/red/magenta/yellow = 34,32,36,31,35,33
            const expectedFG = [34, 32, 36, 31, 35, 33];
            for (let cc = 1; cc <= 6; cc++) {
                const params = allSgrParams(pipeColorToAnsi(cc));
                assert.ok(!params.has(0), `|0${cc}: SGR 0 must NOT be present`);
                assert.ok(params.has(22), `|0${cc}: SGR 22 must be present`);
                assert.ok(
                    params.has(expectedFG[cc - 1]),
                    `|0${cc}: FG SGR ${expectedFG[cc - 1]} must be present`
                );
            }
        });

        it('|08 (bright black) uses SGR 1 (bold), not SGR 0', () => {
            const params = allSgrParams(pipeColorToAnsi(8));
            assert.ok(params.has(1), 'SGR 1 (bold) must be present');
            assert.ok(params.has(30), 'SGR 30 (black FG) must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT be present');
        });

        it('|08–|15 bright codes all use SGR 1, not SGR 0', () => {
            for (let cc = 8; cc <= 15; cc++) {
                const params = allSgrParams(pipeColorToAnsi(cc));
                assert.ok(!params.has(0), `|${cc}: SGR 0 must NOT be present`);
                assert.ok(params.has(1), `|${cc}: SGR 1 (bold) must be present`);
            }
        });

        it('|16–|23 background codes emit no SGR 0', () => {
            for (let cc = 16; cc <= 23; cc++) {
                const params = allSgrParams(pipeColorToAnsi(cc));
                assert.ok(!params.has(0), `|${cc}: SGR 0 must NOT be present`);
            }
        });
    });

    // ── Issue #555 — background survives a dark foreground code ──────────────

    describe('issue #555 — background color survives dark foreground codes', () => {
        //  All three cases from the bug report, tested via pipeToAnsi.
        //  SGR 46 = cyan background, SGR 30 = black foreground, SGR 22 = normal intensity.

        it('|19|00: cyan background survives dark-black foreground', () => {
            //  |19 → ESC[46m  then  |00 → ESC[22;30m
            //  Background (46) must appear and must not be wiped by SGR 0.
            const result = pipeToAnsi('|19|00');
            const params = allSgrParams(result);
            assert.ok(params.has(46), 'SGR 46 (cyanBG) must be present');
            assert.ok(params.has(30), 'SGR 30 (black FG) must be present');
            assert.ok(
                !params.has(0),
                'SGR 0 (reset) must NOT appear — it would wipe the background'
            );
        });

        it('|00|19: dark-black then cyan background produces both attributes', () => {
            const result = pipeToAnsi('|00|19');
            const params = allSgrParams(result);
            assert.ok(params.has(30), 'SGR 30 (black FG) must be present');
            assert.ok(params.has(46), 'SGR 46 (cyanBG) must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT appear');
        });

        it('|00 alone: emits normal-intensity + black FG, not a full reset', () => {
            const result = pipeToAnsi('|00');
            const params = allSgrParams(result);
            assert.ok(params.has(22), 'SGR 22 (normal intensity) must be present');
            assert.ok(params.has(30), 'SGR 30 (black FG) must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT appear');
        });

        it('background set before any of |00–|07 is not reset', () => {
            //  All eight dark FG codes must leave a prior background intact.
            const bgCode = '|19'; // cyan background → SGR 46
            for (let cc = 0; cc <= 7; cc++) {
                const fgCode = `|${String(cc).padStart(2, '0')}`;
                const result = pipeToAnsi(`${bgCode}${fgCode}`);
                const params = allSgrParams(result);
                assert.ok(
                    params.has(46),
                    `${bgCode}${fgCode}: SGR 46 (cyanBG) must survive the dark FG code`
                );
                assert.ok(!params.has(0), `${bgCode}${fgCode}: SGR 0 must NOT appear`);
            }
        });

        it('bright foreground codes (|08–|15) also do not reset background', () => {
            const result = pipeToAnsi('|19|08');
            const params = allSgrParams(result);
            assert.ok(params.has(46), 'SGR 46 (cyanBG) must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT appear');
        });
    });

    // ── CNET dark FG codes: same fix applied ──────────────────────────────────

    describe('CNET dark foreground codes do not reset background (issue #555)', () => {
        //  CNET Y-Style: \x19c0–c7 are dark FG; \x19z0–z7 are backgrounds.
        //  \x19z6 = cyan background (SGR 46), \x19c0 = black FG.

        it('\\x19c0 (CNET dark black) uses SGR 22, not SGR 0', () => {
            const result = controlCodesToAnsi('\x19c0');
            const params = allSgrParams(result);
            assert.ok(params.has(22), 'SGR 22 must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT be present');
        });

        it('CNET cyan BG then dark-black FG: background survives', () => {
            //  \x19z6 = cyanBG (SGR 46), \x19c0 = dark black FG
            const result = controlCodesToAnsi('\x19z6\x19c0');
            const params = allSgrParams(result);
            assert.ok(params.has(46), 'SGR 46 (cyanBG) must survive the dark FG code');
            assert.ok(!params.has(0), 'SGR 0 must NOT appear');
        });

        it('CNET Q-Style dark FG also uses SGR 22, not SGR 0', () => {
            const result = controlCodesToAnsi('\x11c0}');
            const params = allSgrParams(result);
            assert.ok(params.has(22), 'SGR 22 must be present');
            assert.ok(!params.has(0), 'SGR 0 must NOT be present');
        });
    });
});
