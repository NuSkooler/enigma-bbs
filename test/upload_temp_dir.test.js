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
const loggerModule = require('../core/logger.js');

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS' },
    fileBase: { areas: {}, storageTags: {}, areaStoragePrefix: os.tmpdir() },
    fileTransferProtocols: { zmodem8kSz: { external: {} } },
};

//
//  file_base_area.js captures Config when first required, and the upload
//  module's constructor reads file areas through it, so both are loaded
//  afresh against TEST_CONFIG (as file_area_download_acs.test.js does).
//
const RELOAD = ['../core/file_base_area.js', '../core/upload.js'];

const quietLog = {
    warn() {},
    info() {},
    debug() {},
    trace() {},
    error() {},
    level: () => 30,
};

function makeClient() {
    const client = new EventEmitter();
    client.log = quietLog;
    client.interruptQueue = { hasItems: () => false };
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

function waitFor(what, test, cb, deadline = Date.now() + 3000) {
    if (test()) {
        return cb(null);
    }
    if (Date.now() > deadline) {
        return cb(new Error(`Timed out waiting for ${what}`));
    }
    setTimeout(() => waitFor(what, test, cb, deadline), 10);
}

//  long enough for a removal that should not happen to have happened
function stillThereAfterAWhile(path, cb) {
    setTimeout(() => cb(fs.existsSync(path)), 200);
}

describe('Upload receive directory lifecycle', () => {
    let previousConfig;
    let UploadModule;
    let ProtocolSelectModule;
    let TransferModule;
    let MenuModule;
    let MenuStack;
    const leftovers = [];

    before(() => {
        previousConfig = configModule._pushTestConfig(TEST_CONFIG);
        RELOAD.forEach(m => delete require.cache[require.resolve(m)]);
        UploadModule = require('../core/upload.js').getModule;
        ProtocolSelectModule =
            require('../core/file_transfer_protocol_select.js').getModule;
        TransferModule = require('../core/file_transfer.js').getModule;
        MenuModule = require('../core/menu_module.js').MenuModule;
        MenuStack = require('../core/menu_stack.js');
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
        RELOAD.forEach(m => delete require.cache[require.resolve(m)]);
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

    //
    //  The upload module re-entered once the transfer is done, as the menu
    //  stack does it: constructed with the transfer's results, then entered.
    //  Only the screens are left out.
    //
    function reenteredUpload(client, recvDirectory) {
        const mod = new UploadModule({
            menuName: 'fileBaseUploadFiles',
            menuConfig: { config: { menuFlags: [] } }, //  as loadMenu() leaves it
            client,
            lastMenuResult: {
                recvFilePaths: [],
                tempRecvDirectory: recvDirectory,
                areaInfo: { areaTag: 'uploads' },
                uploadType: 'blind',
            },
        });
        mod.initSequence = () => {};
        mod.enter();
        return mod;
    }

    //  Runs a receive through the real transfer sequence; |during| is the
    //  protocol program running, and calls back when it exits.
    function runTransfer(client, extraArgs, during, cb) {
        const transfer = new TransferModule({
            menuName: 'recvFilesFromUser',
            menuConfig: { config: {} },
            client,
            extraArgs,
        });
        transfer.recvFilesFreeOfCharge = during;
        transfer.updateRecvStats = done => done(null);
        transfer.prevMenu = cb;
        transfer.initSequence();
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
        it('waits for the transfer to finish, then removes it', done => {
            const client = makeClient();
            startUpload(client, (err, dir, extraArgs) => {
                assert.ifError(err);

                let thereDuringTransfer;
                runTransfer(
                    client,
                    extraArgs,
                    //  the protocol is still writing when the caller drops
                    exited => {
                        client.emit('end');
                        stillThereAfterAWhile(dir, there => {
                            thereDuringTransfer = there;
                            return exited(null);
                        });
                    },
                    () => {
                        waitUntilGone(dir, err => {
                            assert.ok(thereDuringTransfer, 'removed mid-transfer');
                            assert.ifError(err);
                            done();
                        });
                    }
                );
            });
        });

        it('the upload module arriving afterwards does not call it foreign', done => {
            const client = makeClient();
            const warnings = [];
            const savedWarn = loggerModule.log.warn;
            loggerModule.log.warn = (...args) => warnings.push(args);
            const finish = err => {
                loggerModule.log.warn = savedWarn;
                done(err);
            };

            startUpload(client, (err, dir, extraArgs) => {
                assert.ifError(err);
                runTransfer(
                    client,
                    extraArgs,
                    exited => {
                        client.emit('end');
                        return exited(null);
                    },
                    () => {
                        waitUntilGone(dir, err => {
                            if (err) {
                                return finish(err);
                            }
                            reenteredUpload(client, dir).cleanupTempFiles();
                            try {
                                assert.deepEqual(warnings, []);
                            } catch (e) {
                                return finish(e);
                            }
                            finish();
                        });
                    }
                );
            });
        });
    });

    describe('the re-entered upload module', () => {
        it('removes it once finished', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                reenteredUpload(client, dir).cleanupTempFiles();
                waitUntilGone(dir, done);
            });
        });

        it('removes it when left before the files are moved', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                reenteredUpload(client, dir).leave();
                waitUntilGone(dir, done);
            });
        });

        it('keeps it when left while the files are being moved', done => {
            const client = makeClient();
            startUpload(client, (err, dir) => {
                assert.ifError(err);
                const mod = reenteredUpload(client, dir);
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
                const mod = reenteredUpload(client, dir);
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

            reenteredUpload(makeClient(), operatorDir).cleanupTempFiles();

            stillThereAfterAWhile(paths.join(operatorDir, 'keep.txt'), there => {
                assert.ok(there, 'operator directory removed');
                done();
            });
        });
    });

    //
    //  The same, through the real menu stack: protocol selection, the
    //  transfer, prev() back to a new protocol selection, and its hand-off to
    //  the upload module. Only the screens and the protocol program are
    //  stubbed out.
    //
    describe('through the menu stack', () => {
        const saved = {};

        before(() => {
            saved.menu = MenuModule.prototype.initSequence;
            saved.upload = UploadModule.prototype.initSequence;
            saved.transfer = TransferModule.prototype.initSequence;
            MenuModule.prototype.initSequence = function () {};
            UploadModule.prototype.initSequence = function () {};
            TransferModule.prototype.initSequence = function () {};
        });

        after(() => {
            MenuModule.prototype.initSequence = saved.menu;
            UploadModule.prototype.initSequence = saved.upload;
            TransferModule.prototype.initSequence = saved.transfer;
        });

        function makeMenuClient({ denyUpload = false } = {}) {
            const client = makeClient();
            client.acs = {
                hasMenuModuleAccess: mod => !(denyUpload && mod instanceof UploadModule),
            };
            client.currentTheme = {
                menus: {
                    fileTransferProtocolSelection: {
                        module: 'file_transfer_protocol_select',
                    },
                    recvFilesFromUser: { module: 'file_transfer' },
                    fileBaseUploadFiles: { module: 'upload' },
                },
            };
            client.defaultHandlerMissingMod = () => err => {
                client.menuError = err;
            };
            client.menuStack = new MenuStack(client);
            return client;
        }

        //  Up to the new protocol selection handing the finished transfer to
        //  the upload module. Calls back (err, recvDirectory).
        function uploadThroughMenus(client, cb) {
            startUpload(client, (err, dir, extraArgs) => {
                if (err) {
                    return cb(err);
                }
                const stack = client.menuStack;
                stack.goto('fileTransferProtocolSelection', { extraArgs }, err => {
                    if (err) {
                        return cb(err);
                    }
                    const select = stack.currentModule;
                    select.protocols = [{ protocol: 'zmodem8kSz' }];
                    select.menuMethods.selectProtocol(
                        { value: { protocol: 0 } },
                        {},
                        err => {
                            if (err) {
                                return cb(err);
                            }
                            const transfer = stack.currentModule;
                            assert.ok(transfer instanceof TransferModule);
                            transfer.recvFilePaths = [paths.join(dir, 'partial.zip')];
                            stack.prev(err => cb(err, dir));
                        }
                    );
                });
            });
        }

        it('the upload module gets the finished upload, and removes it when done', done => {
            const client = makeMenuClient();
            uploadThroughMenus(client, (err, dir) => {
                assert.ifError(err);
                waitFor(
                    'the upload module',
                    () => client.menuStack.currentModule instanceof UploadModule,
                    err => {
                        assert.ifError(err || client.menuError);
                        stillThereAfterAWhile(dir, there => {
                            assert.ok(there, 'finished upload removed on hand-off');
                            client.menuStack.currentModule.cleanupTempFiles();
                            waitUntilGone(dir, done);
                        });
                    }
                );
            });
        });

        it('a disconnect still removes it when the upload module is refused', done => {
            const client = makeMenuClient({ denyUpload: true });
            uploadThroughMenus(client, (err, dir) => {
                assert.ifError(err);
                //  the new protocol selection stays put; the upload module was
                //  built and thrown away without ever being entered
                stillThereAfterAWhile(dir, there => {
                    assert.ok(there);
                    assert.ok(
                        client.menuStack.currentModule instanceof ProtocolSelectModule
                    );
                    client.emit('end');
                    waitUntilGone(dir, done);
                });
            });
        });

        it('a reload of protocol selection keeps it, and keeps its arguments', done => {
            const client = makeMenuClient();
            startUpload(client, (err, dir, extraArgs) => {
                assert.ifError(err);
                const stack = client.menuStack;
                stack.goto('fileTransferProtocolSelection', { extraArgs }, err => {
                    assert.ifError(err);
                    const before = stack.currentModule;
                    before.reload(err => {
                        assert.ifError(err);
                        const after = stack.currentModule;
                        assert.notEqual(after, before);
                        assert.equal(after.extraArgs.recvDirectory, dir);
                        stillThereAfterAWhile(dir, there => {
                            assert.ok(there, 'removed by a reload');
                            done();
                        });
                    });
                });
            });
        });
    });
});
