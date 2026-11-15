'use strict';

//
//  Art goes to the socket in one write (WP3): every parser event used to be
//  its own write, so an 80x25 screen went out as hundreds of TCP segments,
//  SSH CHANNEL_DATA messages or WebSocket frames. The bytes must not change
//  for any terminal, and baud emulation (the drip) must keep its byte count
//  per write and its 16 ms pacing exactly. Also here: a drip started inside
//  a beginWrite() batch keeps wire order, and the two repaints that were not
//  batched (ViewController.redrawAll(), the WFC's _refreshAll()) now are.
//
//  The expected values that are not derived in the test were measured on
//  origin/master db3bc81d, before the change.
//
const { strict: assert } = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const paths = require('path');

const { ClientTerminal } = require('../core/client_term.js');
const { attachRipLayer, selectClientEmulation } = require('../core/term/select.js');

//  Late bound: art.js captures config.js's |get| at require time
let art;

const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const ROOT = paths.join(__dirname, '..');

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return quietLog;
    },
};

//  The art and the cp437 wire bytes pinned in test/art_ansi_pin.test.js
const PIN_ART =
    '\x1b[0m\x1b[2J\x1b[1;34m\u2554\u2550\u2557 Name: %ET1\r\n\x1b[0;33mPass: \x1b[5C%ET2(4)\r\n' +
    '\x1b[7m%VM1\x1b[0m end\r\n\x1aSAUCE';
const PIN_WIRE_CP437 =
    '1b5b306d1b5b324a1b5b313b33346dc9cdbb204e616d653a201b5b313b33346d202020200d0a1b5b303b33336d506173733a201b5b35431b5b303b33336d202020202020200d0a1b5b376d1b5b373b33336d202020201b5b306d20656e640d0a';

//  PRE (passed through), then 'mid', 'body' and 'post' translated for PETSCII
//  (charset select and colour, then upper case for lower case), then RAW
//  (passed through)
const PASS_THROUGH_WIRE = '5052450e929b4d4944424f4459504f5354524157';

//  A session over a fake socket: every write, and every term call counted
function session(kind = 'cp437') {
    const writes = [];
    const output = {
        writable: true,
        write(data, cb) {
            writes.push(
                'string' === typeof data ? Buffer.from(data, 'latin1') : Buffer.from(data)
            );
            if (cb) {
                cb(null);
            }
        },
    };
    const term = new ClientTerminal(output);
    const client = {
        term,
        log: quietLog,
        user: { properties: {}, isAuthenticated: () => false },
        currentThemeConfig: { get: () => ({ info: { name: 'N/A' } }) },
    };
    Object.defineProperty(client, 'currentTheme', {
        get: () => client.currentThemeConfig.get(),
        set: tc => {
            client.currentThemeConfig = tc;
        },
    });

    if ('petscii' === kind || 'atascii' === kind) {
        selectClientEmulation(client, {
            firstMenu: 'telnetConnected',
            listener: { name: kind, emulation: kind },
        });
        term.termWidth = 40;
        term.termHeight = 'petscii' === kind ? 25 : 24;
        term.emulation.probes.forEach(probe => probe.run(client, () => {}));
    } else {
        term.outputEncoding = 'utf8' === kind ? 'utf8' : 'cp437';
        term.termWidth = 80;
        term.termHeight = 25;
        if ('rip' === kind) {
            attachRipLayer(client, { source: 'termType' });
        }
    }

    //  how often each way out was taken
    const calls = {};
    ['rawWrite', 'writeUnfilteredRip', 'nativeWrite', 'dripWrite'].forEach(name => {
        const real = term[name].bind(term);
        calls[name] = 0;
        term[name] = (...args) => {
            ++calls[name];
            return real(...args);
        };
    });

    return { term, client, writes, calls, wire: () => Buffer.concat(writes) };
}

