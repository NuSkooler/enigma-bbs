'use strict';

//
//  The exportOutboundNow and binkpPullNow built-in scheduler tasks (#440):
//  the tasks themselves (core/misc_scheduled_events.js), and the ends of them
//  in ftn_bso (ExportBSORequested) and the BinkP mailer (BinkpPullRequested).
//
//  Nothing here dials out: caller.pollNodes and ftn_bso's performExport are
//  replaced, and later.setInterval is replaced so a pull schedule can be
//  fired by hand.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const later = require('@breejs/later');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const Events = require('../core/events.js');
const SystemEvents = require('../core/system_events.js');

//  Records info lines on the shared logger stub (modules hold a reference to
//  the same object, so patching its methods is enough)
function captureInfo() {
    const log = loggerModule.log;
    const original = log.info;
    const lines = [];
    log.info = (obj, msg) => lines.push(typeof obj === 'string' ? obj : msg);
    return {
        lines,
        restore: () => {
            log.info = original;
        },
    };
}

function callTask(task) {
    return new Promise(resolve => task([], (err, ...rest) => resolve({ err, rest })));
}

//  As the tasks do: emit a request and wait for its callback
function request(event, reason) {
    return new Promise(resolve =>
        Events.emit(event, {
            reason,
            callback: (err, outcome) => resolve({ err, outcome }),
        })
    );
}

