'use strict';

//
//  new_scan's skipMessageBase option, the mirror of skipFileBase: the scan
//  never enters the message base step and goes straight to the file base.
//  With both options set there is nothing to scan and it finishes at once.
//

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

const NEW_SCAN_PATH = require.resolve('../core/new_scan.js');

describe('new_scan: skipMessageBase', () => {
    let NewScanModule;
    let prevConfigGet = null;
    let prevLog;
    let logSwapped = false;
    let prevCacheEntry;

    before(() => {
        //  modules capture logger.log and config get() when loaded
        prevLog = loggerModule.log;
        const noop = () => {};
        const stub = {};
        for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
            stub[level] = noop;
        }
        stub.child = () => stub;
        loggerModule.log = stub;
        logSwapped = true;

        prevConfigGet = configModule._pushTestConfig({});

        prevCacheEntry = require.cache[NEW_SCAN_PATH];
        delete require.cache[NEW_SCAN_PATH];
        NewScanModule = require('../core/new_scan.js').getModule;
    });

    after(() => {
        if (prevConfigGet) {
            configModule._popTestConfig(prevConfigGet);
        }
        if (logSwapped) {
            loggerModule.log = prevLog;
        }
        if (prevCacheEntry) {
            require.cache[NEW_SCAN_PATH] = prevCacheEntry;
        } else {
            delete require.cache[NEW_SCAN_PATH];
        }
    });

    function makeScan(config = {}) {
        const mod = new NewScanModule({
            menuName: 'fullLoginSequenceNewScan',
            menuConfig: { config },
            client: {
                log: { error() {}, info() {}, warn() {}, debug() {} },
                user: { userId: 1, properties: {}, getProperty: () => undefined },
            },
        });

        mod.trace = [];

        //  neither real step is under test; record them, and finish each as
        //  a scan that found nothing does
        mod.newScanMessageConference = cb => {
            mod.trace.push(`step:${mod.currentStep}`);
            return cb(new Error('No more conferences'));
        };
        mod.newScanFileBase = cb => {
            mod.trace.push(`step:${mod.currentStep}`);
            return cb(new Error('No more new files'));
        };
        return mod;
    }

    it('is off unless set to true', () => {
        assert.equal(makeScan().skipMessageBase, false);
        assert.equal(makeScan({ skipMessageBase: false }).skipMessageBase, false);
        assert.equal(makeScan({ skipMessageBase: 'yes' }).skipMessageBase, false);
        assert.equal(makeScan({ skipMessageBase: 1 }).skipMessageBase, false);
        assert.equal(makeScan({ skipMessageBase: true }).skipMessageBase, true);
    });

    it('without it, steps message base, file base, finished (as before)', done => {
        for (const config of [{}, { skipMessageBase: false }]) {
            const mod = makeScan(config);
            mod.performScanCurrentStep(err => {
                assert.equal(err, null);
                assert.deepEqual(mod.trace, ['step:messageConferences', 'step:fileBase']);
                assert.equal(mod.currentStep, 'finished');
            });
        }
        done();
    });

    it('goes straight to the file base; the message base is never touched', done => {
        const mod = makeScan({ skipMessageBase: true });
        mod.performScanCurrentStep(err => {
            assert.equal(err, null);
            assert.deepEqual(mod.trace, ['step:fileBase']);
            assert.equal(mod.currentStep, 'finished');
            done();
        });
    });

    it('a saved scan that stopped in the message base resumes at the file base', done => {
        const mod = makeScan({ skipMessageBase: true });
        mod.restoreSavedState({
            currentStep: 'messageConferences',
            currentScanAux: { conf: 2, area: 1 },
        });
        mod.performScanCurrentStep(err => {
            assert.equal(err, null);
            assert.deepEqual(mod.trace, ['step:fileBase']);
            assert.equal(mod.currentStep, 'finished');
            done();
        });
    });

    it('a saved scan at the file base resumes there', done => {
        const mod = makeScan({ skipMessageBase: true });
        mod.restoreSavedState({ currentStep: 'fileBase', currentScanAux: {} });
        mod.performScanCurrentStep(err => {
            assert.equal(err, null);
            assert.deepEqual(mod.trace, ['step:fileBase']);
            assert.equal(mod.currentStep, 'finished');
            done();
        });
    });

    it('a saved finished scan stays finished', done => {
        const mod = makeScan({ skipMessageBase: true });
        mod.restoreSavedState({ currentStep: 'finished', currentScanAux: {} });
        mod.performScanCurrentStep(err => {
            assert.equal(err, null);
            assert.deepEqual(mod.trace, []);
            done();
        });
    });

    describe('with skipFileBase as well', () => {
        for (const step of ['messageConferences', 'fileBase', 'finished']) {
            it(`finishes at once with nothing scanned (saved step ${step})`, done => {
                const mod = makeScan({ skipMessageBase: true, skipFileBase: true });
                mod.restoreSavedState({ currentStep: step, currentScanAux: {} });
                mod.performScanCurrentStep(err => {
                    assert.equal(err, null);
                    assert.deepEqual(mod.trace, []);
                    assert.equal(mod.currentStep, 'finished');
                    done();
                });
            });
        }

        it('finishes at once from a fresh start', done => {
            const mod = makeScan({ skipMessageBase: true, skipFileBase: true });
            mod.performScanCurrentStep(err => {
                assert.equal(err, null);
                assert.deepEqual(mod.trace, []);
                assert.equal(mod.currentStep, 'finished');
                done();
            });
        });
    });
});
