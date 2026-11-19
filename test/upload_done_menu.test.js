'use strict';

//
//  Where a caller goes once an upload is done, or has failed: the upload
//  menu's |uploadDoneMenu|, else the stock 'fileBaseMainMenu'. A board whose
//  file base menu has another name used to end the caller's session after
//  every upload ("No menu entry for fileBaseMainMenu"); now the caller is
//  sent back to the menu they started the upload from.
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const os = require('os');

const configModule = require('../core/config.js');
const { Errors } = require('../core/enig_error.js');

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS' },
    fileBase: { areas: {}, storageTags: {}, areaStoragePrefix: os.tmpdir() },
    fileTransferProtocols: { zmodem8kSz: { external: {} } },
};

//  as upload_temp_dir.test.js: both capture Config when first required
const RELOAD = [
    '../core/file_base_area.js',
    '../core/upload.js',
    '../core/file_transfer_protocol_select.js',
];

function makeClient() {
    const client = new EventEmitter();
    client.warnings = [];
    client.log = {
        warn(obj, msg) {
            client.warnings.push({ obj, msg });
        },
        info() {},
        debug() {},
        trace() {},
        error() {},
        level: () => 30,
    };
    client.interruptQueue = { hasItems: () => false };
    client.clientEnded = false;
    client.endedWith = null;
    client.defaultHandlerMissingMod = () => err => {
        client.endedWith = err;
    };
    return client;
}

