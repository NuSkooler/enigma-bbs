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

module.exports = {
    HostLink,
    amigaCsiToAnsi,
};
