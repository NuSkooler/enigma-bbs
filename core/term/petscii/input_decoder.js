/* jslint node: true */
'use strict';

//
//  The PETSCII input decoder (#593): turns what a C64-class terminal sends
//  into key presses. Drop-in for the ANSI decoder (../ansi/input_decoder.js):
//
//      decode(data, host, emit)    emit('key press', ch, key), synchronously,
//                                  in stream order
//
//  |key| is the same shape the ANSI decoder emits ({ seq, name, ctrl, meta,
//  shift }, name carrying 'ctrl + ' / 'shift + ' prefixes), or undefined for
//  a plain character, so views and menus cannot tell the two apart. |host| is
//  accepted for the shared contract and never used: PETSCII has no
//  backspace-vs-delete ambiguity. |seq| is the single raw byte as a one-char
//  string.
//
//  Only ./charset.js and Node built-ins are imported so this can move to
//  another package with it.
//
//  WIRE FACTS
//  ----------
//  *   A PETSCII terminal sends no escape sequences and answers none of
//      ENiGMA's ANSI queries, so this decoder never emits the query-reply
//      events (cursor position report, device attributes, ...).
//  *   One byte, one key. 0x80-0xFF are ordinary PETSCII, so there is none of
//      the ANSI decoder's "lone high byte means ESC + (byte - 128)" rule.
//  *   Nothing is buffered between calls.
//
//  KEY TABLE
//  ---------
//  Keys come from charset.js KeyBytes (real C64 keyboard codes, which is what
//  SyncTERM cterm.c `petscii_keys` sends): return 0D/8D, arrows 11/1D/91/9D,
//  home 13, clear 93, backspace 14, insert 94, F1-F8 85 89 86 8A 87 8B 88 8C.
//
//  F1 IS ESCAPE
//  ------------
//  A Commodore keyboard has no Escape key, yet ENiGMA reaches some things
//  only through Escape (the full-screen editor's menu, leaving a form). So F1
//  (0x85) is reported exactly as 0x1B is: ch '\x1b', name 'escape'. seq stays
//  the raw byte. The F1 key as such is therefore never reported for a PETSCII
//  session; F2-F8 are. Terminals that do send 0x1B (SyncTERM, IcyTerm) keep
//  working, as both bytes mean the same key.
//
//  Where IcyTerm (icy_engine_gui terminal_keys.rs C64_KEY_MAP) differs:
//
//      Escape      both send 0x1B                            same
//      Tab         neither maps it; 0x09 as typed            handled as ANSI tab
//      Delete      icy sends 0x14 (backspace); SyncTERM too  same
//      End         SyncTERM sends 0x93 (clear); icy none     end (see below)
//      F-keys      icy sends F1..F8 as 85 86 87 88 89 8A 8B 8C, i.e. sequential,
//                  while the C64 keyboard and SyncTERM use 85 89 86 8A 87 8B 88 8C.
//                  Icy's F2 therefore arrives as byte 0x86 and reads as 'f3'.
//                  One byte cannot mean two keys; the real C64 / SyncTERM
//                  meaning wins. (Icy's Shift+F1/F3/F5/F7 send 89/8A/8B/8C,
//                  which come out as f2/f4/f6/f8: Shift-F1 is F2 on a C64, so
//                  that part is right.) Icy's Shift+Home 0x93 is clear.
//
//  LETTERS
//  -------
//  Whatever charset the screen shows, 0x41-0x5A are the unshifted letter keys
//  and give lower case; 0xC1-0xDA and their mirror 0x61-0x7A are the shifted
//  keys and give upper case with shift: true.
//
//  OTHER PRINTABLE BYTES
//  ---------------------
//  Through byteToUnicode(byte, LowerUpper). Bytes that decode to a glyph text
//  input cannot use (the PUA range 0xEC00-0xEDFF, box/block graphics, card
//  suits, pi) are still emitted, as ch with no key name; consumers that only
//  accept printable text decide for themselves what to do with them.
//
//  The pound sign, up arrow and left arrow (0x5C, 0x5E, 0x5F) are what the C64
//  keyboard sends for the keys sitting in the ASCII backslash, caret and
//  underscore positions, so they are reported as '\', '^' and '_' to let
//  users type those characters.
//
//  CONTROL BYTES
//  -------------
//  Colour, reverse and charset-switch bytes (a user can type them with
//  Ctrl/Commodore + digit and so on) are swallowed: 05 0E 12 1C 1E 1F 81 8E
//  90 92 95-9C 9E 9F. So are the remaining C1 bytes (80 82 83 84 8F) and NUL,
//  none of which has a key meaning.
//
//  The other C0 bytes are reported as the ANSI decoder reports them: 08 is
//  backspace, 09 tab, 0A line feed, 1B escape (immediately, nothing can
//  follow it; F1 is the same key, see above), 01-1A otherwise
//  'ctrl + <letter>'. A byte KeyBytes claims wins over that, so these ctrl
//  combinations are NOT available: ctrl+e (05 white), ctrl+n (0E charset),
//  ctrl+q (11 down), ctrl+r (12 reverse), ctrl+s (13 home), ctrl+t (14
//  backspace). ctrl+m (0D) is return as in ANSI,
//  ctrl+h/i/j are backspace/tab/line feed as in ANSI. 1C-1F ctrl+\ ] ^ _ have
//  no ANSI name; 1D is cursor right, the rest are colours.
//
const { Charsets, KeyBytes, byteToUnicode } = require('./charset.js');

