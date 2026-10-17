'use strict';

//
//  The host end of the shim link: what the worker does with the raw byte
//  stream coming off the emulated UART, and the byte-level fix-ups door output
//  needs before it reaches a caller.
//
//  Kept apart from amiga_worker.js so it can be tested without an emulator,
//  and from protocol.js, which is framing only and shared with the PoC
//  harness.
//
//  Plain module, Node built-ins only.
//
const { RS, Decoder } = require('./protocol.js');

const HELLO = Buffer.from([RS, 'H'.charCodeAt(0)]);
const AMIGA_CSI = 0x9b;
const ESC = 0x1b;
const LEFT_BRACKET = 0x5b;

//
//  Shim -> host byte stream to events.
//
//  The AROS ROM prints its boot diagnostics ("ROMInfo: ...", board setup) to
//  the serial port before the shim opens it. That text is not ours and may
//  hold any byte, so nothing is decoded until the first `0x1E H`: the hello
//  frame is the first thing the shim ever sends. A link made for a restored
//  snapshot is told the hello is behind it (|helloSeen|), since the snapshot
//  was taken after it.
//
class HostLink {
    constructor({ helloSeen = false } = {}) {
        this.decoder = new Decoder();
        this.started = helloSeen; //  past the boot noise
        this.hello = null; //  keys of the H frame, once seen
        this.discarded = 0; //  boot noise bytes thrown away
        this.carry = Buffer.alloc(0); //  a trailing RS that may start the hello
    }

    //  Returns the decoder's events: { data: Buffer } and { frame }.
    push(bytes) {
        if (!bytes || 0 === bytes.length) {
            return [];
        }

        if (!this.started) {
            const buf = this.carry.length ? Buffer.concat([this.carry, bytes]) : bytes;
            const at = buf.indexOf(HELLO);
            if (at < 0) {
                const keep = RS === buf[buf.length - 1] ? 1 : 0;
                this.discarded += buf.length - keep;
                this.carry = keep ? Buffer.from([RS]) : Buffer.alloc(0);
                return [];
            }
            this.discarded += at;
            this.carry = Buffer.alloc(0);
            this.started = true;
            bytes = buf.subarray(at);
        }

        const events = this.decoder.push(bytes);
        for (const e of events) {
            if (e.frame && 'H' === e.frame.type && !this.hello) {
                this.hello = e.frame.keys;
            }
        }
        return events;
    }
}

//
//  Some Amiga doors use the single-byte CSI (0x9B) of the Amiga console. No
//  terminal a caller is likely to use understands it, so it becomes the
//  two-byte `ESC [`. Done on bytes, before any decoding: in ISO-8859-1 0x9B is
//  a C1 control, never a printable character, so the translation is always
//  safe and needs no state across chunks.
//
function amigaCsiToAnsi(buf) {
    let count = 0;
    for (const b of buf) {
        if (AMIGA_CSI === b) {
            ++count;
        }
    }
    if (0 === count) {
        return buf;
    }

    const out = Buffer.alloc(buf.length + count);
    let o = 0;
    for (const b of buf) {
        if (AMIGA_CSI === b) {
            out[o++] = ESC;
            out[o++] = LEFT_BRACKET;
        } else {
            out[o++] = b;
        }
    }
    return out;
}

//
//  Amiga console control sequences a PC terminal does not share, translated
//  on the byte stream so a caller sees what an Amiga caller would:
//
//    FF (0x0C)        the Amiga console clears the screen and homes the
//                     cursor. A PC terminal treats a form feed as something
//                     else (SyncTERM also drops the current font), so it
//                     becomes `ESC[2J ESC[H`.
//    CSI 0 SP p       cursor off  -> `ESC[?25l`
//    CSI [1] SP p     cursor on   -> `ESC[?25h`
//    ESC c            reset       -> attributes off, clear, home (keeps the font)
//    0x9B             the single-byte CSI -> `ESC [`
//
//  Cursor positions (CSI row;col H / f, CSI row d) past the caller's screen
//  are moved to its last row or column. That is what console.device does on
//  the Amiga: a position outside the window is clamped, never scrolled. Doors
//  written on a PAL Amiga assume up to 32 rows and address rows 26 and 27
//  freely; without the clamp an 80x25 caller's screen scrolls instead.
//
//  Everything else passes through untouched. A CSI sequence can be split
//  across two chunks, so the unfinished tail is held until it completes; a
//  tail that outgrows any real sequence is passed through as it is.
//
const FORM_FEED = 0x0c;
const CSI_MAX = 32;
const CLEAR_HOME = Buffer.from('\x1b[2J\x1b[H', 'latin1');
const RESET = Buffer.from('\x1b[0m\x1b[2J\x1b[H', 'latin1');
const CURSOR_OFF = Buffer.from('\x1b[?25l', 'latin1');
const CURSOR_ON = Buffer.from('\x1b[?25h', 'latin1');

