'use strict';

const { strict: assert } = require('assert');
const net = require('net');
const { PassThrough } = require('stream');
const {
    TelnetSocket,
    TelnetSpec: { Commands, Options },
} = require('telnet-socket');

const {
    bridgeNegotiationReply,
    TelnetClientConnection,
} = require('../core/telnet_bridge.js');

const hex = buf => [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');

//
//  A client just complete enough for TelnetClientConnection. |socket| is what
//  decides which path the bridge takes: a TelnetSocket means the caller speaks
//  Telnet itself, anything else (SSH) means the bridge must speak it for them.
//
function makeClient({ telnetBased }) {
    const written = [];
    return {
        socket: telnetBased ? new TelnetSocket(new PassThrough()) : new PassThrough(),
        written,
        term: {
            termType: 'ansi',
            rawWrite: data => written.push(Buffer.from(data)),
            output: null, //  restorePipe() tolerates this
        },
        explicitActivityTimeUpdate: () => {},
        restoreDataHandler: () => {},
        setTemporaryDirectDataHandler: () => {},
        received: () => Buffer.concat(written),
    };
}

describe('telnet_bridge IAC handling', () => {
    //
    //  What we are willing to run when the bridge is the Telnet endpoint. Refusing
    //  by default is deliberate: a bridge has no business claiming NAWS or LINEMODE
    //  on the caller's behalf.
    //
    describe('bridgeNegotiationReply()', () => {
        const reply = (code, option) => bridgeNegotiationReply(code, option);

        it('accepts DO for binary, which a transfer needs to be 8-bit clean', () => {
            assert.deepEqual(reply(Commands.DO, Options.TRANSMIT_BINARY), {
                code: Commands.WILL,
                option: Options.TRANSMIT_BINARY,
            });
        });

        it('accepts DO SGA and DO TTYPE', () => {
            assert.equal(reply(Commands.DO, Options.SGA).code, Commands.WILL);
            assert.equal(reply(Commands.DO, Options.TTYPE).code, Commands.WILL);
        });

        it('refuses DO for anything else', () => {
            for (const option of [Options.NAWS, Options.LINEMODE, Options.STATUS]) {
                assert.equal(
                    reply(Commands.DO, option).code,
                    Commands.WONT,
                    `option ${option} should be refused`
                );
            }
        });

        it('accepts WILL for binary, SGA and echo', () => {
            for (const option of [Options.TRANSMIT_BINARY, Options.SGA, Options.ECHO]) {
                assert.equal(reply(Commands.WILL, option).code, Commands.DO);
            }
        });

        it('refuses WILL for anything else', () => {
            assert.equal(reply(Commands.WILL, Options.LINEMODE).code, Commands.DONT);
        });

        it('says nothing to DONT or WONT', () => {
            //  Answering an acknowledgement of refusal is how loops start.
            assert.equal(reply(Commands.DONT, Options.SGA), null);
            assert.equal(reply(Commands.WONT, Options.SGA), null);
        });
    });

    //
    //  The two wiring paths, driven over a real loopback socket so the transport
    //  selection in connect() is exercised rather than assumed.
    //
    describe('data path', () => {
        let server;
        let serverSocket;
        let serverReceived;

        beforeEach(done => {
            serverReceived = [];
            server = net.createServer(socket => {
                serverSocket = socket;
                socket.on('data', d => serverReceived.push(Buffer.from(d)));
            });
            server.listen(0, '127.0.0.1', done);
        });

        afterEach(done => {
            if (server) {
                server.close(() => done());
            } else {
                done();
            }
        });

        const bridgeTo = (client, cb) => {
            const conn = new TelnetClientConnection(client);
            conn.on('connected', () => cb(conn));
            conn.connect({ host: '127.0.0.1', port: server.address().port });
            return conn;
        };

        it('de-escapes IAC pairs for an SSH caller (#266)', done => {
            const client = makeClient({ telnetBased: false });
            bridgeTo(client, conn => {
                assert.equal(
                    conn.bridgeIsTelnetEndpoint,
                    true,
                    'bridge should terminate Telnet for an SSH caller'
                );

                //  Remote sends a ZMODEM-ish payload with a literal 0xFF, escaped
                //  on the wire as required by Telnet.
                serverSocket.write(Buffer.from([0x41, 0xff, 0xff, 0x42]));

                setTimeout(() => {
                    const got = client.received();
                    assert.deepEqual(
                        got,
                        Buffer.from([0x41, 0xff, 0x42]),
                        `caller should see one 0xff, got ${hex(got)}`
                    );
                    conn.destroy();
                    done();
                }, 60);
            });
        });

        it('keeps the remote negotiation out of an SSH caller stream, and answers it', done => {
            const client = makeClient({ telnetBased: false });
            bridgeTo(client, conn => {
                //  IAC DO SGA, then a byte of real data
                serverSocket.write(
                    Buffer.from([Commands.IAC, Commands.DO, Options.SGA, 0x41])
                );

                setTimeout(() => {
                    const got = client.received();
                    assert.deepEqual(
                        got,
                        Buffer.from([0x41]),
                        `negotiation leaked into the caller stream: ${hex(got)}`
                    );

                    const back = Buffer.concat(serverReceived);
                    assert.deepEqual(
                        back,
                        Buffer.from([Commands.IAC, Commands.WILL, Options.SGA]),
                        `expected WILL SGA back, got ${hex(back)}`
                    );

                    conn.destroy();
                    done();
                }, 60);
            });
        });

        it('refuses an option it will not run', done => {
            const client = makeClient({ telnetBased: false });
            bridgeTo(client, conn => {
                serverSocket.write(
                    Buffer.from([Commands.IAC, Commands.DO, Options.NAWS])
                );

                setTimeout(() => {
                    const back = Buffer.concat(serverReceived);
                    assert.deepEqual(
                        back,
                        Buffer.from([Commands.IAC, Commands.WONT, Options.NAWS]),
                        `expected WONT NAWS, got ${hex(back)}`
                    );
                    conn.destroy();
                    done();
                }, 60);
            });
        });

        //
        //  The half that already worked and must not regress. A Telnet caller has
        //  its own stack, so the bridge stays transparent -- escaped pairs and
        //  negotiation both travel through untouched.
        //
        it('passes bytes through verbatim for a Telnet caller', done => {
            const client = makeClient({ telnetBased: true });
            bridgeTo(client, conn => {
                assert.equal(
                    conn.bridgeIsTelnetEndpoint,
                    false,
                    'bridge must stay transparent for a Telnet caller'
                );

                const wire = Buffer.from([
                    0x41,
                    0xff,
                    0xff,
                    0x42,
                    Commands.IAC,
                    Commands.DO,
                    Options.SGA,
                ]);
                serverSocket.write(wire);

                setTimeout(() => {
                    const got = client.received();
                    assert.deepEqual(
                        got,
                        wire,
                        `passthrough altered the stream: ${hex(got)} vs ${hex(wire)}`
                    );
                    conn.destroy();
                    done();
                }, 60);
            });
        });
    });
});
