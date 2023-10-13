/* jslint node: true */
'use strict';

const miscUtil = require('./misc_util.js');
const ansi = require('./ansi_term.js');
const Log = require('./logger.js').log;

//  deps
const events = require('events');
const util = require('util');
const _ = require('lodash');

exports.ANSIEscapeParser = ANSIEscapeParser;

const CR = 0x0d;
const LF = 0x0a;

function ANSIEscapeParser(options) {
    var self = this;

    events.EventEmitter.call(this);

    this.column = 1;
    this.graphicRendition = {};

    this.parseState = {
        re: /(?:\x1b)(?:(?:\x5b([?=;0-9]*?)([ABCDEFGfHJKLmMsSTuUYZt@PXhlnpt]))|([78DEHM]))/g, //  eslint-disable-line no-control-regex
    };

    options = miscUtil.valueWithDefault(options, {
        mciReplaceChar: '',
        termHeight: 25,
        termWidth: 80,
        trailingLF: 'default', //  default|omit|no|yes, ...
    });

    this.mciReplaceChar = miscUtil.valueWithDefault(options.mciReplaceChar, '');
    this.termHeight = miscUtil.valueWithDefault(options.termHeight, 25);
    this.termWidth = miscUtil.valueWithDefault(options.termWidth, 80);
    this.breakWidth = this.termWidth;
    // toNumber takes care of null, undefined etc as well.
    let artWidth = _.toNumber(options.artWidth);
    if(!(_.isNaN(artWidth)) && artWidth > 0 && artWidth < this.breakWidth) {
        this.breakWidth = options.artWidth;
    }
    this.trailingLF = miscUtil.valueWithDefault(options.trailingLF, 'default');

    this.row = Math.min(options?.startRow ?? 1, this.termHeight);

    self.moveCursor = function (cols, rows) {
        self.column += cols;
        self.row += rows;

        self.column = Math.max(self.column, 1);
        self.column = Math.min(self.column, self.termWidth); //  can't move past term width
        self.row = Math.max(self.row, 1);

        self.positionUpdated();
    };

    self.saveCursorPosition = function () {
        self.savedPosition = {
            row: self.row,
            column: self.column,
        };
    };

    self.restoreCursorPosition = function () {
        self.row = self.savedPosition.row;
        self.column = self.savedPosition.column;
        delete self.savedPosition;

        self.positionUpdated();
        //      self.rowUpdated();
    };

    self.clearScreen = function () {
        self.column = 1;
        self.row = 1;
        self.positionUpdated();
        self.emit('clear screen');
    };

    self.positionUpdated = function () {
        if(self.row > self.termHeight) {
            if(this.savedPosition) {
                this.savedPosition.row -= self.row - self.termHeight;
            }
            self.emit('scroll', self.row - self.termHeight);
            self.row = self.termHeight;
        }
        else if(self.row < 1) {
            if(this.savedPosition) {
                this.savedPosition.row -= self.row - 1;
            }
            self.emit('scroll', -(self.row - 1));
            self.row = 1;
        }
        self.emit('position update', self.row, self.column);
    };

    function literal(text) {
        const len = text.length;
        let pos = 0;
        let start = 0;
        let charCode;
        let lastCharCode;

        while (pos < len) {
            charCode = text.charCodeAt(pos) & 0xff; //  8bit clean

            switch (charCode) {
                case CR:
                    self.emit('literal', text.slice(start, pos + 1));
                    start = pos + 1;

                    self.column = 1;

                    self.positionUpdated();
                    break;

                case LF:
                    //  Handle ANSI saved with UNIX-style LF's only
                    //  vs the CRLF pairs
                    if (lastCharCode !== CR) {
                        self.column = 1;
                    }

                    self.emit('literal', text.slice(start, pos + 1));
                    start = pos + 1;

                    self.row += 1;

                    self.positionUpdated();
                    break;

                default:
                    if (self.column === self.breakWidth) {
                        self.emit('literal', text.slice(start, pos + 1));
                        start = pos + 1;

                        // If we hit breakWidth before termWidth then we need to force the terminal to go to the next line.
                        if(self.column < self.termWidth) {
                            self.emit('literal', '\r\n');
                        }
                        self.column = 1;
                        self.row += 1;
                        self.positionUpdated();
                    } else {
                        self.column += 1;
                    }
                    break;
            }

            ++pos;
            lastCharCode = charCode;
        }

        //
        //  Finalize this chunk
        //
        if (self.column > self.breakWidth) {
            self.column = 1;
            self.row += 1;

            self.positionUpdated();
        }

        const rem = text.slice(start);
        if (rem) {
            self.emit('literal', rem);
        }
    }

    function parseMCI(buffer) {
        //  :TODO: move this to "constants" seciton @ top
        var mciRe = /%([A-Z]{2})([0-9]{1,2})?(?:\(([0-9A-Za-z,]+)\))*/g;
        var pos = 0;
        var match;
        var mciCode;
        var args;
        var id;

        do {
            pos = mciRe.lastIndex;
            match = mciRe.exec(buffer);

            if (null !== match) {
                if (match.index > pos) {
                    literal(buffer.slice(pos, match.index));
                }

                mciCode = match[1];
                id = match[2] || null;

                if (match[3]) {
                    args = match[3].split(',');
                } else {
                    args = [];
                }

                //  if MCI codes are changing, save off the current color
                var fullMciCode = mciCode + (id || '');
                if (self.lastMciCode !== fullMciCode) {
                    self.lastMciCode = fullMciCode;

                    self.graphicRenditionForErase = _.clone(self.graphicRendition);
                }

                self.emit('mci', {
                    position: [self.row, self.column],
                    mci: mciCode,
                    id: id ? parseInt(id, 10) : null,
                    args: args,
                    SGR: ansi.getSGRFromGraphicRendition(self.graphicRendition, true),
                });

                if (self.mciReplaceChar.length > 0) {
                    const sgrCtrl = ansi.getSGRFromGraphicRendition(
                        self.graphicRenditionForErase
                    );

                    self.emit(
                        'control',
                        sgrCtrl,
                        'm',
                        sgrCtrl.slice(2).split(/[;m]/).slice(0, 3)
                    );

                    literal(new Array(match[0].length + 1).join(self.mciReplaceChar));
                } else {
                    literal(match[0]);
                }
            }
        } while (0 !== mciRe.lastIndex);

        if (pos < buffer.length) {
            literal(buffer.slice(pos));
        }
    }

    self.reset = function (input) {
        self.column = 1;
        self.row = Math.min(options?.startRow ?? 1, self.termHeight);

        self.parseState = {
            //  ignore anything past EOF marker, if any
            buffer: input.split(String.fromCharCode(0x1a), 1)[0],
            re: /(?:\x1b)(?:(?:\x5b([?=;0-9]*?)([ABCDEFGfHJKLmMsSTuUYZt@PXhlnpt]))|([78DEHM]))/g, //  eslint-disable-line no-control-regex
            stop: false,
        };
    };

    self.stop = function () {
        self.parseState.stop = true;
    };

    self.parse = function (input) {
        if (input) {
            self.reset(input);
        }

        //  :TODO: ensure this conforms to ANSI-BBS / CTerm / bansi.txt for movement/etc.
        var pos;
        var match;
        var opCode;
        var args;
        var re = self.parseState.re;
        var buffer = self.parseState.buffer;

        self.parseState.stop = false;

        do {
            if (self.parseState.stop) {
                return;
            }

            pos = re.lastIndex;
            match = re.exec(buffer);

            if (null !== match) {
                if (match.index > pos) {
                    parseMCI(buffer.slice(pos, match.index));
                }

                opCode = match[2];
                args = match[1].split(';').map(v => parseInt(v, 10)); //  convert to array of ints

                // Handle the case where there is no bracket
                if(!(_.isNil(match[3]))) {
                    opCode = match[3];
                    args = [];
                    // no bracket
                    switch(opCode) {
                        // save cursor position
                        case '7':
                            escape('s', args);
                            break;
                        // restore cursor position
                        case '8':
                            escape('u', args);
                            break;

                        // scroll up
                        case 'D':
                            escape('S', args);
                            break;

                        // move to next line
                        case 'E':
                            // functonality is the same as ESC [ E
                            escape(opCode, args);
                            break;

                        // create a tab at current cursor position
                        case 'H':
                            literal('\t');
                            break;

                        // scroll down
                        case 'M':
                            escape('T', args);
                            break;
                    }
                }
                else {
                    escape(opCode, args);
                }

                self.emit('control', match[0], opCode, args);
            }
        } while (0 !== re.lastIndex);

        if (pos < buffer.length) {
            var lastBit = buffer.slice(pos);

            //  handles either \r\n or \n
            if ('\n' === lastBit.slice(-1).toString()) {
                switch (self.trailingLF) {
                    case 'default':
                        //
                        //  Default is to *not* omit the trailing LF
                        //  if we're going to end on termHeight
                        //
                        if (this.termHeight === self.row) {
                            lastBit = lastBit.slice(0, -1);
                        }
                        break;

                    case 'omit':
                    case 'no':
                    case false:
                        lastBit = lastBit.slice(0, -1);
                        break;
                }
            }

            parseMCI(lastBit);
        }

        self.emit('complete');
    };

    function escape(opCode, args) {
        let arg;

        switch (opCode) {
            //  cursor up
            case 'A':
                //arg = args[0] || 1;
                arg = isNaN(args[0]) ? 1 : args[0];
                self.moveCursor(0, -arg);
                break;

            //  cursor down
            case 'B':
                //arg = args[0] || 1;
                arg = isNaN(args[0]) ? 1 : args[0];
                self.moveCursor(0, arg);
                break;

            //  cursor forward/right
            case 'C':
                //arg = args[0] || 1;
                arg = isNaN(args[0]) ? 1 : args[0];
                self.moveCursor(arg, 0);
                break;

            //  cursor back/left
            case 'D':
                //arg = args[0] || 1;
                arg = isNaN(args[0]) ? 1 : args[0];
                self.moveCursor(-arg, 0);
                break;

            // line feed
            case 'E':
                arg = isNaN(args[0]) ? 1 : args[0];
                if(this.row + arg > this.termHeight) {
                    this.emit('scroll', arg - (this.termHeight - this.row));
                    self.moveCursor(0, this.termHeight);
                }
                else {
                    self.moveCursor(0, arg);
                }
                break;

            // reverse line feed
            case 'F':
                arg = isNaN(args[0]) ? 1 : args[0];
                if(this.row - arg < 1) {
                    this.emit('scroll', -(arg - this.row));
                    self.moveCursor(0, 1 - this.row);
                }
                else {
                    self.moveCursor(0, -arg);
                }
                break;

            // absolute horizontal cursor position
            case 'G':
                arg = isNaN(args[0]) ? 1 : args[0];
                self.column = Math.max(1, arg);
                self.positionUpdated();
                break;

            case 'f': //  horiz & vertical
            case 'H': //  cursor position
                //self.row  = args[0] || 1;
                //self.column   = args[1] || 1;
                self.row = isNaN(args[0]) ? 1 : args[0];
                self.column = isNaN(args[1]) ? 1 : args[1];
                //self.rowUpdated();
                self.positionUpdated();
                break;


            //  erase display/screen
            case 'J':
                if(isNaN(args[0]) || 0 === args[0]) {
                    self.emit('erase rows', self.row, self.termHeight);
                }
                else if (1 === args[0]) {
                    self.emit('erase rows', 1, self.row);
                }
                else if (2 === args[0]) {
                    self.clearScreen();
                }
                break;

            // erase text in line
            case 'K':
                if(isNaN(args[0]) || 0 === args[0]) {
                    self.emit('erase columns', self.row, self.column, self.termWidth);
                }
                else if (1 === args[0]) {
                    self.emit('erase columns', self.row, 1, self.column);
                }
                else if (2 === args[0]) {
                    self.emit('erase columns', self.row, 1, self.termWidth);
                }
                break;

            // insert line
            case 'L':
                arg = isNaN(args[0]) ? 1 : args[0];
                self.emit('insert line', self.row, arg);
                break;

            //  set graphic rendition
            case 'm':
                self.graphicRendition.reset = false;

                for (let i = 0, len = args.length; i < len; ++i) {
                    arg = args[i];

                    if (ANSIEscapeParser.foregroundColors[arg]) {
                        self.graphicRendition.fg = arg;
                    } else if (ANSIEscapeParser.backgroundColors[arg]) {
                        self.graphicRendition.bg = arg;
                    } else if (ANSIEscapeParser.styles[arg]) {
                        switch (arg) {
                            case 0:
                                //  clear out everything
                                delete self.graphicRendition.intensity;
                                delete self.graphicRendition.underline;
                                delete self.graphicRendition.blink;
                                delete self.graphicRendition.negative;
                                delete self.graphicRendition.invisible;

                                delete self.graphicRendition.fg;
                                delete self.graphicRendition.bg;

                                self.graphicRendition.reset = true;
                                //self.graphicRendition.fg = 39;
                                //self.graphicRendition.bg = 49;
                                break;

                            case 1:
                            case 2:
                            case 22:
                                self.graphicRendition.intensity = arg;
                                break;

                            case 4:
                            case 24:
                                self.graphicRendition.underline = arg;
                                break;

                            case 5:
                            case 6:
                            case 25:
                                self.graphicRendition.blink = arg;
                                break;

                            case 7:
                            case 27:
                                self.graphicRendition.negative = arg;
                                break;

                            case 8:
                            case 28:
                                self.graphicRendition.invisible = arg;
                                break;

                            default:
                                Log.trace(
                                    { attribute: arg },
                                    'Unknown attribute while parsing ANSI'
                                );
                                break;
                        }
                    }
                }

                self.emit('sgr update', self.graphicRendition);
                break; //  m

            //  save position
            case 's':
                self.saveCursorPosition();
                break;

            // Scroll up
            case 'S':
                arg = isNaN(args[0]) ? 1 : args[0];
                self.emit('scroll', arg);
                break;

            // Scroll down
            case 'T':
                arg = isNaN(args[0]) ? 1 : args[0];
                self.emit('scroll', -arg);
                break;

            //  restore position
            case 'u':
                self.restoreCursorPosition();
                break;

            // clear
            case 'U':
                self.clearScreen();
                break;

            // delete line
            // TODO: how should we handle 'M'?
            case 'Y':
                arg = isNaN(args[0]) ? 1 : args[0];
                self.emit('delete line', self.row, arg);
                break;

            // back tab
            case 'Z':
                // calculate previous tabstop
                self.column = Math.max( 1, self.column - (self.column % 8 || 8) );
                self.positionUpdated();
                break;
            case '@':
                // insert column(s)
                arg = isNaN(args[0]) ? 1 : args[0];
                self.emit('insert columns', self.row, self.column, arg);
                break;

        }
    }
}

