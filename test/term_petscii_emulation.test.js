'use strict';

//
//  The PETSCII emulation as a whole (#593): the definition in
//  core/term/petscii/index.js, and a session selected into it.
//
const { strict: assert } = require('assert');

const { createEmulation } = require('../core/term');
const { selectClientEmulation } = require('../core/term/select.js');
const { ClientTerminal } = require('../core/client_term.js');

function makeOutput() {
    const written = [];
    return {
        writable: true,
        written,
        write(data, cb) {
            written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            if (cb) {
                cb(null);
            }
        },
    };
}

function petsciiTerm() {
    const output = makeOutput();
    const term = new ClientTerminal(output);
    const client = { term, log: { info() {}, debug() {}, warn() {} } };
    //  by listener rather than by terminal type: setting a terminal type on a
    //  real ClientTerminal needs the system configuration loaded
    selectClientEmulation(client, {
        firstMenu: 'telnetConnected',
        listener: { name: 'c64', emulation: 'petscii' },
    });
    return { term, client, output };
}

const wire = output => Buffer.concat(output.written);

describe('PETSCII emulation', () => {
    describe('definition', () => {
        it('is a base emulation with its own parts', () => {
            const emulation = createEmulation('petscii');
            assert.equal(emulation.name, 'petscii');
            assert.equal(emulation.encoding, 'petscii');
            assert.equal(emulation.defaults.cols, 40);
            assert.equal(emulation.defaults.rows, 25);
            assert.equal(emulation.outputTranslator.identity, false);
            assert.equal(typeof emulation.inputDecoder.decode, 'function');
        });

        it('takes no layers and reports no ANSI capabilities', () => {
            const emulation = createEmulation('petscii');
            assert.equal(emulation.addLayer({ name: 'rip' }), false);
            assert.equal(emulation.supports('osc8_hyperlink', {}), false);
            assert.equal(emulation.supports('vtx_audio', {}), false);
        });

        it('accepts only its own output encoding', () => {
            const { codec } = createEmulation('petscii');
            assert.equal(codec.encodingExists('petscii'), true);
            assert.equal(codec.encodingExists('cp437'), false);
            assert.equal(codec.encodingExists('utf8'), false);
        });

        it('each session gets its own translator and decoder', () => {
            const a = createEmulation('petscii');
            const b = createEmulation('petscii');
            assert.notEqual(a.outputTranslator, b.outputTranslator);
            a.outputTranslator.translate(Buffer.from('abc'));
            assert.notDeepEqual(a.outputTranslator.state(), b.outputTranslator.state());
        });

        it('asks nothing of the terminal at connect', () => {
            const { term, client, output } = petsciiTerm();
            term.emulation.probes.forEach(probe => probe.run(client, () => {}));
            assert.equal(output.written.length, 0);
        });

        it('settles the screen size: reported, else 40x25', () => {
            const reported = petsciiTerm();
            reported.term.termWidth = 80;
            reported.term.termHeight = 25;
            reported.term.emulation.probes[0].run(reported.client, () => {});
            assert.equal(reported.term.emulation.outputTranslator.state().cols, 80);

            const huge = petsciiTerm();
            huge.term.termWidth = 65535;
            huge.term.termHeight = 65535;
            huge.term.emulation.probes[0].run(huge.client, () => {});
            assert.deepEqual([huge.term.termWidth, huge.term.termHeight], [160, 100]);
            assert.equal(huge.term.emulation.outputTranslator.state().rows, 100);

            const tiny = petsciiTerm();
            tiny.term.termWidth = 1;
            tiny.term.termHeight = 1;
            tiny.term.emulation.probes[0].run(tiny.client, () => {});
            assert.deepEqual([tiny.term.termWidth, tiny.term.termHeight], [40, 25]);

            const silent = petsciiTerm();
            silent.term.emulation.probes[0].run(silent.client, () => {});
            assert.equal(silent.term.termWidth, 40);
            assert.equal(silent.term.termHeight, 25);
            assert.equal(silent.term.emulation.outputTranslator.state().cols, 40);
        });
    });

    describe('a selected session', () => {
        it('writes PETSCII, never an escape sequence', () => {
            const { term, output } = petsciiTerm();
            term.write('\x1b[2J\x1b[1;31mHello\x1b[0m\n');
            const bytes = wire(output);
            assert.equal(bytes.includes(0x1b), false);
            //  clear, then 'Hello' with case swapped for the lower/upper set
            assert.equal(bytes.includes(0x93), true);
            assert.notEqual(
                bytes.indexOf(Buffer.from([0xc8, 0x45, 0x4c, 0x4c, 0x4f])),
                -1
            );
        });

        it('rawWrite of ANSI sequences is translated too', () => {
            const { term, output } = petsciiTerm();
            term.rawWrite('\x1b[3;5H');
            term.write('x');
            assert.equal(wire(output).includes(0x1b), false);
            assert.deepEqual(
                [
                    term.emulation.outputTranslator.state().row,
                    term.emulation.outputTranslator.state().col,
                ],
                [2, 5]
            );
        });

        it('a batch is translated as one piece', () => {
            const { term, output } = petsciiTerm();
            term.beginWrite();
            term.rawWrite('\x1b[');
            term.rawWrite('2;2H');
            term.write('ok');
            term.commitWrite();
            assert.equal(output.written.length, 1);
            assert.equal(wire(output).includes(0x1b), false);
        });

        it('passThroughWrite goes out untouched', () => {
            const { term, output } = petsciiTerm();
            term.passThroughWrite(Buffer.from([0x1b, 0x5b, 0x48, 0xff]));
            assert.deepEqual([...wire(output)], [0x1b, 0x5b, 0x48, 0xff]);
        });

        it('keeps its encoding whatever tries to change it', () => {
            const { term } = petsciiTerm();
            term.outputEncoding = 'utf8';
            assert.equal(term.outputEncoding, 'petscii');
            term.outputEncoding = 'cp437';
            assert.equal(term.outputEncoding, 'petscii');
        });

        it('control code points in text cannot drive the terminal', () => {
            const { term, output } = petsciiTerm();
            term.write('a');
            const before = wire(output).length;
            term.write(String.fromCharCode(0x93, 0x13, 0x12, 0x8e, 0x05) + 'b');
            const added = [...wire(output).slice(before)];
            assert.deepEqual(added, [0x42]);
        });

        it('decodes keys as SyncTERM sends them', () => {
            const { term } = petsciiTerm();
            const keys = [];
            term.emulation.inputDecoder.decode(
                Buffer.from([0x41, 0x42, 0x43, 0x0d]),
                { isNixTerm: () => false },
                (event, ch, key) => keys.push(key.name)
            );
            assert.deepEqual(keys, ['a', 'b', 'c', 'return']);
        });
    });

    describe('an ANSI session', () => {
        it('is untouched: same encoding, identity translator', () => {
            const output = makeOutput();
            const term = new ClientTerminal(output);
            selectClientEmulation(
                { term, log: { info() {}, debug() {}, warn() {} } },
                { firstMenu: 'telnetConnected' }
            );
            assert.equal(term.emulation.name, 'ansi');
            assert.equal(term.outputEncoding, 'cp437');
            term.write('\x1b[1;31mHi\x1b[0m');
            assert.equal(wire(output).toString('latin1'), '\x1b[1;31mHi\x1b[0m');
        });
    });
});
