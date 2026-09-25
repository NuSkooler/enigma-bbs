'use strict';

const { strict: assert } = require('assert');
const { PassThrough } = require('stream');
const { TelnetSocket } = require('telnet-socket');

const {
    IAC,
    isTelnetBasedClient,
    escapeIacs,
    createIacDeEscaper,
} = require('../core/telnet_iac.js');

const hex = buf => [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');

//
//  Whole-buffer de-escape, written independently of the implementation, used as
//  ground truth for the chunked one. Deliberately naive: walk the bytes, collapse
//  a pair, pass a lone IAC through.
//
function referenceDeEscape(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
        if (IAC === data[i] && IAC === data[i + 1]) {
            out.push(IAC);
            i += 2;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    return Buffer.from(out);
}

//  Feed |chunks| through one de-escaper and concatenate everything it emits.
function feedChunks(chunks) {
    const deEscaper = createIacDeEscaper();
    const out = chunks.map(c => deEscaper.transform(c));
    out.push(deEscaper.flush());
    return Buffer.concat(out);
}

function splitAt(buf, offsets) {
    const chunks = [];
    let prev = 0;
    for (const o of offsets) {
        chunks.push(buf.slice(prev, o));
        prev = o;
    }
    chunks.push(buf.slice(prev));
    return chunks;
}

describe('telnet_iac', () => {
    //
    //  Which transports need IAC handling at all. This is the guard against the
    //  detection silently inverting: if SSH is ever classified as Telnet-based,
    //  every SSH transfer is corrupted again, exactly as in #353.
    //
    describe('isTelnetBasedClient()', () => {
        it('detects a Telnet client by its TelnetSocket', () => {
            //  TelnetClient's constructor does `new TelnetSocket(socket)`
            const client = { socket: new TelnetSocket(new PassThrough()) };
            assert.equal(isTelnetBasedClient(client), true);
        });

        it('detects a WebSocket client, which also holds a TelnetSocket', () => {
            //
            //  WebSocketClient extends TelnetClient, so it inherits the wrapping
            //  *and* has a banner() of its own. Shaped explicitly here because WS
            //  is a third real transport, not just "Telnet minus a branch".
            //
            const client = {
                socket: new TelnetSocket(new PassThrough()),
                banner: () => {},
            };
            assert.equal(isTelnetBasedClient(client), true);
        });

        it('does NOT treat an SSH client as Telnet-based', () => {
            //  SSH wires rawWrite to the ssh2 channel; there is no TelnetSocket.
            const client = { socket: new PassThrough() };
            assert.equal(isTelnetBasedClient(client), false);
        });

        it('does NOT treat a client with no socket as Telnet-based', () => {
            assert.equal(isTelnetBasedClient({}), false);
        });

        it('does not classify on the presence of a banner() alone', () => {
            //
            //  A removed fallback used to do exactly this. Adding banner() to the
            //  base Client would then have flipped every SSH transfer back to
            //  mangling bytes, with nothing to catch it.
            //
            assert.equal(isTelnetBasedClient({ banner: () => {} }), false);
        });

        it('is defensive about a missing or non-object client', () => {
            assert.equal(isTelnetBasedClient(null), false);
            assert.equal(isTelnetBasedClient(undefined), false);
            assert.equal(isTelnetBasedClient('nope'), false);
        });
    });

    describe('escapeIacs()', () => {
        it('doubles a lone IAC', () => {
            assert.deepEqual(escapeIacs(Buffer.from([0xff])), Buffer.from([0xff, 0xff]));
        });

        it('doubles every IAC in a run', () => {
            assert.deepEqual(
                escapeIacs(Buffer.from([0xff, 0xff])),
                Buffer.from([0xff, 0xff, 0xff, 0xff])
            );
        });

        it('leaves a buffer with no IAC byte-identical', () => {
            const data = Buffer.from([0x41, 0x42, 0x00, 0xfe, 0x7f]);
            assert.deepEqual(escapeIacs(data), data);
        });

        it('escapes IACs at both ends and in the middle', () => {
            assert.deepEqual(
                escapeIacs(Buffer.from([0xff, 0x41, 0xff, 0x42, 0xff])),
                Buffer.from([0xff, 0xff, 0x41, 0xff, 0xff, 0x42, 0xff, 0xff])
            );
        });

        it('passes an empty buffer through', () => {
            assert.equal(escapeIacs(Buffer.alloc(0)).length, 0);
        });
    });

    describe('createIacDeEscaper()', () => {
        it('collapses an escaped pair arriving in one chunk', () => {
            const out = feedChunks([Buffer.from([0x41, 0xff, 0xff, 0x42])]);
            assert.deepEqual(out, Buffer.from([0x41, 0xff, 0x42]));
        });

        it('passes a lone IAC through unchanged', () => {
            const out = feedChunks([Buffer.from([0x41, 0xff, 0x42])]);
            assert.deepEqual(out, Buffer.from([0x41, 0xff, 0x42]));
        });

        it('leaves a buffer with no IAC byte-identical', () => {
            const data = Buffer.from([0x41, 0x42, 0x00, 0xfe]);
            assert.deepEqual(feedChunks([data]), data);
        });

        //
        //  The regression test for the chunk-boundary bug. The previous inline
        //  implementation searched each chunk for the pair with indexOf() and kept
        //  no state, so this case emitted `41 ff ff 42` -- an extra byte straight
        //  into sz/rz, which fails the ZMODEM block.
        //
        it('collapses a pair SPLIT across two chunks', () => {
            const out = feedChunks([
                Buffer.from([0x41, 0xff]),
                Buffer.from([0xff, 0x42]),
            ]);
            assert.deepEqual(
                out,
                Buffer.from([0x41, 0xff, 0x42]),
                `split pair mishandled: got ${hex(out)}`
            );
        });

        it('survives a JPEG-like payload split every 3 bytes', () => {
            //  JPEG is saturated with 0xFF -- every marker is IAC-prefixed, which
            //  is why #353's reporter saw image uploads fail specifically.
            const jpeg = Buffer.from([
                0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xdb,
                0xff, 0xff, 0xc0,
            ]);
            const wire = escapeIacs(jpeg);
            const chunks = [];
            for (let i = 0; i < wire.length; i += 3) {
                chunks.push(wire.slice(i, i + 3));
            }
            const out = feedChunks(chunks);
            assert.deepEqual(out, jpeg, `expected ${hex(jpeg)}, got ${hex(out)}`);
        });

        it('resolves a pending IAC as lone when the next chunk starts with data', () => {
            //  The trickiest transition: the carry is emitted, and the byte that
            //  proved it lone is NOT consumed.
            const out = feedChunks([
                Buffer.from([0x41, 0xff]),
                Buffer.from([0x42, 0x43]),
            ]);
            assert.deepEqual(out, Buffer.from([0x41, 0xff, 0x42, 0x43]));
        });

        it('does not let a zero-length chunk resolve a pending IAC', () => {
            //
            //  An empty chunk carries no byte to judge the carry against. Treating
            //  it as "not an IAC" emits the carry early and then mishandles the
            //  real pair when it arrives.
            //
            const out = feedChunks([
                Buffer.from([0x41, 0xff]),
                Buffer.alloc(0),
                Buffer.from([0xff, 0x42]),
            ]);
            assert.deepEqual(out, Buffer.from([0x41, 0xff, 0x42]));
        });

        it('emits a trailing lone IAC on flush', () => {
            const deEscaper = createIacDeEscaper();
            const body = deEscaper.transform(Buffer.from([0x41, 0xff]));
            assert.deepEqual(body, Buffer.from([0x41]));
            assert.equal(deEscaper.hasPendingIac, true);
            assert.deepEqual(deEscaper.flush(), Buffer.from([0xff]));
            assert.equal(deEscaper.hasPendingIac, false);
        });

        it('flushes empty when nothing is pending', () => {
            const deEscaper = createIacDeEscaper();
            deEscaper.transform(Buffer.from([0x41, 0x42]));
            assert.equal(deEscaper.flush().length, 0);
        });

        it('handles runs of consecutive IACs', () => {
            //  Verified against the reference rather than hand-computed.
            for (let n = 0; n <= 8; ++n) {
                const run = Buffer.alloc(n, 0xff);
                assert.deepEqual(
                    feedChunks([run]),
                    referenceDeEscape(run),
                    `run of ${n} IACs`
                );
            }
        });
    });

    describe('round trip', () => {
        it('escape then de-escape is the identity, whole-buffer', () => {
            const data = Buffer.from([
                0xff, 0xd8, 0xff, 0xff, 0x00, 0x41, 0xff, 0xfe, 0xff, 0xff, 0xff, 0x42,
            ]);
            assert.deepEqual(feedChunks([escapeIacs(data)]), data);
        });

        //
        //  The strongest guard here. Two hand-picked boundary cases prove the bug
        //  is fixed; this proves there is no *other* split that breaks it.
        //
        it('escape then chunked de-escape is the identity at every split point', () => {
            const data = Buffer.from([
                0xff, 0xff, 0x41, 0xff, 0x00, 0xff, 0xff, 0xff, 0x42, 0xff,
            ]);
            const wire = escapeIacs(data);

            for (let i = 0; i <= wire.length; ++i) {
                const out = feedChunks(splitAt(wire, [i]));
                assert.deepEqual(out, data, `single split at ${i}: got ${hex(out)}`);
            }

            for (let i = 0; i <= wire.length; ++i) {
                for (let j = i; j <= wire.length; ++j) {
                    const out = feedChunks(splitAt(wire, [i, j]));
                    assert.deepEqual(out, data, `split at ${i},${j}: got ${hex(out)}`);
                }
            }
        });

        it('matches the reference for pseudo-random payloads at random splits', () => {
            //  Deterministic PRNG so a failure is reproducible from the seed.
            let seed = 0x5eed;
            const rand = n => {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                return seed % n;
            };

            for (let iter = 0; iter < 400; ++iter) {
                const len = 1 + rand(40);
                const data = Buffer.alloc(len);
                for (let i = 0; i < len; ++i) {
                    //  Heavily biased toward 0xFF -- that is where the bugs live.
                    data[i] = rand(3) === 0 ? 0xff : rand(256);
                }

                const wire = escapeIacs(data);
                const cuts = [];
                for (let c = 0; c < 1 + rand(4); ++c) {
                    cuts.push(rand(wire.length + 1));
                }
                cuts.sort((a, b) => a - b);

                const out = feedChunks(splitAt(wire, cuts));
                assert.deepEqual(
                    out,
                    data,
                    `iter ${iter}: data=${hex(data)} cuts=${cuts} got=${hex(out)}`
                );
            }
        });
    });
});
