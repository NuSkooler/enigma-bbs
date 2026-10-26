'use strict';

//
//  CTerm Device Attributes (CTDA, CSI < c): parsing the reply out of the
//  client input stream into term.termCapabilities, the feature numbering, and
//  the connect probes that ask for it and decide SyncTERM fonts from it.
//

const { strict: assert } = require('assert');
const EventEmitter = require('events');

const CTERM_DA = '67;84;101;114;109'; //  "CTerm"

describe('CTerm capabilities (CTDA)', function () {
    //  heavy modules are required here rather than at load: some test files
    //  evict core modules from require.cache when they load
    let ClientModule;
    let ClientTerminal;
    let Events;
    let Connect;

    before(() => {
        ClientModule = require('../core/client.js');
        ClientTerminal = require('../core/client_term.js').ClientTerminal;
        Events = require('../core/events.js');
        Connect = require('../core/connect.js');
    });

    describe('from the client data stream', () => {
        let client;

        beforeEach(() => {
            client = new ClientModule.Client();
            client.term = new ClientTerminal(null);
        });

        afterEach(() => {
            Events.removeListener(
                Events.getSystemEvents().ThemeChanged,
                client.themeChangedListener
            );
        });

        function collectKeys() {
            const keys = [];
            client.on('key press', (ch, key) => keys.push({ ch, key }));
            return keys;
        }

        it('stores a CTDA reply in termCapabilities', () => {
            const keys = collectKeys();
            const reported = [];
            client.on('cterm device attributes', caps => reported.push(caps));

            client.emit('data', Buffer.from('\x1b[<0;1;2;3;5c'));

            const caps = client.term.termCapabilities;
            assert.deepEqual(caps.ctda, [1, 2, 3, 5]);
            assert.equal(caps.loadableFonts, true);
            assert.equal(caps.brightBackground, true);
            assert.equal(caps.paletteOsc, true);
            assert.equal(caps.pixelOps, false);
            assert.equal(caps.fontSelect, true);
            assert.equal(caps.extendedPalette, false);
            assert.equal(caps.mouse, false);
            assert.equal(caps.keyEvents, false);
            assert.equal(reported.length, 1);
            assert.deepEqual(keys, [], 'no part of the reply reaches menus');
        });

        it('keeps an OSC 8 answer alongside the CTDA fields', () => {
            client.term.termCapabilities.osc8 = true;
            client.emit('data', Buffer.from('\x1b[<0;5c'));
            assert.equal(client.term.termCapabilities.osc8, true);
            assert.equal(client.term.termCapabilities.fontSelect, true);
        });

        it('takes a reply with no features as an answer that has none', () => {
            const keys = collectKeys();
            client.emit('data', Buffer.from('\x1b[<0c'));
            assert.deepEqual(client.term.termCapabilities.ctda, []);
            assert.equal(client.term.termCapabilities.fontSelect, false);
            assert.deepEqual(keys, []);
        });

        it("takes pre-1.1 SyncTERM's 'n'-terminated reply too", () => {
            const keys = collectKeys();
            client.emit('data', Buffer.from('\x1b[<0;1;2;3;4;5;6n'));
            assert.deepEqual(client.term.termCapabilities.ctda, [1, 2, 3, 4, 5, 6]);
            assert.deepEqual(keys, []);
        });

        it('parses a reply between other replies, leaking nothing', () => {
            //  any byte of a reply mistaken for a key press would surface
            //  here as a key (or as client.js's key-press logging reading
            //  config this suite doesn't carry), so none may arrive
            const keys = collectKeys();
            const cprs = [];
            client.on('cursor position report', pos => cprs.push(pos));

            client.emit(
                'data',
                Buffer.from(
                    '\x1b[=67;84;101;114;109;1;332c\x1b[<0;1;2;3;4;5;6;7c\x1b[3;1R'
                )
            );

            assert.equal(client.term.termClient, 'cterm');
            assert.deepEqual(client.term.termCapabilities.ctda, [1, 2, 3, 4, 5, 6, 7]);
            assert.equal(client.term.termCapabilities.mouse, true);
            assert.deepEqual(cprs, [[3, 1]]);
            assert.deepEqual(keys, []);
        });

        it("takes IcyTerm 0.8's reply, which has no leading 0", () => {
            const keys = collectKeys();
            client.emit('data', Buffer.from('\x1b[<1;2;3;4;5;6;7c'));
            assert.deepEqual(client.term.termCapabilities.ctda, [1, 2, 3, 4, 5, 6, 7]);
            assert.equal(client.term.termCapabilities.fontSelect, true);
            assert.equal(client.term.termCapabilities.keyEvents, false);
            assert.deepEqual(keys, []);
        });

        it('still leaves SGR mouse reports (also CSI <) alone', () => {
            client.emit('data', Buffer.from('\x1b[<0;10;5M'));
            assert.equal(client.term.termCapabilities.ctda, undefined);
        });
    });

    describe('CTDA feature numbering', () => {
        it('follows the current CTerm manual (Table 4)', () => {
            assert.deepEqual(ClientModule.CtdaFeatures, {
                1: 'loadableFonts',
                2: 'brightBackground',
                3: 'paletteOsc',
                4: 'pixelOps',
                5: 'fontSelect',
                6: 'extendedPalette',
                7: 'mouse',
                8: 'keyEvents',
            });
        });

        it('maps a SyncTERM 1.2+ reply in SDL mode', () => {
            //  what SyncTERM's own code builds with every option and a mouse
            const caps = ClientModule.getCtermCapabilitiesFromCtda('1;2;3;4;5;6;7');
            assert.deepEqual(caps.ctda, [1, 2, 3, 4, 5, 6, 7]);
            assert.equal(caps.fontSelect, true);
            assert.equal(caps.brightBackground, true);
            assert.equal(caps.keyEvents, false);
        });

        it('maps a SyncTERM reply in curses mode, which has no font select', () => {
            const caps = ClientModule.getCtermCapabilitiesFromCtda([2, 7]);
            assert.equal(caps.fontSelect, false);
            assert.equal(caps.loadableFonts, false);
            assert.equal(caps.brightBackground, true);
            assert.equal(caps.mouse, true);
        });

        it('keeps unknown numbers, drops junk, and sorts', () => {
            const caps = ClientModule.getCtermCapabilitiesFromCtda('9;5;;x;5;1');
            assert.deepEqual(caps.ctda, [1, 5, 9]);
            assert.equal(caps.fontSelect, true);
        });
    });

    describe('connect probes', () => {
        function makeClient(termClient) {
            const client = new EventEmitter();
            client.node = 1;
            client.writes = [];
            client.log = {
                info() {},
                debug() {},
                warn() {},
            };
            client.term = {
                termClient,
                syncTermFontsEnabled: false,
                termCapabilities: {},
                rawWrite: s => client.writes.push(s),
            };
            return client;
        }

        const CTERM_QUERY = '\x1b[<c\x1b[=6n\x1b[6n';

        it('takes the SyncTERM font fast path for CTerm without CTDA, with no probe', done => {
            const client = makeClient('cterm');
            Connect.ansiQuerySyncTermFontSupport(client, err => {
                assert.ifError(err);
                assert.equal(client.term.syncTermFontsEnabled, true);
                assert.deepEqual(client.writes, []);
                return done();
            });
        });

        it('still probes by CPR for a client not known to do SyncTERM fonts', done => {
            const client = makeClient('icy_term');
            Connect.ansiQuerySyncTermFontSupport(client, () => {
                assert.equal(client.writes.length, 1);
                assert.match(client.writes[0], / D/); //  the font sequence
                assert.equal(client.term.syncTermFontsEnabled, true);
                return done();
            });
            client.emit('cursor position report', [1, 1]);
        });

        it('enables SyncTERM fonts from CTDA font select, with no probe', done => {
            const client = makeClient('cterm');
            client.term.termCapabilities = { ctda: [1, 2, 5], fontSelect: true };
            Connect.ansiQuerySyncTermFontSupport(client, () => {
                assert.equal(client.term.syncTermFontsEnabled, true);
                assert.deepEqual(client.writes, []);
                return done();
            });
        });

        it('disables SyncTERM fonts when CTDA leaves font select out', done => {
            //  SyncTERM in curses mode: CTerm by name, but no font select
            const client = makeClient('cterm');
            client.term.termCapabilities = { ctda: [2, 7], fontSelect: false };
            Connect.ansiQuerySyncTermFontSupport(client, () => {
                assert.equal(client.term.syncTermFontsEnabled, false);
                assert.deepEqual(client.writes, []);
                return done();
            });
        });

        it('goes by a CTDA answer whichever client gave it', done => {
            const client = makeClient('unknown');
            client.term.termCapabilities = { ctda: [], fontSelect: false };
            Connect.ansiQuerySyncTermFontSupport(client, () => {
                assert.equal(client.term.syncTermFontsEnabled, false);
                assert.deepEqual(client.writes, [], 'no CPR font probe');
                return done();
            });
        });

        it('asks CTerm CTDA, CSI = 6 n and a CPR in one write', done => {
            const client = makeClient('cterm');
            Connect.ansiQueryCtermCapabilities(client, err => {
                assert.ifError(err);
                assert.equal(client.term.termCapabilities.osc8, true);
                assert.equal(client.listenerCount('cterm capability response'), 0);
                assert.equal(client.listenerCount('cursor position report'), 0);
                return done();
            });
            assert.deepEqual(client.writes, [CTERM_QUERY]);
            client.emit('cterm capability response', { id: 6, value: 1 });
            client.emit('cursor position report', [1, 1]);
        });

        it('leaves OSC 8 off when the client answers no', done => {
            const client = makeClient('cterm');
            Connect.ansiQueryCtermCapabilities(client, () => {
                assert.equal(client.term.termCapabilities.osc8, undefined);
                return done();
            });
            client.emit('cterm capability response', { id: 1, value: 1 }); //  not ours
            client.emit('cterm capability response', { id: 6, value: 0 });
            client.emit('cursor position report', [1, 1]);
        });

        it('finishes on the CPR when the client answers neither query', done => {
            //  e.g. SyncTERM 1.0: no CTDA, no CSI = 6 n, but a CPR
            const client = makeClient('cterm');
            const started = Date.now();
            Connect.ansiQueryCtermCapabilities(client, () => {
                assert(Date.now() - started < 500, 'no timeout wait');
                assert.equal(client.term.termCapabilities.ctda, undefined);
                Connect.ansiQuerySyncTermFontSupport(client, () => {
                    //  falls back to the name, as before CTDA
                    assert.equal(client.term.syncTermFontsEnabled, true);
                    return done();
                });
            });
            client.emit('cursor position report', [1, 1]);
        });

        it('gives up after 2s when nothing comes back, without an error', function (done) {
            this.timeout(4000);
            const client = makeClient('cterm');
            const started = Date.now();
            Connect.ansiQueryCtermCapabilities(client, err => {
                assert.ifError(err);
                const waited = Date.now() - started;
                assert(waited >= 1900 && waited < 3000, `waited ${waited}ms`);
                assert.equal(client.listenerCount('cterm capability response'), 0);
                assert.equal(client.listenerCount('cursor position report'), 0);
                return done();
            });
        });

        it('sends nothing to other clients', done => {
            const clients = ['vtx', 'arctel', 'unknown'].map(makeClient);
            let pending = clients.length;
            clients.forEach(client =>
                Connect.ansiQueryCtermCapabilities(client, () => {
                    assert.deepEqual(client.writes, []);
                    if (0 === --pending) {
                        return done();
                    }
                })
            );
        });

        it('asks IcyTerm CTDA too, and takes its answer for the font decision', done => {
            const client = makeClient('icy_term');
            Connect.ansiQueryCtermCapabilities(client, err => {
                assert.ifError(err);
                //  IcyTerm swallows CSI = 6 n; OSC 8 stays as terminalSupports has it
                assert.equal(client.term.termCapabilities.osc8, undefined);
                Connect.ansiQuerySyncTermFontSupport(client, () => {
                    assert.equal(client.term.syncTermFontsEnabled, true);
                    assert.equal(client.writes.length, 1, 'no CPR font probe');
                    return done();
                });
            });
            assert.deepEqual(client.writes, [CTERM_QUERY]);
            client.term.termCapabilities = {
                ctda: [1, 2, 3, 4, 5, 6, 7, 8],
                fontSelect: true,
            };
            client.emit('cursor position report', [1, 1]);
        });

        it('finishes on the CPR for an IcyTerm too old to answer CTDA', done => {
            const client = makeClient('icy_term');
            const started = Date.now();
            Connect.ansiQueryCtermCapabilities(client, () => {
                assert(Date.now() - started < 500, 'no timeout wait');
                assert.equal(client.term.termCapabilities.ctda, undefined);
                //  not CTerm-shaped: no name fast path, the CPR probe stays
                Connect.ansiQuerySyncTermFontSupport(client, () => {
                    assert.equal(client.writes.length, 2);
                    assert.match(client.writes[1], / D/);
                    return done();
                });
                client.emit('cursor position report', [1, 1]);
            });
            client.emit('cursor position report', [1, 1]);
        });

        it('wires the client parser and the probes together', done => {
            //  a real Client: the CTDA reply goes through the input parser
            const client = new ClientModule.Client();
            client.term = new ClientTerminal(null);
            client.session = { id: 1 }; //  client.node
            client.log = { info() {}, debug() {}, warn() {} };
            const writes = [];
            client.term.rawWrite = s => writes.push(s);
            const keys = [];
            client.on('key press', ch => keys.push(ch));

            client.emit('data', Buffer.from(`\x1b[=${CTERM_DA};1;332c`));
            Connect.ansiQueryCtermCapabilities(client, () => {
                Connect.ansiQuerySyncTermFontSupport(client, () => {
                    Events.removeListener(
                        Events.getSystemEvents().ThemeChanged,
                        client.themeChangedListener
                    );
                    assert.deepEqual(writes, [CTERM_QUERY]);
                    assert.deepEqual(client.term.termCapabilities.ctda, [1, 2, 3, 5]);
                    assert.equal(client.term.termCapabilities.osc8, true);
                    assert.equal(client.term.syncTermFontsEnabled, true);
                    assert.deepEqual(keys, []);
                    return done();
                });
            });
            //  SyncTERM's answer to the three queries, in one chunk
            client.emit('data', Buffer.from('\x1b[<0;1;2;3;5c\x1b[=6;1n\x1b[1;1R'));
        });
    });
});
