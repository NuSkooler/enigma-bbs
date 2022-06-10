/* jslint node: true */
'use strict';

//  ENiGMA½
const ANSIEscapeParser = require('./ansi_escape_parser.js').ANSIEscapeParser;
const ANSI = require('./ansi_term.js');
const { splitTextAtTerms, renderStringLength } = require('./string_util.js');

//  deps
const _ = require('lodash');

module.exports = function ansiPrep(input, options, cb) {
    if (!input) {
        return cb(null, '');
    }

    options.termWidth = options.termWidth || 80;
    options.termHeight = options.termHeight || 25;
    options.cols = options.cols || options.termWidth || 80;
    options.rows = options.rows || options.termHeight || 'auto';
    options.startCol = options.startCol || 1;
    options.exportMode = options.exportMode || false;
    options.fillLines = _.get(options, 'fillLines', true);
    options.indent = options.indent || 0;

    //  in auto we start out at 25 rows, but can always expand for more
    const canvas = Array.from(
        { length: 'auto' === options.rows ? 25 : options.rows },
        () => Array.from({ length: options.cols }, () => new Object())
    );
    const parser = new ANSIEscapeParser({
        termHeight: options.termHeight,
        termWidth: options.termWidth,
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

        canvas[row] = Array.from({ length: options.cols }, () => new Object());
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
                    canvas[state.row][state.col].sgr = _.clone(state.sgr);
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
            canvas[state.row][state.col].sgr = _.clone(sgr);
            state.lastSgr = canvas[state.row][state.col].sgr;
        } else {
            state.sgr = sgr;
        }
    });

    function getLastPopulatedColumn(row) {
        let col = row.length;
        while (--col > 0) {
            if (row[col].char || row[col].sgr) {
                break;
            }
        }
        return col;
    }

    parser.on('complete', () => {
        let output = '';
        let line;
        let sgr;

        canvas.slice(0, lastRow + 1).forEach(row => {
            const lastCol = getLastPopulatedColumn(row) + 1;

            let i;
            line = options.indent
                ? output.length > 0
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

            output += line;

            if (i < row.length) {
                output += `${options.asciiMode ? '' : ANSI.blackBG()}`;
                if (options.fillLines) {
                    output += `${row
                        .slice(i)
                        .map(() => ' ')
                        .join('')}`; //${lastSgr}`;
                }
            }

            if (options.startCol + i < options.termWidth || options.forceLineTerm) {
                output += '\r\n';
            }
        });

        if (options.exportMode) {
            //
            //  If we're in export mode, we do some additional hackery:
            //
            //  * Hard wrap ALL lines at <= 79 *characters* (not visible columns)
            //    if a line must wrap early, we'll place a ESC[A ESC[<N>C where <N>
            //    represents chars to get back to the position we were previously at
            //
            //  * Replace contig spaces with ESC[<N>C as well to save... space.
            //
            //  :TODO: this would be better to do as part of the processing above, but this will do for now
            const MAX_CHARS = 79 - 8; //  79 max, - 8 for max ESC seq's we may prefix a line with
            let exportOutput = '';

            let m;
            let afterSeq;
            let wantMore;
            let renderStart;

            splitTextAtTerms(output).forEach(fullLine => {
                renderStart = 0;

                while (fullLine.length > 0) {
                    let splitAt;
                    const ANSI_REGEXP = ANSI.getFullMatchRegExp();
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
