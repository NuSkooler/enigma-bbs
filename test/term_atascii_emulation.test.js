'use strict';

//
//  The ATASCII emulation as a whole (#593): the definition in
//  core/term/atascii/index.js, and a session selected into it.
//
const { strict: assert } = require('assert');

const { createEmulation } = require('../core/term');
const { selectClientEmulation } = require('../core/term/select.js');
const { ClientTerminal } = require('../core/client_term.js');

const CONTROL_BYTES = new Set([
    0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7d, 0x7e, 0x7f, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xfd,
    0xfe, 0xff,
]);

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

function atasciiTerm() {
    const output = makeOutput();
    const term = new ClientTerminal(output);
    const client = { term, log: { info() {}, debug() {}, warn() {} } };
    //  by listener rather than by terminal type: setting a terminal type on a
    //  real ClientTerminal needs the system configuration loaded
    selectClientEmulation(client, {
        firstMenu: 'telnetConnected',
        listener: { name: 'atari', emulation: 'atascii' },
    });
    return { term, client, output };
}

const wire = output => Buffer.concat(output.written);

describe('ATASCII emulation', () => {
    describe('definition', () => {
        it('is a base emulation with its own parts', () => {
            const emulation = createEmulation('atascii');
            assert.equal(emulation.name, 'atascii');
            assert.equal(emulation.encoding, 'atascii');
            assert.equal(emulation.defaults.cols, 40);
            assert.equal(emulation.defaults.rows, 24);
            assert.equal(emulation.outputTranslator.identity, false);
            assert.equal(typeof emulation.inputDecoder.decode, 'function');
            emulation.inputDecoder.dispose();
        });

        it('takes no layers and reports no ANSI capabilities', () => {
            const emulation = createEmulation('atascii');
            assert.equal(emulation.addLayer({ name: 'rip' }), false);
            assert.equal(emulation.supports('osc8_hyperlink', {}), false);
            emulation.inputDecoder.dispose();
        });

        it('accepts only its own output encoding', () => {
            const { codec } = createEmulation('atascii');
            assert.equal(codec.encodingExists('atascii'), true);
            assert.equal(codec.encodingExists('petscii'), false);
            assert.equal(codec.encodingExists('cp437'), false);
            assert.equal(codec.encodingExists('utf8'), false);
        });

        it("is never offered another emulation's native art", () => {
            const emulation = createEmulation('atascii');
            const types = emulation.artTypes({ outputEncoding: 'atascii' });
            assert.equal(JSON.stringify(types).includes('.seq'), false);
            emulation.inputDecoder.dispose();
        });

        it('asks nothing of the terminal at connect', () => {
            const { term, client, output } = atasciiTerm();
            term.emulation.probes.forEach(probe => probe.run(client, () => {}));
            assert.equal(output.written.length, 0);
            term.disconnect();
        });

        it('settles the screen size: reported, bounded, else 40x24', () => {
            const reported = atasciiTerm();
            reported.term.termWidth = 80;
            reported.term.termHeight = 25;
            reported.term.emulation.probes[0].run(reported.client, () => {});
            assert.equal(reported.term.emulation.outputTranslator.state().cols, 80);

            const huge = atasciiTerm();
            huge.term.termWidth = 65535;
            huge.term.termHeight = 65535;
            huge.term.emulation.probes[0].run(huge.client, () => {});
            assert.deepEqual([huge.term.termWidth, huge.term.termHeight], [160, 100]);

            const silent = atasciiTerm();
            silent.term.emulation.probes[0].run(silent.client, () => {});
            assert.deepEqual([silent.term.termWidth, silent.term.termHeight], [40, 24]);
            assert.equal(silent.term.emulation.outputTranslator.state().rows, 24);

            [reported, huge, silent].forEach(s => s.term.disconnect());
        });
    });

    describe('a selected session', () => {
        it('writes ATASCII: no escape sequence, no stray control byte', () => {
            const { term, output } = atasciiTerm();
            term.write('\x1b[2J\x1b[1;31mHello\x1b[0m\n');
            const bytes = [...wire(output)];
            //  clear, the text as it is (ATASCII letters sit at ASCII), end of line
            assert.deepEqual(bytes, [0x7d, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x9b]);
            term.disconnect();
        });

        it('shows reverse video as inverse characters', () => {
            const { term, output } = atasciiTerm();
            term.write('\x1b[2J\x1b[7mHi\x1b[0m');
            assert.deepEqual([...wire(output)], [0x7d, 0xc8, 0xe9]);
            term.disconnect();
        });

        it('rawWrite of ANSI sequences is translated too', () => {
            const { term, output } = atasciiTerm();
            term.rawWrite('\x1b[2J\x1b[3;5H');
            term.write('x');
            assert.equal(wire(output).includes(0x1b), false);
            const state = term.emulation.outputTranslator.state();
            assert.deepEqual([state.row, state.col], [2, 5]);
            term.disconnect();
        });

        it('passThroughWrite goes out untouched', () => {
            const { term, output } = atasciiTerm();
            term.passThroughWrite(Buffer.from([0x1b, 0x5b, 0x48, 0xff]));
            assert.deepEqual([...wire(output)], [0x1b, 0x5b, 0x48, 0xff]);
            term.disconnect();
        });

        it('keeps its encoding whatever tries to change it', () => {
            const { term } = atasciiTerm();
            term.outputEncoding = 'utf8';
            assert.equal(term.outputEncoding, 'atascii');
            term.outputEncoding = 'cp437';
            assert.equal(term.outputEncoding, 'atascii');
            term.disconnect();
        });

        it('control characters in text cannot drive the terminal', () => {
            const { term, output } = atasciiTerm();
            term.write('\x1b[2Ja');
            const before = wire(output).length;
            term.write(String.fromCharCode(0x9b, 0x7f, 0x1c, 0x9c, 0xfd) + '}~b');
            const added = [...wire(output).slice(before)];
            assert.equal(
                added.some(b => CONTROL_BYTES.has(b)),
                false,
                added.map(b => b.toString(16)).join(' ')
            );
            assert.equal(added[added.length - 1], 0x62);
            term.disconnect();
        });

        it('decodes keys as SyncTERM and IcyTerm send them', () => {
            const { term } = atasciiTerm();
            const keys = [];
            const emit = (event, ch, key) => keys.push(key ? key.name : ch);
            const decoder = term.emulation.inputDecoder;
            //  SyncTERM: Return is CR LF without telnet BINARY
            decoder.decode(Buffer.from([0x48, 0x69, 0x0d, 0x0a]), {}, emit);
            //  IcyTerm: Return is the Atari end of line, arrows are ESC-prefixed
            decoder.decode(Buffer.from([0x1b, 0x1c, 0x9b]), {}, emit);
            assert.deepEqual(keys, ['shift + h', 'i', 'return', 'up arrow', 'return']);
            term.disconnect();
        });

        it('a held Escape is not reported after the session has ended', done => {
            const { term } = atasciiTerm();
            const keys = [];
            term.emulation.inputDecoder.decode(Buffer.from([0x1b]), {}, (e, ch, key) =>
                keys.push(key.name)
            );
            term.disconnect();
            setTimeout(() => {
                assert.deepEqual(keys, []);
                done();
            }, 160);
        });
    });

    describe('other sessions', () => {
        it('an ANSI session is untouched, and disconnects as before', () => {
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
            assert.equal(typeof term.emulation.inputDecoder.dispose, 'undefined');
            term.disconnect();
            assert.equal(term.output, null);
        });
    });
});
