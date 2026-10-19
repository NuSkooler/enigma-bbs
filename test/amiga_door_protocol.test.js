'use strict';

const { strict: assert } = require('assert');
const {
    RS,
    MAX_PAYLOAD,
    encode,
    encodeKeys,
    parseKeys,
    escapeData,
    escapeC,
    unescapeC,
    Decoder,
} = require('../core/amiga_door/protocol');

// ── helpers ──────────────────────────────────────────────────────────────────

//  Every event from feeding chunks one by one, with adjacent data events joined
//  (where a chunk boundary falls decides how data is split, not what it is)
function decodeAll(chunks, options) {
    const dec = new Decoder(options);
    const out = [];
    for (const c of chunks) {
        for (const e of dec.push(c)) {
            const last = out[out.length - 1];
            if (e.data && last && last.data) {
                last.data = Buffer.concat([last.data, e.data]);
            } else {
                out.push(e.data ? { data: Buffer.from(e.data) } : e);
            }
        }
    }
    return { events: out, decoder: dec };
}

function bytewise(buf) {
    return [...buf].map(b => Buffer.from([b]));
}

// ── encode ───────────────────────────────────────────────────────────────────

describe('amiga_door protocol: encode', () => {
    it('frames as RS type len_hi len_lo payload', () => {
        const f = encode('t', { timeleft: 5 });
        assert.deepEqual([...f.subarray(0, 4)], [RS, 't'.charCodeAt(0), 0, 10]);
        assert.equal(f.subarray(4).toString('latin1'), 'timeleft=5');
    });

    it('encodes an empty payload as length 0', () => {
        assert.deepEqual([...encode('R')], [RS, 0x52, 0, 0]);
        assert.deepEqual([...encode('R', {})], [RS, 0x52, 0, 0]);
        assert.deepEqual([...encode('R', Buffer.alloc(0))], [RS, 0x52, 0, 0]);
    });

    it('writes the length big-endian', () => {
        const f = encode('s', Buffer.alloc(0x1234, 0x41));
        assert.equal(f[2], 0x12);
        assert.equal(f[3], 0x34);
        assert.equal(f.length, 4 + 0x1234);
    });

    it('accepts the maximum payload of 65535 bytes and refuses one more', () => {
        const f = encode('s', Buffer.alloc(MAX_PAYLOAD, 0x61));
        assert.equal(f[2], 0xff);
        assert.equal(f[3], 0xff);
        assert.throws(() => encode('s', Buffer.alloc(MAX_PAYLOAD + 1)), RangeError);
    });

    it('rejects frame types that are not one letter', () => {
        assert.throws(() => encode('', {}), TypeError);
        assert.throws(() => encode('ss', {}), TypeError);
        assert.throws(() => encode('1', {}), TypeError);
        assert.throws(() => encode(RS, {}), TypeError);
    });

    it('carries ISO-8859-1 payload bytes unchanged', () => {
        const f = encode('s', { name: 'Jürgen ¤' });
        assert.equal(f.subarray(4).toString('latin1'), 'name=Jürgen ¤');
        assert.equal(f.length, 4 + 'name=Jürgen ¤'.length);
    });
});

// ── key=value payloads ─────────────────────────────────────────────────────

describe('amiga_door protocol: key=value payloads', () => {
    it('round-trips a user block', () => {
        const user = {
            version: '1',
            door: 'BBS:Doors/DreamSweeper/dreamsweeper.xim',
            name: 'Test Caller',
            mainline: 'D poc-a.lha enigma.lzx',
            args: '',
        };
        assert.deepEqual(parseKeys(encodeKeys(user)), user);
    });

    it('turns numbers and booleans into text and drops null/undefined', () => {
        const b = encodeKeys({
            node: 3,
            log: true,
            ansi: false,
            skip: null,
            gone: undefined,
        });
        assert.equal(b.toString('latin1'), 'node=3\nlog=1\nansi=0');
    });

    it('refuses a value with a line break and a bad key', () => {
        assert.throws(() => encodeKeys({ name: 'a\nb' }), TypeError);
        assert.throws(() => encodeKeys({ name: 'a\rb' }), TypeError);
        assert.throws(() => encodeKeys({ Name: 'x' }), TypeError);
        assert.throws(() => encodeKeys({ 'a=b': 'x' }), TypeError);
    });

    it('parses leniently: = in values, CR LF, lines without =, last duplicate wins', () => {
        const k = parseKeys(Buffer.from('a=1\r\nnoeq\nb=x=y\n=z\na=2\n', 'latin1'));
        assert.deepEqual(k, { a: '2', b: 'x=y' });
    });

    it('parses an empty payload to an empty object', () => {
        assert.deepEqual(parseKeys(Buffer.alloc(0)), {});
    });
});

