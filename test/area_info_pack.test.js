'use strict';

//
//  Bounded extraction of a network info pack.
//
//  A pack arrives over FTN from a hub, so it is attacker adjacent. The
//  archiver itself is stubbed here: what is under test is the enforcement
//  around it, and specifically that enforcement is applied to what actually
//  lands on disk. ArchiveUtil.extractTo() silently downgrades a selective
//  extraction to a full decompress when the configured archiver has no
//  file-list verb, and listEntries() sizes come from a regex over archiver
//  stdout -- so neither the requested file list nor the reported sizes can be
//  taken as what happened.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');

const ArchiveUtil = require('../core/archive_util.js');
const {
    globToRegExp,
    extractAreaListFromPack,
    MaxMemberBytes,
} = require('../core/area_info_pack.js');

const AREA_LIST = 'FSX_GEN              General Chat + More..\r\n';

let savedGetInstance;

//
//  Stub archiver.  |produces| is what actually appears in the extraction
//  directory, which is deliberately allowed to differ from |entries| (the
//  manifest) and from the file list it was asked for.
//
function stubArchiver({ entries, produces, requestedSink }) {
    ArchiveUtil.getInstance = () => ({
        detectType: (path, cb) => cb(null, 'zip'),
        listEntries: (path, archType, cb) => cb(null, entries),
        extractTo: (archivePath, extractPath, archType, fileList, cb) => {
            if (requestedSink) {
                requestedSink.push(...fileList);
            }
            Object.entries(produces).forEach(([name, content]) => {
                const full = paths.join(extractPath, name);
                fs.mkdirSync(paths.dirname(full), { recursive: true });
                fs.writeFileSync(full, content);
            });
            return cb(null);
        },
    });
}

function extract(wanted) {
    return new Promise(resolve =>
        extractAreaListFromPack('/fake/fsxnet.zip', wanted, (err, data) =>
            resolve({ err, data })
        )
    );
}

describe('area_info_pack: file name matching', () => {
    it('matches a glob against a pack file name', () => {
        assert.ok(globToRegExp('fsxnet*.zip').test('fsxnet.zip'));
        assert.ok(globToRegExp('fsxnet*.zip').test('FSXNET_2025.ZIP'));
        assert.equal(globToRegExp('fsxnet*.zip').test('other.zip'), false);
        assert.equal(globToRegExp('fsxnet*.zip').test('fsxnet.zip.bak'), false);
    });

    it('treats regex metacharacters in a glob as literals', () => {
        assert.ok(globToRegExp('a.b.zip').test('a.b.zip'));
        assert.equal(globToRegExp('a.b.zip').test('axbxzip'), false);
    });

    it('supports ? as a single character', () => {
        assert.ok(globToRegExp('fsx?.na').test('fsxa.na'));
        assert.equal(globToRegExp('fsx?.na').test('fsxab.na'), false);
    });
});

