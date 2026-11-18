'use strict';

//
//  The export watchdog (issue #1079).
//
//  The scheduled or requested export runs under a 10 minute watchdog. When it
//  fired it called back early, which cleared the export block (and removed the
//  outbound .bsy flag) while the export it had given up on carried on: the
//  next export then ran alongside it.
//
//  Nothing in an export can be interrupted, so the watchdog now only reports
//  that the export is still running; the block and the flag are released
//  when the export really ends.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const path = require('path');

const { createHarness } = require('./ftn_export_harness.js');

const WATCHDOG_MS = 20;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('ftn_bso — export watchdog (#1079)', function () {
    this.timeout(10000);

    const h = createHarness();
    before(() => h.setup('ftnwatchdog'));
    after(() => h.teardown());

    beforeEach(() => {
        h.logged.length = 0;
    });

    const bsyFlag = () => path.join(h.root, 'outbound', 'enigma.bsy');

    //  A module whose EchoMail export runs until the test lets it end.
    function makeModule() {
        const mod = h.makeModule();
        mod.exportWatchdogMs = WATCHDOG_MS;
        const running = [];
        mod.performEchoMailExport = cb => running.push(cb);
        mod.performEchoMailRelayExport = cb => cb(null);
        mod.performNetMailExport = cb => cb(null);
        return { mod, running };
    }

    //  Starts an export as the schedule and the exportOutboundNow task do.
    function startExport(mod, reason) {
        let resolveDone;
        const done = new Promise(resolve => {
            resolveDone = resolve;
        });
        const started = mod.tryExportNow(reason, err => resolveDone({ err }));
        return { started, done };
    }

    const stillRunningLines = () =>
        h.logged.filter(l => 'error' === l.level && /still running/.test(String(l.a[1])));

    it('a second export does not start while the first runs past the watchdog', async () => {
        const { mod, running } = makeModule();

        const first = startExport(mod, 'first export');
        assert.equal(first.started, true);
        await wait(WATCHDOG_MS * 5);
        assert.equal(running.length, 1, 'the first export is under way');

        let firstEnded = false;
        first.done.then(() => {
            firstEnded = true;
        });
        await new Promise(setImmediate);
        assert.equal(firstEnded, false, 'not reported as ended');
        assert.equal(mod.exportRunning, true, 'the export block is still held');
        assert.ok(fs.existsSync(bsyFlag()), 'the .bsy flag is still up');
        assert.ok(stillRunningLines().length >= 2, 'the watchdog keeps saying so');

        const second = startExport(mod, 'second export');
        assert.equal(second.started, false, 'a second export is turned away');
        //  ...nor can an @immediate export of a new message slip in
        assert.equal(mod.exportingStart(), false);
        assert.equal(running.length, 1, 'only the first export ever ran');

        running[0](null);
        const { err } = await first.done;
        assert.equal(err, null, 'the first export ends as it really ended');
    });

    it('the block clears, and the watchdog stops, when the old export finishes', async () => {
        const { mod, running } = makeModule();

        const first = startExport(mod, 'slow export');
        await wait(WATCHDOG_MS * 3);
        assert.equal(mod.exportRunning, true);

        running[0](null);
        await first.done;
        assert.equal(mod.exportRunning, false, 'the export block is released');
        assert.equal(fs.existsSync(bsyFlag()), false, 'the .bsy flag is removed');
        const warned = stillRunningLines().length;
        await wait(WATCHDOG_MS * 4);
        assert.equal(stillRunningLines().length, warned, 'no warnings once it ended');

        const next = startExport(mod, 'next export');
        assert.equal(next.started, true, 'the next export can start');
        //  it gets as far as the EchoMail step once its .bsy flag is written
        for (let i = 0; i < 100 && running.length < 2; ++i) {
            await wait(5);
        }
        assert.equal(running.length, 2);
        running[1](null);
        await next.done;
        assert.equal(mod.exportRunning, false);
    });

    it('an export that throws ends at once, and releases the block', async () => {
        const { mod } = makeModule();
        mod.performEchoMailExport = () => {
            throw new Error('export threw');
        };
        const failing = startExport(mod, 'failing export');
        assert.equal(failing.started, true);
        await failing.done;
        assert.equal(mod.exportRunning, false);
        assert.equal(fs.existsSync(bsyFlag()), false);
    });
});
