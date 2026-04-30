'use strict';

const { strict: assert } = require('assert');
const {
    FrameParser,
    buildCommandFrame,
    buildDataFrame,
    EOF_FRAME,
    MAX_FRAME_PAYLOAD,
} = require('../core/binkp/frame');
const { Commands } = require('../core/binkp/commands');

// ── helpers ──────────────────────────────────────────────────────────────────

function collectFrames(chunks) {
    const parser = new FrameParser();
    const frames = [];
    parser.on('frame', f => frames.push(f));
    for (const c of chunks) parser.push(c);
    return frames;
}

function singleFrame(buf) {
    return collectFrames([buf]);
}

// ── buildCommandFrame ─────────────────────────────────────────────────────────

describe('buildCommandFrame', () => {
    it('sets the T bit (MSB of byte 0)', () => {
        const buf = buildCommandFrame(Commands.M_NUL, 'SYS test');
        assert.ok((buf[0] & 0x80) !== 0, 'T bit must be set');
    });

    it('encodes SIZE correctly in header bytes', () => {
        const arg = 'SYS test';
        const buf = buildCommandFrame(Commands.M_NUL, arg);
        const size = ((buf[0] & 0x7f) << 8) | buf[1];
        // payload = 1 (cmd byte) + arg bytes
        assert.equal(size, 1 + Buffer.byteLength(arg, 'utf8'));
    });

    it('places the command ID as the first payload byte', () => {
        const buf = buildCommandFrame(Commands.M_ADR, '1:2/3@fidonet');
        assert.equal(buf[2], Commands.M_ADR);
    });

    it('encodes the arg as utf-8 after the command byte', () => {
        const arg = 'SYS My BBS';
        const buf = buildCommandFrame(Commands.M_NUL, arg);
        const argBytes = buf.slice(3);
        assert.equal(argBytes.toString('utf8'), arg);
    });

    it('produces a 3-byte frame for a command with no arg', () => {
        const buf = buildCommandFrame(Commands.M_EOB, '');
        assert.equal(buf.length, 3); // 2-byte header + 1 cmd byte
        const size = ((buf[0] & 0x7f) << 8) | buf[1];
        assert.equal(size, 1);
    });

    it('handles multi-byte UTF-8 in the arg', () => {
        const arg = 'SYS Ünïcödé BBS';
        const buf = buildCommandFrame(Commands.M_NUL, arg);
        const [f] = singleFrame(buf);
        assert.equal(f.arg, arg);
    });
});

// ── buildDataFrame ────────────────────────────────────────────────────────────

describe('buildDataFrame', () => {
    it('clears the T bit (T=0)', () => {
        const buf = buildDataFrame(Buffer.from('hello'));
        assert.equal(buf[0] & 0x80, 0, 'T bit must be clear for data frames');
    });

    it('encodes SIZE in header bytes', () => {
        const data = Buffer.from('hello');
        const buf = buildDataFrame(data);
        const size = ((buf[0] & 0x7f) << 8) | buf[1];
        assert.equal(size, data.length);
    });

    it('payload follows the header verbatim', () => {
        const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const buf = buildDataFrame(data);
        assert.deepEqual(buf.slice(2), data);
    });

    it('encodes a max-size frame (32,767 bytes)', () => {
        const data = Buffer.alloc(MAX_FRAME_PAYLOAD, 0xaa);
        const buf = buildDataFrame(data);
        const size = ((buf[0] & 0x7f) << 8) | buf[1];
        assert.equal(size, MAX_FRAME_PAYLOAD);
        assert.equal(buf.length, 2 + MAX_FRAME_PAYLOAD);
    });

    it('throws RangeError for oversized data', () => {
        assert.throws(
            () => buildDataFrame(Buffer.alloc(MAX_FRAME_PAYLOAD + 1)),
            RangeError
        );
    });
});

// ── EOF_FRAME ─────────────────────────────────────────────────────────────────

describe('EOF_FRAME', () => {
    it('is exactly two zero bytes', () => {
        assert.equal(EOF_FRAME.length, 2);
        assert.equal(EOF_FRAME[0], 0x00);
        assert.equal(EOF_FRAME[1], 0x00);
    });
});

// ── FrameParser ───────────────────────────────────────────────────────────────

