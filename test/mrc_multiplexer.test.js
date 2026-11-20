'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');

const configModule = require('../core/config.js');
const logger = require('../core/logger.js');

const ModulePath = require.resolve('../core/servers/chat/mrc_multiplexer.js');

const quietLog = {
    child: () => quietLog,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
};

const BaseMrcConfig = {
    enabled: true,
    retryDelay: 60000,
    infoSysop: 's',
    infoWeb: 'w',
    infoTelnet: 't',
    infoSsh: 's',
    infoDesc: 'd',
};

const listen = server =>
    new Promise(resolve =>
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    );

const freePort = () =>
    new Promise(resolve => {
        const probe = net.createServer();
        listen(probe).then(port => probe.close(() => resolve(port)));
    });

const until = async (check, what) => {
    for (let i = 0; i < 200; ++i) {
        const value = check();
        if (value) {
            return value;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
};

const loadModule = mrc => {
    const previousConfig = configModule._pushTestConfig({
        general: { boardName: 'testbbs', prettyBoardName: '|08XXXXX' },
        chatServers: { mrc: { ...BaseMrcConfig, ...mrc } },
    });
    delete require.cache[ModulePath];
    const { getModule } = require(ModulePath);
    return { mux: new getModule(), previousConfig };
};

describe('MRC multiplexer', () => {
    let central; //  stands in for the MRC server
    let board; //  the multiplexer's connection to it
    let lines; //  what the multiplexer sent to it
    let port;
    let mux;
    let previousConfig;
    let previousLog;
    let previousInfo;
    let clients;

    const fromCentral = text => lines.find(line => line.includes(text));

    const connect = async announce => {
        const socket = net.connect(port, '127.0.0.1');
        socket.received = [];
        socket.setEncoding('utf8');
        socket.on('error', () => {});
        socket.on('data', data => socket.received.push(data));
        clients.push(socket);
        await new Promise(resolve => socket.once('connect', resolve));
        if (announce) {
            socket.write(`${announce}\n`);
        }
        return socket;
    };

    const received = (socket, text) => socket.received.join('').includes(text);

    const chat = fields =>
        JSON.stringify({
            from_room: 'lobby',
            to_user: '',
            to_site: '',
            to_room: 'lobby',
            ...fields,
        });

    const say = (socket, fields) => socket.write(`${chat(fields)}\n`);

    beforeEach(async () => {
        lines = [];
        clients = [];
        central = net.createServer(socket => {
            board = socket;
            socket.setEncoding('utf8');
            socket.on('error', () => {});
            socket.on('data', data => lines.push(...data.split('\n').filter(Boolean)));
        });
        const serverPort = await listen(central);
        port = await freePort();

        previousLog = logger.log;
        logger.log = quietLog;
        previousInfo = console.info; //  listenServer() reports the bind there
        console.info = () => {};
        ({ mux, previousConfig } = loadModule({
            serverHostname: '127.0.0.1',
            serverPort,
            multiplexerPort: port,
        }));

        await new Promise(resolve => mux.createServer(resolve));
        await new Promise((resolve, reject) =>
            mux.listen(err => (err ? reject(err) : resolve()))
        );
        await until(() => board, 'the board to connect');
    });

    afterEach(async () => {
        clients.forEach(socket => socket.destroy());
        mux.mrcClient.requestedDisconnect = true;
        mux.mrcClient.destroy();
        if (board) {
            board.destroy();
            board = null;
        }
        await new Promise(resolve => mux.server.close(resolve));
        await new Promise(resolve => central.close(resolve));
        delete require.cache[ModulePath];
        console.info = previousInfo;
        logger.log = previousLog;
        configModule._popTestConfig(previousConfig);
    });

    it('listens on this machine only', () => {
        assert.equal(mux.server.address().address, '127.0.0.1');
    });

    describe('who a message is from', () => {
        it('is the user the connection registered as, whatever it claims', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            say(alice, { from_user: 'bob', body: 'claimed-to-be-bob' });
            const line = await until(
                () => fromCentral('claimed-to-be-bob'),
                'the message'
            );
            assert.equal(line, 'alice~testbbs~lobby~~~lobby~claimed-to-be-bob~');
        });

        it('is nobody before the handshake, so nothing is sent', async () => {
            const stranger = await connect();
            say(stranger, { from_user: 'bob', body: 'from-nobody' });
            const alice = await connect('--DUDE-ITS--|alice');
            say(alice, { body: 'after-nobody' });
            await until(() => fromCentral('after-nobody'), 'the later message');
            assert.equal(fromCentral('from-nobody'), undefined);
        });

        it('is the first name a connection gives', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            alice.write('--DUDE-ITS--|bob\n');
            say(alice, { body: 'still-alice' });
            const line = await until(() => fromCentral('still-alice'), 'the message');
            assert.ok(line.startsWith('alice~'));
        });

        it('cannot add fields to the line through the name', async () => {
            const odd = await connect('--DUDE-ITS--|x~fake~lobby~~~lobby~INJECTED');
            say(odd, { body: 'tail' });
            const line = await until(() => fromCentral('tail'), 'the message');
            assert.equal(line, 'xfakelobbylobbyINJECTED~testbbs~lobby~~~lobby~tail~');
        });

        it('keeps a name with a space as it is, as before', async () => {
            const spaced = await connect('--DUDE-ITS--|Nu Skooler');
            say(spaced, { body: 'spaced' });
            const line = await until(() => fromCentral('spaced'), 'the message');
            assert.ok(line.startsWith('Nu Skooler~testbbs~'));
        });
    });

    describe('a connection that gives no name', () => {
        //  it used to be registered with no name, and every message to a
        //  user (to_user set) then threw on its name, reaching no one after it
        for (const handshake of ['--DUDE-ITS--', '--DUDE-ITS--|']) {
            it(`does not stop private messages to others ('${handshake}')`, async () => {
                await connect(handshake);
                const alice = await connect('--DUDE-ITS--|alice');
                say(alice, { body: 'ready' });
                await until(() => fromCentral('ready'), 'alice to be connected');

                board.write('bob~otherbbs~lobby~alice~~lobby~private-hello~\n');
                await until(() => received(alice, 'private-hello'), 'the message');
            });
        }

        it('is not sent room chat', async () => {
            const nameless = await connect('--DUDE-ITS--');
            const alice = await connect('--DUDE-ITS--|alice');
            say(alice, { body: 'ready' });
            await until(() => fromCentral('ready'), 'alice to be connected');

            board.write('bob~otherbbs~lobby~~~lobby~room-hello~\n');
            await until(() => received(alice, 'room-hello'), 'the message');
            assert.equal(received(nameless, 'room-hello'), false);
        });
    });

    describe('reads', () => {
        it('a handshake and a message split across reads', async () => {
            const socket = await connect();
            socket.write('--DUDE-');
            await new Promise(resolve => setTimeout(resolve, 20));
            socket.write('ITS--|alice\n');
            const message = chat({ body: 'in-two-parts' });
            socket.write(message.slice(0, 10));
            await new Promise(resolve => setTimeout(resolve, 20));
            socket.write(`${message.slice(10)}\n`);

            const line = await until(() => fromCentral('in-two-parts'), 'the message');
            assert.ok(line.startsWith('alice~'));
        });

        it('several lines in one read', async () => {
            const socket = await connect();
            socket.write(
                `--DUDE-ITS--|alice\n${chat({ body: 'one' })}\n${chat({ body: 'two' })}\n`
            );
            await until(() => fromCentral('~two~'), 'the second message');
            assert.ok(fromCentral('~one~').startsWith('alice~'));
        });

        it('drops a message that is JSON but not an object', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            alice.write('null\n"text"\n42\n');
            say(alice, { body: 'after-junk' });
            await until(() => fromCentral('after-junk'), 'the message');
            assert.deepEqual(
                lines.filter(line => line.startsWith('alice~')),
                ['alice~testbbs~lobby~~~lobby~after-junk~']
            );
        });

        it('disconnects a client that sends an endless line', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            alice.write('x'.repeat(20 * 1024));
            await until(() => alice.destroyed || alice.readableEnded, 'the disconnect');
            await until(() => fromCentral('LOGOFF'), 'the log off');
        });
    });

    describe('leaving', () => {
        it('tells the MRC server when a user leaves', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            say(alice, { body: 'here' });
            await until(() => fromCentral('here'), 'the message');
            alice.end();
            const line = await until(() => fromCentral('LOGOFF'), 'the log off');
            assert.equal(line, 'alice~testbbs~~SERVER~~~LOGOFF~');
        });

        //  a reset connection never ends cleanly ('end'), only closes
        it('also when the connection is reset', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            const bob = await connect('--DUDE-ITS--|bob');
            say(alice, { body: 'here' });
            await until(() => fromCentral('here'), 'the message');

            alice.resetAndDestroy();
            const line = await until(() => fromCentral('LOGOFF'), 'the log off');
            assert.equal(line, 'alice~testbbs~~SERVER~~~LOGOFF~');

            //  and alice is no longer written to
            board.write('carol~otherbbs~lobby~~~lobby~after-reset~\n');
            await until(() => received(bob, 'after-reset'), 'the message');
        });

        it('sends no log off for a connection that never registered', async () => {
            const stranger = await connect();
            const alice = await connect('--DUDE-ITS--|alice');
            stranger.end();
            await new Promise(resolve => setTimeout(resolve, 30));
            say(alice, { body: 'later' });
            await until(() => fromCentral('later'), 'the message');
            assert.equal(fromCentral('LOGOFF'), undefined);
        });
    });

    describe('lines from the MRC server', () => {
        //  a short line used to reach receiveFromMRC with body undefined and throw
        it('ignores a line with fields missing', async () => {
            const alice = await connect('--DUDE-ITS--|alice');
            say(alice, { body: 'ready' });
            await until(() => fromCentral('ready'), 'alice to be connected');

            board.write('SERVER~\nbob~otherbbs~lobby~~~lobby~still-here~\n');
            await until(() => received(alice, 'still-here'), 'the message');
            assert.equal(received(alice, '"from_user":"SERVER"'), false);
        });
    });
});

