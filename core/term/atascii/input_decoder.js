/* jslint node: true */
'use strict';

//
//  The ATASCII input decoder (#593): turns what an Atari 8-bit terminal sends
//  (SyncTERM "Atari" modes, IcyTerm ATASCII mode, a real Atari) into key
//  presses. Drop-in for the ANSI decoder (../ansi/input_decoder.js):
//
//      const decoder = createAtasciiInputDecoder({ escTimeoutMs, ... });
//      decoder.decode(data, host, emit)   emit('key press', ch, key),
//                                         synchronously, in stream order
//      decoder.dispose()                  drop pending state and timer
//
//  |key| has the shape the ANSI decoder gives the equivalent key ({ seq, name,
//  ctrl, meta, shift }, name carrying 'ctrl + ' / 'shift + '), or is undefined
//  for a plain character. |host| is accepted and never used. Query replies
//  are never emitted: an Atari terminal answers none of them.
//
//  Only ./charset.js and Node built-ins are imported.
//
//  KEYS, PER CLIENT (bytes -> key; all hex)
//  ---------------------------------------
//                       SyncTERM        IcyTerm            real Atari
//      Return           0D (0D 0A)      9B                 9B
//      Backspace        08, 7E (Delete) 1B 7E              7E
//      Tab              09              (not mapped)       7F
//      Escape           1B              1B                 1B
//      Arrows           1C-1F           1B 1C-1F           1C-1F
//      Delete / Insert  FE / FF         -                  FE / FF
//      End              -               1B 9B              -
//      Ctrl+letter      01-1A           01-1A              (graphics)
//
//  Every byte is read the same whatever the client, so all of the above work
//  for every client.
//
//  RETURN
//  ------
//  Exactly one 'return' for each of 9B, 0D, 0D 0A and 0D 00. After a 0D the
//  next 0A or 00 is swallowed: always when it is in the same buffer, and when
//  it arrives in a later call only within crWindowMs (default 250) of the
//  0D, so a later, deliberate 0A (Ctrl+J, or a client sending bare LF) is not
//  lost. This needs no timer.
//
//  A bare 0A is 'line feed' (ch '\n'), exactly what the ANSI decoder reports
//  for it; the views already treat 'line feed' as Return where it matters (the
//  multi-line editor maps it to 'return'). Reading it as Return outright
//  would not double up anything (CR LF is handled above) but would diverge
//  from ANSI. It is also Ctrl+J, which a real Atari types as a graphic: the
//  ANSI reading wins over that, as it does for 0D (Ctrl+M).
//
//  ESCAPE VERSUS IcyTerm's ESC PREFIX
//  ----------------------------------
//  1B is the Escape key everywhere and also IcyTerm's prefix for arrows,
//  backspace and End. The ANSI decoder reports a trailing 1B as Escape at
//  once and has no timer; here that would turn a split ESC + arrow into
//  Escape + arrow, and menus act on Escape. So:
//
//      ESC + byte in EscPrefixedKeys (same buffer)  that key
//      ESC + any other byte (same buffer)           Escape, then the byte
//      ESC at the end of a buffer                   undecided
//
//  An undecided ESC is resolved by the next decode() call exactly as if the
//  bytes had been in one buffer, or by a timer after escTimeoutMs (default
//  100) when nothing follows, which emits Escape. The timer is unref()ed (it
//  never keeps the process alive), is cancelled by any later decode() and by
//  dispose(), holds the |emit| it was given, and swallows an exception from
//  it. Keys are never reordered: nothing is emitted after an undecided ESC
//  until it is resolved. escTimeoutMs: 0 turns lookahead across calls off
//  (a trailing ESC is Escape at once, like ANSI).
//
//  The client has no end-of-session hook for decoders yet: wiring should call
//  dispose() on disconnect. Without it the worst case is one Escape emitted
//  within escTimeoutMs of the last input, to a client that ignores it.
//
//  Side effect: a SyncTERM user who presses Escape and then Delete/arrow
//  within one TCP segment gets that prefixed key instead (not seen in
//  practice: that needs two key presses in one packet).
//
//  LETTERS, INVERSE VIDEO
//  ----------------------
//  Letters give lower case, or upper case with shift: true, like ANSI.
//  Inverse video (bit 7 set on a glyph byte, a real Atari's inverse key) is
//  stripped: A0-FC read as 20-7C. 80-9A (inverse of the graphics) are
//  graphics like 00-1A.
//
//  CONTROL BYTES
//  -------------
//  01-1A not claimed below are 'ctrl + <letter>' (ch = the raw byte), as in
//  ANSI. Unavailable as ctrl combinations: ctrl+h (backspace), ctrl+i (tab),
//  ctrl+m (return), and the StandIns below (ctrl+w, ctrl+x, ctrl+z). ctrl+j
//  is 'line feed'. 1B..1F are Escape/arrows, so ctrl+[ ] \ ^ _ do not exist.
//
//  Graphics a caller types (00-1A unmapped, 60, 7B, and the high-half
//  equivalents) are emitted as ch only, with no key, as the PETSCII decoder
//  does; text inputs drop non-printables. Control bytes with no key meaning
//  (7D clear, 9E, 9F, FD bell) are swallowed unless a stand-in takes them.
//  Characters a PC keyboard sends that ATASCII cannot type: ` { } ~ (60, 7B,
//  7D, 7E: graphics/controls).
//
//  STAND-INS
//  ---------
//  An Atari keyboard has no Home, End, Page Up/Down or function keys, and
//  SyncTERM sends none; ENiGMA lists and viewers page and jump with them. The
//  table below maps otherwise unused bytes to those keys (the multi-line
//  editor already has ctrl+a/ctrl+e for home/end). Disable with
//  createAtasciiInputDecoder({ standIns: false }).
//
const { KeyBytes, EscPrefixedKeys, byteToUnicode } = require('./charset.js');