util.inherits(ANSIEscapeParser, events.EventEmitter);

ANSIEscapeParser.foregroundColors = {
    30: 'black',
    31: 'red',
    32: 'green',
    33: 'yellow',
    34: 'blue',
    35: 'magenta',
    36: 'cyan',
    37: 'white',
    39: 'default', //  same as white for most implementations

    90: 'grey',
};
Object.freeze(ANSIEscapeParser.foregroundColors);

ANSIEscapeParser.backgroundColors = {
    40: 'black',
    41: 'red',
    42: 'green',
    43: 'yellow',
    44: 'blue',
    45: 'magenta',
    46: 'cyan',
    47: 'white',
    49: 'default', //  same as black for most implementations
};
Object.freeze(ANSIEscapeParser.backgroundColors);

//  :TODO: ensure these names all align with that of ansi_term.js
//
//  See the following specs:
//  * http://www.ansi-bbs.org/ansi-bbs-core-server.html
//  * http://www.vt100.net/docs/vt510-rm/SGR
//  * https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt
//
//  Note that these are intentionally not in order such that they
//  can be grouped by concept here in code.
//
ANSIEscapeParser.styles = {
    0: 'default', //  Everything disabled

    1: 'intensityBright', //  aka bold
    2: 'intensityDim',
    22: 'intensityNormal',

    4: 'underlineOn', //  Not supported by most BBS-like terminals
    24: 'underlineOff', //  Not supported by most BBS-like terminals

    5: 'blinkSlow', //  blinkSlow & blinkFast are generally treated the same
    6: 'blinkFast', //  blinkSlow & blinkFast are generally treated the same
    25: 'blinkOff',

    7: 'negativeImageOn', //  Generally not supported or treated as "reverse FG & BG"
    27: 'negativeImageOff', //  Generally not supported or treated as "reverse FG & BG"

    8: 'invisibleOn', //  FG set to BG
    28: 'invisibleOff', //  Not supported by most BBS-like terminals
};
Object.freeze(ANSIEscapeParser.styles);