describe('Upload done menu', () => {
    let previousConfig;
    let UploadModule;
    let ProtocolSelectModule;

    before(() => {
        previousConfig = configModule._pushTestConfig(TEST_CONFIG);
        RELOAD.forEach(m => delete require.cache[require.resolve(m)]);
        UploadModule = require('../core/upload.js').getModule;
        ProtocolSelectModule =
            require('../core/file_transfer_protocol_select.js').getModule;
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
        RELOAD.forEach(m => delete require.cache[require.resolve(m)]);
    });

    //
    //  An upload module after the transfer, with gotoMenu() standing in for
    //  the menu stack: |menus| are the menu names that exist.
    //
    function finishedUpload({
        config = {},
        uploadFromMenu,
        menus,
        denied = [],
        client,
    } = {}) {
        client = client || makeClient();
        const mod = Object.create(UploadModule.prototype);
        Object.assign(mod, {
            client,
            menuName: 'fileBaseUploadFiles',
            menuConfig: { config },
            uploadFromMenu,
            gotoCalls: [],
            gotoMenu(name, modOpts, done) {
                mod.gotoCalls.push(name);
                if (denied.includes(name)) {
                    return done(Errors.AccessDenied('No access to this menu'));
                }
                if (menus.includes(name)) {
                    return done(null);
                }
                return done(Errors.DoesNotExist(`No menu entry for "${name}"`));
            },
        });
        return mod;
    }

    describe('gotoUploadDoneMenu()', () => {
        it('goes to the menu config\'s "uploadDoneMenu"', done => {
            const mod = finishedUpload({
                config: { uploadDoneMenu: 'fileBase' },
                uploadFromMenu: 'somewhereElse',
                menus: ['fileBase', 'fileBaseMainMenu', 'somewhereElse'],
            });
            mod.gotoUploadDoneMenu(err => {
                assert.ifError(err);
                assert.deepEqual(mod.gotoCalls, ['fileBase']);
                assert.equal(mod.client.warnings.length, 0);
                done();
            });
        });

        it('defaults to "fileBaseMainMenu"', done => {
            const mod = finishedUpload({
                uploadFromMenu: 'fileBase',
                menus: ['fileBaseMainMenu', 'fileBase'],
            });
            mod.gotoUploadDoneMenu(err => {
                assert.ifError(err);
                assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu']);
                done();
            });
        });

        it('without the done menu, returns to the menu the upload started from, with a warning', done => {
            const mod = finishedUpload({
                uploadFromMenu: 'fileBase',
                menus: ['fileBase'],
            });
            mod.gotoUploadDoneMenu(err => {
                assert.ifError(err);
                assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu', 'fileBase']);
                assert.equal(mod.client.endedWith, null, 'session was ended');
                assert.equal(mod.client.warnings.length, 1);
                const { obj, msg } = mod.client.warnings[0];
                assert.equal(obj.uploadDoneMenu, 'fileBaseMainMenu');
                assert.equal(obj.fallbackMenu, 'fileBase');
                assert.match(msg, /uploadDoneMenu/);
                done();
            });
        });

        it('falls back from a misnamed "uploadDoneMenu" too', done => {
            const mod = finishedUpload({
                config: { uploadDoneMenu: 'fileBsae' },
                uploadFromMenu: 'fileBase',
                menus: ['fileBase'],
            });
            mod.gotoUploadDoneMenu(err => {
                assert.ifError(err);
                assert.deepEqual(mod.gotoCalls, ['fileBsae', 'fileBase']);
                done();
            });
        });

        it('without a callback, falls back the same way and ends nothing', () => {
            const mod = finishedUpload({
                uploadFromMenu: 'fileBase',
                menus: ['fileBase'],
            });
            mod.gotoUploadDoneMenu();
            assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu', 'fileBase']);
            assert.equal(mod.client.endedWith, null);
        });

        it('with no menu to fall back to, fails as before', () => {
            const mod = finishedUpload({ menus: [] });
            mod.gotoUploadDoneMenu();
            assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu']);
            assert.ok(mod.client.endedWith, 'the menu stack default handler ran');
        });

        it('when the fallback menu is missing too, fails with its error', done => {
            const mod = finishedUpload({ uploadFromMenu: 'gone', menus: [] });
            mod.gotoUploadDoneMenu(err => {
                assert.ok(err);
                assert.match(err.message, /gone/);
                assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu', 'gone']);
                done();
            });
        });

        it('does not fall back to the done menu itself, or to the upload menu', () => {
            for (const uploadFromMenu of ['fileBaseMainMenu', 'fileBaseUploadFiles']) {
                const mod = finishedUpload({
                    uploadFromMenu,
                    menus: ['fileBaseUploadFiles'],
                });
                mod.gotoUploadDoneMenu();
                assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu']);
                assert.ok(mod.client.endedWith);
            }
        });

        it('does not go anywhere else once the session has ended', () => {
            const client = makeClient();
            client.clientEnded = true;
            const mod = finishedUpload({
                client,
                uploadFromMenu: 'fileBase',
                menus: ['fileBase'],
            });
            mod.gotoUploadDoneMenu();
            assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu']);
            assert.equal(client.endedWith, null, 'the default handler ran');
        });

        it('falls back from a done menu the caller may not enter', done => {
            const mod = finishedUpload({
                uploadFromMenu: 'fileBase',
                menus: ['fileBase'],
                denied: ['fileBaseMainMenu'],
            });
            mod.gotoUploadDoneMenu(err => {
                assert.ifError(err);
                assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu', 'fileBase']);
                done();
            });
        });

        it('without a callback, access denied everywhere does not end the session', () => {
            //  as the menu stack does without a callback
            const mod = finishedUpload({
                uploadFromMenu: 'fileBase',
                menus: [],
                denied: ['fileBaseMainMenu', 'fileBase'],
            });
            mod.gotoUploadDoneMenu();
            assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu', 'fileBase']);
            assert.equal(mod.client.endedWith, null);
        });
    });

    describe('processUploadedFiles()', () => {
        it('a failed upload also ends at the done menu, falling back the same way', () => {
            const mod = finishedUpload({
                uploadFromMenu: 'fileBase',
                menus: ['fileBase'],
            });
            Object.assign(mod, {
                uploadType: 'blind',
                recvFilePaths: [],
                scanFiles: cb => cb(new Error('scan blew up')),
                cleanupTempFiles() {
                    mod.cleanedUp = true;
                },
            });
            mod.processUploadedFiles();
            assert.ok(mod.cleanedUp);
            assert.deepEqual(mod.gotoCalls, ['fileBaseMainMenu', 'fileBase']);
            assert.equal(mod.client.endedWith, null);
        });
    });

    describe('remembering where the upload started', () => {
        it('the options page hands the menu under it on to protocol selection', done => {
            const client = makeClient();
            client.menuStack = { peekPrev: () => ({ name: 'fileBase' }) };
            const mod = Object.create(UploadModule.prototype);
            Object.assign(mod, {
                client,
                menuConfig: { config: {} },
                availAreas: [{ areaTag: 'uploads' }],
                uploadType: 'blind',
                viewControllers: {
                    options: { getView: () => ({ getData: () => 0 }) },
                },
                gotoMenu(name, modOpts, cb) {
                    mod.handedOff = modOpts;
                    return cb(null);
                },
            });

            mod.performUpload(err => {
                assert.ifError(err);
                const { extraArgs } = mod.handedOff;
                try {
                    assert.equal(extraArgs.uploadFromMenu, 'fileBase');
                } finally {
                    require('fs').rmSync(extraArgs.recvDirectory, {
                        recursive: true,
                        force: true,
                    });
                }
                done();
            });
        });

        it('is left unset when there is no menu under it', () => {
            const mod = Object.create(UploadModule.prototype);
            mod.client = makeClient();
            assert.equal(mod.menuBelow(), undefined);
            mod.client.menuStack = { peekPrev: () => undefined };
            assert.equal(mod.menuBelow(), undefined);
        });

        it('protocol selection passes it back to the re-entered upload module', () => {
            const client = makeClient();
            const select = new ProtocolSelectModule({
                menuName: 'fileTransferProtocolSelection',
                menuConfig: { config: {} },
                client,
                extraArgs: {
                    direction: 'recv',
                    recvDirectory: os.tmpdir(),
                    uploadAreaInfo: { areaTag: 'uploads' },
                    uploadType: 'blind',
                    uploadFromMenu: 'fileBase',
                },
                lastMenuResult: { recvFilePaths: [] },
            });
            select.gotoMenu = (name, modOpts) => {
                select.wentTo = { name, modOpts };
            };
            select.initSequence();

            assert.equal(select.wentTo.name, 'fileBaseUploadFiles');
            const { lastMenuResult } = select.wentTo.modOpts;
            assert.equal(lastMenuResult.uploadFromMenu, 'fileBase');

            const upload = new UploadModule({
                menuName: 'fileBaseUploadFiles',
                menuConfig: { config: { menuFlags: [] } },
                client,
                lastMenuResult,
            });
            assert.equal(upload.uploadFromMenu, 'fileBase');
        });
    });
});