const DEFAULT_ESC_TIMEOUT_MS = 100;
const DEFAULT_CR_WINDOW_MS = 250;

const ESC = 0x1b;

//  byte -> key name. Each of these bytes would otherwise be swallowed (7D, 9C,
//  9D: the Atari's clear-screen, delete-line and insert-line keys, nothing a
//  caller means by them) or is a ctrl combination nothing in ENiGMA binds.
const StandIns = Object.freeze({
    0x7d: 'home', //  Atari Ctrl+<  (clear screen)
    0x9c: 'page up', //  Atari Shift+Backspace (delete line)
    0x9d: 'page down', //  Atari Shift+> (insert line)
    0x17: 'page up', //  ctrl+w
    0x1a: 'page down', //  ctrl+z
    0x18: 'end', //  ctrl+x
});

//  control bytes with no key meaning, dropped
const SWALLOWED = new Set([0x7d, 0x9c, 0x9d, 0x9e, 0x9f, 0xfd]);

function makeKey(seq, name, mods) {
    return Object.assign({ seq, name, ctrl: false, meta: false, shift: false }, mods);
}

//  [ch, key] for a byte, never ESC; undefined when swallowed
function decodeByte(byte, standIns) {
    const seq = String.fromCharCode(byte);

    if (0x9b === byte) {
        return ['\r', makeKey(seq, 'return')];
    }
    if (standIns && standIns[byte]) {
        return [undefined, makeKey(seq, standIns[byte])];
    }
    if (SWALLOWED.has(byte)) {
        return;
    }

    const keyName = KeyBytes[byte];
    switch (keyName) {
        case 'return':
            return ['\r', makeKey(seq, 'return')];
        case 'backspace':
            return ['\b', makeKey(seq, 'backspace')];
        case 'tab':
            return ['\t', makeKey(seq, 'tab')];
        case undefined:
            break;
        default:
            return [undefined, makeKey(seq, keyName)]; //  arrows, insert, delete
    }

    if (0x0a === byte) {
        return ['\n', makeKey(seq, 'line feed')];
    }
    if (byte >= 0x01 && byte <= 0x1a) {
        return [
            seq,
            makeKey(seq, 'ctrl + ' + String.fromCharCode(byte + 0x60), { ctrl: true }),
        ];
    }

    //  everything left is a glyph; inverse video (bit 7) is not a different key
    const glyphByte = byte >= 0xa0 ? byte & 0x7f : byte;
    if (glyphByte >= 0x41 && glyphByte <= 0x5a) {
        const lower = String.fromCharCode(glyphByte + 0x20);
        return [
            String.fromCharCode(glyphByte),
            makeKey(seq, 'shift + ' + lower, { shift: true }),
        ];
    }
    if (glyphByte >= 0x61 && glyphByte <= 0x7a) {
        const name = String.fromCharCode(glyphByte);
        return [name, makeKey(seq, name)];
    }
    if (0x20 === glyphByte) {
        return [' ', makeKey(seq, 'space')];
    }

    //  graphics (00, 1x unmapped, 60, 7B, 80-9A) and punctuation/digits: ch only
    return [byteToUnicode(glyphByte), undefined];
}

