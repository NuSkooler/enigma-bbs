'use strict';

//
//  ENiGMA½ <-> Amiga door shim protocol, version 1: framing only.
//
//  One byte stream each way over the emulated UART. Door terminal traffic is
//  unframed; control messages are framed as
//
//      0x1E  type  len_hi  len_lo  payload[len]
//
//  and a literal 0x1E in terminal traffic travels as 0x1E 0x1E. Payloads are
//  ISO-8859-1 `key=value` lines separated by '\n'. Upper case types go shim ->
//  host, lower case host -> shim. misc/amiga_door/README.md (Protocol) lists
//  the frames and keys; the shim's side is misc/amiga_door/shim/axshim.c.
//
//  Plain module, Node built-ins only, so the PoC harness and tests can use it.
//
const { EventEmitter } = require('events');

const RS = 0x1e;
const MAX_PAYLOAD = 0xffff;
const PROTOCOL_VERSION = 1;

//  Frame types by direction (informational; the decoder accepts any type)
const ShimTypes = {
    Hello: 'H',
    Ready: 'R',
    Launched: 'L',
    Command: 'C',
    Editor: 'E',
    Exit: 'X',
};

const HostTypes = {
    Session: 's',
    Time: 't',
    Disconnect: 'd',
    Window: 'w',
    EditorDone: 'e',
};

const KEY_RE = /^[a-z][a-z0-9_]*$/;

function typeByte(type) {
    if (typeof type === 'number') {
        if (!Number.isInteger(type) || type < 0 || type > 0xff || type === RS) {
            throw new TypeError(`invalid frame type: ${type}`);
        }
        return type;
    }
    if (typeof type !== 'string' || !/^[A-Za-z]$/.test(type)) {
        throw new TypeError(`invalid frame type: ${JSON.stringify(type)}`);
    }
    return type.charCodeAt(0);
}

function valueString(value) {
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('latin1');
    }
    return String(value);
}

//  { key: value, ... } -> Buffer of "key=value" lines (no trailing '\n').
//  null/undefined values are left out; booleans become 1/0.
function encodeKeys(obj) {
    const lines = [];
    for (const [key, value] of Object.entries(obj || {})) {
        if (value === undefined || value === null) {
            continue;
        }
        if (!KEY_RE.test(key)) {
            throw new TypeError(`invalid payload key: ${JSON.stringify(key)}`);
        }
        const v = valueString(value);
        if (/[\n\r]/.test(v)) {
            throw new TypeError(`payload value for "${key}" contains a line break`);
        }
        lines.push(`${key}=${v}`);
    }
    return Buffer.from(lines.join('\n'), 'latin1');
}