describe('FTN "now" tasks', function () {
    let tmpDir;
    let tasks;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_ftn_now_'));
        await fsp.mkdir(path.join(tmpDir, 'ftn_in'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_secin'), { recursive: true });
        tasks = require('../core/misc_scheduled_events.js');
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    function makeConfig({ binkp = {}, networks = true, ftnBso = {} } = {}) {
        return {
            debug: { assertsEnabled: false },
            general: { boardName: 'Test BBS' },
            scannerTossers: {
                ftn_bso: Object.assign(
                    {
                        paths: {
                            outbound: tmpDir,
                            inbound: path.join(tmpDir, 'ftn_in'),
                            secInbound: path.join(tmpDir, 'ftn_secin'),
                        },
                        binkp: Object.assign(
                            { inbound: { enabled: false }, tempDir: tmpDir },
                            binkp
                        ),
                    },
                    ftnBso
                ),
            },
            messageNetworks: {
                ftn: networks
                    ? {
                          networks: {
                              testnet: { localAddress: '1:218/700', defaultZone: 1 },
                          },
                      }
                    : {},
            },
        };
    }

    // ── the tasks, with nothing listening ──────────────────────────────────────

    describe('with no module listening', () => {
        it('exportOutboundNow finishes cleanly and says so', async function () {
            if (Events.listenerCount(SystemEvents.ExportBSORequested) > 0) {
                this.skip(); //  some other suite left an ftn_bso running
            }
            const info = captureInfo();
            try {
                const { err } = await callTask(tasks.exportOutboundNowScheduledEvent);
                assert.equal(err, null);
                assert.ok(
                    info.lines.some(l => /not running/.test(l)),
                    `expected a "not running" line in: ${info.lines.join(' | ')}`
                );
            } finally {
                info.restore();
            }
        });

        it('binkpPullNow finishes cleanly and says so', async function () {
            if (Events.listenerCount(SystemEvents.BinkpPullRequested) > 0) {
                this.skip();
            }
            const info = captureInfo();
            try {
                const { err } = await callTask(tasks.binkpPullNowScheduledEvent);
                assert.equal(err, null);
                assert.ok(info.lines.some(l => /BinkP mailer is not running/.test(l)));
            } finally {
                info.restore();
            }
        });

        it('requestBinkpPull reports that nothing ran', done => {
            if (Events.listenerCount(SystemEvents.BinkpPullRequested) > 0) {
                return done();
            }
            tasks.requestBinkpPull('test', (err, outcome) => {
                assert.equal(err, null);
                assert.equal(outcome.ran, false);
                assert.match(outcome.message, /not running/);
                done();
            });
        });
    });

    // ── the tasks, against a stand-in listener ─────────────────────────────────

    describe('with a listener', () => {
        function listen(event, handler) {
            Events.on(event, handler);
            return () => Events.removeListener(event, handler);
        }

        it('exportOutboundNow waits for the export, and names itself', async () => {
            let req;
            const stop = listen(SystemEvents.ExportBSORequested, r => {
                req = r;
            });
            try {
                let finished = false;
                const p = callTask(tasks.exportOutboundNowScheduledEvent).then(r => {
                    finished = true;
                    return r;
                });
                await new Promise(setImmediate);
                assert.ok(req, 'request emitted');
                assert.match(req.reason, /exportOutboundNow/);
                assert.equal(finished, false, 'must not finish before the export');

                req.callback(null, { ran: true, message: 'Export complete' });
                const { err } = await p;
                assert.equal(err, null);
            } finally {
                stop();
            }
        });

        it('exportOutboundNow fails when the export does', async () => {
            const stop = listen(SystemEvents.ExportBSORequested, r =>
                r.callback(new Error('boom'))
            );
            try {
                const { err } = await callTask(tasks.exportOutboundNowScheduledEvent);
                assert.ok(err);
                assert.match(err.message, /boom/);
            } finally {
                stop();
            }
        });

        it('binkpPullNow waits for the pull cycle, and names itself', async () => {
            let req;
            const stop = listen(SystemEvents.BinkpPullRequested, r => {
                req = r;
            });
            try {
                let finished = false;
                const p = callTask(tasks.binkpPullNowScheduledEvent).then(r => {
                    finished = true;
                    return r;
                });
                await new Promise(setImmediate);
                assert.match(req.reason, /binkpPullNow/);
                assert.equal(finished, false);

                //  a second callback (a misbehaving listener) is ignored
                req.callback(new Error('pull failed'));
                req.callback(null);
                const { err } = await p;
                assert.match(err.message, /pull failed/);
            } finally {
                stop();
            }
        });
    });

    // ── ftn_bso: ExportBSORequested ────────────────────────────────────────────

    describe('ftn_bso export requests', () => {
        //  |configured|: hasValidConfiguration() wants nodes{} and ftn.areas
        async function startFtnBso({ configured = true } = {}) {
            const config = makeConfig({
                ftnBso: configured ? { nodes: { '1:218/*': {} } } : {},
            });
            if (configured) {
                config.messageNetworks.ftn.areas = {};
            }
            const prev = configModule._pushTestConfig(config);
            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const mod = new getModule();
            mod.performImport = cb => cb && cb(null);
            const exports = [];
            mod.performExport = cb => exports.push(cb);
            await new Promise((resolve, reject) =>
                mod.startup(err => (err ? reject(err) : resolve()))
            );
            return {
                mod,
                exports,
                stop: async () => {
                    await new Promise(res => mod.shutdown(res));
                    configModule._popTestConfig(prev);
                },
            };
        }

        it('runs an export and reports when it is done', async () => {
            const { exports, stop } = await startFtnBso();
            try {
                const p = request(SystemEvents.ExportBSORequested, 'test export');
                await new Promise(setImmediate);
                assert.equal(exports.length, 1, 'performExport called once');

                exports[0](null);
                const { err, outcome } = await p;
                assert.equal(err, null);
                assert.equal(outcome.ran, true);
            } finally {
                await stop();
            }
        });

        it('passes an export failure back', async () => {
            const { exports, stop } = await startFtnBso();
            try {
                const p = request(SystemEvents.ExportBSORequested, 'test export');
                await new Promise(setImmediate);
                exports[0](new Error('disk full'));
                const { err } = await p;
                assert.match(err.message, /disk full/);
            } finally {
                await stop();
            }
        });

        it('does not start a second export while one runs', async () => {
            const { mod, exports, stop } = await startFtnBso();
            try {
                const first = request(SystemEvents.ExportBSORequested, 'first');
                await new Promise(setImmediate);
                const second = await request(SystemEvents.ExportBSORequested, 'second');
                assert.equal(second.err, null);
                assert.equal(second.outcome.ran, false);
                assert.match(second.outcome.message, /already running/);
                assert.equal(exports.length, 1);

                exports[0](null);
                await first;
                assert.equal(mod.exportRunning, false, 'export block released');
            } finally {
                await stop();
            }
        });

        it('finishes cleanly, without exporting, when FTN is not configured', async () => {
            const { exports, stop } = await startFtnBso({ configured: false });
            const info = captureInfo();
            try {
                const { err, outcome } = await request(
                    SystemEvents.ExportBSORequested,
                    'test'
                );
                assert.equal(err, null);
                assert.equal(outcome.ran, false);
                assert.equal(exports.length, 0);
                assert.ok(info.lines.some(l => /not configured/.test(l)));
            } finally {
                info.restore();
                await stop();
            }
        });

        it('exportOutboundNow runs ftn_bso end to end', async () => {
            const { exports, stop } = await startFtnBso();
            try {
                const p = callTask(tasks.exportOutboundNowScheduledEvent);
                await new Promise(setImmediate);
                assert.equal(exports.length, 1);
                exports[0](null);
                assert.equal((await p).err, null);
            } finally {
                await stop();
            }
        });

        it('stops listening at shutdown', async () => {
            const before = Events.listenerCount(SystemEvents.ExportBSORequested);
            const { stop } = await startFtnBso();
            assert.equal(
                Events.listenerCount(SystemEvents.ExportBSORequested),
                before + 1
            );
            await stop();
            assert.equal(Events.listenerCount(SystemEvents.ExportBSORequested), before);
        });
    });

    // ── BinkP: BinkpPullRequested ──────────────────────────────────────────────

    describe('BinkP pull requests', () => {
        const caller = require('../core/binkp/caller.js');
        let originalPollNodes;
        let originalSetInterval;
        let polls; //  [{ addrs, cb }]
        let timers; //  functions later.setInterval was given

        //  Wildcards and pull: false are left out of a pull cycle
        const NODES = {
            '1:218/701': { host: 'a.example' },
            '1:218/702': { host: 'b.example', pull: false },
            '1:218/703': { host: 'c.example' },
            '1:218/*': { sessionPassword: 'x' },
        };

        beforeEach(() => {
            polls = [];
            timers = [];
            originalPollNodes = caller.pollNodes;
            caller.pollNodes = (addrs, cb) => {
                polls.push({ addrs: addrs.map(a => a.toString()), cb });
            };
            originalSetInterval = later.setInterval;
            later.setInterval = fn => {
                timers.push(fn);
                return { clear() {} };
            };
        });

        afterEach(() => {
            caller.pollNodes = originalPollNodes;
            later.setInterval = originalSetInterval;
        });

        async function startBinkp(opts) {
            const prev = configModule._pushTestConfig(makeConfig(opts));
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();
            await new Promise((resolve, reject) =>
                mod.startup(err => (err ? reject(err) : resolve()))
            );
            return {
                mod,
                stop: async () => {
                    await new Promise(res => mod.shutdown(res));
                    configModule._popTestConfig(prev);
                },
            };
        }

        it('dials the same nodes as the pull schedule', async () => {
            const { stop } = await startBinkp({
                binkp: { nodes: NODES, pullSchedule: 'every 15 minutes' },
            });
            try {
                assert.equal(timers.length, 1, 'pull schedule armed');
                timers[0]();
                assert.equal(polls.length, 1);
                const scheduled = polls[0].addrs;
                polls[0].cb(null);

                const p = request(SystemEvents.BinkpPullRequested, 'test pull');
                await new Promise(setImmediate);
                assert.equal(polls.length, 2);
                assert.deepEqual(polls[1].addrs, scheduled);
                assert.deepEqual(polls[1].addrs.slice().sort(), [
                    '1:218/701',
                    '1:218/703',
                ]);

                polls[1].cb(null);
                const { err, outcome } = await p;
                assert.equal(err, null);
                assert.equal(outcome.ran, true);
            } finally {
                await stop();
            }
        });

        it('pulls with no pullSchedule set', async () => {
            const { stop } = await startBinkp({ binkp: { nodes: NODES } });
            try {
                assert.equal(timers.length, 0);
                const p = callTask(tasks.binkpPullNowScheduledEvent);
                await new Promise(setImmediate);
                assert.equal(polls.length, 1);
                assert.equal(polls[0].addrs.length, 2);
                polls[0].cb(null);
                assert.equal((await p).err, null);
            } finally {
                await stop();
            }
        });

        it('does not start a second cycle while one runs, from either side', async () => {
            const { mod, stop } = await startBinkp({
                binkp: { nodes: NODES, pullSchedule: 'every 15 minutes' },
            });
            try {
                const first = request(SystemEvents.BinkpPullRequested, 'first');
                await new Promise(setImmediate);
                assert.equal(polls.length, 1);

                const second = await request(SystemEvents.BinkpPullRequested, 'second');
                assert.equal(second.err, null);
                assert.equal(second.outcome.ran, false);
                assert.match(second.outcome.message, /already running/);

                timers[0](); //  the schedule fires meanwhile
                assert.equal(polls.length, 1, 'no overlapping cycle');

                polls[0].cb(null);
                await first;
                assert.equal(mod._pulling, false);
            } finally {
                await stop();
            }
        });

        it('passes a pull failure back, and can pull again', async () => {
            const { stop } = await startBinkp({ binkp: { nodes: NODES } });
            try {
                const p = request(SystemEvents.BinkpPullRequested, 'test');
                await new Promise(setImmediate);
                polls[0].cb(new Error('spool unreadable'));
                const { err } = await p;
                assert.match(err.message, /spool unreadable/);

                const again = request(SystemEvents.BinkpPullRequested, 'again');
                await new Promise(setImmediate);
                assert.equal(polls.length, 2);
                polls[1].cb(null);
                await again;
            } finally {
                await stop();
            }
        });

        it('recovers from a pollNodes that rejects', async () => {
            caller.pollNodes = () => Promise.reject(new Error('thrown'));
            const { mod, stop } = await startBinkp({ binkp: { nodes: NODES } });
            try {
                const { err } = await request(SystemEvents.BinkpPullRequested, 'test');
                assert.match(err.message, /thrown/);
                assert.equal(mod._pulling, false);
            } finally {
                await stop();
            }
        });

        it('finishes cleanly, without dialing, when FTN is not configured', async () => {
            const { stop } = await startBinkp({
                binkp: { nodes: NODES },
                networks: false,
            });
            const info = captureInfo();
            try {
                const { err, outcome } = await request(
                    SystemEvents.BinkpPullRequested,
                    'test'
                );
                assert.equal(err, null);
                assert.equal(outcome.ran, false);
                assert.equal(polls.length, 0);
                assert.ok(info.lines.some(l => /not configured/.test(l)));
            } finally {
                info.restore();
                await stop();
            }
        });

        it('says so when there are no nodes to pull from', async () => {
            const { stop } = await startBinkp({ binkp: { nodes: {} } });
            const info = captureInfo();
            try {
                const p = request(SystemEvents.BinkpPullRequested, 'test');
                await new Promise(setImmediate);
                assert.deepEqual(polls[0].addrs, []);
                assert.ok(info.lines.some(l => /No nodes to pull from/.test(l)));
                polls[0].cb(null);
                assert.equal((await p).err, null);
            } finally {
                info.restore();
                await stop();
            }
        });

        it('stops listening at shutdown', async () => {
            const before = Events.listenerCount(SystemEvents.BinkpPullRequested);
            const { stop } = await startBinkp({ binkp: { nodes: NODES } });
            assert.equal(
                Events.listenerCount(SystemEvents.BinkpPullRequested),
                before + 1
            );
            await stop();
            assert.equal(Events.listenerCount(SystemEvents.BinkpPullRequested), before);
        });
    });

    // ── the menu module that !BINKP used ───────────────────────────────────────

    describe('binkp_poll_module', () => {
        it('requests the pull cycle and reports the outcome', done => {
            const { getModule } = require('../core/binkp/binkp_poll_module.js');
            const written = [];
            let req;
            const handler = r => {
                req = r;
            };
            Events.on(SystemEvents.BinkpPullRequested, handler);

            //  just enough of a MenuModule for initSequence()
            const fake = Object.create(getModule.prototype);
            fake.client = {
                term: { write: s => written.push(s) },
                user: { username: 'sysop' },
            };
            fake.prevMenu = () => {
                Events.removeListener(SystemEvents.BinkpPullRequested, handler);
                try {
                    assert.match(req.reason, /requested by sysop/);
                    assert.ok(written.some(s => /Pull cycle complete/.test(s)));
                    done();
                } catch (e) {
                    done(e);
                }
            };
            fake.initSequence();
            req.callback(null, { ran: true, message: 'Pull cycle complete' });
        });
    });
});