function createAtasciiInputDecoder(options = {}) {
    const escTimeoutMs = Number.isFinite(options.escTimeoutMs)
        ? Math.max(0, options.escTimeoutMs)
        : DEFAULT_ESC_TIMEOUT_MS;
    const crWindowMs = Number.isFinite(options.crWindowMs)
        ? Math.max(0, options.crWindowMs)
        : DEFAULT_CR_WINDOW_MS;
    const standIns = false === options.standIns ? null : options.standIns || StandIns;

    let pendingEsc = false;
    let pendingEmit = null;
    let timer = null;
    let afterCr = false; //  next 0A / 00 belongs to a CR
    let crCall = 0;
    let crTime = 0;
    let callNo = 0;
    let disposed = false;

    const cancelTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const escapeKey = () => ['\x1b', makeKey('\x1b', 'escape')];

    function dispose() {
        disposed = true;
        cancelTimer();
        pendingEsc = false;
        pendingEmit = null;
        afterCr = false;
    }

    function decode(data, host, emit) {
        if (disposed || !data || 'function' !== typeof emit) {
            return;
        }
        const bytes = 'string' === typeof data ? Buffer.from(data, 'latin1') : data;

        cancelTimer();
        ++callNo;

        //  an emit that throws must not lose the rest of the buffer nor leave
        //  state half-updated: state is changed before emitting, the first error
        //  is rethrown at the end
        let firstError;
        const out = (ch, key) => {
            try {
                emit('key press', ch, key);
            } catch (e) {
                if (undefined === firstError) {
                    firstError = e;
                }
            }
        };

        for (let i = 0; i < bytes.length; ++i) {
            const byte = bytes[i] & 0xff;

            if (pendingEsc) {
                pendingEsc = false;
                const prefixed = EscPrefixedKeys[byte];
                if (prefixed) {
                    const seq = '\x1b' + String.fromCharCode(byte);
                    out(
                        'backspace' === prefixed ? '\b' : undefined,
                        makeKey(seq, prefixed)
                    );
                    continue;
                }
                out(...escapeKey());
                //  and the byte is read on its own
            }

            if (afterCr) {
                afterCr = false;
                if (
                    (0x0a === byte || 0x00 === byte) &&
                    (crCall === callNo || Date.now() - crTime <= crWindowMs)
                ) {
                    continue;
                }
            }

            if (ESC === byte) {
                pendingEsc = true;
                continue;
            }

            if (0x0d === byte) {
                afterCr = true;
                crCall = callNo;
                crTime = Date.now();
            }

            const decoded = decodeByte(byte, standIns);
            if (decoded) {
                out(decoded[0], decoded[1]);
            }
        }

        if (pendingEsc) {
            if (0 === escTimeoutMs) {
                pendingEsc = false;
                out(...escapeKey());
            } else {
                pendingEmit = emit;
                timer = setTimeout(() => {
                    timer = null;
                    const emitNow = pendingEmit;
                    pendingEmit = null;
                    if (!pendingEsc || !emitNow) {
                        return;
                    }
                    pendingEsc = false;
                    try {
                        const [ch, key] = escapeKey();
                        emitNow('key press', ch, key);
                    } catch (e) {
                        //  nobody to report to; a timer must never throw
                    }
                }, escTimeoutMs);
                timer.unref();
            }
        }

        if (undefined !== firstError) {
            throw firstError;
        }
    }

    return { decode, dispose };
}

module.exports = {
    createAtasciiInputDecoder,
    StandIns,
};
