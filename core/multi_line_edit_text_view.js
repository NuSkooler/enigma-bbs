/* jslint node: true */
'use strict';

const View = require('./view.js').View;
const strUtil = require('./string_util.js');
const ansi = require('./ansi_term.js');
const wordWrapText = require('./word_wrap.js').wordWrapText;
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

exports.MultiLineEditTextView = MultiLineEditTextView;

function MultiLineEditTextView(options) {
    if (!_.isBoolean(options.acceptsFocus)) {
        options.acceptsFocus = true;
    }

    if (!_.isBoolean(this.acceptsInput)) {
        options.acceptsInput = true;
    }

    if (!_.isObject(options.specialKeyMap)) {
        options.specialKeyMap = SPECIAL_KEY_MAP_DEFAULT;
    }

    View.call(this, options);

    this.initDefaultWidth();

    var self = this;

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

    this.getSGRFor = function (sgrFor) {
        return (
            {
                text: self.getSGR(),
            }[sgrFor] || self.getSGR()
        );
    };

    this.isEditMode = function () {
        return 'edit' === self.mode;
    };

    this.isPreviewMode = function () {
        return 'preview' === self.mode;
    };

    //  :TODO: Most of the calls to this could be avoided via incrementRow(), decrementRow() that keeps track or such
    this.getTextLinesIndex = function (row) {
        if (!_.isNumber(row)) {
            row = self.cursorPos.row;
        }
        var index = self.topVisibleIndex + row;
        return index;
    };

    this.getRemainingLinesBelowRow = function (row) {
        if (!_.isNumber(row)) {
            row = self.cursorPos.row;
        }
        return self.textLines.length - (self.topVisibleIndex + row) - 1;
    };

    this.getNextEndOfLineIndex = function (startIndex) {
        for (var i = startIndex; i < self.textLines.length; i++) {
            if (self.textLines[i].eol) {
                return i;
            }
        }
        return self.textLines.length;
    };

    this.toggleTextCursor = function (action) {
        self.client.term.rawWrite(
            `${self.getSGRFor('text')}${
                'hide' === action ? ansi.hideCursor() : ansi.showCursor()
            }`
        );
    };

    this.redrawRows = function (startRow, endRow) {
        self.toggleTextCursor('hide');

        const startIndex = self.getTextLinesIndex(startRow);
        const endIndex = Math.min(self.getTextLinesIndex(endRow), self.textLines.length);
        const absPos = self.getAbsolutePosition(startRow, 0);

        for (let i = startIndex; i < endIndex; ++i) {
            //${self.getSGRFor('text')}
            self.client.term.write(
                `${ansi.goto(absPos.row++, absPos.col)}${self.getRenderText(i)}`,
                false //  convertLineFeeds
            );
        }

        self.toggleTextCursor('show');

        return absPos.row - self.position.row; //  row we ended on
    };

    this.eraseRows = function (startRow, endRow) {
        self.toggleTextCursor('hide');

        const absPos = self.getAbsolutePosition(startRow, 0);
        const absPosEnd = self.getAbsolutePosition(endRow, 0);
        const eraseFiller = ' '.repeat(self.dimens.width); //new Array(self.dimens.width).join(' ');

        while (absPos.row < absPosEnd.row) {
            self.client.term.write(
                `${ansi.goto(absPos.row++, absPos.col)}${eraseFiller}`,
                false //  convertLineFeeds
            );
        }

        self.toggleTextCursor('show');
    };

    this.redrawVisibleArea = function () {
        assert(self.topVisibleIndex <= self.textLines.length);
        const lastRow = self.redrawRows(0, self.dimens.height);

        self.eraseRows(lastRow, self.dimens.height);
        /*

        //  :TOOD: create eraseRows(startRow, endRow)
        if(lastRow < self.dimens.height) {
            var absPos  = self.getAbsolutePosition(lastRow, 0);
            var empty   = new Array(self.dimens.width).join(' ');
            while(lastRow++ < self.dimens.height) {
                self.client.term.write(ansi.goto(absPos.row++, absPos.col));
                self.client.term.write(empty);
            }
        }
        */
    };

    this.getVisibleText = function (index) {
        if (!_.isNumber(index)) {
            index = self.getTextLinesIndex();
        }
        return self.textLines[index].text.replace(/\t/g, ' ');
    };

    this.getText = function (index) {
        if (!_.isNumber(index)) {
            index = self.getTextLinesIndex();
        }
        return self.textLines.length > index ? self.textLines[index].text : '';
    };

    this.getTextLength = function (index) {
        if (!_.isNumber(index)) {
            index = self.getTextLinesIndex();
        }
        return self.textLines.length > index ? self.textLines[index].text.length : 0;
    };

    this.getCharacter = function (index, col) {
        if (!_.isNumber(col)) {
            col = self.cursorPos.col;
        }
        return self.getText(index).charAt(col);
    };

    this.isTab = function (index, col) {
        return '\t' === self.getCharacter(index, col);
    };

    this.getTextEndOfLineColumn = function (index) {
        return Math.max(0, self.getTextLength(index));
    };

    this.getRenderText = function (index) {
        let text = self.getVisibleText(index);
        const remain = self.dimens.width - strUtil.renderStringLength(text);

        if (remain > 0) {
            text += ' '.repeat(remain); // + 1);
        }

        return text;
    };

    this.getTextLines = function (startIndex, endIndex) {
        var lines;
        if (startIndex === endIndex) {
            lines = [self.textLines[startIndex]];
        } else {
            lines = self.textLines.slice(startIndex, endIndex + 1); //  "slice extracts up to but not including end."
        }
        return lines;
    };

    this.getOutputText = function (startIndex, endIndex, eolMarker, options) {
        const lines = self.getTextLines(startIndex, endIndex);
        let text = '';
        const re = new RegExp('\\t{1,' + self.tabWidth + '}', 'g');

        lines.forEach(line => {
            text += line.text.replace(re, '\t');

            if (options.forceLineTerms || (eolMarker && line.eol)) {
                text += eolMarker;
            }
        });

        return text;
    };

    this.getContiguousText = function (startIndex, endIndex, includeEol) {
        var lines = self.getTextLines(startIndex, endIndex);
        var text = '';
        for (var i = 0; i < lines.length; ++i) {
            text += lines[i].text;
            if (includeEol && lines[i].eol) {
                text += '\n';
            }
        }
        return text;
    };

    this.replaceCharacterInText = function (c, index, col) {
        self.textLines[index].text = strUtil.replaceAt(
            self.textLines[index].text,
            col,
            c
        );
    };

    /*
    this.editTextAtPosition = function(editAction, text, index, col) {
        switch(editAction) {
            case 'insert' :
                self.insertCharactersInText(text, index, col);
                break;

            case 'deleteForward' :
                break;

            case 'deleteBack' :
                break;

            case 'replace' :
                break;
        }
    };
    */

    this.updateTextWordWrap = function (index) {
        const nextEolIndex = self.getNextEndOfLineIndex(index);
        const wrapped = self.wordWrapSingleLine(
            self.getContiguousText(index, nextEolIndex),
            'tabsIntact'
        );
        const newLines = wrapped.wrapped.map(l => {
            return { text: l };
        });

        newLines[newLines.length - 1].eol = true;

        Array.prototype.splice.apply(
            self.textLines,
            [index, nextEolIndex - index + 1].concat(newLines)
        );

        return wrapped.firstWrapRange;
    };

    this.removeCharactersFromText = function (index, col, operation, count) {
        if ('delete' === operation) {
            self.textLines[index].text =
                self.textLines[index].text.slice(0, col) +
                self.textLines[index].text.slice(col + count);

            self.updateTextWordWrap(index);
            self.redrawRows(self.cursorPos.row, self.dimens.height);
            self.moveClientCursorToCursorPos();
        } else if ('backspace' === operation) {
            //  :TODO: method for splicing text
            self.textLines[index].text =
                self.textLines[index].text.slice(0, col - (count - 1)) +
                self.textLines[index].text.slice(col + 1);

            self.cursorPos.col -= count - 1;

            self.updateTextWordWrap(index);
            self.redrawRows(self.cursorPos.row, self.dimens.height);

            self.moveClientCursorToCursorPos();
        } else if ('delete line' === operation) {
            //
            //  Delete a visible line. Note that this is *not* the "physical" line, or
            //  1:n entries up to eol! This is to keep consistency with home/end, and
            //  some other text editors such as nano. Sublime for example want to
            //  treat all of these things using the physical approach, but this seems
            //  a bit odd in this context.
            //
            var isLastLine = index === self.textLines.length - 1;
            var hadEol = self.textLines[index].eol;

            self.textLines.splice(index, 1);
            if (hadEol && self.textLines.length > index && !self.textLines[index].eol) {
                self.textLines[index].eol = true;
            }

            //
            //  Create a empty edit buffer if necessary
            //  :TODO: Make this a method
            if (self.textLines.length < 1) {
                self.textLines = [{ text: '', eol: true }];
                isLastLine = false; //  resetting
            }

            self.cursorPos.col = 0;

            var lastRow = self.redrawRows(self.cursorPos.row, self.dimens.height);
            self.eraseRows(lastRow, self.dimens.height);

            //
            //  If we just deleted the last line in the buffer, move up
            //
            if (isLastLine) {
                self.cursorEndOfPreviousLine();
            } else {
                self.moveClientCursorToCursorPos();
            }
        }
    };

    this.insertCharactersInText = function (c, index, col) {
        const prevTextLength = self.getTextLength(index);
        let editingEol = self.cursorPos.col === prevTextLength;

        self.textLines[index].text = [
            self.textLines[index].text.slice(0, col),
            c,
            self.textLines[index].text.slice(col),
        ].join('');

        self.cursorPos.col += c.length;

        if (self.getTextLength(index) > self.dimens.width) {
            //
            //  Update word wrapping and |cursorOffset| if the cursor
            //  was within the bounds of the wrapped text
            //
            let cursorOffset;
            const lastCol = self.cursorPos.col - c.length;
            const firstWrapRange = self.updateTextWordWrap(index);
            if (lastCol >= firstWrapRange.start && lastCol <= firstWrapRange.end) {
                cursorOffset = self.cursorPos.col - firstWrapRange.start;
                editingEol = true; //override
            } else {
                cursorOffset = firstWrapRange.end;
            }

            //  redraw from current row to end of visible area
            self.redrawRows(self.cursorPos.row, self.dimens.height);

            //  If we're editing mid, we're done here. Else, we need to
            //  move the cursor to the new editing position after a wrap
            if (editingEol) {
                self.cursorBeginOfNextLine();
                self.cursorPos.col += cursorOffset;
                self.client.term.rawWrite(ansi.right(cursorOffset));
            } else {
                //  adjust cursor after drawing new rows
                const absPos = self.getAbsolutePosition(
                    self.cursorPos.row,
                    self.cursorPos.col
                );
                self.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
            }
        } else {
            //
            //  We must only redraw from col -> end of current visible line
            //
            const absPos = self.getAbsolutePosition(
                self.cursorPos.row,
                self.cursorPos.col
            );
            const renderText = self
                .getRenderText(index)
                .slice(self.cursorPos.col - c.length);

            self.client.term.write(
                `${ansi.hideCursor()}${self.getSGRFor('text')}${renderText}${ansi.goto(
                    absPos.row,
                    absPos.col
                )}${ansi.showCursor()}`,
                false //  convertLineFeeds
            );
        }
    };

    this.getRemainingTabWidth = function (col) {
        if (!_.isNumber(col)) {
            col = self.cursorPos.col;
        }
        return self.tabWidth - (col % self.tabWidth);
    };

    this.calculateTabStops = function () {
        self.tabStops = [0];
        var col = 0;
        while (col < self.dimens.width) {
            col += self.getRemainingTabWidth(col);
            self.tabStops.push(col);
        }
    };

    this.getNextTabStop = function (col) {
        var i = self.tabStops.length;
        while (self.tabStops[--i] > col);
        return self.tabStops[++i];
    };

    this.getPrevTabStop = function (col) {
        var i = self.tabStops.length;
        while (self.tabStops[--i] >= col);
        return self.tabStops[i];
    };

    this.expandTab = function (col, expandChar) {
        expandChar = expandChar || ' ';
        return new Array(self.getRemainingTabWidth(col)).join(expandChar);
    };

    this.wordWrapSingleLine = function (line, tabHandling = 'expand') {
        return wordWrapText(line, {
            width: self.dimens.width,
            tabHandling: tabHandling,
            tabWidth: self.tabWidth,
            tabChar: '\t',
        });
    };

    this.setTextLines = function (lines, index, termWithEol) {
        if (
            0 === index &&
            (0 === self.textLines.length ||
                (self.textLines.length === 1 && '' === self.textLines[0].text))
        ) {
            //  quick path: just set the things
            self.textLines = lines
                .slice(0, -1)
                .map(l => {
                    return { text: l };
                })
                .concat({ text: lines[lines.length - 1], eol: termWithEol });
        } else {
            //  insert somewhere in textLines...
            if (index > self.textLines.length) {
                //  fill with empty
                self.textLines.splice(
                    self.textLines.length,
                    0,
                    ...Array.from({ length: index - self.textLines.length }).map(() => {
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

            self.textLines.splice(index, 0, ...newLines);
        }
    };

    this.setAnsiWithOptions = function (ansi, options, cb) {
        function setLines(text) {
            text = strUtil.splitTextAtTerms(text);

            let index = 0;

            text.forEach(line => {
                self.setTextLines([line], index, true); //  true=termWithEol
                index += 1;
            });

            self.cursorStartOfDocument();

            if (cb) {
                return cb(null);
            }
        }

        if (options.prepped) {
            return setLines(ansi);
        }

        ansiPrep(
            ansi,
            {
                termWidth: options.termWidth || this.client.term.termWidth,
                termHeight: options.termHeight || this.client.term.termHeight,
                cols: this.dimens.width,
                rows: 'auto',
                startCol: this.position.col,
                forceLineTerm: options.forceLineTerm,
            },
            (err, preppedAnsi) => {
                return setLines(err ? ansi : preppedAnsi);
            }
        );
    };

    this.insertRawText = function (text, index, col) {
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
                text = self.textLines;

                //  :TODO: Remove original line @ index
            }
        } else {
            index = self.textLines.length;
        }

        text = strUtil.splitTextAtTerms(text);

        let wrapped;
        text.forEach(line => {
            wrapped = self.wordWrapSingleLine(line, 'expand').wrapped;

            self.setTextLines(wrapped, index, true); //  true=termWithEol
            index += wrapped.length;
        });
    };

    this.getAbsolutePosition = function (row, col) {
        return {
            row: self.position.row + row,
            col: self.position.col + col,
        };
    };

    this.moveClientCursorToCursorPos = function () {
        var absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
        self.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
    };

    this.keyPressCharacter = function (c) {
        var index = self.getTextLinesIndex();

        //
        //  :TODO: stuff that needs to happen
        //  * Break up into smaller methods
        //  * Even in overtype mode, word wrapping must apply if past bounds
        //  * A lot of this can be used for backspacing also
        //  * See how Sublime treats tabs in *non* overtype mode... just overwrite them?
        //
        //

        if (self.overtypeMode) {
            //  :TODO: special handing for insert over eol mark?
            self.replaceCharacterInText(c, index, self.cursorPos.col);
            self.cursorPos.col++;
            self.client.term.write(c);
        } else {
            self.insertCharactersInText(c, index, self.cursorPos.col);
        }

        self.emitEditPosition();
    };

    this.keyPressUp = function () {
        if (self.cursorPos.row > 0) {
            self.cursorPos.row--;
            self.client.term.rawWrite(ansi.up());

            if (!self.adjustCursorToNextTab('up')) {
                self.adjustCursorIfPastEndOfLine(false);
            }
        } else {
            self.scrollDocumentDown();
            self.adjustCursorIfPastEndOfLine(true);
        }

        self.emitEditPosition();
    };

    this.keyPressDown = function () {
        var lastVisibleRow =
            Math.min(self.dimens.height, self.textLines.length - self.topVisibleIndex) -
            1;

        if (self.cursorPos.row < lastVisibleRow) {
            self.cursorPos.row++;
            self.client.term.rawWrite(ansi.down());

            if (!self.adjustCursorToNextTab('down')) {
                self.adjustCursorIfPastEndOfLine(false);
            }
        } else {
            self.scrollDocumentUp();
            self.adjustCursorIfPastEndOfLine(true);
        }

        self.emitEditPosition();
    };

    this.keyPressLeft = function () {
        if (self.cursorPos.col > 0) {
            var prevCharIsTab = self.isTab();

            self.cursorPos.col--;
            self.client.term.rawWrite(ansi.left());

            if (prevCharIsTab) {
                self.adjustCursorToNextTab('left');
            }
        } else {
            self.cursorEndOfPreviousLine();
        }

        self.emitEditPosition();
    };

    this.keyPressRight = function () {
        var eolColumn = self.getTextEndOfLineColumn();
        if (self.cursorPos.col < eolColumn) {
            var prevCharIsTab = self.isTab();

            self.cursorPos.col++;
            self.client.term.rawWrite(ansi.right());

            if (prevCharIsTab) {
                self.adjustCursorToNextTab('right');
            }
        } else {
            self.cursorBeginOfNextLine();
        }

        self.emitEditPosition();
    };

    this.keyPressHome = function () {
        var firstNonWhitespace = self.getVisibleText().search(/\S/);
        if (-1 !== firstNonWhitespace) {
            self.cursorPos.col = firstNonWhitespace;
        } else {
            self.cursorPos.col = 0;
        }
        self.moveClientCursorToCursorPos();

        self.emitEditPosition();
    };

    this.keyPressEnd = function () {
        self.cursorPos.col = self.getTextEndOfLineColumn();
        self.moveClientCursorToCursorPos();
        self.emitEditPosition();
    };

    this.keyPressPageUp = function () {
        if (self.topVisibleIndex > 0) {
            self.topVisibleIndex = Math.max(0, self.topVisibleIndex - self.dimens.height);
            self.redraw();
            self.adjustCursorIfPastEndOfLine(true);
        } else {
            self.cursorPos.row = 0;
            self.moveClientCursorToCursorPos(); //  :TODO: ajust if eol, etc.
        }

        self.emitEditPosition();
    };

    this.keyPressPageDown = function () {
        var linesBelow = self.getRemainingLinesBelowRow();
        if (linesBelow > 0) {
            self.topVisibleIndex += Math.min(linesBelow, self.dimens.height);
            self.redraw();
            self.adjustCursorIfPastEndOfLine(true);
        }

        self.emitEditPosition();
    };

    this.keyPressLineFeed = function () {
        //
        //  Break up text from cursor position, redraw, and update cursor
        //  position to start of next line
        //
        var index = self.getTextLinesIndex();
        var nextEolIndex = self.getNextEndOfLineIndex(index);
        var text = self.getContiguousText(index, nextEolIndex);
        const newLines = self.wordWrapSingleLine(
            text.slice(self.cursorPos.col),
            'tabsIntact'
        ).wrapped;

        newLines.unshift({ text: text.slice(0, self.cursorPos.col), eol: true });
        for (var i = 1; i < newLines.length; ++i) {
            newLines[i] = { text: newLines[i] };
        }
        newLines[newLines.length - 1].eol = true;

        Array.prototype.splice.apply(
            self.textLines,
            [index, nextEolIndex - index + 1].concat(newLines)
        );

        //  redraw from current row to end of visible area
        self.redrawRows(self.cursorPos.row, self.dimens.height);
        self.cursorBeginOfNextLine();

        self.emitEditPosition();
    };

    this.keyPressInsert = function () {
        self.toggleTextEditMode();
    };

    this.keyPressTab = function () {
        var index = self.getTextLinesIndex();
        self.insertCharactersInText(
            self.expandTab(self.cursorPos.col, '\t') + '\t',
            index,
            self.cursorPos.col
        );

        self.emitEditPosition();
    };

    this.keyPressBackspace = function () {
        if (self.cursorPos.col >= 1) {
            //
            //  Don't want to delete character at cursor, but rather the character
            //  to the left of the cursor!
            //
            self.cursorPos.col -= 1;

            var index = self.getTextLinesIndex();
            var count;

            if (self.isTab()) {
                var col = self.cursorPos.col;
                var prevTabStop = self.getPrevTabStop(self.cursorPos.col);
                while (col >= prevTabStop) {
                    if (!self.isTab(index, col)) {
                        break;
                    }
                    --col;
                }

                count = self.cursorPos.col - col;
            } else {
                count = 1;
            }

            self.removeCharactersFromText(index, self.cursorPos.col, 'backspace', count);
        } else {
            //
            //  Delete character at end of line previous.
            //  * This may be a eol marker
            //  * Word wrapping will need re-applied
            //
            //  :TODO: apply word wrapping such that text can be re-adjusted if it can now fit on prev
            self.keyPressLeft(); //  same as hitting left - jump to previous line
            //self.keyPressBackspace();
        }

        self.emitEditPosition();
    };

    this.keyPressDelete = function () {
        const lineIndex = self.getTextLinesIndex();

        if (
            0 === self.cursorPos.col &&
            0 === self.textLines[lineIndex].text.length &&
            self.textLines.length > 0
        ) {
            //
            //  Start of line and nothing left. Just delete the line
            //
            self.removeCharactersFromText(lineIndex, 0, 'delete line');
        } else {
            self.removeCharactersFromText(lineIndex, self.cursorPos.col, 'delete', 1);
        }

        self.emitEditPosition();
    };

    this.keyPressDeleteLine = function () {
        if (self.textLines.length > 0) {
            self.removeCharactersFromText(self.getTextLinesIndex(), 0, 'delete line');
        }

        self.emitEditPosition();
    };

    this.adjustCursorIfPastEndOfLine = function (forceUpdate) {
        var eolColumn = self.getTextEndOfLineColumn();
        if (self.cursorPos.col > eolColumn) {
            self.cursorPos.col = eolColumn;
            forceUpdate = true;
        }

        if (forceUpdate) {
            self.moveClientCursorToCursorPos();
        }
    };

    this.adjustCursorToNextTab = function (direction) {
        if (self.isTab()) {
            var move;
            switch (direction) {
                //
                //  Next tabstop to the right
                //
                case 'right':
                    move = self.getNextTabStop(self.cursorPos.col) - self.cursorPos.col;
                    self.cursorPos.col += move;
                    self.client.term.rawWrite(ansi.right(move));
                    break;

                //
                //  Next tabstop to the left
                //
                case 'left':
                    move = self.cursorPos.col - self.getPrevTabStop(self.cursorPos.col);
                    self.cursorPos.col -= move;
                    self.client.term.rawWrite(ansi.left(move));
                    break;

                case 'up':
                case 'down':
                    //
                    //  Jump to the tabstop nearest the cursor
                    //
                    var newCol = self.tabStops.reduce(function r(prev, curr) {
                        return Math.abs(curr - self.cursorPos.col) <
                            Math.abs(prev - self.cursorPos.col)
                            ? curr
                            : prev;
                    });

                    if (newCol > self.cursorPos.col) {
                        move = newCol - self.cursorPos.col;
                        self.cursorPos.col += move;
                        self.client.term.rawWrite(ansi.right(move));
                    } else if (newCol < self.cursorPos.col) {
                        move = self.cursorPos.col - newCol;
                        self.cursorPos.col -= move;
                        self.client.term.rawWrite(ansi.left(move));
                    }
                    break;
            }

            return true;
        }
        return false; //  did not fall on a tab
    };

    this.cursorStartOfDocument = function () {
        self.topVisibleIndex = 0;
        self.cursorPos = { row: 0, col: 0 };

        self.redraw();
        self.moveClientCursorToCursorPos();
    };

    this.cursorEndOfDocument = function () {
        self.topVisibleIndex = Math.max(self.textLines.length - self.dimens.height, 0);
        self.cursorPos.row = self.textLines.length - self.topVisibleIndex - 1;
        self.cursorPos.col = self.getTextEndOfLineColumn();

        self.redraw();
        self.moveClientCursorToCursorPos();
    };

    this.cursorBeginOfNextLine = function () {
        //  e.g. when scrolling right past eol
        var linesBelow = self.getRemainingLinesBelowRow();

        if (linesBelow > 0) {
            var lastVisibleRow = Math.min(self.dimens.height, self.textLines.length) - 1;
            if (self.cursorPos.row < lastVisibleRow) {
                self.cursorPos.row++;
            } else {
                self.scrollDocumentUp();
            }
            self.keyPressHome(); //  same as pressing 'home'
        }
    };

    this.cursorEndOfPreviousLine = function () {
        //  e.g. when scrolling left past start of line
        var moveToEnd;
        if (self.cursorPos.row > 0) {
            self.cursorPos.row--;
            moveToEnd = true;
        } else if (self.topVisibleIndex > 0) {
            self.scrollDocumentDown();
            moveToEnd = true;
        }

        if (moveToEnd) {
            self.keyPressEnd(); //  same as pressing 'end'
        }
    };

    /*
    this.cusorEndOfNextLine = function() {
        var linesBelow = self.getRemainingLinesBelowRow();

        if(linesBelow > 0) {
            var lastVisibleRow = Math.min(self.dimens.height, self.textLines.length) - 1;
            if(self.cursorPos.row < lastVisibleRow) {
                self.cursorPos.row++;
            } else {
                self.scrollDocumentUp();
            }
            self.keyPressEnd(); //  same as pressing 'end'
        }
    };
    */

    this.scrollDocumentUp = function () {
        //
        //  Note: We scroll *up* when the cursor goes *down* beyond
        //  the visible area!
        //
        var linesBelow = self.getRemainingLinesBelowRow();
        if (linesBelow > 0) {
            self.topVisibleIndex++;
            self.redraw();
        }
    };

    this.scrollDocumentDown = function () {
        //
        //  Note: We scroll *down* when the cursor goes *up* beyond
        //  the visible area!
        //
        if (self.topVisibleIndex > 0) {
            self.topVisibleIndex--;
            self.redraw();
        }
    };

    this.emitEditPosition = function () {
        self.emit('edit position', self.getEditPosition());
    };

    this.toggleTextEditMode = function () {
        self.overtypeMode = !self.overtypeMode;
        self.emit('text edit mode', self.getTextEditMode());
    };

    this.insertRawText(''); //  init to blank/empty
}

require('util').inherits(MultiLineEditTextView, View);

MultiLineEditTextView.prototype.setWidth = function (width) {
    MultiLineEditTextView.super_.prototype.setWidth.call(this, width);

    this.calculateTabStops();
};

MultiLineEditTextView.prototype.redraw = function () {
    MultiLineEditTextView.super_.prototype.redraw.call(this);

    this.redrawVisibleArea();
};

MultiLineEditTextView.prototype.setFocus = function (focused) {
    this.client.term.rawWrite(this.getSGRFor('text'));
    this.moveClientCursorToCursorPos();

    MultiLineEditTextView.super_.prototype.setFocus.call(this, focused);
};

MultiLineEditTextView.prototype.setText = function (
    text,
    options = { scrollMode: 'default' }
) {
    this.textLines = [];
    this.addText(text, options);
    /*this.insertRawText(text);

    if(this.isEditMode()) {
        this.cursorEndOfDocument();
    } else if(this.isPreviewMode()) {
        this.cursorStartOfDocument();
    }*/
};

MultiLineEditTextView.prototype.setAnsi = function (
    ansi,
    options = { prepped: false },
    cb
) {
    this.textLines = [];
    return this.setAnsiWithOptions(ansi, options, cb);
};

MultiLineEditTextView.prototype.addText = function (
    text,
    options = { scrollMode: 'default' }
) {
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
};

MultiLineEditTextView.prototype.getData = function (options = { forceLineTerms: false }) {
    return this.getOutputText(0, this.textLines.length, '\r\n', options);
};

MultiLineEditTextView.prototype.setPropertyValue = function (propName, value) {
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
    }

    MultiLineEditTextView.super_.prototype.setPropertyValue.call(this, propName, value);
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

MultiLineEditTextView.prototype.onKeyPress = function (ch, key) {
    const self = this;
    let handled;

    if (key) {
        HANDLED_SPECIAL_KEYS.forEach(function aKey(specialKey) {
            if (self.isKeyMapped(specialKey, key.name)) {
                if (
                    self.isPreviewMode() &&
                    -1 === PREVIEW_MODE_KEYS.indexOf(specialKey)
                ) {
                    return;
                }

                if ('tab' !== key.name || !self.tabSwitchesView) {
                    self[_.camelCase('keyPress ' + specialKey)]();
                    handled = true;
                }
            }
        });
    }

    if (self.isEditMode() && ch && strUtil.isPrintable(ch)) {
        this.keyPressCharacter(ch);
    }

    if (!handled) {
        MultiLineEditTextView.super_.prototype.onKeyPress.call(this, ch, key);
    }
};

MultiLineEditTextView.prototype.scrollUp = function () {
    this.scrollDocumentUp();
};

MultiLineEditTextView.prototype.scrollDown = function () {
    this.scrollDocumentDown();
};

MultiLineEditTextView.prototype.deleteLine = function (line) {
    this.textLines.splice(line, 1);
};

MultiLineEditTextView.prototype.getLineCount = function () {
    return this.textLines.length;
};

MultiLineEditTextView.prototype.getTextEditMode = function () {
    return this.overtypeMode ? 'overtype' : 'insert';
};

MultiLineEditTextView.prototype.getEditPosition = function () {
    var currentIndex = this.getTextLinesIndex() + 1;

    return {
        row: this.getTextLinesIndex(this.cursorPos.row),
        col: this.cursorPos.col,
        percent: Math.floor((currentIndex / this.textLines.length) * 100),
        below: this.getRemainingLinesBelowRow(),
    };
};
