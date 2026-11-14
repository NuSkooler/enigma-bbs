'use strict';

//
//  Storing a TIC payload: import, hatch and passthrough all go through
//  tic_store.storePayload(), and all rely on one rule -- an existing file is
//  overwritten only when it is the file being superseded.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const ticStore = require('../core/tic_store.js');
const TicFileInfo = require('../core/tic_file_info.js');

function store(src, dst, opts) {
    return new Promise(resolve =>
        ticStore.storePayload(src, dst, opts, (err, finalPath) =>
            resolve({ err, finalPath })
        )
    );
}

describe('TIC payload storage', () => {
    let dir;
    let src;

    beforeEach(() => {
        dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_ticstore_'));
        src = paths.join(dir, 'incoming.bin');
        fs.writeFileSync(src, 'new bytes');
        fs.mkdirSync(paths.join(dir, 'area'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const inArea = name => paths.join(dir, 'area', name);
    const read = p => fs.readFileSync(p, 'utf8');

    it('stores a new file under its own name', async () => {
        const { err, finalPath } = await store(src, inArea('BAR.ZIP'), {});
        assert.ifError(err);
        assert.equal(finalPath, inArea('BAR.ZIP'));
        assert.equal(read(finalPath), 'new bytes');
    });

    it('overwrites the superseded file when the payload has the same name', async () => {
        fs.writeFileSync(inArea('NODELIST.Z21'), 'old bytes');

        const { err, finalPath } = await store(src, inArea('NODELIST.Z21'), {
            supersedes: inArea('NODELIST.Z21'),
        });
        assert.ifError(err);
        assert.equal(finalPath, inArea('NODELIST.Z21'));
        assert.equal(read(finalPath), 'new bytes');
        assert.deepEqual(fs.readdirSync(paths.join(dir, 'area')), ['NODELIST.Z21']);
    });

    it('keeps an existing file of the same name when a different file is superseded', async () => {
        fs.writeFileSync(inArea('FOO.ZIP'), 'superseded bytes');
        fs.writeFileSync(inArea('BAR.ZIP'), 'another entry');

        const { err, finalPath } = await store(src, inArea('BAR.ZIP'), {
            supersedes: inArea('FOO.ZIP'),
        });
        assert.ifError(err);

        assert.equal(read(inArea('BAR.ZIP')), 'another entry');
        assert.notEqual(finalPath, inArea('BAR.ZIP'));
        assert.equal(paths.dirname(finalPath), paths.join(dir, 'area'));
        assert.equal(read(finalPath), 'new bytes');
    });

    it('refuses an exact-name store onto a taken name, leaving nothing behind', async () => {
        fs.writeFileSync(inArea('BAR.ZIP'), 'another entry');

        const { err } = await store(src, inArea('BAR.ZIP'), { exactName: true });
        assert.ok(err);
        assert.equal(err.reasonCode, ticStore.ReasonCodes.NameTaken);
        assert.equal(read(inArea('BAR.ZIP')), 'another entry');
        assert.deepEqual(fs.readdirSync(paths.join(dir, 'area')), ['BAR.ZIP']);
    });

    it('lets an exact-name store supersede the file it names', async () => {
        fs.writeFileSync(inArea('BAR.ZIP'), 'old bytes');

        const { err, finalPath } = await store(src, inArea('BAR.ZIP'), {
            exactName: true,
            supersedes: paths.join(dir, 'area', '.', 'BAR.ZIP'),
        });
        assert.ifError(err);
        assert.equal(finalPath, inArea('BAR.ZIP'));
        assert.equal(read(finalPath), 'new bytes');
    });

    describe('the import path', () => {
        let inst;

        before(() => {
            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            inst = new getModule();
        });

        const copy = (dst, supersedes) =>
            new Promise(resolve =>
                inst.copyTicAttachment(src, dst, supersedes, (err, finalPath) =>
                    resolve({ err, finalPath })
                )
            );

        it('a Replaces match on another name leaves an unrelated file of the payload name alone', async () => {
            fs.writeFileSync(inArea('FOO.ZIP'), 'superseded bytes');
            fs.writeFileSync(inArea('BAR.ZIP'), 'another entry');

            const { err, finalPath } = await copy(inArea('BAR.ZIP'), inArea('FOO.ZIP'));
            assert.ifError(err);
            assert.equal(read(inArea('BAR.ZIP')), 'another entry');
            assert.notEqual(finalPath, inArea('BAR.ZIP'));
            assert.equal(read(finalPath), 'new bytes');
        });

        it('a Replaces match on the same name updates it in place', async () => {
            fs.writeFileSync(inArea('NODELIST.Z21'), 'old bytes');

            const { err, finalPath } = await copy(
                inArea('NODELIST.Z21'),
                inArea('NODELIST.Z21')
            );
            assert.ifError(err);
            assert.equal(finalPath, inArea('NODELIST.Z21'));
            assert.equal(read(finalPath), 'new bytes');
        });
    });
});

describe('TIC names that become path components', () => {
    it('accepts a plain name', () => {
        assert.ok(TicFileInfo.isSafeFileName('NODELIST.Z21'));
        assert.ok(TicFileInfo.isSafeFileName('fsxnet-infopack.zip'));
    });

    for (const name of ['.', '..', 'a/b', 'a\\b', '/abs', '../x', 'x\u0000y', '']) {
        it(`refuses ${JSON.stringify(name)}`, () => {
            assert.ok(!TicFileInfo.isSafeFileName(name));
        });
    }
});
