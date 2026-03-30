'use strict';

const { strict: assert } = require('assert');

const ansiPrep = require('../core/ansi_prep.js');

// ─── Helper ───────────────────────────────────────────────────────────────────

//  Wrap callback-style ansiPrep in a Promise.
function prep(input, options = {}) {
    return new Promise((resolve, reject) => {
        ansiPrep(input, { ...options }, (err, out) =>
            err ? reject(err) : resolve(out)
        );
    });
}

//  Strip all ANSI escape sequences from a string (for text-only assertions).
function stripAnsi(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*[mGKHJABCDfhilnrstu]/g, '');
}

// ─── Basic behaviour ──────────────────────────────────────────────────────────

describe('ansiPrep', () => {
    describe('basic behaviour', () => {
        it('returns empty string for null input', async () => {
            assert.strictEqual(await prep(null), '');
        });

        it('returns empty string for empty string input', async () => {
            assert.strictEqual(await prep(''), '');
        });

        it('passes plain text through (asciiMode, no fill)', async () => {
            const out = await prep('Hello', {
                cols: 80,
                rows: 1,
                fillLines: false,
                asciiMode: true,
                forceLineTerm: true,
            });
            assert.strictEqual(out, 'Hello\r\n');
        });

        it('fillLines pads a short content row to cols width', async () => {
            const out = await prep('Hi', {
                cols: 5,
                rows: 1,
                fillLines: true,
                asciiMode: true,
                forceLineTerm: true,
            });
            //  'Hi' + 3 padding spaces + line term
            assert.strictEqual(out, 'Hi   \r\n');
        });

        it('multi-row output preserves row order', async () => {
            const out = await prep('foo\r\nbar\r\nbaz', {
                cols: 80,
                rows: 3,
                fillLines: false,
                asciiMode: true,
                forceLineTerm: true,
            });
            const lines = out.split('\r\n').filter(l => l.length > 0);
            assert.deepEqual(lines, ['foo', 'bar', 'baz']);
        });
    });

    // ─── Bug B1 — getLastPopulatedColumn col-0 check ──────────────────────────

    describe('B1 fix — empty rows produce no spurious space character', () => {
        it('blank line between two content rows emits only \\r\\n', async () => {
            //  Before the fix, getLastPopulatedColumn() returned 0 for an
            //  entirely empty row (loop condition `> 0` never tested col 0).
            //  The output loop then ran once and emitted a space character.
            //  After the fix it returns -1, the loop is skipped, and the blank
            //  row contributes only the line terminator.
            const out = await prep('Hi\r\n\r\nBye', {
                cols: 10,
                rows: 3,
                fillLines: false,
                asciiMode: true,
                forceLineTerm: true,
            });

            const lines = out.split('\r\n');
            //  lines[0] = 'Hi', lines[1] = blank row, lines[2] = 'Bye'
            assert.strictEqual(lines[0], 'Hi', 'row 0 content correct');
            assert.strictEqual(lines[1], '', 'blank row must be empty, not a space');
            assert.strictEqual(lines[2], 'Bye', 'row 2 content correct');
        });

        it('multiple consecutive blank rows each emit only \\r\\n', async () => {
            const out = await prep('A\r\n\r\n\r\nB', {
                cols: 10,
                rows: 4,
                fillLines: false,
                asciiMode: true,
                forceLineTerm: true,
            });
            const lines = out.split('\r\n');
            assert.strictEqual(lines[1], '', 'first blank row is empty');
            assert.strictEqual(lines[2], '', 'second blank row is empty');
        });
    });

    // ─── Bug B2 — state.lastSgr not updated for out-of-bounds SGR ─────────────

    describe('B2 fix — out-of-bounds SGR carries to subsequent rows', () => {
        //  B2 is subtle: when an SGR escape arrives at col >= cols, the deferred
        //  `state.sgr` path still delivers it to the first character of the next
        //  non-empty row.  The bug manifests when the row immediately following
        //  the out-of-bounds SGR is empty — `state.lastSgr` stays stale, so the
        //  row after that picks up the wrong `initialSgr` for its background fill.
        //
        //  The test below exercises this scenario (OOB SGR → empty row → content
        //  row) and checks that the content row's output begins with an escape
        //  sequence, confirming `initialSgr` was correctly propagated.

        it('content after OOB SGR + empty row starts with an SGR escape', async () => {
            //  cols=5: "AAAAA" fills cols 0-4; \x1b[7m arrives at col 5 (OOB).
            //  Row 1 is empty (no literals).  Row 2 has "B".
            //  With the B2 fix, state.lastSgr is updated for the OOB SGR, so
            //  state.initialSgr propagates through the empty row and canvas[2][0]
            //  gets a non-null initialSgr → output for row 2 starts with \x1b.
            const out = await prep('AAAAA\x1b[7m\r\n\r\nB', {
                cols: 5,
                rows: 3,
                fillLines: false,
                asciiMode: false,
                forceLineTerm: true,
            });

            const lines = out.split('\r\n');
            //  Row 2 should start with an escape sequence (initialSgr applied).
            assert.ok(lines[2].startsWith('\x1b'), 'row 2 starts with SGR escape');
        });
    });
});
