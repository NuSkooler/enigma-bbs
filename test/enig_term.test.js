'use strict';

//
//  enig-term support: recognising it from its DA reply, and what the
//  connect probes do for it.
//

const { strict: assert } = require('assert');
const EventEmitter = require('events');

const ENIG_TERM_DA = '101;110;105;103;45;116;101;114;109'; //  "enig-term"
const CTERM_DA = '67;84;101;114;109'; //  "CTerm"

describe('enig-term', function () {
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

    describe('DA recognition', () => {
        it('maps the enig-term DA prefix to enig_term with its version', () => {
            assert.deepEqual(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA};0;1;0`),
                { termClient: 'enig_term', version: '0.1.0' }
            );
            assert.deepEqual(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA};1;12;3`),
                { termClient: 'enig_term', version: '1.12.3' }
            );
        });

        it('reports no version when the reply carries none usable', () => {
            assert.deepEqual(ClientModule.getTermClientFromDeviceAttr(ENIG_TERM_DA), {
                termClient: 'enig_term',
                version: null,
            });
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA};0;x;0`).version,
                null
            );
        });

        it('still recognises CTerm, IcyTerm, VTX and arctel', () => {
            assert.deepEqual(
                ClientModule.getTermClientFromDeviceAttr(`${CTERM_DA};1;332`),
                {
                    termClient: 'cterm',
                    version: '1.332',
                }
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr('73;99;121;84;101;114;109;1;0')
                    .termClient,
                'icy_term'
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr('50;86;84;88').termClient,
                'vtx'
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr('63;1;2').termClient,
                'arctel'
            );
            assert.equal(ClientModule.getTermClientFromDeviceAttr('1;2;3'), null);
        });

        it('matches a prefix on a whole parameter only', () => {
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr(`${CTERM_DA}0;1`),
                null
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA}5;0;1;0`),
                null
            );
        });

        it('getDeviceAttrVersion() is the generalised getCtermVersion()', () => {
            assert.equal(
                ClientModule.getDeviceAttrVersion(`${ENIG_TERM_DA};0;1;0`, ENIG_TERM_DA),
                '0.1.0'
            );
            assert.equal(
                ClientModule.getDeviceAttrVersion(`${CTERM_DA};1;332`, ENIG_TERM_DA),
                null
            );
            assert.equal(ClientModule.getCtermVersion(`${CTERM_DA};1;332`), '1.332');
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

            it('sets termClient and termClientVersion, and not ctermVersion', () => {
                client.emit('data', Buffer.from(`\x1b[=${ENIG_TERM_DA};0;1;0c`));
                assert.equal(client.term.termClient, 'enig_term');
                assert.equal(client.term.termClientVersion, '0.1.0');
                assert.equal(client.term.ctermVersion, null);
            });

            it('keeps setting ctermVersion for CTerm', () => {
                client.emit('data', Buffer.from(`\x1b[=${CTERM_DA};1;332c`));
                assert.equal(client.term.termClient, 'cterm');
                assert.equal(client.term.termClientVersion, '1.332');
                assert.equal(client.term.ctermVersion, '1.332');
            });

            it('does not assume OSC 8 or VTX audio from the name', () => {
                client.emit('data', Buffer.from(`\x1b[=${ENIG_TERM_DA};0;1;0c`));
                //  isNixTerm() reads term config this suite doesn't carry; enig-term
                //  identifies as ansi-bbs, which is not a *nix terminal
                client.term.isNixTerm = () => false;
                assert.equal(client.terminalSupports('osc8_hyperlink'), false);
                assert.equal(client.terminalSupports('vtx_audio'), false);

                client.term.termCapabilities.osc8 = true; //  as the =6n reply sets it
                assert.equal(client.terminalSupports('osc8_hyperlink'), true);
            });
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

        it('takes the SyncTERM font fast path for enig_term, with no probe', done => {
            const client = makeClient('enig_term');
            Connect.ansiQuerySyncTermFontSupport(client, err => {
                assert.ifError(err);
                assert.equal(client.term.syncTermFontsEnabled, true);
                assert.deepEqual(client.writes, []);
                return done();
            });
        });

        it('asks a CTerm-shaped client CTDA, CSI = 6 n and a CPR in one write', done => {
            const client = makeClient('enig_term');
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

            client.emit('data', Buffer.from(`\x1b[=${ENIG_TERM_DA};0;1;0c`));
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
            //  enig-term's answer to the three queries, in one chunk
            client.emit('data', Buffer.from('\x1b[<0;1;2;3;5c\x1b[=6;1n\x1b[1;1R'));
        });
    });
});