class AmigaConsoleTranslator {
    constructor({ rows = 0, cols = 0 } = {}) {
        this.pending = null; //  bytes of an unfinished ESC sequence (starts with ESC)
        this.setSize(rows, cols);
    }

    //  The caller's screen; 0 means unknown, and no clamping on that axis.
    setSize(rows, cols) {
        this.rows = rows > 0 ? rows : 0;
        this.cols = cols > 0 ? cols : 0;
    }

    //  Returns the translated bytes; may be empty while a sequence is pending.
    push(bytes) {
        const parts = [];
        let plain = []; //  bytes since the last special byte

        const flushPlain = () => {
            if (plain.length) {
                parts.push(Buffer.from(plain));
                plain = [];
            }
        };

        let i = 0;
        const n = bytes.length;
        while (i < n) {
            if (this.pending) {
                //  continue an unfinished sequence
                const b = bytes[i++];
                this.pending.push(b);
                const done = this._sequenceDone();
                if (done) {
                    flushPlain();
                    parts.push(this._translateSequence(Buffer.from(this.pending)));
                    this.pending = null;
                } else if (this.pending.length > CSI_MAX) {
                    flushPlain();
                    parts.push(Buffer.from(this.pending));
                    this.pending = null;
                }
                continue;
            }

            const b = bytes[i];
            if (AMIGA_CSI === b) {
                this.pending = [ESC, LEFT_BRACKET];
                i++;
            } else if (ESC === b) {
                this.pending = [ESC];
                i++;
            } else if (FORM_FEED === b) {
                flushPlain();
                parts.push(CLEAR_HOME);
                i++;
            } else {
                plain.push(b);
                i++;
            }
        }
        flushPlain();
        return 1 === parts.length ? parts[0] : Buffer.concat(parts);
    }

    //  Whatever is still held, untranslated (the door is gone).
    flush() {
        if (!this.pending) {
            return Buffer.alloc(0);
        }
        const out = Buffer.from(this.pending);
        this.pending = null;
        return out;
    }

    _sequenceDone() {
        const p = this.pending;
        if (p.length < 2) {
            return false;
        }
        if (LEFT_BRACKET !== p[1]) {
            return true; //  ESC + one byte (ESC c, ESC d, ...)
        }
        //  CSI: parameters 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E
        const last = p[p.length - 1];
        return p.length > 2 && last >= 0x40 && last <= 0x7e;
    }

    _translateSequence(seq) {
        if (2 === seq.length) {
            return 0x63 === seq[1] ? RESET : seq; //  ESC c
        }
        const final = seq[seq.length - 1];
        const space = 0x20 === seq[seq.length - 2];
        if (0x70 === final && space) {
            //  CSI Pn SP p : cursor visibility
            const params = seq.subarray(2, seq.length - 2).toString('latin1');
            return '0' === params ? CURSOR_OFF : CURSOR_ON;
        }
        if (0x48 === final || 0x66 === final || 0x64 === final) {
            return this._clampPosition(seq, final);
        }
        return seq;
    }

    //  CSI row ; col H|f and CSI row d, with row and column held to the screen.
    //  The bytes are rewritten only when something was out of range, so a
    //  door whose output fits is passed through exactly.
    _clampPosition(seq, final) {
        const params = seq.subarray(2, seq.length - 1).toString('latin1');
        if (!/^[0-9;]*$/.test(params)) {
            return seq;
        }
        const parts = params.split(';');
        const row = parts[0] ? parseInt(parts[0], 10) : 0;
        const col = 0x64 === final ? 0 : parts[1] ? parseInt(parts[1], 10) : 0;
        const rowOver = this.rows > 0 && row > this.rows;
        const colOver = this.cols > 0 && col > this.cols;
        if (!rowOver && !colOver) {
            return seq;
        }
        const r = rowOver ? this.rows : parts[0] || '';
        if (0x64 === final) {
            return Buffer.from(`\x1b[${r}d`, 'latin1');
        }
        const c = colOver ? this.cols : parts[1] || '';
        const body = parts.length > 1 ? `${r};${c}` : `${r}`;
        return Buffer.from(`\x1b[${body}${String.fromCharCode(final)}`, 'latin1');
    }
}

module.exports = {
    HostLink,
    AmigaConsoleTranslator,
    amigaCsiToAnsi,
};