//  setTimeout() replaced by a queue run by hand; each delay is kept
function fakeTimers() {
    const real = global.setTimeout;
    const queue = [];
    const delays = [];
    global.setTimeout = (fn, ms) => {
        queue.push(fn);
        delays.push(ms);
        return { unref() {} };
    };
    return {
        delays,
        runAll() {
            while (queue.length > 0) {
                queue.shift()();
            }
        },
        restore() {
            global.setTimeout = real;
        },
    };
}

function loadArt(rel, client) {
    return new Promise((resolve, reject) =>
        art.getArtFromPath(
            paths.join(ROOT, rel),
            { readSauce: true, acceptNative: true, acceptRip: true, client },
            (err, info) => (err ? reject(err) : resolve(info))
        )
    );
}

function displayOptions(info, extra = {}) {
    const options = Object.assign({ sauce: info.sauce }, extra);
    if (info.native) {
        options.native = info.native;
    }
    if (info.rip) {
        options.rip = info.rip;
    }
    return options;
}

describe('Art output batching (WP3)', function () {
    before(function () {
        art = require('../core/art.js');
    });

    describe('without a baud rate', function () {
        it('the pinned ANSI art goes out in one rawWrite, bytes as pinned', done => {
            const s = session('cp437');
            art.display(s.client, PIN_ART, {}, err => {
                assert.ifError(err);
                assert.equal(s.calls.rawWrite, 1);
                assert.equal(s.calls.dripWrite, 0);
                assert.equal(s.writes.length, 1);
                assert.equal(s.wire().toString('hex'), PIN_WIRE_CP437);
                return done();
            });
        });

        it('the iCE colors sequence goes in the same write', async function () {
            //  offline_mail.ans has the iCE flag in its SAUCE
            const s = session('cp437');
            const info = await loadArt(
                'art/themes/luciano_blocktronics/offline_mail.ans',
                s.client
            );
            await new Promise(resolve =>
                art.display(s.client, info.data, displayOptions(info), resolve)
            );
            //  823 writes on master
            assert.equal(s.writes.length, 1);
            assert.equal(md5(s.wire()), 'e57a29a9fadda0786d09092eb3a5e3c2');
        });

        //  [art, session, master's write count, length, md5, translator state md5]
        const SAME_AS_MASTER = [
            [
                'art/themes/luciano_blocktronics/2FACONFSCR.ans',
                'petscii',
                629,
                2218,
                '5b7e5a0795fc11f8f5aea2a231a52b38',
                '298afc4700647f21d7bad6ec132874c8',
            ],
            [
                'art/themes/luciano_blocktronics/2FACONFSCR.ans',
                'atascii',
                629,
                1837,
                '10babde6570046c1749a189169db111e',
                '9eaddd11c7b15d042993fa8d3ee68aee',
            ],
            [
                'misc/petscii_starter/PMAIN.seq',
                'petscii',
                1,
                213,
                '0726626a194df4a80ecb3d6546afc77a',
                'be61ed1b4f3ee3eb74e4aa010b31d7c7',
            ],
            [
                'misc/atascii_starter/AMAIN.ata',
                'atascii',
                1,
                202,
                '50a58aa786b210cc08f2f5b9646240c0',
                'ec61470f2682f1ecde7ab7e5bccf48b1',
            ],
        ];
        SAME_AS_MASTER.forEach(([rel, kind, masterWrites, length, sum, stateSum]) => {
            it(`${paths.basename(rel)} on a ${kind} session: one write, master's bytes (was ${masterWrites})`, async function () {
                const s = session(kind);
                const info = await loadArt(rel, s.client);
                await new Promise(resolve =>
                    art.display(s.client, info.data, displayOptions(info), resolve)
                );
                assert.equal(s.writes.length, 1);
                assert.equal(s.wire().length, length);
                assert.equal(md5(s.wire()), sum);
                //  the translator is left where master left it (cursor, colour,
                //  charset), so what is written next lands the same
                assert.equal(
                    md5(JSON.stringify(s.term.emulation.outputTranslator.state())),
                    stateSum
                );
            });
        });

        it('.rip art on a RIP session: one writeUnfilteredRip, filter state as on master', async function () {
            const s = session('rip');
            const info = await loadArt('misc/rip_starter/RMAIN.rip', s.client);
            assert.ok(info.rip);
            await new Promise(resolve =>
                art.display(s.client, info.data, displayOptions(info), resolve)
            );
            //  40 writes on master
            assert.equal(s.calls.writeUnfilteredRip, 1);
            assert.equal(s.calls.rawWrite, 0);
            assert.equal(s.writes.length, 1);
            assert.equal(md5(s.wire()), '9888a3ff989ba8f648a64cabff5382b9');
            assert.deepEqual(s.term.emulation.outputFilter.state, {
                prev: 0x20,
                csi: 0,
                commandOpen: false,
                backslashes: 0,
                held: 0,
            });
        });

        it('.rip art with a font and iCE colors: the init sequence goes first, filtered, on its own', async function () {
            const s = session('rip');
            s.term.syncTermFontsEnabled = true;
            const info = await loadArt('misc/rip_starter/RMAIN.rip', s.client);
            await new Promise(resolve =>
                art.display(
                    s.client,
                    info.data,
                    displayOptions(info, { font: 'topaz', iceColors: true }),
                    resolve
                )
            );
            //  as on master: the init sequence by rawWrite, then the art
            //  unfiltered (master sent the art in 40 writes; it is now one)
            assert.equal(s.calls.rawWrite, 1);
            assert.equal(s.calls.writeUnfilteredRip, 1);
            assert.equal(s.writes.length, 2);
            assert.equal(s.writes[0].toString('latin1'), '\x1b[0;42 D\x1b[?33h');
            assert.equal(md5(s.writes[1]), '9888a3ff989ba8f648a64cabff5382b9');
            assert.equal(md5(s.wire()), '313a3d1ccb646e39dbf0c187153e8eb0');
            assert.deepEqual(s.term.emulation.outputFilter.state, {
                prev: 0x20,
                csi: 0,
                commandOpen: false,
                backslashes: 0,
                held: 0,
            });
        });

        it('ANSI art on a RIP session: one rawWrite (filtered), filter state as on master', async function () {
            const s = session('rip');
            const info = await loadArt(
                'art/themes/luciano_blocktronics/2FACONFSCR.ans',
                s.client
            );
            await new Promise(resolve =>
                art.display(s.client, info.data, displayOptions(info), resolve)
            );
            //  607 writes on master
            assert.equal(s.calls.rawWrite, 1);
            assert.equal(s.calls.writeUnfilteredRip, 0);
            assert.equal(s.writes.length, 1);
            assert.equal(md5(s.wire()), 'c87f83af0f2a9b447073e308769aaed1');
            assert.deepEqual(s.term.emulation.outputFilter.state, {
                prev: 0x6d,
                csi: 0,
                commandOpen: false,
                backslashes: 0,
                held: 0,
            });
        });

        it('what was parsed before the parser throws still goes out', function () {
            //  ESC 7 throws in ANSIEscapeParser (pre-existing); the text before
            //  it was on the wire when each piece was written as parsed
            const s = session('cp437');
            assert.throws(() => art.display(s.client, 'before\x1b7after', {}, () => {}));
            assert.equal(s.wire().toString('latin1'), 'before');
        });
    });

    describe('with a baud rate', function () {
        it('drips the same buffer as before, and nothing goes by rawWrite', done => {
            const s = session('cp437');
            let dripped = null;
            s.term.dripWrite = (buf, bytesPerSec, cb) => {
                dripped = { buf, bytesPerSec };
                return cb(null);
            };
            art.display(s.client, PIN_ART, { baudRate: 2400 }, err => {
                assert.ifError(err);
                assert.equal(s.calls.rawWrite, 0);
                assert.equal(dripped.bytesPerSec, 240);
                assert.equal(dripped.buf.toString('hex'), PIN_WIRE_CP437);
                assert.equal(s.writes.length, 0);
                return done();
            });
        });

        //  A real ClientTerminal at 115200: 11520 bytes/s, 184 bytes per 16 ms
        //  tick. [art, session, master's writes, md5, what goes before the drip]
        const DRIPS = [
            [
                'art/themes/luciano_blocktronics/offline_mail.ans',
                'cp437',
                21,
                'e57a29a9fadda0786d09092eb3a5e3c2',
                '\x1b[?33h', //  iCE colors, written ahead of the drip
            ],
            [
                'art/themes/luciano_blocktronics/2FACONFSCR.ans',
                'petscii',
                13,
                '5b7e5a0795fc11f8f5aea2a231a52b38',
                '',
            ],
            [
                'misc/rip_starter/RMAIN.rip',
                'rip',
                4,
                '9888a3ff989ba8f648a64cabff5382b9',
                '',
            ],
            [
                'misc/atascii_starter/AMAIN.ata',
                'atascii',
                2,
                '50a58aa786b210cc08f2f5b9646240c0',
                '',
            ],
        ];
        DRIPS.forEach(([rel, kind, masterWrites, sum, before]) => {
            it(`${paths.basename(rel)} on a ${kind} session: ${masterWrites} writes, 184 bytes each 16 ms, as on master`, async function () {
                const s = session(kind);
                const info = await loadArt(rel, s.client);
                const timers = fakeTimers();
                let done = false;
                try {
                    art.display(
                        s.client,
                        info.data,
                        displayOptions(info, { baudRate: 115200 }),
                        err => {
                            assert.ifError(err);
                            done = true;
                        }
                    );
                    timers.runAll();
                } finally {
                    timers.restore();
                }
                assert.ok(done);
                assert.equal(s.writes.length, masterWrites);
                assert.equal(md5(s.wire()), sum);

                const drips = s.writes.slice(before ? 1 : 0);
                if (before) {
                    assert.equal(s.writes[0].toString('latin1'), before);
                }
                //  every drip write but the last is exactly one tick's worth
                drips.slice(0, -1).forEach(w => assert.equal(w.length, 184));
                assert.ok(drips[drips.length - 1].length <= 184);
                //  one 16 ms pause between drip writes, no others
                assert.equal(timers.delays.length, drips.length - 1);
                timers.delays.forEach(ms => assert.equal(ms, 16));
            });
        });
    });

    describe('a drip started inside a beginWrite() batch', function () {
        it('art with a baud rate: what the batch held goes first, then the drip, then the rest', function () {
            const s = session('cp437');
            const timers = fakeTimers();
            try {
                s.term.beginWrite();
                s.term.rawWrite('<PRE>');
                art.display(s.client, PIN_ART, { baudRate: 2400 }, err => {
                    assert.ifError(err);
                    s.term.rawWrite('<POST>');
                    s.term.commitWrite();
                });
                timers.runAll();
            } finally {
                timers.restore();
            }
            const pin = Buffer.from(PIN_WIRE_CP437, 'hex').toString('latin1');
            assert.equal(s.wire().toString('latin1'), `<PRE>${pin}<POST>`);

            //  the drip's own pieces are untouched: 240 bytes/s is 4 per 16 ms
            assert.equal(s.writes[0].toString('latin1'), '<PRE>');
            const drips = s.writes.slice(1, -1);
            assert.equal(drips.length, Math.ceil(pin.length / 4));
            drips.slice(0, -1).forEach(w => assert.equal(w.length, 4));
            assert.equal(s.writes[s.writes.length - 1].toString('latin1'), '<POST>');
        });

        const VARIANTS = {
            dripWrite: term => cb => term.dripWrite(Buffer.from('BODY'), 1000000, cb),
            ripDripWrite: term => cb =>
                term.ripDripWrite(Buffer.from('BODY'), 1000000, cb, true),
            nativeDripWrite: term => cb =>
                term.nativeDripWrite(Buffer.from('BODY'), {}, 1000000, cb),
        };
        const KIND = {
            dripWrite: 'cp437',
            ripDripWrite: 'rip',
            nativeDripWrite: 'petscii',
        };

        it('the output translator sees the batch before the drip (PETSCII)', done => {
            //  PETSCII has no absolute cursor address: the move home is worked
            //  out from where 'hello' left the cursor, so translating the drip
            //  first would put different bytes on the wire
            const reference = session('petscii');
            reference.term.rawWrite('hello\x1b[1;1HX');

            const s = session('petscii');
            s.term.beginWrite();
            s.term.rawWrite('hello');
            s.term.dripWrite(Buffer.from('\x1b[1;1HX'), 1000000, err => {
                assert.ifError(err);
                s.term.commitWrite();
                assert.equal(s.writes.length, 2);
                assert.equal(s.wire().toString('hex'), reference.wire().toString('hex'));
                return done();
            });
        });

        Object.keys(VARIANTS).forEach(name => {
            it(`${name}(): keeps wire order, the batch stays open`, done => {
                const s = session(KIND[name]);
                s.term.beginWrite();
                s.term.beginWrite(); //  nested: depth is kept
                //  around the translator, so that PETSCII leaves them be
                s.term.passThroughWrite('PRE');
                VARIANTS[name](s.term)(err => {
                    assert.ifError(err);
                    s.term.passThroughWrite('POST');
                    s.term.commitWrite();
                    assert.equal(s.writes.length, 2, 'inner commit sends nothing');
                    s.term.commitWrite();
                    const sent = s.writes.map(w => w.toString('latin1'));
                    assert.equal(sent.length, 3);
                    assert.ok(sent[0].endsWith('PRE'), sent[0]);
                    assert.ok(sent[1].endsWith('BODY'), sent[1]);
                    assert.ok(sent[2].endsWith('POST'), sent[2]);
                    return done();
                });
            });
        });

        it('what the batch held around the translator does not mark what is written after the drip', done => {
            //  PETSCII, so that translated and passed-through bytes differ: the
            //  batch's first chunk goes around the translator, and the first
            //  chunk written into it after the drip must not be taken for it
            const s = session('petscii');
            s.term.beginWrite();
            s.term.passThroughWrite('PRE');
            s.term.rawWrite('mid');
            s.term.dripWrite(Buffer.from('body'), 1000000, err => {
                assert.ifError(err);
                s.term.rawWrite('post');
                s.term.passThroughWrite('RAW');
                s.term.commitWrite();

                //  as the same writes made with no batch at all
                const reference = session('petscii');
                reference.term.passThroughWrite('PRE');
                reference.term.rawWrite('mid');
                reference.term.rawWrite('body');
                reference.term.rawWrite('post');
                reference.term.passThroughWrite('RAW');

                assert.deepEqual(
                    s.writes.map(w => w.toString('hex')),
                    [
                        Buffer.concat(reference.writes.slice(0, 2)).toString('hex'),
                        reference.writes[2].toString('hex'),
                        Buffer.concat(reference.writes.slice(3)).toString('hex'),
                    ]
                );
                assert.equal(s.wire().toString('hex'), PASS_THROUGH_WIRE);
                return done();
            });
        });
    });

    describe('repaints in one write', function () {
        function viewSession(withBatch) {
            const s = session('cp437');
            if (!withBatch) {
                //  as a stand-in term without batching would be
                s.term.beginWrite = undefined;
                s.term.commitWrite = undefined;
            }
            return s;
        }

        function drawForm(s) {
            const { ViewController } = require('../core/view_controller.js');
            const { TextView } = require('../core/text_view.js');
            const { VerticalMenuView } = require('../core/vertical_menu_view.js');

            const client = new EventEmitter();
            client.term = s.term;
            client.log = quietLog;

            const vc = new ViewController({ client });
            for (let i = 1; i <= 8; ++i) {
                const tv = new TextView({
                    client,
                    id: i,
                    position: { row: i, col: 1 },
                    dimens: { width: 20 },
                    text: `text view ${i}`,
                });
                vc.addView(tv);
            }
            const menu = new VerticalMenuView({
                client,
                id: 9,
                position: { row: 10, col: 1 },
                dimens: { width: 20, height: 10 },
            });
            menu.setItems(Array.from({ length: 10 }, (_, i) => `item ${i}`));
            vc.addView(menu);

            s.writes.length = 0;
            vc.redrawAll();
            return s.wire();
        }

        it('ViewController.redrawAll(): one write, the same bytes', function () {
            const unbatched = viewSession(false);
            const before = drawForm(unbatched);
            assert.equal(unbatched.writes.length, 29);

            const batched = viewSession(true);
            const after = drawForm(batched);
            assert.equal(batched.writes.length, 1);
            assert.equal(after.toString('hex'), before.toString('hex'));
        });

        it('ViewController.redrawAll(): a view that throws does not leave the batch open', function () {
            const s = session('cp437');
            const { ViewController } = require('../core/view_controller.js');
            const client = new EventEmitter();
            client.term = s.term;
            client.log = quietLog;
            const vc = new ViewController({ client });
            vc.views = {
                1: {
                    redraw() {
                        throw new Error('boom');
                    },
                },
            };
            assert.throws(() => vc.redrawAll(), /boom/);
            assert.equal(s.term._writeBuf, null);
            s.term.rawWrite('next');
            assert.equal(s.writes[s.writes.length - 1].toString('latin1'), 'next');
        });

        function makeWfc(s) {
            const WfcModule = require('../core/wfc.js').getModule;
            const client = new EventEmitter();
            client.node = 1;
            client.term = s.term;
            client.log = quietLog;
            client.user = {
                username: 'Sysop',
                setVisibility: () => {},
                isVisible: () => true,
            };
            client.currentTheme = { helpers: {} };
            client.startIdleMonitor = () => {};
            client.stopIdleMonitor = () => {};
            const wfc = new WfcModule({
                menuName: 'mainMenuWaitingForCaller',
                menuConfig: { config: { acs: 'SCID1', art: {} } },
                client,
            });
            //  form 0 is up; each step draws something of its own
            wfc.viewControllers.main = {};
            wfc._refreshStats = cb => {
                s.term.write('stats ');
                return cb(null);
            };
            wfc._refreshNodeStatus = cb => {
                s.term.write('nodes ');
                return cb(null);
            };
            wfc._refreshQuickLog = cb => {
                s.term.write('log ');
                return cb(null);
            };
            wfc.updateCustomViewTextsWithFilter = () => s.term.write('custom');
            return wfc;
        }

        it("the WFC's _refreshAll(): one write, the same bytes, before its callback", function () {
            const unbatched = viewSession(false);
            makeWfc(unbatched)._refreshAll();
            assert.equal(unbatched.writes.length, 4);

            const batched = viewSession(true);
            let writesAtCallback;
            makeWfc(batched)._refreshAll(err => {
                assert.ifError(err);
                writesAtCallback = batched.writes.length;
            });
            assert.equal(writesAtCallback, 1);
            assert.equal(batched.writes.length, 1);
            assert.equal(
                batched.wire().toString('latin1'),
                unbatched.wire().toString('latin1')
            );
            assert.equal(batched.wire().toString('latin1'), 'stats nodes log custom');
        });

        it("the WFC's _refreshAll(): a step that throws does not leave the batch open", function () {
            const s = session('cp437');
            const wfc = makeWfc(s);
            wfc._refreshQuickLog = () => {
                throw new Error('boom');
            };
            assert.throws(() => wfc._refreshAll(), /boom/);
            assert.equal(s.term._writeBuf, null);
            assert.equal(s.wire().toString('latin1'), 'stats nodes ');
        });
    });
});
