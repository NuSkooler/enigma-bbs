'use strict';

const { EventEmitter } = require('events');

const MAX_FRAME_PAYLOAD = 0x7fff; // 32,767 bytes

//
//  Stream-oriented BinkP frame parser.
//
//  Push raw TCP chunks via push(); emits 'frame' events:
//    { type: 'command', cmd: <number>, arg: <string> }
//    { type: 'data',    data: <Buffer> }          (data.length === 0 → EOF)
//
class FrameParser extends EventEmitter {
    constructor() {
        super();
        this._buf = Buffer.alloc(0);
    }

    push(chunk) {
        this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
        this._parse();
    }

    _parse() {
        while (this._buf.length >= 2) {
            const isCommand = (this._buf[0] & 0x80) !== 0;
            const size = ((this._buf[0] & 0x7f) << 8) | this._buf[1];

            if (this._buf.length < 2 + size) break;

            const payload = this._buf.slice(2, 2 + size);
            this._buf = this._buf.slice(2 + size);

            if (isCommand) {
                if (size < 1) continue; // malformed — no command byte
                const cmd = payload[0];
                const arg =
                    size > 1 ? payload.slice(1).toString('utf8').replace(/\0+$/, '') : '';
                this.emit('frame', { type: 'command', cmd, arg });
            } else {
                // data frame; size === 0 means EOF
                this.emit('frame', { type: 'data', data: payload });
            }
        }
    }
}

// Build a command frame: [T=1][size 15-bit][cmd byte][arg utf8]
function buildCommandFrame(cmd, arg) {
    const argBuf = arg ? Buffer.from(arg, 'utf8') : Buffer.alloc(0);
    const size = 1 + argBuf.length;
    const header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | ((size >> 8) & 0x7f);
    header[1] = size & 0xff;
    return Buffer.concat([header, Buffer.from([cmd]), argBuf]);
}

// Build a data frame: [T=0][size 15-bit][data]
function buildDataFrame(data) {
    const size = data.length;
    if (size > MAX_FRAME_PAYLOAD) {
        throw new RangeError(`Data frame too large: ${size}`);
    }
    const header = Buffer.allocUnsafe(2);
    header[0] = (size >> 8) & 0x7f;
    header[1] = size & 0xff;
    return Buffer.concat([header, data]);
}

// Zero-length data frame signals end of file stream
const EOF_FRAME = Buffer.from([0x00, 0x00]);

module.exports = {
    FrameParser,
    buildCommandFrame,
    buildDataFrame,
    EOF_FRAME,
    MAX_FRAME_PAYLOAD,
};