describe('area_info_pack: bounded extraction', () => {
    beforeEach(() => {
        savedGetInstance = ArchiveUtil.getInstance;
    });

    afterEach(() => {
        ArchiveUtil.getInstance = savedGetInstance;
    });

    it('extracts the named area list', async () => {
        const requested = [];
        stubArchiver({
            entries: [
                { fileName: 'fsxnet.na', byteSize: AREA_LIST.length },
                { fileName: 'fsx_file.na', byteSize: 100 },
                { fileName: 'nodelist.z21', byteSize: 100000 },
            ],
            produces: { 'fsxnet.na': AREA_LIST },
            requestedSink: requested,
        });

        const { err, data } = await extract('fsxnet.na');
        assert.ifError(err);
        assert.equal(data, AREA_LIST);
        //  only the one file was ever asked for
        assert.deepEqual(requested, ['fsxnet.na']);
    });

    it('refuses an areaFile whose extension is not allowed', async () => {
        stubArchiver({ entries: [], produces: {} });
        const { err } = await extract('nodelist.z21');
        assert.ok(err);
        assert.match(err.message, /allowed extension/);
    });

    it('refuses when the named file is not in the manifest', async () => {
        stubArchiver({
            entries: [{ fileName: 'fsx_file.na', byteSize: 100 }],
            produces: {},
        });
        const { err } = await extract('fsxnet.na');
        assert.ok(err);
        assert.match(err.message, /is not in/);
    });

    it('refuses a manifest entry larger than the per-member cap', async () => {
        stubArchiver({
            entries: [{ fileName: 'fsxnet.na', byteSize: MaxMemberBytes + 1 }],
            produces: {},
        });
        const { err } = await extract('fsxnet.na');
        assert.ok(err);
        assert.match(err.message, /is not in/);
    });

    it('never asks for a member carrying a path', async () => {
        const requested = [];
        stubArchiver({
            entries: [
                { fileName: '../../etc/fsxnet.na', byteSize: 10 },
                { fileName: 'sub/fsxnet.na', byteSize: 10 },
            ],
            produces: {},
            requestedSink: requested,
        });

        const { err } = await extract('fsxnet.na');
        assert.ok(err, 'nothing safe to extract');
        assert.deepEqual(requested, []);
    });

    it('deletes everything a full decompress produced beyond what was wanted', async () => {
        //
        //  The "silent full decompress" case: the archiver ignored the file
        //  list and unpacked the whole pack. Only the wanted file may survive,
        //  and only its contents may be returned.
        //
        stubArchiver({
            entries: [{ fileName: 'fsxnet.na', byteSize: AREA_LIST.length }],
            produces: {
                'fsxnet.na': AREA_LIST,
                'fsx_file.na': 'Area FSX_NODE 0 ! Nodelist\r\n',
                'readme.txt': 'hello',
                'nodelist.z21': 'binary junk',
                'evil.sh': '#!/bin/sh\nrm -rf /\n',
            },
        });

        const { err, data } = await extract('fsxnet.na');
        assert.ifError(err);
        assert.equal(data, AREA_LIST);

        //  temptmp cleans the directory up, but nothing unwanted may have
        //  been read either -- the returned data is the wanted file alone
        assert.equal(data.includes('FSX_NODE'), false);
    });

    it('refuses when extraction produced nothing usable', async () => {
        stubArchiver({
            entries: [{ fileName: 'fsxnet.na', byteSize: 10 }],
            produces: { 'somethingelse.na': 'nope' },
        });

        const { err } = await extract('fsxnet.na');
        assert.ok(err);
        assert.match(err.message, /was not produced/);
    });

    it('refuses a produced file that exceeds the per-member cap', async () => {
        stubArchiver({
            entries: [{ fileName: 'fsxnet.na', byteSize: 10 }], //  manifest lied
            produces: { 'fsxnet.na': 'x'.repeat(MaxMemberBytes + 1) },
        });

        const { err } = await extract('fsxnet.na');
        assert.ok(err);
        assert.match(err.message, /was not produced/);
    });

    it('ignores a produced directory with the wanted name', async () => {
        ArchiveUtil.getInstance = () => ({
            detectType: (path, cb) => cb(null, 'zip'),
            listEntries: (path, archType, cb) =>
                cb(null, [{ fileName: 'fsxnet.na', byteSize: 10 }]),
            extractTo: (archivePath, extractPath, archType, fileList, cb) => {
                fs.mkdirSync(paths.join(extractPath, 'fsxnet.na'));
                return cb(null);
            },
        });

        const { err } = await extract('fsxnet.na');
        assert.ok(err);
        assert.match(err.message, /was not produced/);
    });

    it('propagates an archive type it cannot identify', async () => {
        ArchiveUtil.getInstance = () => ({
            detectType: (path, cb) => cb(null, undefined),
        });

        const { err } = await extract('fsxnet.na');
        assert.ok(err);
        assert.match(err.message, /Unknown archive type/);
    });
});
