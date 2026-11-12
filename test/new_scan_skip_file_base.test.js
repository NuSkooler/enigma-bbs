'use strict';

//
//  new_scan's skipFileBase option: the scan stops after the message base and
//  never enters the file base step. Without it (absent or false) the steps
//  are exactly as before: message base, then file base, then finished.
//

const { strict: assert } = require('assert');

const FileEntry = require('../core/file_entry.js');
const FileBaseFilters = require('../core/file_base_filter.js');
const NewScanModule = require('../core/new_scan.js').getModule;

function makeScan(config = {}) {
    const mod = new NewScanModule({
        menuName: 'fullLoginSequenceNewScan',
        menuConfig: { config },
        client: {
            log: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
            user: { userId: 1, properties: {}, getProperty: () => undefined },
        },
    });

    //  what happened, in order
    mod.trace = [];
    mod.went = null;

    //  the message base step is not under test: record it and carry on as a
    //  scan that found nothing does
    mod.newScanMessageConference = cb => {
        mod.trace.push(`step:${mod.currentStep}`);
        return cb(new Error('No more conferences'));
    };

    mod.gotoMenu = (name, options, cb) => {
        mod.went = { name, options };
        if (cb) {
            return cb(null);
        }
    };

    return mod;
}

describe('new_scan: skipFileBase', () => {
    let restore = [];

    //  file base stand-ins; |fileIds| is what a file search finds
    function stubFileBase(fileIds) {
        const calls = { findFiles: 0, setLastViewed: [] };
        const findFiles = FileEntry.findFiles;
        const setLastViewed = FileBaseFilters.setFileBaseLastViewedFileIdForUser;
        const getLastViewed = FileBaseFilters.getFileBaseLastViewedFileIdByUser;

        FileEntry.findFiles = (filter, cb) => {
            ++calls.findFiles;
            return cb(null, fileIds);
        };
        FileBaseFilters.setFileBaseLastViewedFileIdForUser = (user, id) =>
            calls.setLastViewed.push(id);
        FileBaseFilters.getFileBaseLastViewedFileIdByUser = () => 0;

        restore.push(() => {
            FileEntry.findFiles = findFiles;
            FileBaseFilters.setFileBaseLastViewedFileIdForUser = setLastViewed;
            FileBaseFilters.getFileBaseLastViewedFileIdByUser = getLastViewed;
        });
        return calls;
    }

    afterEach(() => {
        restore.forEach(r => r());
        restore = [];
    });

    it('is off unless set to true', () => {
        assert.equal(makeScan().skipFileBase, false);
        assert.equal(makeScan({ skipFileBase: false }).skipFileBase, false);
        assert.equal(makeScan({ skipFileBase: 'yes' }).skipFileBase, false);
        assert.equal(makeScan({ skipFileBase: true }).skipFileBase, true);
    });

    describe('without it (as before)', () => {
        //  the file base step as master runs it, recorded: |found| new files
        //  go to the file list (the scan resumes from saved state later),
        //  none ends the step
        function recordFileBase(mod, found) {
            mod.newScanFileBase = cb => {
                mod.trace.push(`step:${mod.currentStep}`);
                if (found) {
                    return mod.gotoMenu('newScanFileBaseList', {
                        extraArgs: { fileList: found },
                    });
                }
                return cb(new Error('No more new files'));
            };
        }

        it('goes on to the file base after the message base', done => {
            const mod = makeScan();
            recordFileBase(mod, [7, 8, 9]);
            mod.performScanCurrentStep(() => assert.fail('finished early'));
            setImmediate(() => {
                assert.deepEqual(mod.trace, ['step:messageConferences', 'step:fileBase']);
                assert.equal(mod.went.name, 'newScanFileBaseList');
                done();
            });
        });

        for (const config of [{}, { skipFileBase: false }]) {
            it(`steps message base, file base, finished (${JSON.stringify(config)})`, done => {
                const mod = makeScan(config);
                recordFileBase(mod, null);
                mod.performScanCurrentStep(err => {
                    assert.equal(err, null);
                    assert.deepEqual(mod.trace, [
                        'step:messageConferences',
                        'step:fileBase',
                    ]);
                    assert.equal(mod.currentStep, 'finished');
                    assert.equal(mod.went, null);
                    done();
                });
            });
        }

        it('a saved scan resumes at the file base', done => {
            const mod = makeScan();
            recordFileBase(mod, null);
            mod.restoreSavedState({ currentStep: 'fileBase', currentScanAux: {} });
            mod.performScanCurrentStep(err => {
                assert.equal(err, null);
                assert.deepEqual(mod.trace, ['step:fileBase']);
                assert.equal(mod.currentStep, 'finished');
                done();
            });
        });
    });

    describe('with skipFileBase: true', () => {
        it('finishes after the message base; the file base is never touched', done => {
            const calls = stubFileBase([7, 8, 9]);
            const mod = makeScan({ skipFileBase: true });
            let fileBaseEntered = false;
            mod.newScanFileBase = cb => {
                fileBaseEntered = true;
                return cb(null);
            };

            mod.performScanCurrentStep(err => {
                assert.equal(err, null);
                assert.deepEqual(mod.trace, ['step:messageConferences']);
                assert.equal(fileBaseEntered, false);
                assert.equal(mod.currentStep, 'finished');
                assert.equal(calls.findFiles, 0);
                assert.deepEqual(calls.setLastViewed, []);
                assert.equal(mod.went, null);
                done();
            });
        });

        //  the real step would need a file base configuration: entering it
        //  here would throw, and the stand-ins below would see calls
        it('the real file base step is not run either', done => {
            const calls = stubFileBase([7, 8, 9]);
            const mod = makeScan({ skipFileBase: true });
            mod.performScanCurrentStep(err => {
                assert.equal(err, null);
                assert.equal(calls.findFiles, 0);
                assert.deepEqual(calls.setLastViewed, []);
                assert.equal(mod.went, null);
                done();
            });
        });
    });
});
