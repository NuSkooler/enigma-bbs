/* jslint node: true */
'use strict';

//  ENiGMA½
const ANSIEscapeParser = require('./ansi_escape_parser.js').ANSIEscapeParser;
const ANSI = require('./ansi_term.js');
const { splitTextAtTerms, renderStringLength } = require('./string_util.js');

module.exports = function ansiPrep(input, options, cb) {
    if (!input) {
        return cb(null, '');
    }

    options.termWidth  = options.termWidth  || 80;
    options.termHeight = options.termHeight || 25;
    options.cols       = options.cols || options.termWidth || 80;
    options.rows       = options.rows || options.termHeight || 'auto';
    options.startCol   = options.startCol || 1;
    options.exportMode = options.exportMode || false;
    options.fillLines  = options.fillLines ?? true;
    options.indent     = options.indent || 0;

    //  in auto we start out at 25 rows, but can always expand for more
    const canvas = Array.from(
        { length: 'auto' === options.rows ? 25 : options.rows },
        () => Array.from({ length: options.cols }, () => ({}))
    );
    //  When rows='auto' the canvas expands dynamically, so give the parser a
    //  very large termHeight to prevent it from capping/clamping the cursor row
    //  at the real terminal height.  All art past row termHeight would otherwise
    //  be collapsed onto the last visible row, producing a scrambled "mash" at
    //  the bottom of any art taller than the connected terminal window.
    const parserTermHeight =
        'auto' === options.rows ? 0x3fff : options.termHeight;

    const parser = new ANSIEscapeParser({
        termHeight: parserTermHeight,
        termWidth:  options.termWidth,
    });

    const state = {
        row: 0,
        col: 0,
    };

    let lastRow = 0;

    function ensureRow(row) {
        if (canvas[row]) {
            return;
        }

        canvas[row] = Array.from({ length: options.cols }, () => ({}));
    }

    parser.on('position update', (row, col) => {
        state.row = row - 1;
        state.col = col - 1;

        if (0 === state.col) {
            state.initialSgr = state.lastSgr;
        }

        lastRow = Math.max(state.row, lastRow);
    });

    parser.on('literal', literal => {
        //
        //  CR/LF are handled for 'position update'; we don't need the chars themselves
        //
        literal = literal.replace(/\r?\n|[\r\u2028\u2029]/g, '');

        for (let c of literal) {
            if (
                state.col < options.cols &&
                ('auto' === options.rows || state.row < options.rows)
            ) {
                ensureRow(state.row);

                if (0 === state.col) {
                    canvas[state.row][state.col].initialSgr = state.initialSgr;
                }

                canvas[state.row][state.col].char = c;

                if (state.sgr) {
                    canvas[state.row][state.col].sgr = { ...state.sgr };
                    state.lastSgr = canvas[state.row][state.col].sgr;
                    state.sgr = null;
                }
            }

            state.col += 1;
        }
    });

    parser.on('sgr update', sgr => {
        ensureRow(state.row);

        if (state.col < options.cols) {
            canvas[state.row][state.col].sgr = { ...sgr };
            state.lastSgr = canvas[state.row][state.col].sgr;
        } else {
            state.sgr = sgr;
            state.lastSgr = sgr; //  keep lastSgr current for next row's initialSgr
        }
    });

    function getLastPopulatedColumn(row) {
        let col = row.length;
        while (--col >= 0) {
            if (row[col].char || row[col].sgr) {
                return col;
            }
        }
        return -1; //  completely empty row
    }

    parser.on('complete', () => {
        const lines = [];
        let sgr;

        canvas.slice(0, lastRow + 1).forEach(row => {
            const lastCol = getLastPopulatedColumn(row) + 1;

            let i;
            let line = options.indent
                ? lines.length > 0
                    ? ' '.repeat(options.indent)
                    : ''
                : '';

            for (i = 0; i < lastCol; ++i) {
                const col = row[i];

                sgr =
                    !options.asciiMode && 0 === i
                        ? col.initialSgr
                            ? ANSI.getSGRFromGraphicRendition(col.initialSgr)
                            : ''
                        : '';

                if (!options.asciiMode && col.sgr) {
                    sgr += ANSI.getSGRFromGraphicRendition(col.sgr);
                }

                line += `${sgr}${col.char || ' '}`;
            }

            if (i < row.length) {
                line += options.asciiMode ? '' : ANSI.blackBG();
                if (options.fillLines) {
                    line += ' '.repeat(row.length - i);
                }
            }

            if (options.startCol + i < options.termWidth || options.forceLineTerm) {
                line += '\r\n';
            }

            lines.push(line);
        });

        const output = lines.join('');

        if (options.exportMode) {
            //
            //  Export mode post-processing:
            //
            //  * Hard-wrap ALL lines at <= 79 *characters* (not visible columns).
            //    When a line must wrap early, prefix the continuation with
            //    ESC[A ESC[<N>C to return to the correct render column.
            //
            //  * :TODO: Replace runs of spaces with ESC[<N>C to compress the output.
            //
            //  :TODO: Ideally this would be integrated into the canvas render loop
            //         above, but the current approach is correct and good enough.
            //
            const MAX_CHARS = 79 - 8; //  79 max, − 8 for the ESC sequences we may prefix
            let exportOutput = '';

            let m;
            let afterSeq;
            let wantMore;
            let renderStart;

            //  Compile the regexp once for the entire export pass.
            const ANSI_REGEXP = ANSI.getFullMatchRegExp();

            splitTextAtTerms(output).forEach(fullLine => {
                renderStart = 0;

                while (fullLine.length > 0) {
                    let splitAt;
                    ANSI_REGEXP.lastIndex = 0; //  reset for each slice of fullLine
                    wantMore = true;

                    while ((m = ANSI_REGEXP.exec(fullLine))) {
                        afterSeq = m.index + m[0].length;

                        if (afterSeq < MAX_CHARS) {
                            //  after current seq
                            splitAt = afterSeq;
                        } else {
                            if (m.index < MAX_CHARS) {
                                //  before last found seq
                                splitAt = m.index;
                                wantMore = false; //  can't eat up any more
                            }

                            break; //  seq's beyond this point are >= MAX_CHARS
                        }
                    }

                    if (splitAt) {
                        if (wantMore) {
                            splitAt = Math.min(fullLine.length, MAX_CHARS - 1);
                        }
                    } else {
                        splitAt = Math.min(fullLine.length, MAX_CHARS - 1);
                    }

                    const part = fullLine.slice(0, splitAt);
                    fullLine = fullLine.slice(splitAt);
                    renderStart += renderStringLength(part);
                    exportOutput += `${part}\r\n`;

                    if (fullLine.length > 0) {
                        //  more to go for this line?
                        exportOutput += `${ANSI.up()}${ANSI.right(renderStart)}`;
                    } else {
                        exportOutput += ANSI.up();
                    }
                }
            });

            return cb(null, exportOutput);
        }

        return cb(null, output);
    });

    parser.parse(input);
};
