'use strict';

//  The terminal emulation object (#593): what it is made of, and that the
//  three seams -- connect probes, client input, ClientTerminal output -- go
//  through it. ANSI is the only emulation, so most of this pins "nothing
//  changed"; the rest uses stand-in parts to show another emulation could
//  plug in.

const { strict: assert } = require('assert');

const Term = require('../core/term');
const { Emulation } = require('../core/term/emulation.js');
const AnsiInput = require('../core/term/ansi/input_decoder.js');
const { createIconvCodec } = require('../core/term/codecs/iconv_codec.js');
const { createIdentityTranslator } = require('../core/term/translators/identity.js');
const { ClientTerminal } = require('../core/client_term.js');
const { getArtTypePolicy } = require('../core/art.js');

function makeOutput() {
    const chunks = [];
    return {
        writable: true,
        chunks,
        write(data, cb) {
            chunks.push(data);
            cb && cb(null);
        },
        sent: () =>
            Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(c)))),
    };
}

//  An output translator that is visibly not the identity: upper-cases ASCII
function shoutingTranslator() {
    const passed = [];
    return {
        passed,
        translate: data =>
            Buffer.from(
                (Buffer.isBuffer(data) ? data : Buffer.from(data))
                    .toString('latin1')
                    .toUpperCase(),
                'latin1'
            ),
        passThrough: data => passed.push(Buffer.from(data)),
    };
}