//  Buffer|string of "key=value" lines -> { key: value }. Lines without '=' are
//  ignored, a trailing CR is dropped, the last duplicate wins.
function parseKeys(payload) {
    const text = Buffer.isBuffer(payload)
        ? payload.toString('latin1')
        : String(payload || '');
    const keys = {};
    for (let line of text.split('\n')) {
        if (line.endsWith('\r')) {
            line = line.slice(0, -1);
        }
        const eq = line.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        keys[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return keys;
}

function payloadBuffer(payload) {
    if (payload === undefined || payload === null) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(payload)) {
        return payload;
    }
    if (payload instanceof Uint8Array) {
        return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    if (typeof payload === 'string') {
        return Buffer.from(payload, 'latin1');
    }
    if (typeof payload === 'object') {
        return encodeKeys(payload);
    }
    throw new TypeError('payload must be an object, Buffer or string');
}

//  encode('s', { version: 1, door: 'BBS:Doors/X/x' }) -> framed Buffer
function encode(type, payload) {
    const t = typeByte(type);
    const body = payloadBuffer(payload);
    if (body.length > MAX_PAYLOAD) {
        throw new RangeError(`frame payload too long: ${body.length} > ${MAX_PAYLOAD}`);
    }
    const header = Buffer.from([RS, t, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([header, body]);
}

//  Terminal data for the other side: every 0x1E doubled.
function escapeData(data) {
    const buf = payloadBuffer(data);
    let count = 0;
    for (const b of buf) {
        if (b === RS) {
            ++count;
        }
    }
    if (0 === count) {
        return buf;
    }
    const out = Buffer.alloc(buf.length + count);
    let o = 0;
    for (const b of buf) {
        out[o++] = b;
        if (b === RS) {
            out[o++] = RS;
        }
    }
    return out;
}

//  The `str=` value of a C frame: '\', control bytes (CR, LF, 0x1E ...) and 0x7F
//  as \xNN. escapeC() is what the shim does; unescapeC() undoes it.
function escapeC(data) {
    const buf = payloadBuffer(data);
    let out = '';
    for (const b of buf) {
        if (b < 0x20 || b === 0x7f || b === 0x5c) {
            out += '\\x' + b.toString(16).padStart(2, '0');
        } else {
            out += String.fromCharCode(b);
        }
    }
    return out;
}

//  '\xNN' -> the byte; anything else (a lone '\' included) is kept as is.
//  Returns a Buffer of the original bytes.
function unescapeC(str) {
    const s = String(str || '');
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
        if (
            s[i] === '\\' &&
            s[i + 1] === 'x' &&
            /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))
        ) {
            bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
            i += 3;
        } else {
            bytes.push(s.charCodeAt(i) & 0xff);
        }
    }
    return Buffer.from(bytes);
}

const State = {
    Data: 0,
    Escape: 1,
    LenHi: 2,
    LenLo: 3,
    Payload: 4,
};

//
//  Streaming decoder: feed it chunks as they arrive (split anywhere), get back
//  events in stream order:
//
//      { data: Buffer }                                      terminal bytes, unescaped
//      { frame: { type, payload: Buffer, keys: {...} } }     a control frame
//
//  The same events are also emitted as 'data' (Buffer) and 'frame' (frame).
//  options.accept: string or iterable of the frame types wanted; others are
//  skipped by their length and counted in `skipped` (default: accept all).
//
class Decoder extends EventEmitter {
    constructor(options = {}) {
        super();
        this.accept = options.accept ? new Set(options.accept) : null;
        this.skipped = 0;
        this.reset();
    }

    reset() {
        this.state = State.Data;
        this.type = null;
        this.len = 0;
        this.payload = null;
        this.got = 0;
    }

    //  Mid-frame (or mid-escape) at the end of the last chunk?
    get pending() {
        return this.state !== State.Data;
    }

    push(chunk) {
        const buf = payloadBuffer(chunk);
        const events = [];
        let dataStart = -1; //  start of the current run of plain data in buf
        let escaped = null; //  data bytes collected across an RS RS pair

        const flushData = end => {
            if (dataStart >= 0 && end > dataStart) {
                const run = buf.subarray(dataStart, end);
                escaped = escaped ? Buffer.concat([escaped, run]) : Buffer.from(run);
            }
            dataStart = -1;
        };
        const emitData = () => {
            if (escaped && escaped.length) {
                events.push({ data: escaped });
            }
            escaped = null;
        };

        for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            switch (this.state) {
                case State.Data:
                    if (b === RS) {
                        flushData(i);
                        this.state = State.Escape;
                    } else if (dataStart < 0) {
                        dataStart = i;
                    }
                    break;

                case State.Escape:
                    if (b === RS) {
                        //  a literal 0x1E: stays part of the data run
                        escaped = escaped
                            ? Buffer.concat([escaped, Buffer.from([RS])])
                            : Buffer.from([RS]);
                        this.state = State.Data;
                    } else {
                        emitData();
                        this.type = String.fromCharCode(b);
                        this.state = State.LenHi;
                    }
                    break;

                case State.LenHi:
                    this.len = b << 8;
                    this.state = State.LenLo;
                    break;

                case State.LenLo:
                    this.len |= b;
                    this.payload = Buffer.alloc(this.len);
                    this.got = 0;
                    if (0 === this.len) {
                        this._frameDone(events);
                    } else {
                        this.state = State.Payload;
                    }
                    break;

                case State.Payload: {
                    const n = Math.min(this.len - this.got, buf.length - i);
                    buf.copy(this.payload, this.got, i, i + n);
                    this.got += n;
                    i += n - 1;
                    if (this.got === this.len) {
                        this._frameDone(events);
                    }
                    break;
                }
            }
        }
        flushData(buf.length);
        emitData();

        for (const e of events) {
            if (e.data) {
                this.emit('data', e.data);
            } else {
                this.emit('frame', e.frame);
            }
        }
        return events;
    }

    _frameDone(events) {
        const type = this.type;
        const payload = this.payload;
        this.state = State.Data;
        this.type = null;
        this.payload = null;
        if (this.accept && !this.accept.has(type)) {
            ++this.skipped;
            return;
        }
        events.push({ frame: { type, payload, keys: parseKeys(payload) } });
    }
}

module.exports = {
    RS,
    MAX_PAYLOAD,
    PROTOCOL_VERSION,
    ShimTypes,
    HostTypes,
    encode,
    encodeKeys,
    parseKeys,
    escapeData,
    escapeC,
    unescapeC,
    Decoder,
};
