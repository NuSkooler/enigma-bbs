'use strict';

//
//  Hiding entries a rescan marked infected (#291, PR 4): the findFiles()
//  filter, core/file_base_visibility.js, and each place a user could find,
//  queue, fetch or be served one -- the download queue, the send queue at
//  send time, web links (including ones made before the flag) and the REST
//  API.
//
//  The file database is an in-memory one. file_entry.js, file_base_area.js
//  and the modules that capture them are required fresh against it (and the
//  test config) and put back afterwards.
//

const { strict: assert } = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const moment = require('moment');
const _ = require('lodash');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');
const ACS = require('../core/acs.js');

const FRESH = [
    '../core/file_entry.js',
    '../core/file_base_area.js',
    '../core/download_queue.js',
    '../core/file_area_web.js',
    '../core/rest/routes/files.js',
];

const AREA = 'vis_area';

function makeUser(groups, userId = 42) {
    const props = {
        account_status: 0,
        login_count: 10,
        account_created: moment().subtract(90, 'days').format(),
    };
    return {
        userId,
        username: `user${userId}`,
        authFactor: 1,
        groups,
        properties: {},
        isGroupMember(name) {
            return this.groups.includes(name);
        },
        getAge() {
            return 25;
        },
        getProperty(name) {
            return props[name];
        },
        getPropertyAsNumber(name) {
            const v = props[name];
            return typeof v === 'number' ? v : parseInt(v, 10) || 0;
        },
    };
}

function makeClient(groups, userId) {
    const user = makeUser(groups, userId);
    const logged = [];
    const log = {};
    ['trace', 'debug', 'info', 'warn', 'error'].forEach(level => {
        log[level] = (obj, msg) => logged.push({ level, obj, msg });
    });
    const client = {
        user,
        session: { isSecure: false, uniqueId: `s${userId || 42}` },
        term: { termWidth: 80, termHeight: 25 },
        log,
        logged,
    };
    client.acs = new ACS({ client, user });
    return client;
}