describe('terminal emulation', () => {
    describe('registry', () => {
        it('ANSI is the default; PETSCII and ATASCII are the other base emulations', () => {
            assert.equal(Term.DEFAULT_EMULATION, 'ansi');
            assert.deepEqual(Term.emulationNames(), ['ansi', 'petscii', 'atascii']);
            assert.equal(Term.emulationExists('ansi'), true);
            assert.equal(Term.emulationExists('petscii'), true);
            assert.equal(Term.emulationExists('atascii'), true);
            assert.equal(Term.emulationExists('viewdata'), false);
            assert.equal(Term.createEmulation().name, 'ansi');
        });

        it('an unknown emulation is an error, not a silent ANSI', () => {
            assert.throws(() => Term.createEmulation('viewdata'), /Unknown terminal/);
        });

        it('each client gets its own instance', () => {
            const a = Term.createEmulation();
            const b = Term.createEmulation();
            a.capabilities.osc8 = true;
            assert.equal(b.capabilities.osc8, undefined);
            assert.notEqual(a.layers, b.layers);
        });

        it('emulationOf() treats a stand-in term as ANSI', () => {
            const term = new ClientTerminal(null);
            assert.equal(Term.emulationOf(term), term.emulation);
            assert.equal(Term.emulationOf({}).name, 'ansi');
            assert.equal(Term.emulationOf(undefined).name, 'ansi');
        });
    });

    describe('the ANSI emulation object', () => {
        const emulation = Term.createEmulation('ansi');

        it('has every part of the component interface', () => {
            assert.equal(emulation.name, 'ansi');
            assert(Array.isArray(emulation.probes));
            assert.equal(typeof emulation.inputDecoder.decode, 'function');
            assert.equal(typeof emulation.outputTranslator.translate, 'function');
            assert.equal(typeof emulation.outputTranslator.passThrough, 'function');
            assert.equal(typeof emulation.codec.encode, 'function');
            assert.deepEqual(emulation.capabilities, {});
            assert.equal(emulation.defaults.cols, 80);
            assert.equal(emulation.defaults.rows, 25);
            assert.equal(typeof emulation.defaults.artTypes, 'function');
            assert.equal(emulation.layers.size, 0);
        });

        it('probes are the connect sequence, in its long-standing order', () => {
            assert.deepEqual(
                emulation.probes.map(p => p.name),
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
            emulation.probes.forEach(p => assert.equal(typeof p.run, 'function'));
        });

        it('the output translator is the identity, for strings and buffers', () => {
            const buf = Buffer.from([0x1b, 0x5b, 0x48, 0xff, 0x00]);
            assert.equal(emulation.outputTranslator.translate(buf), buf);
            assert.equal(emulation.outputTranslator.translate('\x1b[H'), '\x1b[H');
        });

        it('the codec sends cp437 through the BBS-aware variant, utf8 as-is', () => {
            //  0x01 (smiley) only survives in the BBS-aware CP437 codec
            assert.deepEqual(emulation.codec.encode('☺', 'cp437'), Buffer.from([1]));
            assert.deepEqual(emulation.codec.encode('░', 'cp437'), Buffer.from([0xb0]));
            assert.deepEqual(emulation.codec.encode('░', 'utf8'), Buffer.from('░'));
            assert.equal(emulation.codec.decode(Buffer.from([0xb0]), 'cp437'), '░');
            assert.equal(emulation.codec.encodingExists('cp437'), true);
            assert.equal(emulation.codec.encodingExists('nope'), false);
        });

        it('art types follow the output encoding', () => {
            assert.deepEqual(emulation.artTypes({ outputEncoding: 'utf8' }), {
                preferred: [['.utf8ans']],
            });
            assert.deepEqual(emulation.artTypes({ outputEncoding: 'cp437' }), {
                preferred: [],
                last: ['.utf8ans'],
            });
        });

        it('supports() answers as Client.terminalSupports() always has', () => {
            const term = (termClient, caps = {}, nix = false) => ({
                termClient,
                termCapabilities: caps,
                isNixTerm: () => nix,
            });
            assert.equal(emulation.supports('vtx_audio', term('vtx')), true);
            assert.equal(emulation.supports('vtx_audio', term('cterm')), false);
            assert.equal(emulation.supports('osc8_hyperlink', term('cterm')), false);
            assert.equal(
                emulation.supports('osc8_hyperlink', term('cterm', { osc8: true })),
                true
            );
            assert.equal(emulation.supports('osc8_hyperlink', term('icy_term')), true);
            assert.equal(emulation.supports('osc8_hyperlink', term('vtx')), true);
            assert.equal(
                emulation.supports('osc8_hyperlink', term('unknown', {}, true)),
                true
            );
            assert.equal(emulation.supports('no_such_thing', term('cterm')), false);
        });
    });

    describe('layers', () => {
        it('ANSI takes a layer; it adds a capability and an art preference', () => {
            const emulation = Term.createEmulation('ansi');
            const added = emulation.addLayer({
                name: 'rip',
                supports: query => 'rip' === query,
                artTypes: { preferred: [['.rip']] },
            });
            assert.equal(added, true);
            assert.equal(emulation.hasLayer('rip'), true);
            assert.equal(emulation.supports('rip', {}), true);
            assert.deepEqual(emulation.artTypes({ outputEncoding: 'utf8' }), {
                preferred: [['.rip'], ['.utf8ans']],
            });
            assert.deepEqual(emulation.artTypes({ outputEncoding: 'cp437' }), {
                preferred: [['.rip']],
                last: ['.utf8ans'],
            });
        });

        it('a base that does not take layers refuses one', () => {
            const base = new Emulation({
                name: 'standin',
                createInputDecoder: () => ({ decode() {} }),
                createOutputTranslator: createIdentityTranslator,
                codec: createIconvCodec(),
                defaults: { cols: 40, rows: 25, artTypes: () => ({ preferred: [] }) },
            });
            assert.equal(base.addLayer({ name: 'rip' }), false);
            assert.equal(base.hasLayer('rip'), false);
            assert.equal(base.supports('anything', {}), false);
            assert.deepEqual(base.probes, []);
        });
    });

    describe('ANSI input decoder', () => {
        const decode = (bytes, nix = false) => {
            const events = [];
            AnsiInput.decode(
                Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'latin1'),
                { isNixTerm: () => nix },
                (name, ...args) => events.push([name, ...args])
            );
            return events;
        };
        const keyNames = events =>
            events.filter(e => 'key press' === e[0]).map(e => e[2] && e[2].name);

        it('plain characters', () => {
            const events = decode('aB1');
            assert.deepEqual(
                events.map(e => e[1]),
                ['a', 'B', '1']
            );
            assert.deepEqual(keyNames(events), ['a', 'shift + b', undefined]);
        });

        it('control keys, return, tab, escape', () => {
            assert.deepEqual(keyNames(decode('\r\n\t\x03 ')), [
                'return',
                'line feed',
                'tab',
                'ctrl + c',
                'space',
            ]);
            assert.deepEqual(keyNames(decode('\x1b')), ['escape']);
        });

        it('cursor and function keys', () => {
            assert.deepEqual(
                keyNames(decode('\x1b[A\x1b[B\x1b[C\x1b[D\x1bOP\x1b[24~\x1b[V\x1b[Z')),
                [
                    'up arrow',
                    'down arrow',
                    'right arrow',
                    'left arrow',
                    'f1',
                    'f12',
                    'page up',
                    'shift + tab',
                ]
            );
        });

        it('0x7f is delete, or backspace on an xterm class terminal', () => {
            assert.deepEqual(keyNames(decode('\x7f', false)), ['delete']);
            assert.deepEqual(keyNames(decode('\x7f', true)), ['backspace']);
            assert.deepEqual(keyNames(decode('\b')), ['backspace']);
        });

        it('a lone high byte is ESC + (byte - 128): the ANSI-only meta rule', () => {
            assert.deepEqual(keyNames(decode(Buffer.from([0xe1]))), ['meta + a']);
        });

        it('query replies are reported, in stream order, not as keys', () => {
            const events = decode('x\x1b[<0;1;2;3;5c\x1b[=6;1n\x1b[12;40Ry');
            assert.deepEqual(
                events.map(e => e[0]),
                [
                    'key press',
                    'cterm device attributes',
                    'cterm capability response',
                    'cursor position report',
                    'key press',
                ]
            );
            assert.deepEqual(events[1][1].ctda, [1, 2, 3, 5]);
            assert.deepEqual(events[2][1], { id: 6, value: 1 });
            assert.deepEqual(events[3][1], [12, 40]);
        });

        it('a DA reply naming a known client is reported', () => {
            const events = decode('\x1b[=67;84;101;114;109;1;332c');
            assert.deepEqual(events, [
                ['device attributes', { termClient: 'cterm', version: '1.332' }],
            ]);
        });

        it('getKeyComponentsFromCode() hands out a copy, not the table entry', () => {
            const first = AnsiInput.getKeyComponentsFromCode('[A');
            assert.deepEqual(first, { name: 'up arrow' });
            first.name = 'changed';
            assert.deepEqual(AnsiInput.getKeyComponentsFromCode('[A'), {
                name: 'up arrow',
            });
            assert.equal(AnsiInput.getKeyComponentsFromCode('nope'), undefined);
        });

        it('a chunk holding a mouse report is dropped whole', () => {
            assert.deepEqual(decode('a\x1b[<0;10;5Mb'), []);
        });
    });

    describe('ClientTerminal goes through its emulation', () => {
        it('has an ANSI emulation, and termCapabilities is its capabilities', () => {
            const term = new ClientTerminal(null);
            assert.equal(term.emulation.name, 'ansi');
            assert.equal(term.termCapabilities, term.emulation.capabilities);

            term.termCapabilities.osc8 = true;
            assert.equal(term.emulation.capabilities.osc8, true);

            const replaced = { ctda: [1] };
            term.termCapabilities = replaced;
            assert.equal(term.emulation.capabilities, replaced);
            assert(Object.keys(term).includes('termCapabilities'));
        });

        it('encode() asks the codec', () => {
            const term = new ClientTerminal(null);
            const asked = [];
            term.emulation.codec = {
                encodingExists: () => true,
                encode: (s, encoding) => {
                    asked.push([s, encoding]);
                    return Buffer.from('X');
                },
            };
            assert.deepEqual(term.encode('a\nb'), Buffer.from('X'));
            assert.deepEqual(asked, [['a\r\nb', 'cp437']]);
        });

        it('ANSI: write, rawWrite, a batch and dripWrite reach the socket unchanged', done => {
            const output = makeOutput();
            const term = new ClientTerminal(output);

            term.write('h░\n');
            term.rawWrite('\x1b[H');
            term.rawWrite(Buffer.from([0xff, 0x00]));
            term.passThroughWrite(Buffer.from([0x18, 0x18]));
            term.beginWrite();
            term.rawWrite('ab');
            term.passThroughWrite(Buffer.from('cd'));
            term.write('e');
            term.commitWrite();

            //  a string handed to rawWrite() is still handed to the socket as one
            assert.equal(output.chunks[1], '\x1b[H');

            term.dripWrite(Buffer.from('drip'), 1000000, err => {
                assert.ifError(err);
                assert.deepEqual(
                    output.sent(),
                    Buffer.concat([
                        Buffer.from([0x68, 0xb0, 0x0d, 0x0a]),
                        Buffer.from('\x1b[H'),
                        Buffer.from([0xff, 0x00, 0x18, 0x18]),
                        Buffer.from('abcde'),
                        Buffer.from('drip'),
                    ])
                );
                done();
            });
        });

        it('every socket path uses the output translator; pass-through does not', done => {
            const output = makeOutput();
            const term = new ClientTerminal(output);
            const translator = shoutingTranslator();
            term.emulation.outputTranslator = translator;

            term.write('one ');
            term.rawWrite('two ');
            term.passThroughWrite(Buffer.from('raw '));

            term.beginWrite();
            term.rawWrite('ba');
            term.rawWrite('tch ');
            term.passThroughWrite(Buffer.from('raw2 '));
            term.write('tail ');
            term.commitWrite();

            term.dripWrite(Buffer.from('drip'), 1000000, err => {
                assert.ifError(err);
                assert.equal(
                    output.sent().toString(),
                    'ONE TWO raw BATCH raw2 TAIL DRIP'
                );
                //  the translator is told what went around it
                assert.deepEqual(
                    translator.passed.map(b => b.toString()),
                    ['raw ', 'raw2 ']
                );
                done();
            });
        });

        it('a batch is translated as one piece', () => {
            const output = makeOutput();
            const term = new ClientTerminal(output);
            const seen = [];
            term.emulation.outputTranslator = {
                translate: data => {
                    seen.push(data.toString());
                    return data;
                },
                passThrough() {},
            };
            term.beginWrite();
            term.rawWrite('\x1b[');
            term.rawWrite('1;1H');
            term.commitWrite();
            assert.deepEqual(seen, ['\x1b[1;1H']);
        });
    });

    describe('art type policy comes from the emulation', () => {
        //  '.zzz' stands in for a type an emulation might add; '.seq' is real
        //  native art now and has its own rule (test/art_native_petscii.test.js)
        const types = ['.ans', '.utf8ans', '.zzz'];

        it('a real terminal: ANSI defaults by output encoding', () => {
            const term = new ClientTerminal(null);
            assert.deepEqual(getArtTypePolicy({ term }, types), {
                allowed: types,
                preferred: [['.ans', '.zzz'], ['.utf8ans']],
            });
            term.outputEncoding = 'utf8';
            assert.deepEqual(getArtTypePolicy({ term }, types), {
                allowed: types,
                preferred: [['.utf8ans'], ['.ans', '.zzz']],
            });
        });

        it("another emulation's defaults decide what is allowed", () => {
            const term = new ClientTerminal(null);
            term.emulation.defaults = {
                cols: 40,
                rows: 25,
                artTypes: () => ({ allowed: ['.zzz'], preferred: [['.zzz']] }),
            };
            assert.deepEqual(getArtTypePolicy({ term }, types), {
                allowed: ['.zzz'],
                preferred: [['.zzz']],
            });
        });

        it('a stand-in term without an emulation behaves as before', () => {
            assert.deepEqual(
                getArtTypePolicy({ term: { outputEncoding: 'utf8' } }, types),
                { allowed: types, preferred: [['.utf8ans'], ['.ans', '.zzz']] }
            );
            assert.deepEqual(getArtTypePolicy(undefined, types), {
                allowed: types,
                preferred: [types],
            });
        });

        it('native PETSCII art is never allowed for an ANSI terminal', () => {
            const term = new ClientTerminal(null);
            term.emulation.defaults = {
                cols: 80,
                rows: 25,
                artTypes: () => ({ allowed: ['.seq'], preferred: [['.seq']] }),
            };
            assert.deepEqual(getArtTypePolicy({ term }, ['.ans', '.seq']), {
                allowed: [],
                preferred: [],
            });
        });
    });
});