// ── terminal data escaping ─────────────────────────────────────────────────

describe('amiga_door protocol: 0x1E escaping', () => {
    it('doubles 0x1E in terminal data and leaves other bytes alone', () => {
        const d = Buffer.from([0x41, RS, 0x42, RS, RS, 0x9b]);
        assert.deepEqual([...escapeData(d)], [0x41, RS, RS, 0x42, RS, RS, RS, RS, 0x9b]);
        const plain = Buffer.from('hello');
        assert.equal(escapeData(plain), plain);
    });

    it('decodes RS RS back to one 0x1E and stays in data mode', () => {
        const { events } = decodeAll([Buffer.from([0x41, RS, RS, 0x42])]);
        assert.equal(events.length, 1);
        assert.deepEqual([...events[0].data], [0x41, RS, 0x42]);
    });

    it('round-trips every byte value through escapeData and the decoder', () => {
        const all = Buffer.from([...Array(256).keys(), RS, RS, RS]);
        const { events } = decodeAll([escapeData(all)]);
        assert.equal(events.length, 1);
        assert.deepEqual(events[0].data, all);
    });

    it('escapes and unescapes C frame strings', () => {
        const raw = Buffer.from([0x48, 0x69, RS, 0x0d, 0x0a, 0x5c, 0x01, 0x7f, 0xe4]);
        const esc = escapeC(raw);
        assert.equal(esc, 'Hi\\x1e\\x0d\\x0a\\x5c\\x01\\x7f\u00e4');
        assert.deepEqual(unescapeC(esc), raw);
    });

    it('unescapes \\xNN only and keeps other backslashes', () => {
        assert.deepEqual([...unescapeC('a\\x1Eb')], [0x61, RS, 0x62]);
        assert.equal(unescapeC('C:\\path \\x2').toString('latin1'), 'C:\\path \\x2');
    });
});

// ── decoder ────────────────────────────────────────────────────────────────

