'use strict';

//
//  RIPscrip detection (#989): the 'rip' layer, the version query sent at
//  connect, taking the terminal's reply out of the input stream, selection by
//  terminal type, TE[rip], terminalSupports('rip') and the BBSDEV.DRP flag.
//

const { strict: assert } = require('assert');
const EventEmitter = require('events');

const Rip = require('../core/term/rip');
const { createRipReplyScanner } = require('../core/term/rip/reply_scanner.js');
const AnsiInput = require('../core/term/ansi/input_decoder.js');
const Term = require('../core/term');
const {
    resolveEmulation,
    selectClientEmulation,
    attachRipLayer,
} = require('../core/term/select.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

//  Runs |chunks| through a scanner; returns what the sink saw, in order
function makeScanner(options) {
    const scanner = createRipReplyScanner(options);
    const seen = [];
    const sink = {
        bytes: chunk => seen.push(['bytes', chunk]),
        reply: reply => seen.push(['reply', reply]),
    };
    const scan = data => scanner.scan(data, sink);
    //  the bytes seen so far as one latin1 string, replies as <reply>
    const flat = () =>
        seen
            .map(([kind, value]) =>
                'reply' === kind
                    ? `<${value}>`
                    : Buffer.isBuffer(value)
                      ? value.toString('latin1')
                      : String(value)
            )
            .join('');
    return { scanner, seen, scan, flat };
}

//  A decoder for one connection, and the events it reports
function makeDecoder(options) {
    const decoder = AnsiInput.createAnsiInputDecoder(options);
    const events = [];
    const decode = data =>
        decoder.decode(
            Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'),
            { isNixTerm: () => false },
            (name, ...args) => events.push([name, ...args])
        );
    const typed = () =>
        events
            .filter(e => 'key press' === e[0])
            .map(e => e[1])
            .join('');
    const replies = () => events.filter(e => 'rip version' === e[0]).map(e => e[1]);
    return { decoder, events, decode, typed, replies };
}

function makeLog() {
    const logged = [];
    const record = level => (info, msg) => logged.push({ level, info, msg });
    return {
        logged,
        log: {
            info: record('info'),
            debug: record('debug'),
            warn: record('warn'),
        },
    };
}

//  A stand-in client with a real emulation object
function makeClient(termType, emulationName) {
    const { logged, log } = makeLog();
    return {
        logged,
        log,
        term: {
            termType: (termType || 'unknown').toLowerCase(),
            emulation: Term.createEmulation(emulationName),
        },
    };
}

describe('RIPscrip detection', () => {
    describe('the layer', () => {
        it('is called rip, answers supports("rip") and nothing else', () => {
            const layer = Rip.createRipLayer({ source: 'termType' });
            assert.equal(layer.name, 'rip');
            assert.equal(layer.source, 'termType');
            assert.equal(layer.version, undefined);
            assert.equal(layer.supports('rip'), true);
            assert.equal(layer.supports('osc8_hyperlink'), false);
            assert.equal(layer.supports('vtx_audio'), false);
        });

        it('carries the version the terminal reported', () => {
            const v1 = Rip.createRipLayer({ source: 'probe', version: 'RIPSCRIP015410' });
            assert.equal(v1.version, 'RIPSCRIP015410');
            assert.equal(v1.majorVersion, 1);
            const v3 = Rip.createRipLayer({ source: 'probe', version: 'RIPSCRIP030001' });
            assert.equal(v3.majorVersion, 3);
        });

        it('takes only a well formed version', () => {
            for (const bad of [
                'RIPSCRIP01541',
                'RIPSCRIP01541x',
                'ripscrip015410',
                '',
                42,
            ]) {
                assert.equal(Rip.majorVersionOf(bad), undefined, String(bad));
                const layer = Rip.createRipLayer({ version: bad });
                assert.equal(layer.version, undefined, String(bad));
            }
        });

        it('is registered as a layer, not a base emulation', () => {
            assert.equal(Term.layerExists('rip'), true);
            assert.equal(Term.emulationExists('rip'), false);
            assert.equal(Term.createLayer('rip', { source: 'probe' }).name, 'rip');
            assert.throws(
                () => Term.createLayer('sixel'),
                /Unknown terminal emulation layer/
            );
        });
    });

    describe('the query', () => {
        it('is one constant, its trailing byte hidden by black on black', () => {
            assert.equal(Rip.VERSION_QUERY, '\x1b[!_');
            assert.equal(Rip.VERSION_PROBE, '\x1b[30;40m\x1b[!_\x1b[0m');
        });

        it('ends as a complete control sequence for a terminal that does not know it', () => {
            //  ECMA-48: CSI, parameter bytes 0x30-0x3F, intermediate bytes
            //  0x20-0x2F, one final byte 0x40-0x7E
            /* eslint-disable-next-line no-control-regex */
            assert.match(
                Rip.VERSION_QUERY,
                /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]$/
            );
            //  and is not DECSTR (CSI ! p, a soft terminal reset)
            assert.notEqual(Rip.VERSION_QUERY.slice(-1), 'p');
        });

        describe('connect probes', () => {
            function probeClient(emulationName) {
                const client = new EventEmitter();
                client.writes = [];
                client.log = { info() {}, debug() {}, warn() {} };
                client.term = {
                    emulation: Term.createEmulation(emulationName),
                    termWidth: 40,
                    termHeight: 25,
                    rawWrite: s => client.writes.push(s),
                    write: s => client.writes.push(s),
                };
                return client;
            }

            it('an ANSI session is sent it with the DA query, before anything waits', done => {
                const client = probeClient('ansi');
                const basic = client.term.emulation.probes.find(
                    p => 'basicPrepWork' === p.name
                );
                basic.run(client, err => {
                    assert.ifError(err);
                    assert.deepEqual(client.writes, [
                        '\x1b[0c',
                        Rip.VERSION_PROBE,
                        '\nDetecting client features...',
                    ]);
                    return done();
                });
            });

            it('adds no probe step: the ANSI connect sequence is unchanged', () => {
                assert.deepEqual(
                    Term.createEmulation('ansi').probes.map(p => p.name),
                    [
                        'basicPrepWork',
                        'discoverHomePosition',
                        'queryTermSizeByNonStandardAnsi',
                        'checkUtf8IfNeeded',
                        'probeUtf8IfOptedIn',
                        'queryCtermCapabilities',
                        'querySyncTERMFontSupport',
                    ]
                );
            });

            for (const name of ['petscii', 'atascii']) {
                it(`a ${name.toUpperCase()} session is never sent it`, done => {
                    const client = probeClient(name);
                    const probes = client.term.emulation.probes;
                    let i = 0;
                    const next = () => {
                        if (i === probes.length) {
                            const sent = client.writes.join('');
                            assert.equal(sent.includes('\x1b['), false);
                            assert.equal(sent.includes('!'), false);
                            return done();
                        }
                        probes[i++].run(client, next);
                    };
                    next();
                });
            }
        });
    });

    describe('the reply scanner', () => {
        it('hands a chunk with no reply on as the same object', () => {
            const { scan, seen } = makeScanner();
            const chunk = Buffer.from('hello RIPSCRAP R\x1b[A');
            scan(chunk);
            assert.equal(seen.length, 1);
            assert.equal(seen[0][1], chunk);
        });

        it('a lone typed R is not held back', () => {
            const { scan, seen } = makeScanner();
            const r = Buffer.from('R');
            scan(r);
            assert.deepEqual(seen, [['bytes', r]]);
        });

        it('takes a reply out, with or without the NUL, in stream order', () => {
            const { scan, flat } = makeScanner();
            scan(Buffer.from('a\x1b[1;1RRIPSCRIP015410b'));
            scan(Buffer.from('RIPSCRIP015410\x00c'));
            assert.equal(flat(), 'a\x1b[1;1R<RIPSCRIP015410>b<RIPSCRIP015410>c');
        });

        it('takes two replies in one chunk', () => {
            const { scan, flat } = makeScanner();
            scan(Buffer.from('RIPSCRIP015410\x00RIPSCRIP030001'));
            assert.equal(flat(), '<RIPSCRIP015410><RIPSCRIP030001>');
        });

        it('leaves RIPSCRIP followed by anything but six digits alone', () => {
            const { scan, flat } = makeScanner({ holdMs: 0 });
            scan(Buffer.from('RIPSCRIPxyz RIPSCRIP12a'));
            assert.equal(flat(), 'RIPSCRIPxyz RIPSCRIP12a');
        });

        it('takes a NUL that starts the next chunk', () => {
            const { scan, flat } = makeScanner();
            scan(Buffer.from('RIPSCRIP015410'));
            scan(Buffer.from('\x00x'));
            assert.equal(flat(), '<RIPSCRIP015410>x');
        });

        it('takes that NUL only straight after the reply, and only within the window', async () => {
            const late = makeScanner({ nulWindowMs: 10 });
            late.scan(Buffer.from('RIPSCRIP015410'));
            await sleep(30);
            late.scan(Buffer.from('\x00'));
            assert.equal(late.flat(), '<RIPSCRIP015410>\x00');

            const notNext = makeScanner();
            notNext.scan(Buffer.from('RIPSCRIP015410'));
            notNext.scan(Buffer.from('a'));
            notNext.scan(Buffer.from('\x00'));
            assert.equal(notNext.flat(), '<RIPSCRIP015410>a\x00');
        });

        it('puts a reply split across chunks back together', () => {
            for (let cut = 2; cut < 15; ++cut) {
                const reply = 'RIPSCRIP015410\x00';
                const { scan, flat } = makeScanner();
                scan(Buffer.from('x' + reply.slice(0, cut)));
                scan(Buffer.from(reply.slice(cut) + 'y'));
                assert.equal(flat(), 'x<RIPSCRIP015410>y', `cut at ${cut}`);
            }
        });

        it('never holds back a single R: a typed key, or the end of a CPR', () => {
            const { scan, seen } = makeScanner();
            const cpr = Buffer.from('\x1b[12;40R');
            scan(cpr);
            assert.deepEqual(seen, [['bytes', cpr]]);
            //  so a reply split right after its R is the one that gets through
            const split = makeScanner();
            split.scan(Buffer.from('xR'));
            split.scan(Buffer.from('IPSCRIP015410'));
            assert.equal(split.flat(), 'xRIPSCRIP015410');
        });

        it('hands held bytes on when nothing follows', async () => {
            const { scan, flat } = makeScanner({ holdMs: 10 });
            scan(Buffer.from('xRIPS'));
            assert.equal(flat(), 'x');
            await sleep(40);
            assert.equal(flat(), 'xRIPS');
        });

        it('held bytes that turn out not to be a reply go on in order', () => {
            const { scan, flat } = makeScanner();
            scan(Buffer.from('xRI'));
            scan(Buffer.from('ght'));
            assert.equal(flat(), 'xRIght');
        });

        it('dispose() drops held bytes and stops the timer; later input passes through', async () => {
            const { scanner, scan, flat, seen } = makeScanner({ holdMs: 10 });
            scan(Buffer.from('xRIPS'));
            scanner.dispose();
            await sleep(40);
            assert.equal(flat(), 'x');
            const chunk = Buffer.from('RIPSCRIP015410');
            scan(chunk);
            assert.equal(seen[seen.length - 1][1], chunk);
        });
    });

    describe('the ANSI input decoder', () => {
        it('reports a reply as "rip version", never as keys', () => {
            const d = makeDecoder();
            d.decode('RIPSCRIP015410\x00');
            assert.deepEqual(d.events, [['rip version', 'RIPSCRIP015410']]);
        });

        it('a late reply in the middle of typing a user name leaves only the name', () => {
            //  the failure to prevent: RIPSCRIP015410 typed into the login form
            const d = makeDecoder();
            for (const chunk of ['g', 'u', 'RIPSCRIP015410\x00', 'e', 's', 't', '\r']) {
                d.decode(chunk);
            }
            assert.equal(d.typed(), 'guest\r');
            assert.deepEqual(d.replies(), ['RIPSCRIP015410']);
        });

        it("IcyTerm's NUL arriving on its own is not a key either", () => {
            const d = makeDecoder();
            d.decode('RIPSCRIP015410');
            d.decode('\x00');
            d.decode('a');
            assert.equal(d.typed(), 'a');
            assert.equal(d.events.length, 2);
        });

        it('a reply among other replies leaks nothing', () => {
            const d = makeDecoder();
            d.decode('\x1b[=67;84;101;114;109;1;332cRIPSCRIP015410\x1b[1;1R');
            assert.deepEqual(
                d.events.map(e => e[0]),
                ['device attributes', 'rip version', 'cursor position report']
            );
        });

        it('everything else decodes exactly as before (held bytes once let go)', async () => {
            const inputs = [
                'abc',
                'RIP',
                'R',
                'RIPSCRIP',
                'RIPSCRIP01',
                '\x1b[A\x1b[B',
                '\r\n\t\x7f',
                Buffer.from([0xe1]),
                '\x1b[<0;1;2;3;5c\x1b[=6;1n\x1b[12;40R',
            ];
            for (const input of inputs) {
                const d = makeDecoder({ ripReply: { holdMs: 0 } });
                const before = [];
                const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'latin1');
                AnsiInput.decode(Buffer.from(buf), { isNixTerm: () => false }, (...e) =>
                    before.push(e)
                );
                d.decode(Buffer.from(buf));
                await sleep(5);
                assert.deepEqual(d.events, before, JSON.stringify(String(input)));
            }
        });

        it('each connection has its own decoder, and dispose()', () => {
            const a = Term.createEmulation('ansi');
            const b = Term.createEmulation('ansi');
            assert.notEqual(a.inputDecoder, b.inputDecoder);
            assert.equal(typeof a.inputDecoder.dispose, 'function');
        });
    });

    describe('selection', () => {
        it('TTYPE RIP: ANSI with the rip layer, no fallback', () => {
            assert.deepEqual(resolveEmulation({ termType: 'RIP' }), {
                requested: 'rip',
                source: 'termType',
                kind: 'layer',
                base: 'ansi',
                layers: ['rip'],
                fallback: false,
            });
        });

        it('TTYPE RIP attaches the layer and logs it at info', () => {
            const client = makeClient('RIP');
            selectClientEmulation(client, {});
            const emulation = client.term.emulation;
            assert.equal(emulation.name, 'ansi');
            assert.equal(emulation.hasLayer('rip'), true);
            assert.equal(emulation.layers.get('rip').source, 'termType');
            assert.equal(emulation.supports('rip', client.term), true);
            const info = client.logged.filter(l => 'info' === l.level);
            assert.equal(info.length, 1);
            assert.equal(info[0].info.source, 'termType');
            assert.match(info[0].msg, /layer "rip" attached \(termType\)/);
        });

        it('SyncTERM by name gets no layer until it answers', () => {
            const client = makeClient('syncterm');
            selectClientEmulation(client, {});
            assert.equal(client.term.emulation.hasLayer('rip'), false);
            assert.equal(client.term.emulation.supports('rip', client.term), false);
            assert.equal(client.logged.filter(l => 'info' === l.level).length, 0);
        });

        it('a reply attaches the layer for any ANSI session, with its version', () => {
            const client = makeClient('syncterm');
            selectClientEmulation(client, {});
            attachRipLayer(client, { source: 'probe', version: 'RIPSCRIP015410' });
            const layer = client.term.emulation.layers.get('rip');
            assert.equal(layer.source, 'probe');
            assert.equal(layer.version, 'RIPSCRIP015410');
            const info = client.logged.filter(l => 'info' === l.level);
            assert.equal(info.length, 1);
            assert.equal(info[0].info.version, 'RIPSCRIP015410');
            assert.equal(info[0].info.source, 'probe');
        });

        it('a reply after TTYPE RIP adds the version to the layer already there', () => {
            const client = makeClient('RIP');
            selectClientEmulation(client, {});
            const layer = client.term.emulation.layers.get('rip');
            attachRipLayer(client, { source: 'probe', version: 'RIPSCRIP015410' });
            assert.equal(client.term.emulation.layers.get('rip'), layer);
            assert.equal(layer.version, 'RIPSCRIP015410');
            assert.equal(layer.source, 'termType');
            const info = client.logged.filter(l => 'info' === l.level);
            assert.equal(info.length, 2);
            assert.equal(info[1].msg, 'RIPscrip version reported');
            //  a second reply changes nothing and logs nothing more
            attachRipLayer(client, { source: 'probe', version: 'RIPSCRIP030001' });
            assert.equal(layer.version, 'RIPSCRIP015410');
            assert.equal(client.logged.filter(l => 'info' === l.level).length, 2);
        });

        for (const name of ['petscii', 'atascii']) {
            it(`a ${name.toUpperCase()} session never gets the layer`, () => {
                const client = makeClient(name.toUpperCase());
                selectClientEmulation(client, {});
                assert.equal(client.term.emulation.name, name);
                assert.equal(attachRipLayer(client, { source: 'probe' }), undefined);
                assert.equal(client.term.emulation.layers.size, 0);
                assert.equal(client.term.emulation.supports('rip', client.term), false);
            });
        }
    });

    describe('the client', () => {
        let ClientModule;
        let ClientTerminal;
        let Events;

        before(() => {
            ClientModule = require('../core/client.js');
            ClientTerminal = require('../core/client_term.js').ClientTerminal;
            Events = require('../core/events.js');
        });

        function realClient() {
            const client = new ClientModule.Client();
            client.term = new ClientTerminal(null);
            client.log = makeLog().log;
            return client;
        }

        const release = client =>
            Events.removeListener(
                Events.getSystemEvents().ThemeChanged,
                client.themeChangedListener
            );

        it('a reply on the input attaches the layer; terminalSupports("rip") is true', () => {
            const client = realClient();
            const keys = [];
            const versions = [];
            client.on('key press', ch => keys.push(ch));
            client.on('rip version', v => versions.push(v));

            assert.equal(client.terminalSupports('rip'), false);
            client.emit('data', Buffer.from('RIPSCRIP015410\x00'));
            release(client);

            assert.deepEqual(keys, []);
            assert.deepEqual(versions, ['RIPSCRIP015410']);
            assert.equal(client.terminalSupports('rip'), true);
            assert.equal(
                client.term.emulation.layers.get('rip').version,
                'RIPSCRIP015410'
            );
        });

        it('TE[rip] is true for such a session, and TE[ansi] still is', () => {
            const loggerModule = require('../core/logger.js');
            if (!loggerModule.log) {
                loggerModule.log = {
                    warn() {},
                    info() {},
                    debug() {},
                    trace() {},
                    error() {},
                };
            }
            const acsParser = require('../core/acs_parser.js');
            const client = realClient();
            const ctx = { subject: { client, user: { properties: {} } } };

            assert.equal(acsParser.parse('TE[rip]', ctx), false);
            client.emit('data', Buffer.from('RIPSCRIP015410'));
            release(client);

            assert.equal(acsParser.parse('TE[rip]', ctx), true);
            assert.equal(acsParser.parse('TE[ansi]', ctx), true);
            assert.equal(acsParser.parse('TE[petscii,atascii]', ctx), false);
        });
    });

    describe('BBSDEV.DRP', () => {
        const os = require('os');
        const ACS = require('../core/acs.js');
        const DropFile = require('../core/dropfile.js');

        //  line 9 is RIP
        function ripField(term) {
            const user = {
                userId: 1,
                username: 'u',
                properties: {},
                getSanitizedName: () => 'u',
                getLegacySecurityLevel: () => 30,
                isSysOp: () => false,
                isRoot: () => false,
                isGroupMember: () => false,
                isAuthenticated: () => true,
                getProperty: () => undefined,
                getPropertyAsNumber: () => NaN,
                persistProperty: () => {},
            };
            const client = { node: 1, term, user };
            client.acs = new ACS({ client, user });
            const dropFile = new DropFile(client, {
                fileType: 'BBSDEV',
                baseDir: os.tmpdir(),
            });
            const configModule = require('../core/config.js');
            const previous = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                menus: { cls: false },
                general: { language: 'en-US', boardName: 'Test Board' },
            });
            try {
                return dropFile.getContents().toString('utf8').split('\r\n')[8];
            } finally {
                configModule._popTestConfig(previous);
            }
        }

        it('says N for an ANSI session and Y once the rip layer is attached', () => {
            const term = {
                termWidth: 80,
                termHeight: 25,
                outputEncoding: 'cp437',
                emulation: Term.createEmulation('ansi'),
            };
            assert.equal(ripField(term), 'N');
            term.emulation.addLayer(Rip.createRipLayer({ source: 'probe' }));
            assert.equal(ripField(term), 'Y');
        });

        it('says N for a stand-in term with no emulation', () => {
            assert.equal(
                ripField({ termWidth: 80, termHeight: 25, outputEncoding: 'cp437' }),
                'N'
            );
        });
    });
});
