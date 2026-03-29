'use strict';

const { View } = require('./view.js');
const { LineBuffer } = require('./line_buffer.js');
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
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
//  * Add word delete (CTRL+????)
//

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
        //  :TODO: what should this really be? Maybe 8 is OK
        //
        this.tabWidth = _.isNumber(options.tabWidth) ? options.tabWidth : 4;

        this.buffer = new LineBuffer({ width: this.dimens.width });
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
        return this.buffer.lines.length - (this.topVisibleIndex + row) - 1;
    }

    getNextEndOfLineIndex(startIndex) {
        for (let i = startIndex; i < this.buffer.lines.length; i++) {
            if (this.buffer.lines[i].eol) {
                return i;
            }
        }
        return this.buffer.lines.length;
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
        const endIndex = Math.min(this.getTextLinesIndex(endRow), this.buffer.lines.length);
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
        assert(this.topVisibleIndex <= this.buffer.lines.length);
        const lastRow = this.redrawRows(0, this.dimens.height);

        this.eraseRows(lastRow, this.dimens.height);
    }

    getVisibleText(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.buffer.lines.length > index
            ? this.buffer.lines[index].chars.replace(/\t/g, ' ')
            : '';
    }

    getText(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.buffer.lines.length > index ? this.buffer.lines[index].chars : '';
    }

    getTextLength(index) {
        if (!_.isNumber(index)) {
            index = this.getTextLinesIndex();
        }
        return this.buffer.lines.length > index ? this.buffer.lines[index].chars.length : 0;
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

    //  Compatibility shim — returns raw buffer lines (shape: { chars, attrs, eol })
    getTextLines(startIndex, endIndex) {
        if (startIndex === endIndex) {
            return [this.buffer.lines[startIndex]];
        }
        return this.buffer.lines.slice(startIndex, endIndex + 1);
    }

    getCharacterLength() {
        return this.buffer.lines.reduce((sum, l) => sum + l.chars.length, 0);
    }

    replaceCharacterInText(c, index, col) {
        //  At end of line there is no character to overwrite — just append
        if (col < this.buffer.lines[index].chars.length) {
            this.buffer.deleteChar(index, col);
        }
        this.buffer.insertChar(index, col, c);
    }

    //  Returns the absolute character offset of (lineIndex, col) within its
    //  paragraph, treating soft-wrapped lines as continuous (space reinserted
    //  at each soft-wrap join point).
    _paragraphOffset(lineIndex, col) {
        const { start } = this.buffer._paragraphRange(lineIndex);
        let offset = col;
        for (let i = start; i < lineIndex; i++) {
            offset += this.buffer.lines[i].chars.length + 1; //  +1 for soft-wrap space
        }
        return offset;
    }

    //  Maps an absolute paragraph offset back to { lineIndex, col } after a
    //  rewrapParagraph call.  paragraphStart is the start index returned by
    //  rewrapParagraph (same as _paragraphRange.start, which is stable).
    _offsetToLineCol(paragraphStart, offset) {
        let i = paragraphStart;
        while (i < this.buffer.lines.length) {
            const len = this.buffer.lines[i].chars.length;
            if (offset <= len || this.buffer.lines[i].eol) {
                return { lineIndex: i, col: Math.min(offset, len) };
            }
            offset -= len + 1; //  +1 for soft-wrap space
            i++;
        }
        const last = Math.max(paragraphStart, i - 1);
        return { lineIndex: last, col: this.buffer.lines[last]?.chars.length ?? 0 };
    }

    insertCharactersInText(c, index, col) {
        const prevTextLength = this.getTextLength(index);
        let editingEol = this.cursorPos.col === prevTextLength;

        //  Insert each character
        for (let i = 0; i < c.length; i++) {
            this.buffer.insertChar(index, col + i, c[i]);
        }
        this.cursorPos.col += c.length;

        if (this.buffer.lines[index].chars.length > this.buffer.width) {
            //  Track cursor position in paragraph coordinates before rewrap
            const paragraphOffset = this._paragraphOffset(index, this.cursorPos.col);
            const { start } = this.buffer.rewrapParagraph(index);

            //  Map cursor back to new line/col after rewrap
            const { lineIndex: newLineIndex, col: newCol } =
                this._offsetToLineCol(start, paragraphOffset);

            //  Redraw from current row to end of visible area
            this.redrawRows(this.cursorPos.row, this.dimens.height);

            if (newLineIndex !== index) {
                //  Cursor moved to the next visual line after wrap
                this.cursorBeginOfNextLine();
                this.cursorPos.col = newCol;
                if (newCol > 0) {
                    this.client.term.rawWrite(ansi.right(newCol));
                }
            } else {
                this.cursorPos.col = newCol;
                this.moveClientCursorToCursorPos();
            }
        } else {
            //
            //  No wrap needed — redraw from col → end of current visible line only
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

    removeCharactersFromText(index, col, operation, count) {
        if ('delete' === operation) {
            if (col >= this.buffer.lines[index].chars.length) {
                return; //  nothing to delete at or past end of line
            }
            this.buffer.deleteChar(index, col);
            this.buffer.rewrapParagraph(index);
            this.redrawRows(this.cursorPos.row, this.dimens.height);
            this.moveClientCursorToCursorPos();
        } else if ('backspace' === operation) {
            //  Remove `count` chars starting at col - (count - 1).
            //  cursorPos.col was already decremented by 1 in keyPressBackspace,
            //  so `col` here is the position of the first char to delete.
            const startCol = col - (count - 1);
            for (let i = 0; i < count; i++) {
                this.buffer.deleteChar(index, startCol);
            }
            this.cursorPos.col -= count - 1;

            this.buffer.rewrapParagraph(index);
            this.redrawRows(this.cursorPos.row, this.dimens.height);
            this.moveClientCursorToCursorPos();
        } else if ('delete line' === operation) {
            //
            //  Delete a visible line. Note that this is *not* the "physical" line, or
            //  1:n entries up to eol! This is to keep consistency with home/end, and
            //  some other text editors such as nano. Sublime for example wants to
            //  treat all of these things using the physical approach, but this seems
            //  a bit odd in this context.
            //
            const isLastLine = index === this.buffer.lines.length - 1;
            const hadEol = this.buffer.lines[index].eol;

            this.buffer.lines.splice(index, 1);
            if (
                hadEol &&
                this.buffer.lines.length > index &&
                !this.buffer.lines[index].eol
            ) {
                this.buffer.lines[index].eol = true;
            }

            //
            //  Ensure a non-empty edit buffer
            //
            let isLastLineMut = isLastLine;
            if (this.buffer.lines.length < 1) {
                this.buffer.lines = [
                    { chars: '', attrs: new Uint32Array(0), eol: true, initialAttr: 0 },
                ];
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
            //  :TODO: special handling for insert over eol mark?
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
            Math.min(this.dimens.height, this.buffer.lines.length - this.topVisibleIndex) -
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
            this.moveClientCursorToCursorPos(); //  :TODO: adjust if eol, etc.
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
        //  Split at cursor position — LineBuffer creates a hard break here
        //  and handles the right-hand fragment.  Both resulting lines fit
        //  within width so no rewrap is needed.
        //
        const index = this.getTextLinesIndex();
        this.buffer.splitLine(index, this.cursorPos.col);

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
            this.keyPressLeft(); //  same as hitting left - jump to previous line
        }

        this.emitEditPosition();
    }

    keyPressDelete() {
        const lineIndex = this.getTextLinesIndex();
        const lineLen   = this.buffer.lines[lineIndex].chars.length;

        if (0 === this.cursorPos.col && lineLen === 0 && this.buffer.lines.length > 0) {
            //
            //  Empty line — delete it
            //
            this.removeCharactersFromText(lineIndex, 0, 'delete line');
        } else if (this.cursorPos.col >= lineLen) {
            //
            //  Cursor is at end of line — forward-delete the line break by joining
            //  with the next line (standard editor behaviour for Delete at EOL).
            //  Only join across a hard break; soft-wrap boundaries are transparent.
            //
            if (
                lineIndex < this.buffer.lines.length - 1 &&
                this.buffer.lines[lineIndex].eol
            ) {
                this.buffer.joinLines(lineIndex);
                this.buffer.rewrapParagraph(lineIndex);
                const lastRow = this.redrawRows(this.cursorPos.row, this.dimens.height);
                this.eraseRows(lastRow, this.dimens.height);
                this.moveClientCursorToCursorPos();
            }
            //  else: at end of last line — nothing to delete
        } else {
            this.removeCharactersFromText(lineIndex, this.cursorPos.col, 'delete', 1);
        }

        this.emitEditPosition();
    }

    keyPressDeleteLine() {
        if (this.buffer.lines.length > 0) {
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
        this.topVisibleIndex = Math.max(this.buffer.lines.length - this.dimens.height, 0);
        this.cursorPos.row = this.buffer.lines.length - this.topVisibleIndex - 1;
        this.cursorPos.col = this.getTextEndOfLineColumn();

        this.redraw();
        this.moveClientCursorToCursorPos();
    }

    cursorBeginOfNextLine() {
        //  e.g. when scrolling right past eol
        const linesBelow = this.getRemainingLinesBelowRow();

        if (linesBelow > 0) {
            const lastVisibleRow =
                Math.min(this.dimens.height, this.buffer.lines.length) - 1;
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
        if (this.buffer) {
            this.buffer.setWidth(width);
        }
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
        //  Normalize line endings and load into a fresh buffer
        this.buffer = new LineBuffer({ width: this.dimens.width });
        const normalized = (text || '').replace(/\r\n|\r/g, '\n');
        this.buffer.setText(normalized);

        switch (options.scrollMode || 'default') {
            case 'top':
            case 'start':
                this.cursorStartOfDocument();
                break;
            case 'end':
            case 'bottom':
                this.cursorEndOfDocument();
                break;
            default:
                if (this.isEditMode() || this.autoScroll) {
                    this.cursorEndOfDocument();
                } else {
                    this.cursorStartOfDocument();
                }
                break;
        }
    }

    setAnsi(ansiText, options = { prepped: false }, cb) {
        this.buffer = new LineBuffer({ width: this.dimens.width });
        return this.setAnsiWithOptions(ansiText, options, cb);
    }

    addText(text, options = { scrollMode: 'default' }) {
        const normalized = (text || '').replace(/\r\n|\r/g, '\n');

        const isEmpty =
            this.buffer.lines.length === 1 && this.buffer.lines[0].chars === '';

        if (isEmpty) {
            this.buffer.setText(normalized);
        } else {
            //  Append as new paragraphs
            const tmp = new LineBuffer({ width: this.buffer.width });
            tmp.setText(normalized);
            this.buffer.lines.push(...tmp.lines);
        }

        switch (options.scrollMode || 'default') {
            case 'top':
            case 'start':
                this.cursorStartOfDocument();
                break;
            case 'end':
            case 'bottom':
                this.cursorEndOfDocument();
                break;
            default:
                if (this.isEditMode() || this.autoScroll) {
                    this.cursorEndOfDocument();
                } else {
                    this.cursorStartOfDocument();
                }
                break;
        }
    }

    setAnsiWithOptions(ansiText, options, cb) {
        const setLines = text => {
            const splitLines = strUtil.splitTextAtTerms(text);
            this.buffer.lines = splitLines.map(line => ({
                chars:       line,
                attrs:       new Uint32Array(line.length),
                eol:         true,
                initialAttr: 0,
            }));
            if (this.buffer.lines.length === 0) {
                this.buffer.lines = [
                    { chars: '', attrs: new Uint32Array(0), eol: true, initialAttr: 0 },
                ];
            }

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

    getData(options = { forceLineTerms: false }) {
        if (options.forceLineTerms) {
            //  Every visual line (including soft-wrapped) gets \r\n
            return this.buffer.lines.map(l => l.chars + '\r\n').join('');
        }
        //  Hard breaks → \r\n; soft-wrapped joins get a space (LineBuffer getText() semantics)
        return this.buffer.getText().replace(/\n/g, '\r\n');
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
        this.buffer.lines.splice(line, 1);
    }

    getLineCount() {
        return this.buffer.lines.length;
    }

    getTextEditMode() {
        return this.overtypeMode ? 'overtype' : 'insert';
    }

    getEditPosition() {
        const currentIndex = this.getTextLinesIndex() + 1;

        return {
            row: this.getTextLinesIndex(this.cursorPos.row),
            col: this.cursorPos.col,
            percent: Math.floor((currentIndex / this.buffer.lines.length) * 100),
            below: this.getRemainingLinesBelowRow(),
        };
    }
}

exports.MultiLineEditTextView = MultiLineEditTextView;
