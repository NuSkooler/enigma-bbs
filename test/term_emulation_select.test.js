'use strict';

//  Which emulation a connection gets (#593): the listener's |emulation| first,
//  then the terminal type, else ANSI. Only ANSI is implemented, so anything
//  else is recorded and falls back to ANSI with a log line.

const { strict: assert } = require('assert');

const {
    emulationFromTermType,
    resolveEmulation,
    selectClientEmulation,
} = require('../core/term/select.js');
const { createEmulation } = require('../core/term');

//  A stand-in term: the real termType setter also picks an output encoding
//  from the loaded config, which is not what is under test here.
function makeClient(termType) {
    const logged = [];
    const term = {
        termType: (termType || 'unknown').toLowerCase(),
        emulation: createEmulation(),
    };
    const record = level => (info, msg) => logged.push({ level, info, msg });
    return {
        term,
        logged,
        log: { info: record('info'), debug: record('debug'), warn: record('warn') },
    };
}

describe('terminal emulation selection', () => {
    describe('TTYPE mapping', () => {
        it('recognises what SyncTERM and IcyTerm announce, in any case', () => {
            assert.equal(emulationFromTermType('PETSCII'), 'petscii');
            assert.equal(emulationFromTermType('petscii'), 'petscii');
            assert.equal(emulationFromTermType('ATASCII'), 'atascii');
            assert.equal(emulationFromTermType('RIP'), 'rip');
            assert.equal(emulationFromTermType(' Atascii '), 'atascii');
        });

        it('every other terminal type names nothing', () => {
            for (const ttype of [
                'ansi',
                'ansi-bbs',
                'xterm',
                'xterm-256color',
                'syncterm',
                'unknown',
                'vt100',
                'ripterm',
                'petscii-80',
                'constructor',
                '__proto__',
                '',
                undefined,
                null,
                42,
            ]) {
                assert.equal(emulationFromTermType(ttype), undefined, String(ttype));
            }
        });
    });

    describe('resolveEmulation', () => {
        it('nothing asked: ANSI by default, no fallback', () => {
            for (const args of [
                undefined,
                {},
                { termType: 'ansi' },
                { termType: 'xterm' },
            ]) {
                assert.deepEqual(resolveEmulation(args), {
                    requested: 'ansi',
                    source: 'default',
                    kind: 'base',
                    base: 'ansi',
                    layers: [],
                    fallback: false,
                });
            }
        });

        it('TTYPE PETSCII and ATASCII are honoured', () => {
            assert.deepEqual(resolveEmulation({ termType: 'petscii' }), {
                requested: 'petscii',
                source: 'termType',
                kind: 'base',
                base: 'petscii',
                layers: [],
                fallback: false,
            });
            assert.deepEqual(resolveEmulation({ termType: 'ATASCII' }), {
                requested: 'atascii',
                source: 'termType',
                kind: 'base',
                base: 'atascii',
                layers: [],
                fallback: false,
            });
        });

        it('TTYPE RIP: the rip layer on ANSI (#989)', () => {
            assert.deepEqual(resolveEmulation({ termType: 'rip' }), {
                requested: 'rip',
                source: 'termType',
                kind: 'layer',
                base: 'ansi',
                layers: ['rip'],
                fallback: false,
            });
        });

        it("the listener's emulation wins over the terminal type", () => {
            const r = resolveEmulation({
                termType: 'atascii',
                listenerEmulation: 'PETSCII',
            });
            assert.equal(r.requested, 'petscii');
            assert.equal(r.source, 'listener');

            const ansi = resolveEmulation({
                termType: 'petscii',
                listenerEmulation: 'ansi',
            });
            assert.deepEqual(ansi, {
                requested: 'ansi',
                source: 'listener',
                kind: 'base',
                base: 'ansi',
                layers: [],
                fallback: false,
            });
        });

        it('an empty or non-string listener emulation is no request', () => {
            for (const listenerEmulation of ['', '  ', undefined, null, 7, {}]) {
                const r = resolveEmulation({ termType: 'ansi', listenerEmulation });
                assert.equal(r.source, 'default');
                assert.equal(r.fallback, false);
            }
        });

        it('a name we do not know falls back to ANSI', () => {
            for (const name of ['viewdata', 'constructor', '__proto__', 'toString']) {
                const r = resolveEmulation({ listenerEmulation: name });
                assert.equal(r.kind, 'unknown', name);
                assert.equal(r.base, 'ansi', name);
                assert.equal(r.fallback, true, name);
            }
        });
    });

    describe('selectClientEmulation', () => {
        it('an ordinary caller keeps its ANSI emulation object and logs only debug', () => {
            const client = makeClient('ansi');
            const before = client.term.emulation;
            before.capabilities.osc8 = true;

            selectClientEmulation(client, { firstMenu: 'telnetConnected' });

            assert.equal(client.term.emulation, before);
            assert.equal(client.term.emulation.capabilities.osc8, true);
            assert.deepEqual(client.term.requestedEmulation, {
                name: 'ansi',
                source: 'default',
            });
            assert.deepEqual(
                client.logged.map(l => l.level),
                ['debug']
            );
        });

        it('TTYPE PETSCII: the session becomes PETSCII with its own encoding', () => {
            const client = makeClient('PETSCII');
            selectClientEmulation(client, { firstMenu: 'telnetConnected' });

            assert.equal(client.term.emulation.name, 'petscii');
            assert.equal(client.term.outputEncoding, 'petscii');
            assert.deepEqual(client.term.requestedEmulation, {
                name: 'petscii',
                source: 'termType',
            });
            assert.equal(client.logged.length, 1);
            assert.equal(client.logged[0].level, 'debug');
            assert.equal(client.logged[0].info.emulation, 'petscii');
            assert.equal(client.logged[0].info.termType, 'petscii');
        });

        it('TTYPE ATASCII: the session becomes ATASCII with its own encoding', () => {
            const client = makeClient('ATASCII');
            selectClientEmulation(client, { firstMenu: 'telnetConnected' });

            assert.equal(client.term.emulation.name, 'atascii');
            assert.equal(client.term.outputEncoding, 'atascii');
            assert.deepEqual(client.term.requestedEmulation, {
                name: 'atascii',
                source: 'termType',
            });
            assert.equal(client.logged.length, 1);
            assert.equal(client.logged[0].level, 'debug');
            assert.equal(client.logged[0].info.emulation, 'atascii');
        });

        it('TTYPE RIP: stays ANSI, records the request, attaches the rip layer', () => {
            const client = makeClient('RIP');
            selectClientEmulation(client, { firstMenu: 'telnetConnected' });

            assert.equal(client.term.emulation.name, 'ansi');
            assert.equal(client.term.emulation.hasLayer('rip'), true);
            assert.equal(client.term.outputEncoding, undefined);
            assert.deepEqual(client.term.requestedEmulation, {
                name: 'rip',
                source: 'termType',
            });
            //  the layer at info, the selection itself at debug as usual
            assert.deepEqual(
                client.logged.map(l => l.level),
                ['info', 'debug']
            );
            assert.match(client.logged[0].msg, /layer "rip" attached \(termType\)/);
        });

        it("a named listener's emulation is used and named in the log", () => {
            const client = makeClient('ansi');
            selectClientEmulation(client, {
                firstMenu: 'c64Connected',
                listener: { name: 'c64', port: 6400, emulation: 'petscii' },
            });

            assert.equal(client.term.emulation.name, 'petscii');
            assert.deepEqual(client.term.requestedEmulation, {
                name: 'petscii',
                source: 'listener',
            });
            assert.equal(client.logged[0].info.listener, 'c64');
        });

        it('an unknown name says so', () => {
            const client = makeClient('ansi');
            selectClientEmulation(client, {
                listener: { name: 'odd', emulation: 'viewdata' },
            });
            assert.match(client.logged[0].msg, /"viewdata" is not known; using "ansi"/);
            assert.equal(client.term.emulation.name, 'ansi');
        });

        it('a listener without an emulation behaves as no listener', () => {
            const client = makeClient('xterm');
            selectClientEmulation(client, {
                firstMenu: 'other',
                listener: { name: 'second', port: 2323 },
            });
            assert.deepEqual(client.term.requestedEmulation, {
                name: 'ansi',
                source: 'default',
            });
        });

        it('works without readyOptions and without a log', () => {
            const client = makeClient('ansi');
            delete client.log;
            assert.equal(selectClientEmulation(client).base, 'ansi');
            assert.equal(selectClientEmulation(client, undefined).fallback, false);
        });
    });
});
