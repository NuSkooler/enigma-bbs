'use strict';

//
//  temptmp tracks the paths it creates by session ID, and a session's
//  cleanup() removes every path tracked under that ID. A session shared
//  between callers -- a module-level one, or a per-instance one with a fixed
//  ID -- lets whichever caller finishes first delete the others' temp files
//  while they are still in use: one node finishing an upload took another
//  node's half-received upload with it.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');

const configModule = require('../core/config.js');

//  temptmp's cleanup is asynchronous and calls back to nobody we can hook,
//  so wait for the finished caller's path to go, then a little longer for
//  anything removed alongside it.
function waitUntilGone(path, cb, deadline = Date.now() + 3000) {
    if (!fs.existsSync(path)) {
        return setTimeout(cb, 100);
    }
    if (Date.now() > deadline) {
        return cb(new Error(`${path} was never cleaned up`));
    }
    setTimeout(() => waitUntilGone(path, cb, deadline), 10);
}

describe('Temp files are per transfer, not shared between nodes', () => {
    describe('uploads', () => {
        let UploadModule;
        const leftovers = [];

        before(() => {
            UploadModule = require('../core/upload.js').getModule;
        });

        after(() => {
            leftovers.forEach(p => fs.rmSync(p, { recursive: true, force: true }));
        });

        //  The options page: makes the receive directory, then hands off to
        //  protocol selection. Constructing the module needs file areas from
        //  config, so the menu plumbing around performUpload() is stubbed.
        function startUpload(cb) {
            const mod = Object.create(UploadModule.prototype);
            Object.assign(mod, {
                menuConfig: { config: {} },
                availAreas: [{ areaTag: 'uploads' }],
                uploadType: 'blind',
                viewControllers: {
                    options: { getView: () => ({ getData: () => 0 }) },
                },
                gotoMenu(name, modOpts, done) {
                    mod.handedOff = modOpts;
                    return done(null);
                },
            });

            mod.performUpload(err => {
                if (err) {
                    return cb(err);
                }
                const recvDirectory = mod.handedOff.extraArgs.recvDirectory;
                leftovers.push(recvDirectory);
                return cb(null, recvDirectory);
            });
        }

        //  The module is re-entered as a new instance once the transfer is
        //  done, with the receive directory handed back to it.
        function finishUpload(recvDirectory) {
            const mod = Object.create(UploadModule.prototype);
            mod.tempRecvDirectory = recvDirectory;
            mod.cleanupTempFiles();
        }

        it("one node finishing does not remove another node's upload", done => {
            startUpload((err, firstDir) => {
                assert.ifError(err);
                startUpload((err, secondDir) => {
                    assert.ifError(err);
                    assert.notEqual(firstDir, secondDir);

                    //  the second node's file is still arriving
                    const inFlight = paths.join(secondDir, 'upload.zip');
                    fs.writeFileSync(inFlight, 'partial');

                    finishUpload(firstDir);

                    waitUntilGone(firstDir, err => {
                        assert.ifError(err);
                        assert.ok(fs.existsSync(secondDir), 'receive directory removed');
                        assert.ok(fs.existsSync(inFlight), 'in-flight upload removed');
                        done();
                    });
                });
            });
        });
    });

    describe('file transfers', () => {
        let previousConfig;
        let TransferModule;
        const leftovers = [];

        before(() => {
            previousConfig = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                menus: { cls: false },
                fileTransferProtocols: {
                    zmodem8kSz: {
                        external: { sendArgs: ['--list', '{fileListPath}'] },
                    },
                },
            });
            TransferModule = require('../core/file_transfer.js').getModule;
        });

        after(() => {
            configModule._popTestConfig(previousConfig);
            leftovers.forEach(p => fs.rmSync(p, { force: true }));
        });

        function makeTransfer() {
            return new TransferModule({
                menuName: 'sendFilesToUser',
                menuConfig: { config: {} },
                client: {},
                extraArgs: { direction: 'send' },
            });
        }

        //  builds the protocol's arguments, which writes its file list
        function prepSend(transfer, cb) {
            transfer.prepAndBuildSendArgs(['/files/a.zip'], (err, args) => {
                if (err) {
                    return cb(err);
                }
                const listPath = args[1];
                leftovers.push(listPath);
                assert.ok(fs.existsSync(listPath));
                return cb(null, listPath);
            });
        }

        it("one transfer finishing does not remove another's temp files", done => {
            const first = makeTransfer();
            const second = makeTransfer();

            prepSend(second, (err, secondList) => {
                assert.ifError(err);

                //  the first runs to completion through the real sequence,
                //  with only the protocol itself and the stats stubbed out
                let firstList;
                first.checkSendTimeRemaining = cb => cb(null);
                first.sendFiles = cb =>
                    prepSend(first, (err, listPath) => {
                        firstList = listPath;
                        return cb(err);
                    });
                first.updateSendStats = cb => cb(null);
                first.prevMenu = () => {
                    waitUntilGone(firstList, err => {
                        assert.ifError(err);
                        assert.ok(
                            fs.existsSync(secondList),
                            "the other transfer's file list was removed"
                        );
                        done();
                    });
                };

                first.initSequence();
            });
        });
    });

    describe('offline mail packet readers and writers', () => {
        let QWKPacketReader;
        let QWKPacketWriter;
        let BlueWavePacketWriter;

        before(() => {
            ({
                QWKPacketReader,
                QWKPacketWriter,
            } = require('../core/qwk_mail_packet.js'));
            ({ BlueWavePacketWriter } = require('../core/bluewave_mail_packet.js'));
        });

        const makers = {
            QWKPacketReader: () => new QWKPacketReader('/nonexistent.qwk'),
            QWKPacketWriter: () => new QWKPacketWriter(),
            BlueWavePacketWriter: () => new BlueWavePacketWriter(),
        };

        Object.entries(makers).forEach(([name, make]) => {
            it(`${name}: one cleaning up leaves another's work directory alone`, done => {
                const first = make();
                const second = make();

                first.temptmp.mkdir({ prefix: 'enigtest-' }, (err, firstDir) => {
                    assert.ifError(err);
                    second.temptmp.mkdir({ prefix: 'enigtest-' }, (err, secondDir) => {
                        assert.ifError(err);

                        //  cleanup() calls back from inside a promise, which
                        //  would swallow a failed assertion; assert outside it
                        first.temptmp.cleanup(() => {
                            const survived = fs.existsSync(secondDir);
                            second.temptmp.cleanup(() => {
                                setImmediate(() => {
                                    assert.equal(fs.existsSync(firstDir), false);
                                    assert.ok(survived, 'work directory removed');
                                    done();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});