describe('MRC multiplexer TLS', () => {
    let previousConfig;
    let previousLog;
    let previousConnect;
    let warnings;
    let connected;

    const start = mrc => {
        let mux;
        ({ mux, previousConfig } = loadModule({
            serverHostname: 'mrc.example.com',
            serverPort: 5000,
            serverSslPort: 5001,
            useSsl: true,
            multiplexerPort: 5999,
            ...mrc,
        }));
        mux.connectToMrc();
        return mux;
    };

    beforeEach(() => {
        warnings = [];
        connected = [];
        const log = {
            ...quietLog,
            child: () => log,
            warn: (fields, text) => warnings.push({ fields, text }),
        };
        previousLog = logger.log;
        logger.log = log;
        previousConnect = tls.connect;
        tls.connect = options => {
            const socket = new EventEmitter();
            socket.write = () => {};
            connected.push(options);
            return socket;
        };
    });

    afterEach(() => {
        tls.connect = previousConnect;
        logger.log = previousLog;
        configModule._popTestConfig(previousConfig);
        delete require.cache[ModulePath];
    });

    it('verifies the certificate by default, for the configured host', () => {
        start();
        assert.equal(connected.length, 1);
        assert.equal(connected[0].rejectUnauthorized, true);
        assert.equal(connected[0].host, 'mrc.example.com');
        assert.equal(connected[0].servername, 'mrc.example.com');
        assert.equal(connected[0].port, 5001);
    });

    it('sends no server name for an IP address, and still verifies', () => {
        start({ serverHostname: '192.0.2.1' });
        assert.equal(connected[0].servername, undefined);
        assert.equal(connected[0].rejectUnauthorized, true);
    });

    it('can be turned off for a private server', () => {
        start({ verifyCertificate: false });
        assert.equal(connected[0].rejectUnauthorized, false);
    });

    it('does not use TLS when useSsl is off', () => {
        const mux = start({ useSsl: false, serverHostname: '127.0.0.1', serverPort: 1 });
        mux.mrcClient.on('error', () => {});
        mux.mrcClient.requestedDisconnect = true;
        mux.mrcClient.destroy();
        assert.equal(connected.length, 0);
    });

    it('says why when a certificate is refused', () => {
        const mux = start();
        const err = new Error('self-signed certificate');
        err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
        mux.mrcClient.emit('error', err);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].text, /certificate could not be verified/);
        assert.equal(warnings[0].fields.host, 'mrc.example.com');
    });
});
