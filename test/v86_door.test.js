'use strict';

const { strict: assert } = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// v86_door has load-time requires for MenuModule, theme, ansi etc. that all
// eventually reach Config().  setup.js stubs Config.get before any test file
// loads, so we can require v86_door safely here.
const { _test } = require('../core/v86_door/v86_door.js');
const { imageRegistry, getOrCreateSab, flushSabToDisk } = _test;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempImage(size = 512) {
    const p = path.join(os.tmpdir(), `v86_test_${process.pid}_${Date.now()}.img`);
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = i & 0xff;
    fs.writeFileSync(p, buf);
    return p;
}

// Clean up registry entries added by each test suite
function clearRegistry(imagePath) {
    imageRegistry.delete(imagePath);
}

// ─── SAB registry ─────────────────────────────────────────────────────────────

describe('v86_door SAB registry', () => {
    let tmpPath;

    beforeEach(() => {
        tmpPath = makeTempImage(256);
    });

    afterEach(() => {
        clearRegistry(tmpPath);
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    });

    it('getOrCreateSab returns a SharedArrayBuffer', () => {
        const sab = getOrCreateSab(tmpPath);
        assert.ok(sab instanceof SharedArrayBuffer);
    });

    it('SAB contains the original file contents', () => {
        const original = fs.readFileSync(tmpPath);
        const sab = getOrCreateSab(tmpPath);
        const view = new Uint8Array(sab);
        for (let i = 0; i < original.byteLength; i++) {
            assert.equal(view[i], original[i], `byte ${i} mismatch`);
        }
    });

    it('getOrCreateSab returns the same SAB instance for the same path', () => {
        const sab1 = getOrCreateSab(tmpPath);
        const sab2 = getOrCreateSab(tmpPath);
        assert.equal(sab1, sab2, 'should be the same SharedArrayBuffer reference');
    });

    it('mutations to SAB are visible across references', () => {
        const sab = getOrCreateSab(tmpPath);
        const view = new Uint8Array(sab);
        view[0] = 0xde;
        view[1] = 0xad;
        const sab2 = getOrCreateSab(tmpPath);
        const view2 = new Uint8Array(sab2);
        assert.equal(view2[0], 0xde);
        assert.equal(view2[1], 0xad);
    });
});

// ─── SAB flush ────────────────────────────────────────────────────────────────

describe('v86_door flushSabToDisk', () => {
    let tmpPath;

    beforeEach(() => {
        tmpPath = makeTempImage(256);
    });

    afterEach(() => {
        clearRegistry(tmpPath);
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    });

    it('writes SAB contents back to disk', async () => {
        const sab = getOrCreateSab(tmpPath);
        const view = new Uint8Array(sab);
        view[0] = 0xca;
        view[1] = 0xfe;

        flushSabToDisk(tmpPath);
        // wait for the flush promise to resolve
        await imageRegistry.get(tmpPath).flushQueue;

        const written = fs.readFileSync(tmpPath);
        assert.equal(written[0], 0xca);
        assert.equal(written[1], 0xfe);
    });

    it('serializes concurrent flushes — last flush wins at byte level', async () => {
        const sab = getOrCreateSab(tmpPath);

        const view = new Uint8Array(sab);
        view[0] = 0x01;
        flushSabToDisk(tmpPath);

        view[0] = 0x02;
        flushSabToDisk(tmpPath);

        await imageRegistry.get(tmpPath).flushQueue;

        const written = fs.readFileSync(tmpPath);
        assert.equal(written[0], 0x02, 'last enqueued flush should win');
    });

    it('is a no-op when the image path is not in the registry', () => {
        assert.doesNotThrow(() => flushSabToDisk('/nonexistent/path.img'));
    });
});