describe('hiding infected file entries (#291)', function () {
    let mods;
    let fileDb;
    let prevFileDb;
    let prevConfig;
    let config;
    let dir;
    const savedModules = {};

    before(() => {
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-vis-')));

        config = configDefault();
        config.general.boardName = 'Visibility Test';
        config.fileBase.areaStoragePrefix = dir;
        config.fileBase.storageTags = { vis_tag: 'vis' };
        config.fileBase.areas = {
            [AREA]: {
                name: 'Visibility',
                storageTags: ['vis_tag'],
                acs: { read: 'GM[users]', download: 'GM[users]' },
            },
        };
        _.set(config, 'contentServers.web.restApi.files.publicAccess', {
            [AREA]: { include: [AREA] },
        });
        prevConfig = configModule._pushTestConfig(config);

        prevFileDb = dbModule.dbs.file;
        //  the real schema: foreign keys, cascades and triggers included
        fileDb = dbModule.createFileDatabase();

        FRESH.forEach(m => {
            const key = require.resolve(m);
            savedModules[key] = require.cache[key];
            delete require.cache[key];
        });

        mods = {
            FileEntry: require('../core/file_entry.js'),
            DownloadQueue: require('../core/download_queue.js'),
            Visibility: require('../core/file_base_visibility.js'),
            FileAreaWeb: require('../core/file_area_web.js'),
            Allowlist: require('../core/file_scan_allowlist.js'),
        };
    });

    after(() => {
        FRESH.forEach(m => {
            const key = require.resolve(m);
            if (savedModules[key]) {
                require.cache[key] = savedModules[key];
            } else {
                delete require.cache[key];
            }
        });
        dbModule.dbs.file = prevFileDb;
        fileDb.close();
        configModule._popTestConfig(prevConfig);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        fileDb.exec(`
            DELETE FROM file_web_serve_batch; DELETE FROM file_web_serve;
            DELETE FROM file_user_rating; DELETE FROM file_hash_tag; DELETE FROM hash_tag;
            DELETE FROM file_meta; DELETE FROM file; DELETE FROM file_scan_allowlist;
        `);
        config.fileBase.scanning.hideInfected = true;
        config.fileBase.scanning.infectedVisibleAcs =
            configDefault().fileBase.scanning.infectedVisibleAcs;
    });

    //  An entry in AREA with a real file behind it
    function addFile(fileId, { infected = false, scanResult } = {}) {
        const fileName = `file${fileId}.zip`;
        const data = `contents of ${fileId}`;
        fs.mkdirSync(paths.join(dir, 'vis'), { recursive: true });
        fs.writeFileSync(paths.join(dir, 'vis', fileName), data);
        fileDb
            .prepare(
                `INSERT INTO file (file_id, area_tag, file_sha256, file_name, storage_tag,
                    desc, desc_long, upload_timestamp)
                VALUES (?, ?, ?, ?, 'vis_tag', 'a file', '', '2026-01-01T00:00:00.000Z');`
            )
            .run(
                fileId,
                AREA,
                crypto.createHash('sha256').update(data).digest('hex'),
                fileName
            );
        const meta = { byte_size: data.length };
        if (infected) {
            Object.assign(meta, {
                scan_result: 'infected',
                scan_signature: 'Eicar-Test-Signature',
            });
        } else if (scanResult) {
            meta.scan_result = scanResult;
        }
        const ins = fileDb.prepare(
            'INSERT INTO file_meta (file_id, meta_name, meta_value) VALUES (?, ?, ?);'
        );
        Object.entries(meta).forEach(([n, v]) => ins.run(fileId, n, String(v)));
    }

    function markInfected(fileId) {
        mods.FileEntry.replaceMetaValues(
            fileId,
            { scan_result: 'infected', scan_signature: 'Eicar-Test-Signature' },
            err => assert.ifError(err)
        );
    }

    function findFiles(filter) {
        return new Promise((resolve, reject) =>
            mods.FileEntry.findFiles(filter, (err, ids) =>
                err ? reject(err) : resolve(ids)
            )
        );
    }

    function loadEntry(fileId) {
        return new Promise((resolve, reject) => {
            const entry = new mods.FileEntry();
            entry.load(fileId, err => (err ? reject(err) : resolve(entry)));
        });
    }

    function scanResultRows(fileId) {
        return fileDb
            .prepare(
                `SELECT meta_value FROM file_meta
                WHERE file_id = ? AND meta_name = 'scan_result' ORDER BY meta_value;`
            )
            .all(fileId)
            .map(r => r.meta_value);
    }

    describe('FileEntry', () => {
        it('findFiles() leaves infected entries out only when asked to', async () => {
            addFile(1);
            addFile(2, { infected: true });
            addFile(3, { scanResult: 'clean' });

            assert.deepEqual(
                await findFiles({ areaTag: AREA, order: 'ascending' }),
                [1, 2, 3]
            );
            assert.deepEqual(
                await findFiles({
                    areaTag: AREA,
                    order: 'ascending',
                    excludeInfected: true,
                }),
                [1, 3]
            );
        });

        it('getInfectedFileIds() reads the database, not an entry in memory', async () => {
            addFile(1);
            addFile(2);
            const entry = await loadEntry(1);
            markInfected(1);

            assert.equal(entry.meta.scan_result, undefined);
            assert.deepEqual([...mods.FileEntry.getInfectedFileIds([1, 2, 99])], [1]);
        });

        //  file_meta is UNIQUE on (file_id, meta_name, meta_value), so an older
        //  database can hold an 'infected' row beside a 'clean' one.
        it('with duplicate scan_result rows, "infected" wins everywhere', async () => {
            addFile(1, { scanResult: 'clean' });
            fileDb
                .prepare(
                    `INSERT INTO file_meta (file_id, meta_name, meta_value)
                    VALUES (1, 'scan_result', 'infected');`
                )
                .run();
            addFile(2, { infected: true });
            fileDb
                .prepare(
                    `INSERT INTO file_meta (file_id, meta_name, meta_value)
                    VALUES (2, 'scan_result', 'clean');`
                )
                .run();

            assert.deepEqual(
                await findFiles({ areaTag: AREA, excludeInfected: true }),
                []
            );
            assert.deepEqual(
                [...mods.FileEntry.getInfectedFileIds([1, 2])].sort(),
                [1, 2]
            );
            assert.equal((await loadEntry(1)).meta.scan_result, 'infected');
            assert.equal((await loadEntry(2)).meta.scan_result, 'infected');
        });

        it('loading an entry again picks up a mark-safe', async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);
            assert.equal(entry.meta.scan_result, 'infected');

            mods.FileEntry.replaceMetaValues(1, { scan_result: 'clean' }, err =>
                assert.ifError(err)
            );
            await new Promise((resolve, reject) =>
                entry.load(1, err => (err ? reject(err) : resolve()))
            );
            assert.equal(entry.meta.scan_result, 'clean');
        });

        const persist = (entry, isUpdate) =>
            new Promise((resolve, reject) =>
                entry.persist(isUpdate, err => (err ? reject(err) : resolve()))
            );

        //  oputil fb desc, the desc editor, fb scan's dupe update, a TIC update
        it('load, edit the description, update: an infected entry stays infected', async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);
            entry.desc = 'a new description';
            await persist(entry, true);

            assert.deepEqual(scanResultRows(1), ['infected']);
            assert.deepEqual(
                await findFiles({ areaTag: AREA, excludeInfected: true }),
                []
            );
            assert.equal((await loadEntry(1)).desc, 'a new description');
            assert.equal(
                (await loadEntry(1)).meta.scan_signature,
                'Eicar-Test-Signature'
            );
        });

        it('insert, flagged since, update: the flag stays', async () => {
            const entry = new mods.FileEntry({
                areaTag: AREA,
                storageTag: 'vis_tag',
                fileName: 'new.zip',
                fileSha256: 'b'.repeat(64),
                meta: { byte_size: 3, scan_result: 'clean' },
            });
            entry.desc = 'first';
            await persist(entry, false);
            markInfected(entry.fileId);

            entry.desc = 'second';
            await persist(entry, true);
            assert.deepEqual(scanResultRows(entry.fileId), ['infected']);
        });

        it('an update keeps user ratings, and the hash tags the entry has', async () => {
            addFile(1);
            const entry = await loadEntry(1);
            entry.setHashTags(['demo', 'dos']);
            await persist(entry, true);
            mods.FileEntry.persistUserRating(1, 42, 4, err => assert.ifError(err));

            const again = await loadEntry(1);
            again.hashTags.delete('dos');
            again.desc = 'edited';
            await persist(again, true);

            const after = await loadEntry(1);
            assert.deepEqual([...after.hashTags], ['demo']);
            assert.equal(after.userRating, 4);
            assert.equal(after.meta.byte_size, 'contents of 1'.length);
        });

        it('a replace by a fresh entry drops what the old file had', async () => {
            addFile(1, { infected: true });
            const add = fileDb.prepare(
                'INSERT INTO file_meta (file_id, meta_name, meta_value) VALUES (1, ?, ?)'
            );
            add.run('archive_type', 'zip');
            add.run('desc_sauce', '{"title":"old"}');
            add.run('est_release_year', '1994');
            mods.FileEntry.persistUserRating(1, 42, 5, err => assert.ifError(err));
            fileDb
                .prepare(
                    "INSERT INTO file_web_serve_batch (hash_id, file_id) VALUES ('h', 1)"
                )
                .run();

            //  a TIC "Replaces" with scanning off: new bytes, no verdict at all
            const entry = new mods.FileEntry({
                fileId: 1,
                areaTag: AREA,
                storageTag: 'vis_tag',
                fileName: 'file1.txt',
                fileSha256: 'd'.repeat(64),
                meta: { byte_size: 5 },
            });
            await persist(entry, true);

            const names = fileDb
                .prepare('SELECT meta_name FROM file_meta WHERE file_id = 1 ORDER BY 1')
                .all()
                .map(r => r.meta_name);
            assert.deepEqual(names, ['byte_size', 'dl_count']);
            assert.deepEqual(mods.FileEntry.getInfectedFileIds([1]), new Set());
            assert.equal(
                fileDb.prepare('SELECT COUNT(*) AS n FROM file_user_rating').get().n,
                0
            );
            assert.equal(
                fileDb.prepare('SELECT COUNT(*) AS n FROM file_web_serve_batch').get().n,
                0
            );

            //  ...and once persisted, the same object's next update is an edit
            markInfected(1);
            entry.desc = 'edited';
            await persist(entry, true);
            assert.deepEqual(scanResultRows(1), ['infected']);
        });

        it('a loaded entry edited keeps its scan meta, ratings and other meta', async () => {
            addFile(1, { infected: true });
            fileDb
                .prepare(
                    "INSERT INTO file_meta (file_id, meta_name, meta_value) VALUES (1, 'archive_type', 'zip')"
                )
                .run();
            mods.FileEntry.persistUserRating(1, 42, 3, err => assert.ifError(err));

            const entry = await loadEntry(1);
            entry.desc = 'edited';
            await persist(entry, true);

            const after = await loadEntry(1);
            assert.equal(after.meta.scan_result, 'infected');
            assert.equal(after.meta.archive_type, 'zip');
            assert.equal(after.userRating, 3);
        });

        it('an update with new meta replaces the old values, not adds to them', async () => {
            addFile(1, { infected: true });

            //  a TIC replace: a fresh entry for the new file, the old file ID
            const entry = new mods.FileEntry({
                fileId: 1,
                areaTag: AREA,
                storageTag: 'vis_tag',
                fileName: 'file1.zip',
                fileSha256: 'c'.repeat(64),
                meta: { byte_size: 99, scan_result: 'clean' },
            });
            await persist(entry, true);

            const rows = name =>
                fileDb
                    .prepare(
                        'SELECT meta_value FROM file_meta WHERE file_id = 1 AND meta_name = ?'
                    )
                    .all(name)
                    .map(r => r.meta_value);
            assert.deepEqual(rows('byte_size'), ['99']);
            assert.deepEqual(rows('scan_result'), ['clean']);
            assert.deepEqual(rows('scan_signature'), [], 'no stale signature');
        });

        it('an update does not write back stale scan meta it was loaded with', async () => {
            addFile(1, { scanResult: 'clean' });
            const entry = await loadEntry(1);

            //  a rescan flags it while the entry is held (oputil fb desc, say)
            markInfected(1);

            entry.desc = 'a new description';
            await new Promise((resolve, reject) =>
                entry.persist(true, err => (err ? reject(err) : resolve()))
            );

            assert.deepEqual(scanResultRows(1), ['infected']);
            assert.deepEqual(mods.FileEntry.getInfectedFileIds([1]), new Set([1]));
        });

        it('an update with a new verdict replaces the old one, not adds to it', async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);

            //  e.g. a TIC replace carrying a fresh scanFile() verdict
            entry.meta.scan_result = 'clean';
            entry.meta.scan_signature = null;
            await new Promise((resolve, reject) =>
                entry.persist(true, err => (err ? reject(err) : resolve()))
            );

            assert.deepEqual(scanResultRows(1), ['clean']);
            assert.equal(
                fileDb
                    .prepare(
                        `SELECT COUNT(*) AS n FROM file_meta
                        WHERE file_id = 1 AND meta_name = 'scan_signature';`
                    )
                    .get().n,
                0
            );
            assert.deepEqual(
                await findFiles({ areaTag: AREA, excludeInfected: true }),
                [1]
            );
        });
    });

    describe('file_base_visibility', () => {
        it('hides infected entries from users and no one in particular', () => {
            const V = mods.Visibility;
            assert.equal(V.hidesInfected(makeClient(['users'])), true);
            assert.equal(V.hidesInfected(makeUser(['users'])), true);
            assert.equal(V.hidesInfected(null), true);
        });

        it('not from user 1, even outside the sysops group (GM[sysops]|ID1)', () => {
            assert.equal(mods.Visibility.DefaultInfectedVisibleAcs, 'GM[sysops]|ID1');
            assert.equal(config.fileBase.scanning.infectedVisibleAcs, 'GM[sysops]|ID1');
            assert.equal(mods.Visibility.hidesInfected(makeClient(['users'], 1)), false);
            assert.equal(mods.Visibility.hidesInfected(makeUser(['users'], 1)), false);
        });

        it('not from sysops (by default), whether client or User', () => {
            const V = mods.Visibility;
            assert.equal(V.hidesInfected(makeClient(['users', 'sysops'])), false);
            assert.equal(V.hidesInfected(makeUser(['users', 'sysops'])), false);
        });

        it('infectedVisibleAcs decides who sees them', () => {
            const V = mods.Visibility;
            config.fileBase.scanning.infectedVisibleAcs = 'ID1';
            assert.equal(V.hidesInfected(makeClient(['users'], 1)), false);
            assert.equal(V.hidesInfected(makeClient(['users', 'sysops'], 2)), true);
        });

        it('an ACS that does not parse shows them to no one', () => {
            config.fileBase.scanning.infectedVisibleAcs = 'GM[sysops';
            assert.equal(
                mods.Visibility.hidesInfected(makeClient(['users', 'sysops'])),
                true
            );
        });

        it('hideInfected: false shows them to everyone', async () => {
            config.fileBase.scanning.hideInfected = false;
            addFile(1);
            addFile(2, { infected: true });
            const user = makeClient(['users']);

            assert.equal(mods.Visibility.hidesInfected(user), false);
            assert.deepEqual(
                await findFiles(
                    mods.Visibility.visibleFilesFilter(user, { areaTag: AREA })
                ),
                [2, 1]
            );
            assert.equal(mods.Visibility.isFileIdHidden(user, 2), false);
        });

        it('a user lists only clean entries; a sysop lists all', async () => {
            addFile(1);
            addFile(2, { infected: true });
            const V = mods.Visibility;
            const filter = { areaTag: AREA, order: 'ascending' };

            assert.deepEqual(
                await findFiles(V.visibleFilesFilter(makeClient(['users']), filter)),
                [1]
            );
            assert.deepEqual(
                await findFiles(
                    V.visibleFilesFilter(makeClient(['users', 'sysops']), filter)
                ),
                [1, 2]
            );
            assert.equal(
                filter.excludeInfected,
                undefined,
                'the caller filter is not changed'
            );
        });

        it('an ID given as text is checked like the number; junk names nothing', () => {
            addFile(2, { infected: true });
            const user = makeClient(['users']);
            const V = mods.Visibility;
            assert.equal(V.isFileIdHidden(user, '2'), true);
            assert.equal(V.isFileIdHidden(user, ' 2 '), true);
            assert.deepEqual(V.filterHidden(user, [{ fileId: '2' }, { fileId: 3 }]), [
                { fileId: 3 },
            ]);
            for (const junk of ['2abc', -2, 2.5, NaN, null, {}, '']) {
                assert.equal(V.isFileIdHidden(user, junk), false, String(junk));
            }
            assert.deepEqual([...mods.FileEntry.getInfectedFileIds(['2', 'x', 2])], [2]);
        });

        it('a dupe of a hidden entry is still a dupe, but is not named', () => {
            addFile(1);
            addFile(2, { infected: true });
            const V = mods.Visibility;
            const dupes = () => [
                { fileId: 1, areaTag: AREA },
                { fileId: 2, areaTag: AREA },
            ];

            assert.deepEqual(
                V.maskHiddenDupes(makeClient(['users']), dupes(), 'MINE.ZIP'),
                [
                    { fileId: 1, areaTag: AREA },
                    { fileName: 'MINE.ZIP', hiddenDupe: true },
                ]
            );
            assert.deepEqual(
                V.maskHiddenDupes(makeClient(['users', 'sysops']), dupes(), 'MINE.ZIP'),
                dupes(),
                'a sysop is told which'
            );
        });

        it('filterHidden() drops hidden IDs and entries, keeps bare paths', () => {
            addFile(1);
            addFile(2, { infected: true });
            const user = makeClient(['users']);

            assert.deepEqual(mods.Visibility.filterHidden(user, [1, 2]), [1]);
            assert.deepEqual(
                mods.Visibility.filterHidden(user, [
                    { fileId: 1 },
                    { fileId: 2 },
                    { path: '/tmp/x.zip' },
                ]),
                [{ fileId: 1 }, { path: '/tmp/x.zip' }]
            );
        });

        it('mark-safe brings an entry back', done => {
            addFile(1, { infected: true });
            const user = makeClient(['users']);
            assert.equal(mods.Visibility.isFileIdHidden(user, 1), true);

            const sha = fileDb
                .prepare('SELECT file_sha256 FROM file WHERE file_id = 1')
                .get().file_sha256;
            mods.Allowlist.markEntriesSafe(sha, (err, changed) => {
                assert.ifError(err);
                assert.deepEqual(changed, [1]);
                assert.equal(mods.Visibility.isFileIdHidden(user, 1), false);
                return done();
            });
        });
    });

    describe('download queue', () => {
        it('a user cannot queue an infected entry; a sysop can', async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);

            const user = makeClient(['users']);
            user.user.downloadQueue = [];
            const userQueue = new mods.DownloadQueue(user);
            assert.equal(userQueue.canDownload(entry), false);
            assert.equal(userQueue.add(entry), false);
            assert.equal(userQueue.items.length, 0);
            assert.ok(
                user.logged.some(l => /marked infected/.test(l.msg)),
                'the refusal is logged'
            );

            const sysop = makeClient(['users', 'sysops']);
            sysop.user.downloadQueue = [];
            assert.equal(new mods.DownloadQueue(sysop).add(entry), true);
        });

        it('an entry flagged after it was queued is withheld, then removed', async () => {
            addFile(1);
            addFile(2);
            const user = makeClient(['users']);
            user.user.downloadQueue = [];
            const dlQueue = new mods.DownloadQueue(user);
            assert.equal(dlQueue.add(await loadEntry(1)), true);
            assert.equal(dlQueue.add(await loadEntry(2)), true);

            markInfected(2);

            assert.deepEqual(
                dlQueue.allowedItems.map(i => i.fileId),
                [1]
            );
            assert.equal(dlQueue.items.length, 2, 'allowedItems leaves the queue be');

            assert.deepEqual(
                dlQueue.removeHiddenItems().map(i => i.fileId),
                [2]
            );
            assert.deepEqual(
                dlQueue.items.map(i => i.fileId),
                [1]
            );
        });
    });

    describe('send queue at send time', () => {
        //  the module without its MenuModule constructor
        function makeTransfer(client, sendQueue) {
            const FileTransfer = require('../core/file_transfer.js').getModule;
            return Object.assign(Object.create(FileTransfer.prototype), {
                client,
                direction: 'send',
                sendQueue,
            });
        }

        it('does not send an entry flagged after it was queued', done => {
            addFile(1);
            addFile(2);
            markInfected(2);
            const transfer = makeTransfer(makeClient(['users']), [
                { fileId: 1, path: '/x/file1.zip' },
                { fileId: 2, path: '/x/file2.zip' },
                { path: '/x/bare.zip' },
            ]);

            transfer.withholdHiddenEntries(err => {
                assert.ifError(err);
                assert.deepEqual(
                    transfer.sendQueue.map(i => i.path),
                    ['/x/file1.zip', '/x/bare.zip']
                );
                return done();
            });
        });

        it('nothing left to send is an error', done => {
            addFile(2, { infected: true });
            const transfer = makeTransfer(makeClient(['users']), [
                { fileId: 2, path: '/x/file2.zip' },
            ]);
            transfer.withholdHiddenEntries(err => {
                assert.ok(err);
                assert.equal(transfer.sendQueue.length, 0);
                return done();
            });
        });

        it('a sysop is still sent it', done => {
            addFile(2, { infected: true });
            const transfer = makeTransfer(makeClient(['users', 'sysops']), [
                { fileId: 2, path: '/x/file2.zip' },
            ]);
            transfer.withholdHiddenEntries(err => {
                assert.ifError(err);
                assert.equal(transfer.sendQueue.length, 1);
                return done();
            });
        });
    });

    describe('FREQ by magic name or search directory', () => {
        it('does not serve a file whose entry is marked infected', async () => {
            const { FreqResolver } = require('../core/binkp/freq.js');
            addFile(1);
            addFile(2, { infected: true });
            const storage = paths.join(dir, 'vis');
            //  a search directory reached through a symbolic link
            const linked = paths.join(dir, 'linked');
            fs.symlinkSync(storage, linked);

            const resolver = new FreqResolver({
                magic: {
                    CLEAN: paths.join(storage, 'file1.zip'),
                    BAD: paths.join(storage, 'file2.zip'),
                },
                dirs: [linked],
            });
            const names = async list =>
                (await resolver.resolveNames(list)).map(r => r.name);

            assert.deepEqual(await names(['CLEAN', 'BAD']), ['file1.zip']);
            assert.deepEqual(await names(['file1.zip', 'FILE2.ZIP']), ['file1.zip']);

            config.fileBase.scanning.hideInfected = false;
            assert.deepEqual(await names(['BAD', 'file2.zip']), [
                'file2.zip',
                'file2.zip',
            ]);
            fs.unlinkSync(linked);
        });
    });

    describe('web downloads', () => {
        let web;
        let notFound;
        let served;
        let User;
        let prevGetUser;
        const users = {};

        before(() => {
            web = mods.FileAreaWeb;
            User = require('../core/user.js');
            prevGetUser = User.getUser;
            User.getUser = (userId, cb) =>
                users[userId] ? cb(null, users[userId]) : cb(new Error('no such user'));
        });

        after(() => {
            User.getUser = prevGetUser;
            delete web.webServer;
        });

        beforeEach(() => {
            notFound = 0;
            served = [];
            web.webServer = {
                instance: {
                    isEnabled: () => true,
                    fileNotFound: () => ++notFound,
                },
            };
            users[42] = makeUser(['users'], 42);
            users[1] = makeUser(['users', 'sysops'], 1);
        });

        function fakeResp() {
            const resp = new (require('stream').Writable)({
                write(chunk, enc, cb) {
                    served.push(chunk.toString());
                    cb();
                },
            });
            resp.writeHead = () => {};
            return resp;
        }

        it('no link is made for an infected entry', async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);
            const user = makeClient(['users'], 42);
            await new Promise(resolve =>
                web.createAndServeTempDownload(user, entry, {}, (err, url) => {
                    assert.ok(err);
                    assert.match(err.message, /No file is available by that ID/);
                    assert.equal(url, undefined);
                    return resolve();
                })
            );
        });

        it('a link made before the flag stops working', async () => {
            addFile(1);
            const entry = await loadEntry(1);
            const user = makeClient(['users'], 42);
            const url = await new Promise((resolve, reject) =>
                web.createAndServeTempDownload(user, entry, {}, (err, url) =>
                    err ? reject(err) : resolve(url)
                )
            );
            const hashId = paths.basename(url);

            //  it works...
            await new Promise(resolve => {
                const resp = fakeResp();
                resp.on('finish', resolve);
                web.routeWebRequest({ url: `/f/${hashId}` }, resp);
            });
            assert.deepEqual(served, ['contents of 1']);

            //  ...until a rescan flags the file
            markInfected(1);
            web.routeWebRequest({ url: `/f/${hashId}` }, fakeResp());
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(notFound, 1);
            assert.deepEqual(served, ['contents of 1']);
        });

        it("a sysop's link to an infected entry still works", async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);
            const sysop = makeClient(['users', 'sysops'], 1);
            const url = await new Promise((resolve, reject) =>
                web.createAndServeTempDownload(sysop, entry, {}, (err, url) =>
                    err ? reject(err) : resolve(url)
                )
            );

            await new Promise(resolve => {
                const resp = fakeResp();
                resp.on('finish', resolve);
                web.routeWebRequest({ url: `/f/${paths.basename(url)}` }, resp);
            });
            assert.equal(notFound, 0);
            assert.deepEqual(served, ['contents of 1']);
        });

        it('a batch leaves out entries flagged since; all flagged is not found', done => {
            addFile(1);
            addFile(2);
            markInfected(2);
            web.withholdHiddenFromLinkOwner(42, [1, 2], ids => {
                assert.deepEqual(ids, [1]);
                markInfected(1);
                web.withholdHiddenFromLinkOwner(42, [1, 2], ids => {
                    assert.deepEqual(ids, []);
                    web.withholdHiddenFromLinkOwner(1, [1, 2], ids => {
                        assert.deepEqual(ids, [1, 2], 'the sysop keeps both');
                        return done();
                    });
                });
            });
        });

        it('no batch link is made of only infected entries', async () => {
            addFile(1, { infected: true });
            const entry = await loadEntry(1);
            await new Promise(resolve =>
                web.createAndServeTempBatchDownload(
                    makeClient(['users'], 42),
                    [entry],
                    {},
                    err => {
                        assert.ok(err);
                        return resolve();
                    }
                )
            );
        });
    });

    describe('REST API', () => {
        let routes;
        let authedUserId;
        let auth;
        let prevResolve;
        let prevRequire;
        let StatLog;
        const prevStatLog = {};
        let User;
        let prevGetUser;
        const users = {};

        before(() => {
            auth = require('../core/rest/auth.js');
            prevResolve = auth.resolveAuthenticatedUser;
            auth.resolveAuthenticatedUser = (req, cb) =>
                cb(null, authedUserId ? { userId: authedUserId } : null);
            //  a download's stat bookkeeping is not under test
            StatLog = require('../core/stat_log.js');
            ['incrementUserStat', 'updateUserUlDlRatio', 'incrementSystemStat'].forEach(
                fn => {
                    prevStatLog[fn] = StatLog[fn];
                    StatLog[fn] = () => {};
                }
            );

            prevRequire = auth.requireAuth;
            auth.requireAuth = (req, resp, cb) => {
                if (!authedUserId) {
                    resp.writeHead(401);
                    return resp.end();
                }
                return cb({ userId: authedUserId });
            };

            User = require('../core/user.js');
            prevGetUser = User.getUser;
            User.getUser = (userId, cb) =>
                users[userId] ? cb(null, users[userId]) : cb(new Error('no such user'));

            //  files.js destructures auth at load: require it after the stub
            const key = require.resolve('../core/rest/routes/files.js');
            delete require.cache[key];
            routes = [];
            require('../core/rest/routes/files.js').register(
                { addRoute: r => routes.push(r) },
                { info() {}, warn() {}, error() {}, debug() {} }
            );
        });

        after(() => {
            auth.resolveAuthenticatedUser = prevResolve;
            auth.requireAuth = prevRequire;
            Object.assign(StatLog, prevStatLog);
            User.getUser = prevGetUser;
        });

        beforeEach(() => {
            authedUserId = null;
            users[42] = makeUser(['users'], 42);
            users[1] = makeUser(['users', 'sysops'], 1);
        });

        function request(method, url) {
            const route = routes.find(r => r.method === method && r.path.test(url));
            assert.ok(route, `no route for ${method} ${url}`);
            return new Promise(resolve => {
                const chunks = [];
                const resp = new (require('stream').Writable)({
                    write(chunk, enc, cb) {
                        chunks.push(chunk);
                        cb();
                    },
                });
                resp.headers = {};
                resp.setHeader = (k, v) => (resp.headers[k.toLowerCase()] = v);
                resp.getHeader = k => resp.headers[k.toLowerCase()];
                resp.writeHead = (status, headers) => {
                    resp.statusCode = status;
                    Object.assign(resp.headers, headers || {});
                };
                resp.on('finish', () =>
                    resolve({
                        status: resp.statusCode,
                        body: Buffer.concat(chunks).toString(),
                    })
                );
                route.handler({ method, url, headers: {}, complete: true }, resp);
            });
        }

        it('lists only clean entries to anonymous callers and users', async () => {
            addFile(1);
            addFile(2, { infected: true });

            for (const who of [null, 42]) {
                authedUserId = who;
                const r = await request('GET', `/_enig/api/v1/files/areas/${AREA}/files`);
                assert.equal(r.status, 200, r.body);
                assert.deepEqual(
                    JSON.parse(r.body).data.map(f => f.fileId),
                    [1],
                    `as ${who}`
                );
            }
        });

        it('lists infected entries to a sysop', async () => {
            addFile(1);
            addFile(2, { infected: true });
            authedUserId = 1;
            const r = await request('GET', `/_enig/api/v1/files/areas/${AREA}/files`);
            assert.deepEqual(
                JSON.parse(r.body).data.map(f => f.fileId),
                [1, 2]
            );
        });

        it('an infected entry by ID, or its download, is 404 to a user', async () => {
            addFile(2, { infected: true });
            authedUserId = 42;

            const meta = await request('GET', '/_enig/api/v1/files/2');
            assert.equal(meta.status, 404);
            const dl = await request('GET', '/_enig/api/v1/files/2/download');
            assert.equal(dl.status, 404);
            assert.ok(!/infected/i.test(meta.body + dl.body), 'nothing says why');
        });

        it('a sysop can fetch and download it', async () => {
            addFile(2, { infected: true });
            authedUserId = 1;

            const meta = await request('GET', '/_enig/api/v1/files/2');
            assert.equal(meta.status, 200);
            const dl = await request('GET', '/_enig/api/v1/files/2/download');
            assert.equal(dl.status, 200);
            assert.equal(dl.body, 'contents of 2');
        });
    });
});
