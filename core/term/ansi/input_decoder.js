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

//
//  The ANSI input decoder: turns what an ANSI-BBS / xterm class terminal
//  sends into key presses and query replies. No ENiGMA imports: the client
//  owns what happens with each event (logging, CPR offset, capability
//  storage, 'key press').
//
//  decode(data, host, emit) calls emit(eventName, ...args) synchronously and
//  in stream order for:
//
//      'key press', ch, key              a key; either may be undefined
//      'cursor position report', [r, c]  CPR, before any home-position offset
//      'device attributes', { termClient, version }    a DA reply we know
//      'cterm capability response', { id, value }      CSI = Ps ; Pv n
//      'cterm device attributes', caps   a CTDA reply, parsed
//      'rip version', reply              the RIPscrip version reply, e.g.
//                                        'RIPSCRIP015410', once at most, in
//                                        the window after the query (decoder
//                                        instances only; see
//                                        createAnsiInputDecoder)
//
//  |host| supplies the one piece of terminal state key naming needs:
//
//      host.isNixTerm()    true when 0x7f means backspace (xterm class)
//
//  It is asked per key, not once per chunk, because a reply handled earlier
//  in the same chunk can change the answer.
//
const {
    getTermClientFromDeviceAttr,
    getCtermCapabilitiesFromCtda,
} = require('./device_attributes.js');
const { createRipReplyScanner } = require('../rip/reply_scanner.js');
const assert = require('assert');

//
//  Resources & Standards:
//  * http://www.ansi-bbs.org/ansi-bbs-core-server.html
//
/* eslint-disable no-control-regex */
const RE_DSR_RESPONSE_ANYWHERE = /(?:\u001b\[)([0-9;]+)(R)/;
const RE_DEV_ATTR_RESPONSE_ANYWHERE = /(?:\u001b\[)[=?]([0-9a-zA-Z;]+)(c)/;
//  CTerm capability query response: ESC [ = <id> ; <value> n
//  e.g. \x1b[=6;1n  → capability 6 (OSC 8 hyperlinks) supported
//  See https://syncterm.bbsdev.net/cterm.html
const RE_CTERM_CAP_RESPONSE_ANYWHERE = /\u001b\[=([0-9]+);([0-9]+)n/;
//  CTerm Device Attributes (CTDA) response: ESC [ < 0 ; Ps... c
//  e.g. \x1b[<0;1;2;3;5c. CTerm builds from before 2020-04-25 (Synchronet
//  commit 3c5bb707, ahead of the SyncTERM 1.1 release) ended it with 'n'
//  instead; both are taken so neither leaks into input as keystrokes.
//  IcyTerm 0.8.0 to 0.8.4 leave the leading 0 out (\x1b[<1;2;3;4;5;6;7c).
//  Ends in c or n only: SGR mouse reports, which also start ESC [ <, end in
//  M or m.
const RE_CTDA_RESPONSE_ANYWHERE = /\u001b\[<([0-9]+(?:;[0-9]*)*)([cn])/;
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
        RE_CTERM_CAP_RESPONSE_ANYWHERE.source,
        RE_CTDA_RESPONSE_ANYWHERE.source,
        /\u001b./.source, //  eslint-disable-line no-control-regex
    ].join('|')
);

/* eslint-disable no-control-regex */
function isMouseInput(data) {
    return (
        /\x1b\[M/.test(data) ||
        /\u001b\[M([\x00\u0020-\uffff]{3})/.test(data) ||
        /\u001b\[(\d+;\d+;\d+)M/.test(data) ||
        /\u001b\[<(\d+;\d+;\d+)([mM])/.test(data) ||
        /\u001b\[<(\d+;\d+;\d+;\d+)&w/.test(data) ||
        /\u001b\[24([0135])~\[(\d+),(\d+)\]\r/.test(data) ||
        /\u001b\[(O|I)/.test(data)
    );
}
/* eslint-enable no-control-regex */

const KeyComponentsByCode = {
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
};

//  a fresh object per call, as callers have always been handed
function getKeyComponentsFromCode(code) {
    const components = KeyComponentsByCode[code];
    return components ? Object.assign({}, components) : undefined;
}

function decode(data, host, emit) {
    //  create a uniform format that can be parsed below
    if (data[0] > 127 && undefined === data[1]) {
        data[0] -= 128;
        data = '\u001b' + data.toString('utf-8');
    } else {
        data = data.toString('utf-8');
    }

    if (isMouseInput(data)) {
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
                    emit('cursor position report', cprArgs);
                }
            }
        } else if ((parts = RE_DEV_ATTR_RESPONSE_ANYWHERE.exec(s))) {
            assert('c' === parts[2]);
            const identified = getTermClientFromDeviceAttr(parts[1]);
            if (identified) {
                emit('device attributes', identified);
            }
        } else if ((parts = RE_CTERM_CAP_RESPONSE_ANYWHERE.exec(s))) {
            emit('cterm capability response', {
                id: parseInt(parts[1], 10),
                value: parseInt(parts[2], 10),
            });
        } else if ((parts = RE_CTDA_RESPONSE_ANYWHERE.exec(s))) {
            const caps = getCtermCapabilitiesFromCtda(parts[1]);
            emit('cterm device attributes', caps);
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
            //  See https://www.hypexr.org/linux_ruboff.html
            //  And a great discussion @ https://lists.debian.org/debian-i18n/1998/04/msg00015.html
            //
            if (host.isNixTerm()) {
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
                (parts[1] || '') + (parts[2] || '') + (parts[4] || '') + (parts[9] || '');

            var modifier = (parts[3] || parts[8] || 1) - 1;

            key.ctrl = !!(modifier & 4);
            key.meta = !!(modifier & 10);
            key.shift = !!(modifier & 1);
            key.code = code;

            Object.assign(key, getKeyComponentsFromCode(code));
        }

        var ch;
        if (1 === s.length) {
            ch = s;
        } else if ('space' === key.name) {
            //  stupid hack to always get space as a regular char
            ch = ' ';
        }

        if (key.name === undefined) {
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
            emit('key press', ch, key);
        }
    });
}

//
//  A decoder for one connection. Key and query reply decoding keeps nothing
//  between chunks (that is decode() above); in front of it sits the RIPscrip
//  reply scanner (../rip/reply_scanner.js). expectRipReply() is called as the
//  version query is sent; from then until the window closes (30 seconds) the
//  scanner takes the first reply out of the input and reports it as
//  'rip version'. Before and after, input goes straight to decode(). The
//  scanner can hold back a few bytes that might start a reply split across
//  chunks, so it is per connection, and dispose() drops what it holds.
//
//  |options.ripReply| is passed to the scanner ({ windowMs, holdMs,
//  nulWindowMs }).
//
function createAnsiInputDecoder(options = {}) {
    const ripReplies = createRipReplyScanner(options.ripReply);

    return {
        expectRipReply() {
            ripReplies.expectReply();
        },
        decode(data, host, emit) {
            ripReplies.scan(data, {
                bytes: chunk => decode(chunk, host, emit),
                reply: reply => emit('rip version', reply),
            });
        },
        dispose() {
            ripReplies.dispose();
        },
    };
}

module.exports = {
    createAnsiInputDecoder,
    decode,
    isMouseInput,
    getKeyComponentsFromCode,
    RE_CTDA_RESPONSE: RE_CTDA_RESPONSE_ANYWHERE,
};
