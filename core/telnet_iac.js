/* jslint node: true */
'use strict';

//  deps
const { TelnetSocket } = require('telnet-socket');

//
//  Telnet IAC (0xFF, "Interpret As Command") escaping for the file transfer
//  paths.
//
//  In Telnet a literal 0xFF in a data stream must be sent doubled, so the far
//  end reads it as data rather than the start of a command. SSH has no such
//  rule: 0xFF is just a byte. Escaping for a transport that does not use IAC --
//  or failing to for one that does -- corrupts the stream, and ZMODEM reports
//  it as a header or CRC failure, which reaches the caller as a hang.
//
//  |telnet-socket| does this itself: TelnetSocket._write() doubles 0xFF and
//  _data() collapses pairs, both gated on its |passthrough| flag. ENiGMA turns
//  that off for the duration of a transfer -- setTemporaryDirectDataHandler()
//  sets client.dataPassthrough, which on a Telnet client maps straight to
//  socket.passthrough -- so the transforms here are a *replacement* for logic
//  that was just disabled, not an addition on top of it.
//
const IAC = 0xff;
const IACBuffer = Buffer.from([IAC]);
const EscapedIACBuffer = Buffer.from([IAC, IAC]);
const EmptyBuffer = Buffer.alloc(0);

//
//  Does this client's transport speak Telnet, and therefore need IAC handling?
//
//  TelnetClient's constructor always wraps its socket (`new TelnetSocket(...)`),
//  and WebSocketClient extends TelnetClient, so both hold a genuine TelnetSocket
//  while SSH holds none -- SSH wires rawWrite to the ssh2 channel directly. That
//  makes this single check exhaustive for every client class we have.
//
//  It previously carried two further fallbacks. One tested `client.banner`,
//  which is unreachable (a TelnetSocket is always present first) and would
//  misclassify SSH the moment anything added a banner() to the base Client. The
//  other tested socket.writeData/negotiateOptions, which exist nowhere -- not in
//  this repo and not in telnet-socket. Both are gone; test/telnet_iac.test.js
//  pins the matrix so their removal cannot silently regress.
//
function isTelnetBasedClient(client) {
    if (!client || typeof client !== 'object') {
        return false;
    }

    return client.socket instanceof TelnetSocket;
}

//
//  Outbound: double every IAC so the client's Telnet layer reads it as data.
//
//  Stateless, because escaping is a per-byte substitution -- no byte's encoding
//  depends on its neighbours, so a chunk can be transformed in isolation.
//
function escapeIacs(data) {
    let iacPos = data.indexOf(IAC);
    if (-1 === iacPos) {
        return data; //  nothing to do; hand back the original, no copy
    }

    const parts = [];
    let lastPos = 0;

    while (iacPos !== -1) {
        if (iacPos > lastPos) {
            parts.push(data.slice(lastPos, iacPos));
        }
        parts.push(EscapedIACBuffer);
        lastPos = iacPos + 1;
        iacPos = data.indexOf(IAC, lastPos);
    }

    if (lastPos < data.length) {
        parts.push(data.slice(lastPos));
    }

    return Buffer.concat(parts);
}

//
//  Inbound: collapse escaped pairs back to a single byte. A lone IAC -- one not
//  followed by another -- passes through unchanged.
//
//  This direction *cannot* be stateless, and that was a real bug: the previous
//  implementation searched each chunk for the pair with indexOf() and kept
//  nothing between calls, so a pair split across a chunk boundary was invisible
//  to both passes and both bytes reached the external process. Large transfers
//  hit it most, having the most boundaries, and one stray byte kills a ZMODEM
//  block.
//
//  So the de-escaper is a factory: one instance per transfer, holding at most a
//  single undecided IAC. One byte of carry is provably sufficient -- when a
//  pending IAC meets the next chunk we emit exactly one IAC either way, and only
//  whether we consume the following byte differs.
//
//  Call flush() at end of stream, or a transfer ending on a lone IAC loses it.
//
function createIacDeEscaper() {
    let pendingIac = false;

    return {
        transform(data) {
            //
            //  An empty chunk must not resolve a pending IAC: there is no next
            //  byte to judge it against, and treating "no byte" as "not an IAC"
            //  would emit the carry early and then mishandle the real pair when
            //  it arrives.
            //
            if (!data || 0 === data.length) {
                return EmptyBuffer;
            }

            const parts = [];
            let pos = 0;

            if (pendingIac) {
                pendingIac = false;

                //  Either way one IAC is emitted; a completed pair also eats
                //  the byte that completed it.
                parts.push(IACBuffer);
                if (IAC === data[0]) {
                    pos = 1;
                }
            }

            while (pos < data.length) {
                const iacPos = data.indexOf(IAC, pos);

                if (-1 === iacPos) {
                    parts.push(data.slice(pos));
                    break;
                }

                if (iacPos > pos) {
                    parts.push(data.slice(pos, iacPos));
                }

                if (iacPos === data.length - 1) {
                    //  Last byte of the chunk: we cannot tell a pair from a
                    //  lone IAC yet. Hold it for the next call.
                    pendingIac = true;
                    break;
                }

                parts.push(IACBuffer);
                pos = IAC === data[iacPos + 1] ? iacPos + 2 : iacPos + 1;
            }

            return parts.length ? Buffer.concat(parts) : EmptyBuffer;
        },

        flush() {
            if (!pendingIac) {
                return EmptyBuffer;
            }
            pendingIac = false;
            return IACBuffer;
        },

        //  Exposed for assertions; callers have no reason to read it.
        get hasPendingIac() {
            return pendingIac;
        },
    };
}

module.exports = {
    IAC,
    isTelnetBasedClient,
    escapeIacs,
    createIacDeEscaper,
};