describe('FrameParser — command frames', () => {
    it('parses a complete command frame in a single push', () => {
        const [f] = singleFrame(buildCommandFrame(Commands.M_NUL, 'SYS My BBS'));
        assert.equal(f.type, 'command');
        assert.equal(f.cmd, Commands.M_NUL);
        assert.equal(f.arg, 'SYS My BBS');
    });

    it('strips trailing null bytes from arg', () => {
        // Some implementations pad the arg field with nulls
        const raw = Buffer.concat([
            buildCommandFrame(Commands.M_NUL, 'SYS test'),
            Buffer.from([0x00, 0x00]), // extra nulls (won't be parsed as part of arg)
        ]);
        // Just verify the arg has no trailing nulls
        const [f] = singleFrame(buildCommandFrame(Commands.M_NUL, 'SYS test\x00\x00'));
        assert.equal(f.arg, 'SYS test');
    });

    it('parses a command frame with an empty arg', () => {
        const [f] = singleFrame(buildCommandFrame(Commands.M_EOB, ''));
        assert.equal(f.type, 'command');
        assert.equal(f.cmd, Commands.M_EOB);
        assert.equal(f.arg, '');
    });

    it('parses multiple frames concatenated in a single push', () => {
        const combined = Buffer.concat([
            buildCommandFrame(Commands.M_NUL, 'SYS A'),
            buildCommandFrame(Commands.M_NUL, 'SYS B'),
            buildCommandFrame(Commands.M_ADR, '1:2/3@fidonet'),
        ]);
        const frames = singleFrame(combined);
        assert.equal(frames.length, 3);
        assert.equal(frames[0].arg, 'SYS A');
        assert.equal(frames[1].arg, 'SYS B');
        assert.equal(frames[2].arg, '1:2/3@fidonet');
    });
});

describe('FrameParser — data frames', () => {
    it('parses a complete data frame', () => {
        const [f] = singleFrame(buildDataFrame(Buffer.from('hello')));
        assert.equal(f.type, 'data');
        assert.deepEqual(f.data, Buffer.from('hello'));
    });

    it('parses the EOF frame (zero-length data)', () => {
        const [f] = singleFrame(EOF_FRAME);
        assert.equal(f.type, 'data');
        assert.equal(f.data.length, 0);
    });

    it('parses a max-size data frame', () => {
        const data = Buffer.alloc(MAX_FRAME_PAYLOAD, 0x42);
        const [f] = singleFrame(buildDataFrame(data));
        assert.equal(f.type, 'data');
        assert.equal(f.data.length, MAX_FRAME_PAYLOAD);
        assert.equal(f.data[0], 0x42);
    });
});

describe('FrameParser — partial / split reads', () => {
    it('reassembles a frame split across the header boundary', () => {
        const buf = buildCommandFrame(Commands.M_ADR, '1:2/3@fidonet');
        const frames = collectFrames([buf.slice(0, 1), buf.slice(1)]);
        assert.equal(frames.length, 1);
        assert.equal(frames[0].arg, '1:2/3@fidonet');
    });

    it('reassembles a frame split across the payload', () => {
        const buf = buildCommandFrame(Commands.M_NUL, 'SYS Long BBS Name');
        const mid = Math.floor(buf.length / 2);
        const frames = collectFrames([buf.slice(0, mid), buf.slice(mid)]);
        assert.equal(frames.length, 1);
        assert.equal(frames[0].arg, 'SYS Long BBS Name');
    });

    it('reassembles a frame delivered one byte at a time', () => {
        const buf = buildCommandFrame(Commands.M_NUL, 'ZYZ Sysop');
        const chunks = Array.from({ length: buf.length }, (_, i) => buf.slice(i, i + 1));
        const frames = collectFrames(chunks);
        assert.equal(frames.length, 1);
        assert.equal(frames[0].arg, 'ZYZ Sysop');
    });

    it('emits two frames when both arrive in the same push', () => {
        const a = buildCommandFrame(Commands.M_NUL, 'SYS A');
        const b = buildCommandFrame(Commands.M_NUL, 'SYS B');
        const frames = collectFrames([Buffer.concat([a, b])]);
        assert.equal(frames.length, 2);
    });

    it('holds an incomplete frame until more data arrives', () => {
        const buf = buildCommandFrame(Commands.M_ADR, '2:5020/1@fidonet');
        const parser = new FrameParser();
        const frames = [];
        parser.on('frame', f => frames.push(f));

        parser.push(buf.slice(0, 2)); // header only
        assert.equal(frames.length, 0, 'should have no frames after header-only push');

        parser.push(buf.slice(2)); // rest of payload
        assert.equal(frames.length, 1);
    });

    it('handles interleaved command and data frames across multiple pushes', () => {
        const cmd = buildCommandFrame(Commands.M_NUL, 'VER test binkp/1.1');
        const dat = buildDataFrame(Buffer.from([0x01, 0x02, 0x03]));
        const eof = EOF_FRAME;

        // Split cmd across two pushes, then data+eof in one
        const frames = collectFrames([
            cmd.slice(0, 3),
            Buffer.concat([cmd.slice(3), dat, eof]),
        ]);

        assert.equal(frames.length, 3);
        assert.equal(frames[0].type, 'command');
        assert.equal(frames[1].type, 'data');
        assert.equal(frames[1].data.length, 3);
        assert.equal(frames[2].type, 'data');
        assert.equal(frames[2].data.length, 0); // EOF
    });
});