describe('amiga_door protocol: Decoder', () => {
    const stream = Buffer.concat([
        Buffer.from('\x1b[2J'),
        encode('H', {
            version: 1,
            shim: 'axshim 1.0',
            exec: '51.7',
            kick: 51,
            baud: 115200,
        }),
        encode('R'),
        Buffer.from([0x41, RS, RS, 0x42]),
        encode('C', { cmd: 4, data: 1, len: 264, str: escapeC(Buffer.from([RS, 0x01])) }),
        Buffer.from('door text\r\n'),
        encode('X', {
            status: 'ok',
            reg: 0,
            cmds: 17,
            codes: '1 2 4',
            return: '',
            wrote: 0,
        }),
    ]);

    function check(events) {
        assert.equal(events.length, 7);
        assert.equal(events[0].data.toString('latin1'), '\x1b[2J');
        assert.equal(events[1].frame.type, 'H');
        assert.equal(events[1].frame.keys.version, '1');
        assert.equal(events[1].frame.keys.shim, 'axshim 1.0');
        assert.equal(events[2].frame.type, 'R');
        assert.equal(events[2].frame.payload.length, 0);
        assert.deepEqual(events[2].frame.keys, {});
        assert.deepEqual([...events[3].data], [0x41, RS, 0x42]);
        assert.equal(events[4].frame.type, 'C');
        assert.deepEqual([...unescapeC(events[4].frame.keys.str)], [RS, 0x01]);
        assert.equal(events[5].data.toString('latin1'), 'door text\r\n');
        assert.equal(events[6].frame.type, 'X');
        assert.equal(events[6].frame.keys.status, 'ok');
        assert.equal(events[6].frame.keys.return, '');
    }

    it('splits a stream into data and frames in order', () => {
        check(decodeAll([stream]).events);
    });

    it('decodes the same events when fed one byte at a time', () => {
        const { events, decoder } = decodeAll(bytewise(stream));
        check(events);
        assert.equal(decoder.pending, false);
    });

    it('decodes the same events for every split point', () => {
        for (let i = 1; i < stream.length; i++) {
            check(decodeAll([stream.subarray(0, i), stream.subarray(i)]).events);
        }
    });

    it('reports a frame cut mid-way as pending until it completes', () => {
        const f = encode('t', { timeleft: 0 });
        const dec = new Decoder();
        assert.deepEqual(dec.push(f.subarray(0, 3)), []);
        assert.equal(dec.pending, true);
        const ev = dec.push(f.subarray(3));
        assert.equal(dec.pending, false);
        assert.equal(ev.length, 1);
        assert.deepEqual(ev[0].frame.keys, { timeleft: '0' });
    });

    it('skips frame types it was not asked for by their length', () => {
        //  the unknown frame's payload holds an RS and what looks like a frame
        const junk = Buffer.concat([
            Buffer.from('k=v\n'),
            encode('X', { status: 'bogus' }),
        ]);
        const s = Buffer.concat([
            Buffer.from('a'),
            encode('Z', junk),
            Buffer.from('b'),
            encode('R'),
        ]);
        for (const chunks of [[s], bytewise(s)]) {
            const { events, decoder } = decodeAll(chunks, { accept: 'HRLCEX' });
            //  'a' and 'b' are one data run once the frame between them is gone
            assert.equal(decoder.skipped, 1);
            assert.equal(events.length, 2);
            assert.equal(events[0].data.toString(), 'ab');
            assert.equal(events[1].frame.type, 'R');
        }
    });

    it('passes unknown types through when no accept list is given', () => {
        const { events } = decodeAll([encode('q', { x: 1 })]);
        assert.equal(events[0].frame.type, 'q');
        assert.deepEqual(events[0].frame.keys, { x: '1' });
    });

    it('decodes a 65535-byte payload, also split across chunks', () => {
        const body = Buffer.alloc(MAX_PAYLOAD);
        for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
        const f = Buffer.concat([encode('s', body), Buffer.from('after')]);
        const chunks = [];
        for (let i = 0; i < f.length; i += 4093) chunks.push(f.subarray(i, i + 4093));
        const { events } = decodeAll(chunks);
        assert.equal(events.length, 2);
        assert.equal(events[0].frame.type, 's');
        assert.deepEqual(events[0].frame.payload, body);
        assert.equal(events[1].data.toString(), 'after');
    });

    it('emits data and frame events as well as returning them', () => {
        const dec = new Decoder();
        const seen = [];
        dec.on('data', d => seen.push(['data', d.toString('latin1')]));
        dec.on('frame', f => seen.push(['frame', f.type]));
        dec.push(Buffer.concat([Buffer.from('hi'), encode('R'), Buffer.from('yo')]));
        assert.deepEqual(seen, [
            ['data', 'hi'],
            ['frame', 'R'],
            ['data', 'yo'],
        ]);
    });

    it('round-trips host frames the shim parses', () => {
        const user = {
            version: 1,
            door: 'BBS:Doors/XIMTest/XIMTest',
            name: 'Caller',
            log: true,
        };
        const s = Buffer.concat([
            encode('s', user),
            escapeData(Buffer.from([0x71, RS])),
            encode('w', { rows: 50, cols: 132 }),
            encode('d', { reason: 'hangup' }),
        ]);
        const { events } = decodeAll(bytewise(s));
        assert.deepEqual(events[0].frame.keys, {
            version: '1',
            door: 'BBS:Doors/XIMTest/XIMTest',
            name: 'Caller',
            log: '1',
        });
        assert.deepEqual([...events[1].data], [0x71, RS]);
        assert.deepEqual(events[2].frame.keys, { rows: '50', cols: '132' });
        assert.deepEqual(events[3].frame.keys, { reason: 'hangup' });
    });
});
