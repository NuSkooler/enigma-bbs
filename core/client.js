/* jslint node: true */
'use strict';

/*
    Portions of this code for key handling heavily inspired from the following:
    https://github.com/chjj/blessed/blob/master/lib/keys.js

    chji's blessed is MIT licensed:

    ----/snip/----------------------
    The MIT License (MIT)

    Copyright (c) <year> <copyright holders>

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.
    ----/snip/----------------------
*/
//  ENiGMA½
const term = require('./client_term.js');
const ansi = require('./ansi_term.js');
const User = require('./user.js');
const Config = require('./config.js').get;
const MenuStack = require('./menu_stack.js');
const ACS = require('./acs.js');
const Events = require('./events.js');
const UserInterruptQueue = require('./user_interrupt_queue.js');
const UserProps = require('./user_property.js');

//  deps
const stream = require('stream');
const assert = require('assert');
const _ = require('lodash');

exports.Client = Client;

//  :TODO: Move all of the key stuff to it's own module

//
//  Resources & Standards:
//  * http://www.ansi-bbs.org/ansi-bbs-core-server.html
//
/* eslint-disable no-control-regex */
const RE_DSR_RESPONSE_ANYWHERE = /(?:\u001b\[)([0-9;]+)(R)/;
const RE_DEV_ATTR_RESPONSE_ANYWHERE = /(?:\u001b\[)[=?]([0-9a-zA-Z;]+)(c)/;
const RE_META_KEYCODE_ANYWHERE = /(?:\u001b)([a-zA-Z0-9])/;
const RE_META_KEYCODE = new RegExp('^' + RE_META_KEYCODE_ANYWHERE.source + '$');
const RE_FUNCTION_KEYCODE_ANYWHERE = new RegExp(
    '(?:\u001b+)(O|N|\\[|\\[\\[)(?:' +
        [
            '(\\d+)(?:;(\\d+))?([~^$])',
            '(?:M([@ #!a`])(.)(.))', // mouse stuff
            '(?:1;)?(\\d+)?([a-zA-Z@])',
        ].join('|') +
        ')'
);
/* eslint-enable no-control-regex */

const RE_FUNCTION_KEYCODE = new RegExp('^' + RE_FUNCTION_KEYCODE_ANYWHERE.source);
const RE_ESC_CODE_ANYWHERE = new RegExp(
    [
        RE_FUNCTION_KEYCODE_ANYWHERE.source,
        RE_META_KEYCODE_ANYWHERE.source,
        RE_DSR_RESPONSE_ANYWHERE.source,
        RE_DEV_ATTR_RESPONSE_ANYWHERE.source,
        /\u001b./.source, //  eslint-disable-line no-control-regex
    ].join('|')
);

function Client(/*input, output*/) {
    stream.call(this);

    const self = this;

    this.user = new User();
    this.currentThemeConfig = { info: { name: 'N/A', description: 'None' } };
    this.lastActivityTime = Date.now();
    this.menuStack = new MenuStack(this);
    this.acs = new ACS({ client: this, user: this.user });
    this.interruptQueue = new UserInterruptQueue(this);

    Object.defineProperty(this, 'currentTheme', {
        get: () => {
            if (this.currentThemeConfig) {
                return this.currentThemeConfig.get();
            } else {
                return {
                    info: {
                        name: 'N/A',
                        author: 'N/A',
                        description: 'N/A',
                        group: 'N/A',
                    },
                };
            }
        },
        set: theme => {
            this.currentThemeConfig = theme;
        },
    });

    Object.defineProperty(this, 'node', {
        get: function () {
            return self.session.id;
        },
    });

    Object.defineProperty(this, 'currentMenuModule', {
        get: function () {
            return self.menuStack.currentModule;
        },
    });

    this.setTemporaryDirectDataHandler = function (handler) {
        this.dataPassthrough = true; //  let implementations do with what they will here
        this.input.removeAllListeners('data');
        this.input.on('data', handler);
    };

    this.restoreDataHandler = function () {
        this.dataPassthrough = false;
        this.input.removeAllListeners('data');
        this.input.on('data', this.dataHandler);
    };

    this.themeChangedListener = function ({ themeId }) {
        if (_.get(self.currentTheme, 'info.themeId') === themeId) {
            self.currentThemeConfig = require('./theme.js')
                .getAvailableThemes()
                .get(themeId);
        }
    };

    Events.on(Events.getSystemEvents().ThemeChanged, this.themeChangedListener);

    //
    //  Peek at incoming |data| and emit events for any special
    //  handling that may include:
    //  *   Keyboard input
    //  *   ANSI CSR's and the like
    //
    //  References:
    //  *   http://www.ansi-bbs.org/ansi-bbs-core-server.html
    //  *   Christopher Jeffrey's Blessed library @ https://github.com/chjj/blessed/
    //
    this.getTermClient = function (deviceAttr) {
        let termClient = {
            '63;1;2': 'arctel', //  http://www.fbl.cz/arctel/download/techman.pdf - Irssi ConnectBot (Android)
            '50;86;84;88': 'vtx', //  https://github.com/codewar65/VTX_ClientServer/blob/master/vtx.txt
        }[deviceAttr];

        if (!termClient) {
            if (_.startsWith(deviceAttr, '67;84;101;114;109')) {
                //
                //  See https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt
                //
                //  Known clients:
                //  * SyncTERM
                //
                termClient = 'cterm';
            }
        }

        return termClient;
    };

    /* eslint-disable no-control-regex */
    this.isMouseInput = function (data) {
        return (
            /\x1b\[M/.test(data) ||
            /\u001b\[M([\x00\u0020-\uffff]{3})/.test(data) ||
            /\u001b\[(\d+;\d+;\d+)M/.test(data) ||
            /\u001b\[<(\d+;\d+;\d+)([mM])/.test(data) ||
            /\u001b\[<(\d+;\d+;\d+;\d+)&w/.test(data) ||
            /\u001b\[24([0135])~\[(\d+),(\d+)\]\r/.test(data) ||
            /\u001b\[(O|I)/.test(data)
        );
    };
    /* eslint-enable no-control-regex */

    this.getKeyComponentsFromCode = function (code) {
        return {
            //  xterm/gnome
            OP: { name: 'f1' },
            OQ: { name: 'f2' },
            OR: { name: 'f3' },
            OS: { name: 'f4' },

            OA: { name: 'up arrow' },
            OB: { name: 'down arrow' },
            OC: { name: 'right arrow' },
            OD: { name: 'left arrow' },
            OE: { name: 'clear' },
            OF: { name: 'end' },
            OH: { name: 'home' },

            //  xterm/rxvt
            '[11~': { name: 'f1' },
            '[12~': { name: 'f2' },
            '[13~': { name: 'f3' },
            '[14~': { name: 'f4' },

            '[1~': { name: 'home' },
            '[2~': { name: 'insert' },
            '[3~': { name: 'delete' },
            '[4~': { name: 'end' },
            '[5~': { name: 'page up' },
            '[6~': { name: 'page down' },

            //  Cygwin & libuv
            '[[A': { name: 'f1' },
            '[[B': { name: 'f2' },
            '[[C': { name: 'f3' },
            '[[D': { name: 'f4' },
            '[[E': { name: 'f5' },

            //  Common impls
            '[15~': { name: 'f5' },
            '[17~': { name: 'f6' },
            '[18~': { name: 'f7' },
            '[19~': { name: 'f8' },
            '[20~': { name: 'f9' },
            '[21~': { name: 'f10' },
            '[23~': { name: 'f11' },
            '[24~': { name: 'f12' },

            //  xterm
            '[A': { name: 'up arrow' },
            '[B': { name: 'down arrow' },
            '[C': { name: 'right arrow' },
            '[D': { name: 'left arrow' },
            '[E': { name: 'clear' },
            '[F': { name: 'end' },
            '[H': { name: 'home' },

            //  PuTTY
            '[[5~': { name: 'page up' },
            '[[6~': { name: 'page down' },

            //  rvxt
            '[7~': { name: 'home' },
            '[8~': { name: 'end' },

            //  rxvt with modifiers
            '[a': { name: 'up arrow', shift: true },
            '[b': { name: 'down arrow', shift: true },
            '[c': { name: 'right arrow', shift: true },
            '[d': { name: 'left arrow', shift: true },
            '[e': { name: 'clear', shift: true },

            '[2$': { name: 'insert', shift: true },
            '[3$': { name: 'delete', shift: true },
            '[5$': { name: 'page up', shift: true },
            '[6$': { name: 'page down', shift: true },
            '[7$': { name: 'home', shift: true },
            '[8$': { name: 'end', shift: true },

            Oa: { name: 'up arrow', ctrl: true },
            Ob: { name: 'down arrow', ctrl: true },
            Oc: { name: 'right arrow', ctrl: true },
            Od: { name: 'left arrow', ctrl: true },
            Oe: { name: 'clear', ctrl: true },

            '[2^': { name: 'insert', ctrl: true },
            '[3^': { name: 'delete', ctrl: true },
            '[5^': { name: 'page up', ctrl: true },
            '[6^': { name: 'page down', ctrl: true },
            '[7^': { name: 'home', ctrl: true },
            '[8^': { name: 'end', ctrl: true },

            //  SyncTERM / EtherTerm
            '[K': { name: 'end' },
            '[@': { name: 'insert' },
            '[V': { name: 'page up' },
            '[U': { name: 'page down' },

            //  other
            '[Z': { name: 'tab', shift: true },
        }[code];
    };

    this.on('data', function clientData(data) {
        //  create a uniform format that can be parsed below
        if (data[0] > 127 && undefined === data[1]) {
            data[0] -= 128;
            data = '\u001b' + data.toString('utf-8');
        } else {
            data = data.toString('utf-8');
        }

        if (self.isMouseInput(data)) {
            return;
        }

        var buf = [];
        var m;
        while ((m = RE_ESC_CODE_ANYWHERE.exec(data))) {
            buf = buf.concat(data.slice(0, m.index).split(''));
            buf.push(m[0]);
            data = data.slice(m.index + m[0].length);
        }

        buf = buf.concat(data.split('')); //  remainder

        buf.forEach(function bufPart(s) {
            var key = {
                seq: s,
                name: undefined,
                ctrl: false,
                meta: false,
                shift: false,
            };

            var parts;

            if ((parts = RE_DSR_RESPONSE_ANYWHERE.exec(s))) {
                if ('R' === parts[2]) {
                    const cprArgs = parts[1].split(';').map(v => parseInt(v, 10) || 0);
                    if (2 === cprArgs.length) {
                        if (self.cprOffset) {
                            cprArgs[0] = cprArgs[0] + self.cprOffset;
                            cprArgs[1] = cprArgs[1] + self.cprOffset;
                        }
                        self.emit('cursor position report', cprArgs);
                    }
                }
            } else if ((parts = RE_DEV_ATTR_RESPONSE_ANYWHERE.exec(s))) {
                assert('c' === parts[2]);
                var termClient = self.getTermClient(parts[1]);
                if (termClient) {
                    self.term.termClient = termClient;
                }
            } else if ('\r' === s) {
                key.name = 'return';
            } else if ('\n' === s) {
                key.name = 'line feed';
            } else if ('\t' === s) {
                key.name = 'tab';
            } else if ('\x7f' === s) {
                //
                //  Backspace vs delete is a crazy thing, especially in *nix.
                //  - ANSI-BBS uses 0x7f for DEL
                //  - xterm et. al clients send 0x7f for backspace... ugg.
                //
                //  See http://www.hypexr.org/linux_ruboff.php
                //  And a great discussion @ https://lists.debian.org/debian-i18n/1998/04/msg00015.html
                //
                if (self.term.isNixTerm()) {
                    key.name = 'backspace';
                } else {
                    key.name = 'delete';
                }
            } else if ('\b' === s || '\x1b\x7f' === s || '\x1b\b' === s) {
                //  backspace, CTRL-H
                key.name = 'backspace';
                key.meta = '\x1b' === s.charAt(0);
            } else if ('\x1b' === s || '\x1b\x1b' === s) {
                key.name = 'escape';
                key.meta = 2 === s.length;
            } else if (' ' === s || '\x1b ' === s) {
                //  rather annoying that space can come in other than just " "
                key.name = 'space';
                key.meta = 2 === s.length;
            } else if (1 === s.length && s <= '\x1a') {
                //  CTRL-<letter>
                key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
                key.ctrl = true;
            } else if (1 === s.length && s >= 'a' && s <= 'z') {
                //  normal, lowercased letter
                key.name = s;
            } else if (1 === s.length && s >= 'A' && s <= 'Z') {
                key.name = s.toLowerCase();
                key.shift = true;
            } else if ((parts = RE_META_KEYCODE.exec(s))) {
                //  meta with character key
                key.name = parts[1].toLowerCase();
                key.meta = true;
                key.shift = /^[A-Z]$/.test(parts[1]);
            } else if ((parts = RE_FUNCTION_KEYCODE.exec(s))) {
                var code =
                    (parts[1] || '') +
                    (parts[2] || '') +
                    (parts[4] || '') +
                    (parts[9] || '');

                var modifier = (parts[3] || parts[8] || 1) - 1;

                key.ctrl = !!(modifier & 4);
                key.meta = !!(modifier & 10);
                key.shift = !!(modifier & 1);
                key.code = code;

                _.assign(key, self.getKeyComponentsFromCode(code));
            }

            var ch;
            if (1 === s.length) {
                ch = s;
            } else if ('space' === key.name) {
                //  stupid hack to always get space as a regular char
                ch = ' ';
            }

            if (_.isUndefined(key.name)) {
                key = undefined;
            } else {
                //
                //  Adjust name for CTRL/Shift/Meta modifiers
                //
                key.name =
                    (key.ctrl ? 'ctrl + ' : '') +
                    (key.meta ? 'meta + ' : '') +
                    (key.shift ? 'shift + ' : '') +
                    key.name;
            }

            if (key || ch) {
                if (Config().logging.traceUserKeyboardInput) {
                    self.log.trace({ key: key, ch: escape(ch) }, 'User keyboard input'); // jshint ignore:line
                }

                self.lastActivityTime = Date.now();

                if (!self.ignoreInput) {
                    self.emit('key press', ch, key);
                }
            }
        });
    });
}

require('util').inherits(Client, stream);

Client.prototype.setInputOutput = function (input, output) {
    this.input = input;
    this.output = output;

    this.term = new term.ClientTerminal(this.output);
};

Client.prototype.setTermType = function (termType) {
    this.term.env.TERM = termType;
    this.term.termType = termType;

    this.log.debug({ termType: termType }, 'Set terminal type');
};

Client.prototype.startIdleMonitor = function () {
    //  clear existing, if any
    if (this.idleCheck) {
        this.stopIdleMonitor();
    }

    this.lastActivityTime = Date.now();

    //
    //  Every 1m, check for idle.
    //  We also update minutes spent online the system here,
    //  if we have a authenticated user.
    //
    this.idleCheck = setInterval(() => {
        const nowMs = Date.now();

        let idleLogoutSeconds;
        if (this.user.isAuthenticated()) {
            idleLogoutSeconds = Config().users.idleLogoutSeconds;

            //
            //  We don't really want to be firing off an event every 1m for
            //  every user, but want at least some updates for various things
            //  such as achievements. Send off every 5m.
            //
            const minOnline = this.user.incrementProperty(
                UserProps.MinutesOnlineTotalCount,
                1
            );
            if (0 === minOnline % 5) {
                Events.emit(Events.getSystemEvents().UserStatIncrement, {
                    user: this.user,
                    statName: UserProps.MinutesOnlineTotalCount,
                    statIncrementBy: 1,
                    statValue: minOnline,
                });
            }
        } else {
            idleLogoutSeconds = Config().users.preAuthIdleLogoutSeconds;
        }

        //  use override value if set
        idleLogoutSeconds = this.idleLogoutSecondsOverride || idleLogoutSeconds;

        if (
            idleLogoutSeconds > 0 &&
            nowMs - this.lastActivityTime >= idleLogoutSeconds * 1000
        ) {
            this.emit('idle timeout');
        }
    }, 1000 * 60);
};

Client.prototype.stopIdleMonitor = function () {
    if (this.idleCheck) {
        clearInterval(this.idleCheck);
        delete this.idleCheck;
    }
};

Client.prototype.explicitActivityTimeUpdate = function () {
    this.lastActivityTime = Date.now();
};

Client.prototype.overrideIdleLogoutSeconds = function (seconds) {
    this.idleLogoutSecondsOverride = seconds;
};

Client.prototype.restoreIdleLogoutSeconds = function () {
    delete this.idleLogoutSecondsOverride;
};

Client.prototype.end = function () {
    if (this.term) {
        this.term.disconnect();
    }

    Events.removeListener(
        Events.getSystemEvents().ThemeChanged,
        this.themeChangedListener
    );

    const currentModule = this.menuStack.getCurrentModule;

    if (currentModule) {
        currentModule.leave();
    }

    //  persist time online for authenticated users
    if (this.user.isAuthenticated()) {
        this.user.persistProperty(
            UserProps.MinutesOnlineTotalCount,
            this.user.getProperty(UserProps.MinutesOnlineTotalCount)
        );
    }

    this.stopIdleMonitor();

    try {
        //
        //  We can end up calling 'end' before TTY/etc. is established, e.g. with SSH
        //
        if (_.isFunction(this.disconnect)) {
            return this.disconnect();
        } else {
            //  legacy fallback
            return this.output.end.apply(this.output, arguments);
        }
    } catch (e) {
        //  ie TypeError
    }
};

Client.prototype.destroy = function () {
    return this.output.destroy.apply(this.output, arguments);
};

Client.prototype.destroySoon = function () {
    return this.output.destroySoon.apply(this.output, arguments);
};

Client.prototype.waitForKeyPress = function (cb) {
    this.once('key press', function kp(ch, key) {
        cb(ch, key);
    });
};

Client.prototype.isLocal = function () {
    //  :TODO: Handle ipv6 better
    return ['127.0.0.1', '::ffff:127.0.0.1'].includes(this.remoteAddress);
};

///////////////////////////////////////////////////////////////////////////////
//  Default error handlers
///////////////////////////////////////////////////////////////////////////////

//  :TODO: getDefaultHandler(name) -- handlers in default_handlers.js or something
Client.prototype.defaultHandlerMissingMod = function () {
    var self = this;

    function handler(err) {
        self.log.error(err);

        self.term.write(ansi.resetScreen());
        self.term.write('An unrecoverable error has been encountered!\n');
        self.term.write('This has been logged for your SysOp to review.\n');
        self.term.write('\nGoodbye!\n');

        //self.term.write(err);

        //if(miscUtil.isDevelopment() && err.stack) {
        //  self.term.write('\n' + err.stack + '\n');
        //}

        self.end();
    }

    return handler;
};

Client.prototype.terminalSupports = function (query) {
    const termClient = this.term.termClient;

    switch (query) {
        case 'vtx_audio':
            //  https://github.com/codewar65/VTX_ClientServer/blob/master/vtx.txt
            return 'vtx' === termClient;

        case 'vtx_hyperlink':
            return 'vtx' === termClient;

        default:
            return false;
    }
};
