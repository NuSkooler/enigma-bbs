'use strict';

const { View } = require('./view.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
const { wordWrapText } = require('./word_wrap.js');
const ansiPrep = require('./ansi_prep.js');

const assert = require('assert');
const _ = require('lodash');

//  :TODO: Determine CTRL-* keys for various things
//  See http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
//  http://wiki.synchro.net/howto:editor:slyedit#edit_mode
//  http://sublime-text-unofficial-documentation.readthedocs.org/en/latest/reference/keyboard_shortcuts_win.html

/* Mystic
     [^B]  Reformat Paragraph            [^O]  Show this help file
       [^I]  Insert tab space              [^Q]  Enter quote mode
       [^K]  Cut current line of text      [^V]  Toggle insert/overwrite
       [^U]  Paste previously cut text     [^Y]  Delete current line


                            BASIC MOVEMENT COMMANDS

                  UP/^E       LEFT/^S      PGUP/^R      HOME/^F
                DOWN/^X      RIGHT/^D      PGDN/^C       END/^G
*/

//
//  Some other interesting implementations, resources, etc.
//
//  Editors - BBS
//  *   https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//
//
//  Editors - Other
//  *   http://joe-editor.sourceforge.net/
//  *   http://www.jbox.dk/downloads/edit.c
//  *   https://github.com/dominictarr/hipster
//
//  Implementations - Word Wrap
//  *   https://github.com/protomouse/synchronet/blob/93b01c55b3102ebc3c4f4793c3a45b8c13d0dc2a/src/sbbs3/wordwrap.c
//
//  Misc notes
//  * https://github.com/dominictarr/hipster/issues/15 (Deleting lines/etc.)
//
//  Blessed
//      insertLine: CSR(top, bottom) + CUP(y, 0) + IL(1) + CSR(0, height)
//      deleteLine: CSR(top, bottom) + CUP(y, 0) + DL(1) + CSR(0, height)
//  Quick Ansi -- update only what was changed:
//  https://github.com/dominictarr/quickansi

//
//  To-Do
//
//  * Index pos % for emit scroll events
//  * Some of this should be async'd where there is lots of processing (e.g. word wrap)
//  * Fix backspace when col=0 (e.g. bs to prev line)
//  * Add word delete (CTRL+????)
//  *

const SPECIAL_KEY_MAP_DEFAULT = {
    'line feed': ['return'],
    exit: ['esc'],
    backspace: ['backspace', 'ctrl + d'], //  https://www.tecmint.com/linux-command-line-bash-shortcut-keys/
    delete: ['delete'],
    tab: ['tab'],
    up: ['up arrow'],
    down: ['down arrow'],
    end: ['end'],
    home: ['home'],
    left: ['left arrow'],
    right: ['right arrow'],
    'delete line': ['ctrl + y', 'ctrl + u'], //  https://en.wikipedia.org/wiki/Backspace
    'page up': ['page up'],
    'page down': ['page down'],
    insert: ['insert', 'ctrl + v'],
};

const HANDLED_SPECIAL_KEYS = [
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'page up',
    'page down',
    'line feed',
    'insert',
    'tab',
    'backspace',
    'delete',
    'delete line',
];

const PREVIEW_MODE_KEYS = ['up', 'down', 'page up', 'page down'];

class MultiLineEditTextView extends View {
    constructor(options) {
        if (!_.isBoolean(options.acceptsFocus)) {
            options.acceptsFocus = true;
        }

        options.acceptsInput = true;

        if (!_.isObject(options.specialKeyMap)) {
            options.specialKeyMap = SPECIAL_KEY_MAP_DEFAULT;
        }

        super(options);

        this.initDefaultWidth();

        //
        //  ANSI seems to want tabs to default to 8 characters. See the following:
        //  * http://www.ansi-bbs.org/ansi-bbs2/control_chars/
        //  * http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
        //
        //  This seems overkill though, so let's default to 4 :)
        //  :TODO: what shoudl this really be? Maybe 8 is OK
        //
        this.tabWidth = _.isNumber(options.tabWidth) ? options.tabWidth : 4;

        this.textLines = [];
        this.topVisibleIndex = 0;
        this.mode = options.mode || 'edit'; //  edit | preview | read-only
        this.maxLength = 0; // no max by default

        if ('preview' === this.mode) {
            this.autoScroll = options.autoScroll || true;
            this.tabSwitchesView = true;
        } else {
            this.autoScroll = options.autoScroll || false;
            this.tabSwitchesView = options.tabSwitchesView || false;
        }
        //
        //  cursorPos represents zero-based row, col positions
        //  within the editor itself
        //
        this.cursorPos = { col: 0, row: 0 };

        this.insertRawText(''); //  init to blank/empty
    }

    isEditMode() {
        return 'edit' === this.mode;
    }

    isPreviewMode() {
        return 'preview' === this.mode;
    }

    getTextSgrPrefix() {
        return this.hasFocus ? this.getFocusSGR() : this.getSGR();
    }

    //  :TODO: Most of the calls to this could be avoided via incrementRow(), decrementRow() that keeps track or such
    getTextLinesIndex(row) {
        if (!_.isNumber(row)) {
            row = this.cursorPos.row;
        }
        return this.topVisibleIndex + row;
    }

    getRemainingLinesBelowRow(row) {
        if (!_.isNumber(row)) {
            row = this.cursorPos.row;
        }
        return this.textLines.length - (this.topVisibleIndex + row) - 1;
    }

    getNextEndOfLineIndex(startIndex) {
        for (let i = startIndex; i < this.textLines.length; i++) {
            if (this.textLines[i].eol) {
                return i;
            }
        }
        return this.textLines.length;
    }

    toggleTextCursor(action) {
        this.client.term.rawWrite(
            `${this.getTextSgrPrefix()}${
                'hide' === action ? ansi.hideCursor() : ansi.showCursor()
            }`
        );
    }

    redrawRows(startRow, endRow) {
        this.toggleTextCursor('hide');

        const startIndex = this.getTextLinesIndex(startRow);
        const endIndex = Math.min(this.getTextLinesIndex(endRow), this.textLines.length);
        const absPos = this.getAbsolutePosition(startRow, 0);
        const prefix = this.getTextSgrPrefix();

        for (let i = startIndex; i < endIndex; ++i) {
            this.client.term.write(
                `${ansi.goto(absPos.row++, absPos.col)}${prefix}${this.getRenderText(i)}`,
                false //  convertLineFeeds
            );
        }

        this.toggleTextCursor('show');

        return absPos.row - this.position.row; //  row we ended on
    }

    eraseRows(startRow, endRow) {
        this.toggleTextCursor('hide');

        const absPos = this.getAbsolutePosition(startRow, 0);
        const absPosEnd = this.getAbsolutePosition(endRow, 0);
        const eraseFiller = ' '.repeat(this.dimens.width);

        while (absPos.row < absPosEnd.row) {
            this.client.term.write(
                `${ansi.goto(absPos.row++, absPos.col)}${eraseFiller}`,
                false //  convertLineFeeds
            );
        }

        this.toggleTextCursor('show');
    }

    redrawVisibleArea() {
        assert(this.topVisibleIndex <= this.textLines.length);
        const lastRow = this.redrawRows(0, this.dimens.height);

        this.eraseRows(lastRow, this.dimens.height);
    }

    getVisibleText(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.textLines[index].text.replace(/\t/g, ' ');
    }

    getText(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.textLines.length > index ? this.textLines[index].text : '';
    }

    getTextLength(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.textLines.length > index ? this.textLines[index].text.length : 0;
    }

    getCharacter(index, col) {
        if (!_.isNumber(col)) {
            col = this.cursorPos.col;
        }
        return this.getText(index).charAt(col);
    }

    isTab(index, col) {
        return '\t' === this.getCharacter(index, col);
    }

    getTextEndOfLineColumn(index) {
        return Math.max(0, this.getTextLength(index));
    }

    getRenderText(index) {
        let text = this.getVisibleText(index);

        const remain = this.dimens.width - strUtil.renderStringLength(text);

        if (remain > 0) {
            text += ' '.repeat(remain);
        }

        return text;
    }

    getTextLines(startIndex, endIndex) {
        if (startIndex === endIndex) {
            return [this.textLines[startIndex]];
        }
        return this.textLines.slice(startIndex, endIndex + 1); //  "slice extracts up to but not including end."
    }

    getOutputText(startIndex, endIndex, eolMarker, options) {
        const lines = this.getTextLines(startIndex, endIndex);
        const re = new RegExp('\\t{1,' + this.tabWidth + '}', 'g');

        return lines
            .map((line, lineIndex) => {
                let text = line.text.replace(re, '\t');
                if (
                    options.forceLineTerms ||
                    (eolMarker && line.eol && lineIndex < lines.length - 1)
                ) {
                    text += eolMarker;
                }
                return text;
            })
            .join('');
    }

    getContiguousText(startIndex, endIndex, includeEol) {
        const lines = this.getTextLines(startIndex, endIndex);
        let text = '';
        for (let i = 0; i < lines.length; ++i) {
            text += lines[i].text;
            if (includeEol && lines[i].eol) {
                text += '\n';
            }
        }
        return text;
    }

    getCharacterLength() {
        //  :TODO: FSE needs re-write anyway, but this should just be known all the time vs calc. Too much of a mess right now...
        let len = 0;
        this.textLines.forEach(tl => {
            len += tl.text.length;
        });
        return len;
    }

    replaceCharacterInText(c, index, col) {
        this.textLines[index].text = strUtil.replaceAt(this.textLines[index].text, col, c);
    }

    updateTextWordWrap(index) {
        const nextEolIndex = this.getNextEndOfLineIndex(index);
        const wrapped = this.wordWrapSingleLine(
            this.getContiguousText(index, nextEolIndex),
            'tabsIntact'
        );
        const newLines = wrapped.wrapped.map(l => {
            return { text: l };
        });

        newLines[newLines.length - 1].eol = true;

        Array.prototype.splice.apply(
            this.textLines,
            [index, nextEolIndex - index + 1].concat(newLines)
        );

        return wrapped.firstWrapRange;
    }

    removeCharactersFromText(index, col, operation, count) {
        if ('delete' === operation) {
            this.textLines[index].text =
                this.textLines[index].text.slice(0, col) +
                this.textLines[index].text.slice(col + count);

            this.updateTextWordWrap(index);
            this.redrawRows(this.cursorPos.row, this.dimens.height);
            this.moveClientCursorToCursorPos();
        } else if ('backspace' === operation) {
            //  :TODO: method for splicing text
            this.textLines[index].text =
                this.textLines[index].text.slice(0, col - (count - 1)) +
                this.textLines[index].text.slice(col + 1);

            this.cursorPos.col -= count - 1;

            this.updateTextWordWrap(index);
            this.redrawRows(this.cursorPos.row, this.dimens.height);

            this.moveClientCursorToCursorPos();
        } else if ('delete line' === operation) {
            //
            //  Delete a visible line. Note that this is *not* the "physical" line, or
            //  1:n entries up to eol! This is to keep consistency with home/end, and
            //  some other text editors such as nano. Sublime for example want to
            //  treat all of these things using the physical approach, but this seems
            //  a bit odd in this context.
            //
            const isLastLine = index === this.textLines.length - 1;
            const hadEol = this.textLines[index].eol;

            this.textLines.splice(index, 1);
            if (
                hadEol &&
                this.textLines.length > index &&
                !this.textLines[index].eol
            ) {
                this.textLines[index].eol = true;
            }

            //
            //  Create a empty edit buffer if necessary
            //  :TODO: Make this a method
            let isLastLineMut = isLastLine;
            if (this.textLines.length < 1) {
                this.textLines = [{ text: '', eol: true }];
                isLastLineMut = false; //  resetting
            }

            this.cursorPos.col = 0;

            const lastRow = this.redrawRows(this.cursorPos.row, this.dimens.height);
            this.eraseRows(lastRow, this.dimens.height);

            //
            //  If we just deleted the last line in the buffer, move up
            //
            if (isLastLineMut) {
                this.cursorEndOfPreviousLine();
            } else {
                this.moveClientCursorToCursorPos();
            }
        }
    }

    insertCharactersInText(c, index, col) {
        const prevTextLength = this.getTextLength(index);
        let editingEol = this.cursorPos.col === prevTextLength;

        this.textLines[index].text = [
            this.textLines[index].text.slice(0, col),
            c,
            this.textLines[index].text.slice(col),
        ].join('');

        this.cursorPos.col += c.length;

        if (this.getTextLength(index) > this.dimens.width) {
            //
            //  Update word wrapping and |cursorOffset| if the cursor
            //  was within the bounds of the wrapped text
            //
            let cursorOffset;
            const lastCol = this.cursorPos.col - c.length;
            const firstWrapRange = this.updateTextWordWrap(index);
            if (lastCol >= firstWrapRange.start && lastCol <= firstWrapRange.end) {
                cursorOffset = this.cursorPos.col - firstWrapRange.start;
                editingEol = true; //override
            } else {
                cursorOffset = firstWrapRange.end;
            }

            //  redraw from current row to end of visible area
            this.redrawRows(this.cursorPos.row, this.dimens.height);

            //  If we're editing mid, we're done here. Else, we need to
            //  move the cursor to the new editing position after a wrap
            if (editingEol) {
                this.cursorBeginOfNextLine();
                this.cursorPos.col += cursorOffset;
                this.client.term.rawWrite(ansi.right(cursorOffset));
            } else {
                //  adjust cursor after drawing new rows
                const absPos = this.getAbsolutePosition(
                    this.cursorPos.row,
                    this.cursorPos.col
                );
                this.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
            }
        } else {
            //
            //  We must only redraw from col -> end of current visible line
            //
            const absPos = this.getAbsolutePosition(this.cursorPos.row, this.cursorPos.col);
            const renderText = this.getRenderText(index).slice(this.cursorPos.col - c.length);

            this.client.term.write(
                `${ansi.hideCursor()}${this.getTextSgrPrefix()}${renderText}${ansi.goto(
                    absPos.row,
                    absPos.col
                )}${ansi.showCursor()}`,
                false //  convertLineFeeds
            );
        }
    }

    getRemainingTabWidth(col) {
        if (!_.isNumber(col)) {
            col = this.cursorPos.col;
        }
        return this.tabWidth - (col % this.tabWidth);
    }

    calculateTabStops() {
        this.tabStops = [0];
        let col = 0;
        while (col < this.dimens.width) {
            col += this.getRemainingTabWidth(col);
            this.tabStops.push(col);
        }
    }

    getNextTabStop(col) {
        let i = this.tabStops.length;
        while (this.tabStops[--i] > col);
        return this.tabStops[++i];
    }

    getPrevTabStop(col) {
        let i = this.tabStops.length;
        while (this.tabStops[--i] >= col);
        return this.tabStops[i];
    }

    expandTab(col, expandChar) {
        expandChar = expandChar || ' ';
        return new Array(this.getRemainingTabWidth(col)).join(expandChar);
    }

    wordWrapSingleLine(line, tabHandling = 'expand') {
        return wordWrapText(line, {
            width: this.dimens.width,
            tabHandling: tabHandling,
            tabWidth: this.tabWidth,
            tabChar: '\t',
        });
    }

    setTextLines(lines, index, termWithEol) {
        if (
            0 === index &&
            (0 === this.textLines.length ||
                (this.textLines.length === 1 && '' === this.textLines[0].text))
        ) {
            //  quick path: just set the things
            this.textLines = lines
                .slice(0, -1)
                .map(l => {
                    return { text: l };
                })
                .concat({ text: lines[lines.length - 1], eol: termWithEol });
        } else {
            //  insert somewhere in textLines...
            if (index > this.textLines.length) {
                //  fill with empty
                this.textLines.splice(
                    this.textLines.length,
                    0,
                    ...Array.from({ length: index - this.textLines.length }).map(() => {
                        return { text: '' };
                    })
                );
            }

            const newLines = lines
                .slice(0, -1)
                .map(l => {
                    return { text: l };
                })
                .concat({ text: lines[lines.length - 1], eol: termWithEol });

            this.textLines.splice(index, 0, ...newLines);
        }
    }

    setAnsiWithOptions(ansiText, options, cb) {
        const setLines = text => {
            text = strUtil.splitTextAtTerms(text);

            let index = 0;

            text.forEach(line => {
                this.setTextLines([line], index, true); //  true=termWithEol
                index += 1;
            });

            this.cursorStartOfDocument();

            if (cb) {
                return cb(null);
            }
        };

        if (options.prepped) {
            return setLines(ansiText);
        }

        ansiPrep(
            ansiText,
            {
                termWidth: options.termWidth || this.client.term.termWidth,
                termHeight: options.termHeight || this.client.term.termHeight,
                cols: this.dimens.width,
                rows: 'auto',
                startCol: this.position.col,
                forceLineTerm: options.forceLineTerm,
            },
            (err, preppedAnsi) => {
                return setLines(err ? ansiText : preppedAnsi);
            }
        );
    }

    insertRawText(text, index, col) {
        //
        //  Perform the following on |text|:
        //  *   Normalize various line feed formats -> \n
        //  *   Remove some control characters (e.g. \b)
        //  *   Word wrap lines such that they fit in the visible workspace.
        //      Each actual line will then take 1:n elements in textLines[].
        //  *   Each tab will be appropriately expanded and take 1:n \t
        //      characters. This allows us to know when we're in tab space
        //      when doing cursor movement/etc.
        //
        //
        //  Try to handle any possible newline that can be fed to us.
        //  See http://stackoverflow.com/questions/5034781/js-regex-to-split-by-line
        //
        //  :TODO: support index/col insertion point

        if (_.isNumber(index)) {
            if (_.isNumber(col)) {
                //
                //  Modify text to have information from index
                //  before and and after column
                //
                //  :TODO: Need to clean this string (e.g. collapse tabs)
                text = this.textLines;

                //  :TODO: Remove original line @ index
            }
        } else {
            index = this.textLines.length;
        }

        text = strUtil.splitTextAtTerms(text);

        let wrapped;
        text.forEach(line => {
            wrapped = this.wordWrapSingleLine(line, 'expand').wrapped;

            this.setTextLines(wrapped, index, true); //  true=termWithEol
            index += wrapped.length;
        });
    }

    getAbsolutePosition(row, col) {
        return {
            row: this.position.row + row,
            col: this.position.col + col,
        };
    }

    moveClientCursorToCursorPos() {
        const absPos = this.getAbsolutePosition(this.cursorPos.row, this.cursorPos.col);
        this.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
    }

    keyPressCharacter(c) {
        if (this.maxLength > 0 && this.getCharacterLength() + 1 >= this.maxLength) {
            return;
        }

        const index = this.getTextLinesIndex();

        //
        //  :TODO: stuff that needs to happen
        //  * Break up into smaller methods
        //  * Even in overtype mode, word wrapping must apply if past bounds
        //  * A lot of this can be used for backspacing also
        //  * See how Sublime treats tabs in *non* overtype mode... just overwrite them?
        //

        if (this.overtypeMode) {
            //  :TODO: special handing for insert over eol mark?
            this.replaceCharacterInText(c, index, this.cursorPos.col);
            this.cursorPos.col++;
            this.client.term.write(c);
        } else {
            this.insertCharactersInText(c, index, this.cursorPos.col);
        }

        this.emitEditPosition();
    }

    keyPressUp() {
        if (this.cursorPos.row > 0) {
            this.cursorPos.row--;
            this.client.term.rawWrite(ansi.up());

            if (!this.adjustCursorToNextTab('up')) {
                this.adjustCursorIfPastEndOfLine(false);
            }
        } else {
            this.scrollDocumentDown();
            this.adjustCursorIfPastEndOfLine(true);
        }

        this.emitEditPosition();
    }

    keyPressDown() {
        const lastVisibleRow =
            Math.min(this.dimens.height, this.textLines.length - this.topVisibleIndex) -
            1;

        if (this.cursorPos.row < lastVisibleRow) {
            this.cursorPos.row++;
            this.client.term.rawWrite(ansi.down());

            if (!this.adjustCursorToNextTab('down')) {
                this.adjustCursorIfPastEndOfLine(false);
            }
        } else {
            this.scrollDocumentUp();
            this.adjustCursorIfPastEndOfLine(true);
        }

        this.emitEditPosition();
    }

    keyPressLeft() {
        if (this.cursorPos.col > 0) {
            const prevCharIsTab = this.isTab();

            this.cursorPos.col--;
            this.client.term.rawWrite(ansi.left());

            if (prevCharIsTab) {
                this.adjustCursorToNextTab('left');
            }
        } else {
            this.cursorEndOfPreviousLine();
        }

        this.emitEditPosition();
    }

    keyPressRight() {
        const eolColumn = this.getTextEndOfLineColumn();
        if (this.cursorPos.col < eolColumn) {
            const prevCharIsTab = this.isTab();

            this.cursorPos.col++;
            this.client.term.rawWrite(ansi.right());

            if (prevCharIsTab) {
                this.adjustCursorToNextTab('right');
            }
        } else {
            this.cursorBeginOfNextLine();
        }

        this.emitEditPosition();
    }

    keyPressHome() {
        const firstNonWhitespace = this.getVisibleText().search(/\S/);
        if (-1 !== firstNonWhitespace) {
            this.cursorPos.col = firstNonWhitespace;
        } else {
            this.cursorPos.col = 0;
        }
        this.moveClientCursorToCursorPos();

        this.emitEditPosition();
    }

    keyPressEnd() {
        this.cursorPos.col = this.getTextEndOfLineColumn();
        this.moveClientCursorToCursorPos();
        this.emitEditPosition();
    }

    keyPressPageUp() {
        if (this.topVisibleIndex > 0) {
            this.topVisibleIndex = Math.max(
                0,
                this.topVisibleIndex - this.dimens.height
            );
            this.redraw();
            this.adjustCursorIfPastEndOfLine(true);
        } else {
            this.cursorPos.row = 0;
            this.moveClientCursorToCursorPos(); //  :TODO: ajust if eol, etc.
        }

        this.emitEditPosition();
    }

    keyPressPageDown() {
        const linesBelow = this.getRemainingLinesBelowRow();
        if (linesBelow > 0) {
            this.topVisibleIndex += Math.min(linesBelow, this.dimens.height);
            this.redraw();
            this.adjustCursorIfPastEndOfLine(true);
        }

        this.emitEditPosition();
    }

    keyPressLineFeed() {
        //
        //  Break up text from cursor position, redraw, and update cursor
        //  position to start of next line
        //
        const index = this.getTextLinesIndex();
        const nextEolIndex = this.getNextEndOfLineIndex(index);
        const text = this.getContiguousText(index, nextEolIndex);
        const newLines = this.wordWrapSingleLine(
            text.slice(this.cursorPos.col),
            'tabsIntact'
        ).wrapped;

        newLines.unshift({ text: text.slice(0, this.cursorPos.col), eol: true });
        for (let i = 1; i < newLines.length; ++i) {
            newLines[i] = { text: newLines[i] };
        }
        newLines[newLines.length - 1].eol = true;

        Array.prototype.splice.apply(
            this.textLines,
            [index, nextEolIndex - index + 1].concat(newLines)
        );

        //  redraw from current row to end of visible area
        this.redrawRows(this.cursorPos.row, this.dimens.height);
        this.cursorBeginOfNextLine();

        this.emitEditPosition();
    }

    keyPressInsert() {
        this.toggleTextEditMode();
    }

    keyPressTab() {
        const index = this.getTextLinesIndex();
        this.insertCharactersInText(
            this.expandTab(this.cursorPos.col, '\t') + '\t',
            index,
            this.cursorPos.col
        );

        this.emitEditPosition();
    }

    keyPressBackspace() {
        if (this.cursorPos.col >= 1) {
            //
            //  Don't want to delete character at cursor, but rather the character
            //  to the left of the cursor!
            //
            this.cursorPos.col -= 1;

            const index = this.getTextLinesIndex();
            let count;

            if (this.isTab()) {
                let col = this.cursorPos.col;
                const prevTabStop = this.getPrevTabStop(this.cursorPos.col);
                while (col >= prevTabStop) {
                    if (!this.isTab(index, col)) {
                        break;
                    }
                    --col;
                }

                count = this.cursorPos.col - col;
            } else {
                count = 1;
            }

            this.removeCharactersFromText(index, this.cursorPos.col, 'backspace', count);
        } else {
            //
            //  Delete character at end of line previous.
            //  * This may be a eol marker
            //  * Word wrapping will need re-applied
            //
            //  :TODO: apply word wrapping such that text can be re-adjusted if it can now fit on prev
            this.keyPressLeft(); //  same as hitting left - jump to previous line
        }

        this.emitEditPosition();
    }

    keyPressDelete() {
        const lineIndex = this.getTextLinesIndex();

        if (
            0 === this.cursorPos.col &&
            0 === this.textLines[lineIndex].text.length &&
            this.textLines.length > 0
        ) {
            //
            //  Start of line and nothing left. Just delete the line
            //
            this.removeCharactersFromText(lineIndex, 0, 'delete line');
        } else {
            this.removeCharactersFromText(lineIndex, this.cursorPos.col, 'delete', 1);
        }

        this.emitEditPosition();
    }

    keyPressDeleteLine() {
        if (this.textLines.length > 0) {
            this.removeCharactersFromText(this.getTextLinesIndex(), 0, 'delete line');
        }

        this.emitEditPosition();
    }

    adjustCursorIfPastEndOfLine(forceUpdate) {
        const eolColumn = this.getTextEndOfLineColumn();
        if (this.cursorPos.col > eolColumn) {
            this.cursorPos.col = eolColumn;
            forceUpdate = true;
        }

        if (forceUpdate) {
            this.moveClientCursorToCursorPos();
        }
    }

    adjustCursorToNextTab(direction) {
        if (this.isTab()) {
            let move;
            switch (direction) {
                //
                //  Next tabstop to the right
                //
                case 'right':
                    move = this.getNextTabStop(this.cursorPos.col) - this.cursorPos.col;
                    this.cursorPos.col += move;
                    this.client.term.rawWrite(ansi.right(move));
                    break;

                //
                //  Next tabstop to the left
                //
                case 'left':
                    move =
                        this.cursorPos.col - this.getPrevTabStop(this.cursorPos.col);
                    this.cursorPos.col -= move;
                    this.client.term.rawWrite(ansi.left(move));
                    break;

                case 'up':
                case 'down':
                    //
                    //  Jump to the tabstop nearest the cursor
                    //
                    {
                        const newCol = this.tabStops.reduce((prev, curr) => {
                            return Math.abs(curr - this.cursorPos.col) <
                                Math.abs(prev - this.cursorPos.col)
                                ? curr
                                : prev;
                        });

                        if (newCol > this.cursorPos.col) {
                            move = newCol - this.cursorPos.col;
                            this.cursorPos.col += move;
                            this.client.term.rawWrite(ansi.right(move));
                        } else if (newCol < this.cursorPos.col) {
                            move = this.cursorPos.col - newCol;
                            this.cursorPos.col -= move;
                            this.client.term.rawWrite(ansi.left(move));
                        }
                    }
                    break;
            }

            return true;
        }
        return false; //  did not fall on a tab
    }

    cursorStartOfDocument() {
        this.topVisibleIndex = 0;
        this.cursorPos = { row: 0, col: 0 };

        this.redraw();
        this.moveClientCursorToCursorPos();
    }

    cursorEndOfDocument() {
        this.topVisibleIndex = Math.max(this.textLines.length - this.dimens.height, 0);
        this.cursorPos.row = this.textLines.length - this.topVisibleIndex - 1;
        this.cursorPos.col = this.getTextEndOfLineColumn();

        this.redraw();
        this.moveClientCursorToCursorPos();
    }

    cursorBeginOfNextLine() {
        //  e.g. when scrolling right past eol
        const linesBelow = this.getRemainingLinesBelowRow();

        if (linesBelow > 0) {
            const lastVisibleRow =
                Math.min(this.dimens.height, this.textLines.length) - 1;
            if (this.cursorPos.row < lastVisibleRow) {
                this.cursorPos.row++;
            } else {
                this.scrollDocumentUp();
            }
            this.keyPressHome(); //  same as pressing 'home'
        }
    }

    cursorEndOfPreviousLine() {
        //  e.g. when scrolling left past start of line
        let moveToEnd;
        if (this.cursorPos.row > 0) {
            this.cursorPos.row--;
            moveToEnd = true;
        } else if (this.topVisibleIndex > 0) {
            this.scrollDocumentDown();
            moveToEnd = true;
        }

        if (moveToEnd) {
            this.keyPressEnd(); //  same as pressing 'end'
        }
    }

    scrollDocumentUp() {
        //
        //  Note: We scroll *up* when the cursor goes *down* beyond
        //  the visible area!
        //
        const linesBelow = this.getRemainingLinesBelowRow();
        if (linesBelow > 0) {
            this.topVisibleIndex++;
            this.redraw();
        }
    }

    scrollDocumentDown() {
        //
        //  Note: We scroll *down* when the cursor goes *up* beyond
        //  the visible area!
        //
        if (this.topVisibleIndex > 0) {
            this.topVisibleIndex--;
            this.redraw();
        }
    }

    emitEditPosition() {
        this.emit('edit position', this.getEditPosition());
    }

    toggleTextEditMode() {
        this.overtypeMode = !this.overtypeMode;
        this.emit('text edit mode', this.getTextEditMode());
    }

    setWidth(width) {
        super.setWidth(width);

        this.calculateTabStops();
    }

    redraw() {
        super.redraw();

        this.redrawVisibleArea();
    }

    setFocus(focused) {
        super.setFocus(focused);

        if (this.isEditMode() && this.getSGR() !== this.getFocusSGR()) {
            this.redrawVisibleArea();
        } else {
            this.client.term.rawWrite(this.getTextSgrPrefix());
        }
        this.moveClientCursorToCursorPos();
    }

    setText(text, options = { scrollMode: 'default' }) {
        this.textLines = [];
        this.addText(text, options);
    }

    setAnsi(ansiText, options = { prepped: false }, cb) {
        this.textLines = [];
        return this.setAnsiWithOptions(ansiText, options, cb);
    }

    addText(text, options = { scrollMode: 'default' }) {
        this.insertRawText(text);

        switch (options.scrollMode) {
            case 'default':
                if (this.isEditMode() || this.autoScroll) {
                    this.cursorEndOfDocument();
                } else {
                    this.cursorStartOfDocument();
                }
                break;

            case 'top':
            case 'start':
                this.cursorStartOfDocument();
                break;

            case 'end':
            case 'bottom':
                this.cursorEndOfDocument();
                break;
        }
    }

    getData(options = { forceLineTerms: false }) {
        return this.getOutputText(0, this.textLines.length, '\r\n', options);
    }

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'mode':
                this.mode = value;
                if ('preview' === value && !this.specialKeyMap.next) {
                    this.specialKeyMap.next = ['tab'];
                }
                break;

            case 'autoScroll':
                this.autoScroll = value;
                break;

            case 'tabSwitchesView':
                this.tabSwitchesView = value;
                this.specialKeyMap.next = this.specialKeyMap.next || [];
                this.specialKeyMap.next.push('tab');
                break;

            case 'maxLength':
                if (_.isNumber(value)) {
                    this.maxLength = value;
                }
                break;
        }

        super.setPropertyValue(propName, value);
    }

    onKeyPress(ch, key) {
        let handled;

        if (key) {
            HANDLED_SPECIAL_KEYS.forEach(specialKey => {
                if (this.isKeyMapped(specialKey, key.name)) {
                    if (
                        this.isPreviewMode() &&
                        -1 === PREVIEW_MODE_KEYS.indexOf(specialKey)
                    ) {
                        return;
                    }

                    if ('tab' !== key.name || !this.tabSwitchesView) {
                        this[_.camelCase('keyPress ' + specialKey)]();
                        handled = true;
                    }
                }
            });
        }

        if (this.isEditMode() && ch && strUtil.isPrintable(ch)) {
            this.keyPressCharacter(ch);
        }

        if (!handled) {
            super.onKeyPress(ch, key);
        }
    }

    scrollUp() {
        this.scrollDocumentUp();
    }

    scrollDown() {
        this.scrollDocumentDown();
    }

    deleteLine(line) {
        this.textLines.splice(line, 1);
    }

    getLineCount() {
        return this.textLines.length;
    }

    getTextEditMode() {
        return this.overtypeMode ? 'overtype' : 'insert';
    }

    getEditPosition() {
        const currentIndex = this.getTextLinesIndex() + 1;

        return {
            row: this.getTextLinesIndex(this.cursorPos.row),
            col: this.cursorPos.col,
            percent: Math.floor((currentIndex / this.textLines.length) * 100),
            below: this.getRemainingLinesBelowRow(),
        };
    }
}

exports.MultiLineEditTextView = MultiLineEditTextView;
