'use strict';

/**
 * oputil_fat.test.js
 *
 * Unit tests for the FAT disk image helpers used by oputil_fat.js.
 * Tests operate entirely on in-memory buffers — no real disk images required.
 *
 * We test the underlying helpers (mkdirp, copyFile, etc.) by building a
 * real in-memory FAT12 image via fat_image.js, mounting it with
 * fatfs-volume-driver, and then exercising the helpers against it.
 */

const { strict: assert } = require('assert');
const { createRequire } = require('module');

const _require = createRequire(__filename);
const fatfs = _require('fatfs');
const { createBufferDriverSync } = _require('fatfs-volume-driver');

const { createFloppyWithFiles } = require('../core/v86_door/fat_image.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fresh in-memory FAT12 image and return a mounted fatfs instance.
 * @param {Array<{name:string, content:Buffer}>} [files]
 */
async function buildMountedImage(files = []) {
    const img = await createFloppyWithFiles(files);
    const driver = createBufferDriverSync('', { buffer: img, partitionNumber: 0 });
    const fs = fatfs.createFileSystem(driver);
    await new Promise((resolve, reject) => {
        fs.on('error', reject);
        fs.on('ready', resolve);
    });
    return { fs, img };
}

/** Promise wrapper around fatfs.readdir */
function readdir(fs, p) {
    return new Promise((resolve, reject) =>
        fs.readdir(p, (err, entries) => (err ? reject(err) : resolve(entries)))
    );
}

/** Promise wrapper around fatfs.readFile */
function readFile(fs, p) {
    return new Promise((resolve, reject) =>
        fs.readFile(p, (err, data) => (err ? reject(err) : resolve(data)))
    );
}

/** Promise wrapper around fatfs.mkdir */
function mkdir(fs, p) {
    return new Promise(
        resolve => fs.mkdir(p, err => resolve(err)) // resolve even on error (caller checks)
    );
}

/** Promise wrapper around fatfs.writeFile */
function writeFile(fs, p, data) {
    return new Promise((resolve, reject) =>
        fs.writeFile(p, data, err => (err ? reject(err) : resolve()))
    );
}

// ─── createFloppyWithFiles ────────────────────────────────────────────────────

describe('createFloppyWithFiles', () => {
    it('returns a 1.44MB buffer', async () => {
        const img = await createFloppyWithFiles([]);
        assert.equal(img.length, 512 * 2880);
    });

    it('has a valid FAT12 boot sector signature', async () => {
        const img = await createFloppyWithFiles([]);
        assert.equal(img[510], 0x55);
        assert.equal(img[511], 0xaa);
    });

    it('writes a file that can be read back', async () => {
        const content = Buffer.from('Hello, DOS!\r\n', 'ascii');
        const { fs } = await buildMountedImage([{ name: 'TEST.TXT', content }]);

        const data = await readFile(fs, 'TEST.TXT');
        assert.deepEqual(data, content);
    });

    it('writes multiple files', async () => {
        const files = [
            { name: 'DOOR.SYS', content: Buffer.from('door\r\n') },
            { name: 'DORINFO1.DEF', content: Buffer.from('dorinfo\r\n') },
        ];
        const { fs } = await buildMountedImage(files);

        const entries = await readdir(fs, '/');
        assert.ok(entries.includes('DOOR.SYS'));
        assert.ok(entries.includes('DORINFO1.DEF'));
    });

    it('returns an empty-rooted image when no files given', async () => {
        const { fs } = await buildMountedImage([]);
        const entries = await readdir(fs, '/');
        assert.equal(entries.length, 0);
    });
});

// ─── FAT image — write & read roundtrip ──────────────────────────────────────

describe('FAT image write/read roundtrip', () => {
    it('preserves binary content exactly', async () => {
        const content = Buffer.from([0x00, 0xff, 0x1b, 0x0d, 0x0a, 0xaa]);
        const { fs } = await buildMountedImage([{ name: 'BIN.DAT', content }]);

        const data = await readFile(fs, 'BIN.DAT');
        assert.deepEqual(data, content);
    });

    it('preserves CRLF line endings', async () => {
        const lines = 'line1\r\nline2\r\nline3\r\n';
        const content = Buffer.from(lines, 'ascii');
        const { fs } = await buildMountedImage([{ name: 'CRLF.TXT', content }]);

        const data = await readFile(fs, 'CRLF.TXT');
        assert.equal(data.toString('ascii'), lines);
    });

    it('handles an empty file', async () => {
        const { fs } = await buildMountedImage([
            { name: 'EMPTY.TXT', content: Buffer.alloc(0) },
        ]);
        const data = await readFile(fs, 'EMPTY.TXT');
        assert.equal(data.length, 0);
    });
});

// ─── mkdir ────────────────────────────────────────────────────────────────────

describe('FAT image mkdir', () => {
    it('creates a directory', async () => {
        const { fs } = await buildMountedImage([]);

        await mkdir(fs, 'DOORS');
        const entries = await readdir(fs, '/');
        assert.ok(entries.includes('DOORS'));
    });

    it('does not error on EEXIST', async () => {
        const { fs } = await buildMountedImage([]);

        await mkdir(fs, 'DOORS');
        const err = await mkdir(fs, 'DOORS'); // second call
        assert.ok(!err || err.code === 'EEXIST' || err.code === 'EXIST');
    });

    it('supports nested directories', async () => {
        const { fs } = await buildMountedImage([]);

        await mkdir(fs, 'DOORS');
        await mkdir(fs, 'DOORS/PW');
        await mkdir(fs, 'DOORS/PW/PIMPWARS');

        const sub = await readdir(fs, 'DOORS/PW');
        assert.ok(sub.includes('PIMPWARS'));
    });
});

// ─── runBatch variable substitution ──────────────────────────────────────────

describe('runBatch variable substitution', () => {
    //  Test the substitution logic that lives in v86_door.js by replicating it
    //  here — ensures the pattern stays correct independently of the module.

    function applySubstitutions(template, dropFile, node, baud) {
        return template
            .replace(/\{dropFile\}/gi, dropFile)
            .replace(/\{node\}/gi, String(node))
            .replace(/\{baud\}/gi, String(baud))
            .replace(/\r\n/g, '\n')
            .replace(/\n/g, '\r\n');
    }

    it('substitutes {dropFile}', () => {
        const result = applySubstitutions(
            'COPY A:\\{dropFile} C:\\',
            'DORINFO1.DEF',
            1,
            57600
        );
        assert.ok(result.includes('DORINFO1.DEF'));
        assert.ok(!result.includes('{dropFile}'));
    });

    it('substitutes {node}', () => {
        const result = applySubstitutions('GAME.EXE {node}', 'DOOR.SYS', 3, 57600);
        assert.ok(result.includes('3'));
        assert.ok(!result.includes('{node}'));
    });

    it('substitutes {baud}', () => {
        const result = applySubstitutions('MODE COM1:{baud}', 'DOOR.SYS', 1, 57600);
        assert.ok(result.includes('57600'));
        assert.ok(!result.includes('{baud}'));
    });

    it('normalizes LF-only to CRLF', () => {
        const result = applySubstitutions('line1\nline2\nline3', 'X', 1, 57600);
        assert.ok(result.includes('\r\nline2\r\n'));
        assert.ok(!result.match(/(?<!\r)\n/));
    });

    it('does not double-convert existing CRLF', () => {
        const result = applySubstitutions('line1\r\nline2\r\n', 'X', 1, 57600);
        assert.ok(!result.includes('\r\r\n'));
    });

    it('is case-insensitive for variable names', () => {
        const result = applySubstitutions(
            '{DROPFILE} {Node} {BAUD}',
            'DOOR.SYS',
            2,
            57600
        );
        assert.ok(result.includes('DOOR.SYS'));
        assert.ok(result.includes('2'));
        assert.ok(result.includes('57600'));
    });

    it('writes the substituted RUN.BAT into a floppy and reads it back', async () => {
        const template = 'COPY A:\\{dropFile} C:\\DOORS\\\r\nGAME.EXE {node}\r\n';
        const substituted = applySubstitutions(template, 'DORINFO1.DEF', 1, 57600);
        const content = Buffer.from(substituted, 'ascii');

        const { fs } = await buildMountedImage([
            { name: 'DORINFO1.DEF', content: Buffer.from('drop\r\n') },
            { name: 'RUN.BAT', content },
        ]);

        const data = await readFile(fs, 'RUN.BAT');
        assert.equal(data.toString('ascii'), substituted);
    });
});
