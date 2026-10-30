'use strict';

//
//  An upload's receive directory is removed on every way out of the upload
//  -- finished, failed, cancelled, abandoned for a second attempt, or
//  disconnected -- but never while a transfer is still writing into it, and
//  never a directory the upload did not make.
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');

const quietLog = {
    warn() {},
    info() {},
    debug() {},
    trace() {},
    error() {},
};

function makeClient() {
    const client = new EventEmitter();
    client.log = quietLog;
    return client;
}

//  removal is asynchronous
function waitUntilGone(path, cb, deadline = Date.now() + 3000) {
    if (!fs.existsSync(path)) {
        return cb(null);
    }
    if (Date.now() > deadline) {
        return cb(new Error(`${path} was never removed`));
    }
    setTimeout(() => waitUntilGone(path, cb, deadline), 10);
}

//  long enough for a removal that should not happen to have happened
function stillThereAfterAWhile(path, cb) {
    setTimeout(() => cb(fs.existsSync(path)), 200);
}

describe('Upload receive directory lifecycle', () => {
    let UploadModule;
    let ProtocolSelectModule;
    const leftovers = [];

    before(() => {
        UploadModule = require('../core/upload.js').getModule;
        ProtocolSelectModule =
            require('../core/file_transfer_protocol_select.js').getModule;
    });

    after(() => {
        leftovers.forEach(p => fs.rmSync(p, { recursive: true, force: true }));
    });

    //  The options page: makes the receive directory, then hands off to
    //  protocol selection. Calls back (err, recvDirectory, extraArgs).
    function startUpload(client, cb) {
        const mod = Object.create(UploadModule.prototype);
        Object.assign(mod, {
            client,
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
            const { extraArgs } = mod.handedOff;
            leftovers.push(extraArgs.recvDirectory);
            fs.writeFileSync(paths.join(extraArgs.recvDirectory, 'partial.zip'), 'x');
            return cb(null, extraArgs.recvDirectory, extraArgs);
        });
    }

    function makeProtocolSelect(client, extraArgs) {
        return new ProtocolSelectModule({
            menuName: 'fileTransferProtocolSelection',
            menuConfig: { config: {} },
            client,
            extraArgs,
        });
    }

    //  The upload module re-entered once the transfer is done.
    function finishingUpload(client, recvDirectory) {
        const mod = Object.create(UploadModule.prototype);
        Object.assign(mod, { client, viewControllers: {} });
        mod.adoptTempRecvDirectory(recvDirectory); //  as the constructor does
        return mod;
    }

    describe('cancel and abandon', () => {
        it('is removed when the caller backs out of protocol selection', done => {
            const client = makeClient();
            startUpload(client, (err, dir, extraArgs) => {
                assert.ifError(err);
                makeProtocolSelect(client, extraArgs).leave();
                waitUntilGone(dir, done);
            });
        });

        it('is kept when protocol selection hands off to the transfer', done => {
            const client = makeClient();
            startUpload(client, (err, dir, extraArgs) => {
                assert.ifError(err);
                const select = makeProtocolSelect(client, extraArgs);
                select.protocols = [{ protocol: 'zmodem8kSz' }];
                select.gotoMenu = (name, modOpts, cb) => {
                    select.leave(); //  as the menu stack does
                    return cb(null);
                };
                select.menuMethods.selectProtocol({ value: { protocol: 0 } }, {}, err => {
                    assert.ifError(err);
                    stillThereAfterAWhile(dir, there => {
                        assert.ok(there, 'removed before the transfer could use it');
                        done();
                    });
                });
            });
        });

        it('is removed when the caller disconnects before the transfer', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                client.emit('end');
                waitUntilGone(dir, done);
            });
        });

        it('a second attempt removes the first one', done => {
            const client = makeClient();
            startUpload(client, (err, firstDir) => {
                assert.ifError(err);
                startUpload(client, (err, secondDir) => {
                    assert.ifError(err);
                    waitUntilGone(firstDir, err => {
                        assert.ifError(err);
                        assert.ok(fs.existsSync(secondDir), 'second attempt removed');
                        done();
                    });
                });
            });
        });

        it("another caller's upload is left alone", done => {
            const mine = makeClient();
            const theirs = makeClient();
            startUpload(theirs, (err, theirDir, theirArgs) => {
                assert.ifError(err);
                startUpload(mine, (err, myDir) => {
                    assert.ifError(err);
                    //  my protocol selection, handed their directory
                    makeProtocolSelect(mine, theirArgs).leave();
                    mine.emit('end');
                    waitUntilGone(myDir, err => {
                        assert.ifError(err);
                        stillThereAfterAWhile(theirDir, there => {
                            assert.ok(there, "another caller's upload removed");
                            done();
                        });
                    });
                });
            });
        });
    });

    describe('a disconnect during the transfer', () => {
        let previousConfig;
        let TransferModule;

        before(() => {
            previousConfig = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                menus: { cls: false },
                fileTransferProtocols: { zmodem8kSz: { external: {} } },
            });
            TransferModule = require('../core/file_transfer.js').getModule;
        });

        after(() => {
            configModule._popTestConfig(previousConfig);
        });

        it('waits for the transfer to finish, then removes it', done => {
            const client = makeClient();
            startUpload(client, (err, dir, extraArgs) => {
                assert.ifError(err);

                const transfer = new TransferModule({
                    menuName: 'recvFilesFromUser',
                    menuConfig: { config: {} },
                    client,
                    extraArgs,
                });

                let thereDuringTransfer;
                //  the protocol is still writing when the caller drops
                transfer.recvFilesFreeOfCharge = cb => {
                    client.emit('end');
                    stillThereAfterAWhile(dir, there => {
                        thereDuringTransfer = there;
                        return cb(null);
                    });
                };
                transfer.updateRecvStats = cb => cb(null);
                transfer.prevMenu = () => {
                    waitUntilGone(dir, err => {
                        assert.ok(thereDuringTransfer, 'removed mid-transfer');
                        assert.ifError(err);
                        done();
                    });
                };

                transfer.initSequence();
            });
        });
    });

    describe('the re-entered upload module', () => {
        it('removes it once finished', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                finishingUpload(client, dir).cleanupTempFiles();
                waitUntilGone(dir, done);
            });
        });

        it('removes it when left before the files are moved', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                finishingUpload(client, dir).leave();
                waitUntilGone(dir, done);
            });
        });

        it('keeps it when left while the files are being moved', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                const mod = finishingUpload(client, dir);
                mod.movingUploads = true;
                mod.leave();
                stillThereAfterAWhile(dir, there => {
                    assert.ok(there, 'removed while files were being moved');
                    done();
                });
            });
        });

        it('does not throw for an area with no storage directory, and removes it', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                const mod = finishingUpload(client, dir);
                mod.areaInfo = { areaTag: 'no_storage' };
                assert.doesNotThrow(() => mod.moveAndPersistUploadsToDatabase([]));
                waitUntilGone(dir, done);
            });
        });

        it('never removes a directory an upload did not make', done => {
            //  e.g. a recvDirectory from an operator's menu extraArgs
            const operatorDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'operator-'));
            leftovers.push(operatorDir);
            fs.writeFileSync(paths.join(operatorDir, 'keep.txt'), 'keep');

            const mod = Object.create(UploadModule.prototype);
            Object.assign(mod, { client: makeClient(), viewControllers: {} });
            mod.tempRecvDirectory = operatorDir;
            mod.cleanupTempFiles();

            stillThereAfterAWhile(paths.join(operatorDir, 'keep.txt'), there => {
                assert.ok(there, 'operator directory removed');
                done();
            });
        });
    });
});