const SWALLOWED = new Set([
    0x00, 0x05, 0x0e, 0x12, 0x1c, 0x1e, 0x1f, 0x80, 0x81, 0x82, 0x83, 0x84, 0x8e, 0x8f,
    0x90, 0x92, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f,
]);

//  the F1 key; reported as Escape
const F1 = 0x85;

//  pound sign, up arrow, left arrow glyphs -> the ASCII keys in those positions
const ASCII_POSITION_KEYS = new Map([
    [0x5c, '\\'],
    [0x5e, '^'],
    [0x5f, '_'],
]);

function makeKey(byte, name, mods) {
    return Object.assign(
        {
            seq: String.fromCharCode(byte),
            name,
            ctrl: false,
            meta: false,
            shift: false,
        },
        mods
    );
}

//  returns [ch, key] or undefined when the byte is swallowed
function decodeByte(byte) {
    const seq = String.fromCharCode(byte);

    if (SWALLOWED.has(byte)) {
        return;
    }

    //  return is a character too ('\r'), the other named keys are not
    if (0x0d === byte || 0x8d === byte) {
        return ['\r', makeKey(byte, 'return')];
    }

    //
    //  0x93 is CLR (Shift+HOME) on a C64, and it is what SyncTERM sends for
    //  the End key. Nothing in ENiGMA acts on a 'clear' key, while 'end' is a
    //  generic list and editor key with no other PETSCII byte (its usual
    //  alternative, ctrl + e, is the colour byte 0x05). So CLR is End here.
    //
    if (0x1b === byte || F1 === byte) {
        return ['\x1b', makeKey(byte, 'escape')]; //  F1 is Escape: see above
    }

    const keyName = 0x93 === byte ? 'end' : KeyBytes[byte];
    if (keyName) {
        //  backspace is '\b' the way the ANSI decoder reports Ctrl-H
        return ['backspace' === keyName ? '\b' : undefined, makeKey(byte, keyName)];
    }

    if (0x08 === byte) {
        return [seq, makeKey(byte, 'backspace')];
    }
    if (0x09 === byte) {
        return [seq, makeKey(byte, 'tab')];
    }
    if (0x0a === byte) {
        return [seq, makeKey(byte, 'line feed')];
    }

    if (byte >= 0x01 && byte <= 0x1a) {
        return [
            seq,
            makeKey(byte, 'ctrl + ' + String.fromCharCode(byte + 0x60), { ctrl: true }),
        ];
    }

    if (byte < 0x20 || (byte >= 0x80 && byte <= 0x9f)) {
        return; //  the rest of C0 / C1: nothing a key press can express
    }

    //  letters, in either screen charset
    if (byte >= 0x41 && byte <= 0x5a) {
        const name = String.fromCharCode(byte + 0x20);
        return [name, makeKey(byte, name)];
    }
    if ((byte >= 0xc1 && byte <= 0xda) || (byte >= 0x61 && byte <= 0x7a)) {
        const lower = String.fromCharCode((byte & 0x1f) + 0x60);
        return [lower.toUpperCase(), makeKey(byte, 'shift + ' + lower, { shift: true })];
    }

    const ascii = ASCII_POSITION_KEYS.get(byte);
    const ch = ascii || byteToUnicode(byte, Charsets.LowerUpper);

    if (' ' === ch) {
        return [ch, makeKey(byte, 'space')]; //  0x20 and shifted space 0xA0
    }
    return [ch, undefined];
}

function decode(data, host, emit) {
    const bytes = 'string' === typeof data ? Buffer.from(data, 'latin1') : data;

    for (let i = 0; i < bytes.length; ++i) {
        const decoded = decodeByte(bytes[i]);
        if (decoded) {
            emit('key press', decoded[0], decoded[1]);
        }
    }
}

//  nothing is kept between chunks, so one decoder serves every caller
function createPetsciiInputDecoder() {
    return { decode };
}

module.exports = {
    createPetsciiInputDecoder,
    decode,
};
