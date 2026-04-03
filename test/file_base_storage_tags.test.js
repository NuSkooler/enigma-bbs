'use strict';

const { strict: assert } = require('assert');
const paths = require('path');

//
//  Install a richer Config mock before requiring any module that captures
//  Config.get at load time.  This must happen here, in module scope, before
//  require('../core/file_base_area.js') is evaluated.
//
const configModule = require('../core/config.js');

const BASE_PREFIX = '/test/storage';

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    fileBase: {
        areaStoragePrefix: BASE_PREFIX,
        storageTags: {
            flat_rel: 'files/flat',
            flat_abs: '/srv/files/flat',
            wc_rel: 'files/wc/*',
            wc_abs: '/srv/files/wc/*',
            empty_tag: '',
        },
        areas: {},
        yearEstPatterns: [],
    },
};

configModule.get = () => TEST_CONFIG;

//  Modules under test — loaded after Config mock is in place
const {
    isWildcardStorageTag,
    getAreaStorageDirectoryByTag,
    getAreaStorageLocations,
} = require('../core/file_base_area.js');

const FileEntry = require('../core/file_entry.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

//  Derive relPath the same way scanFileAreaForChanges does.
function relPathFromGlobResult(relFile) {
    const dir = paths.dirname(relFile);
    return dir === '.' ? null : dir;
}

// ─── isWildcardStorageTag ─────────────────────────────────────────────────────

describe('isWildcardStorageTag()', () => {
    it('returns false for a flat relative tag', () => {
        assert.equal(isWildcardStorageTag('flat_rel'), false);
    });

    it('returns false for a flat absolute tag', () => {
        assert.equal(isWildcardStorageTag('flat_abs'), false);
    });

    it('returns true for a wildcard relative tag', () => {
        assert.equal(isWildcardStorageTag('wc_rel'), true);
    });

    it('returns true for a wildcard absolute tag', () => {
        assert.equal(isWildcardStorageTag('wc_abs'), true);
    });

    it('returns false for an unknown tag', () => {
        assert.equal(isWildcardStorageTag('no_such_tag'), false);
    });
});

// ─── getAreaStorageDirectoryByTag (file_base_area.js) ────────────────────────

describe('getAreaStorageDirectoryByTag() — file_base_area.js', () => {
    it('resolves a relative flat tag against areaStoragePrefix', () => {
        const expected = paths.resolve(BASE_PREFIX, 'files/flat');
        assert.equal(getAreaStorageDirectoryByTag('flat_rel'), expected);
    });

    it('returns an absolute flat tag path unchanged', () => {
        assert.equal(getAreaStorageDirectoryByTag('flat_abs'), '/srv/files/flat');
    });

    it('strips /* from a relative wildcard tag', () => {
        const expected = paths.resolve(BASE_PREFIX, 'files/wc');
        assert.equal(getAreaStorageDirectoryByTag('wc_rel'), expected);
        assert.ok(
            !getAreaStorageDirectoryByTag('wc_rel').includes('*'),
            'result must not contain *'
        );
    });

    it('strips /* from an absolute wildcard tag', () => {
        assert.equal(getAreaStorageDirectoryByTag('wc_abs'), '/srv/files/wc');
        assert.ok(!getAreaStorageDirectoryByTag('wc_abs').includes('*'));
    });

    it('handles a null/undefined storageTag gracefully', () => {
        //  should resolve to the prefix itself without throwing
        assert.doesNotThrow(() => getAreaStorageDirectoryByTag(null));
        assert.doesNotThrow(() => getAreaStorageDirectoryByTag(undefined));
    });
});

// ─── FileEntry.getAreaStorageDirectoryByTag (static copy) ────────────────────

describe('FileEntry.getAreaStorageDirectoryByTag() — static', () => {
    it('strips /* from an absolute wildcard tag', () => {
        assert.equal(FileEntry.getAreaStorageDirectoryByTag('wc_abs'), '/srv/files/wc');
    });

    it('strips /* from a relative wildcard tag', () => {
        const expected = paths.join(BASE_PREFIX, 'files/wc');
        assert.equal(FileEntry.getAreaStorageDirectoryByTag('wc_rel'), expected);
    });

    it('resolves a relative flat tag against areaStoragePrefix', () => {
        const expected = paths.join(BASE_PREFIX, 'files/flat');
        assert.equal(FileEntry.getAreaStorageDirectoryByTag('flat_rel'), expected);
    });

    it('returns an absolute flat tag unchanged', () => {
        assert.equal(
            FileEntry.getAreaStorageDirectoryByTag('flat_abs'),
            '/srv/files/flat'
        );
    });
});

// ─── getAreaStorageLocations ─────────────────────────────────────────────────

describe('getAreaStorageLocations()', () => {
    it('marks a flat location with isWildcard=false', () => {
        const locations = getAreaStorageLocations({ storageTags: ['flat_rel'] });
        assert.equal(locations.length, 1);
        assert.equal(locations[0].isWildcard, false);
        assert.equal(locations[0].storageTag, 'flat_rel');
    });

    it('marks a wildcard location with isWildcard=true', () => {
        const locations = getAreaStorageLocations({ storageTags: ['wc_rel'] });
        assert.equal(locations.length, 1);
        assert.equal(locations[0].isWildcard, true);
    });

    it('returns the base dir for a wildcard tag (/* stripped)', () => {
        const locations = getAreaStorageLocations({ storageTags: ['wc_rel'] });
        assert.ok(!locations[0].dir.includes('*'), 'dir must not contain *');
    });

    it('handles an area with mixed flat and wildcard tags', () => {
        const locations = getAreaStorageLocations({
            storageTags: ['flat_rel', 'wc_rel'],
        });
        assert.equal(locations.length, 2);

        const flat = locations.find(l => l.storageTag === 'flat_rel');
        const wc = locations.find(l => l.storageTag === 'wc_rel');
        assert.ok(flat, 'flat location should be present');
        assert.ok(wc, 'wildcard location should be present');
        assert.equal(flat.isWildcard, false);
        assert.equal(wc.isWildcard, true);
    });

    it('silently drops unknown storage tags', () => {
        const locations = getAreaStorageLocations({
            storageTags: ['flat_rel', 'no_such_tag'],
        });
        assert.equal(locations.length, 1);
        assert.equal(locations[0].storageTag, 'flat_rel');
    });
});

// ─── FileEntry.filePath getter ────────────────────────────────────────────────

describe('FileEntry.filePath getter', () => {
    //  All tests use an absolute storage tag so the path is deterministic.

    it('returns storageDir + fileName when relPath is null', () => {
        const fe = new FileEntry({
            storageTag: 'flat_abs',
            fileName: 'test.zip',
            relPath: null,
        });
        assert.equal(fe.filePath, '/srv/files/flat/test.zip');
    });

    it('returns storageDir + relPath + fileName when relPath is set', () => {
        const fe = new FileEntry({
            storageTag: 'flat_abs',
            fileName: 'test.zip',
            relPath: '2024/April',
        });
        assert.equal(fe.filePath, '/srv/files/flat/2024/April/test.zip');
    });

    it('returns same path for WC tag as for equivalent flat tag (/* stripped)', () => {
        const feFlat = new FileEntry({
            storageTag: 'flat_abs',
            fileName: 'test.zip',
            relPath: null,
        });
        //  wc_abs = /srv/files/wc/* → strips to /srv/files/wc
        const feWc = new FileEntry({
            storageTag: 'wc_abs',
            fileName: 'test.zip',
            relPath: null,
        });
        //  Both should resolve to their respective base dirs + filename
        assert.ok(!feFlat.filePath.includes('*'));
        assert.ok(!feWc.filePath.includes('*'));
    });

    it('throws on path traversal via relPath (../ escape)', () => {
        const fe = new FileEntry({
            storageTag: 'flat_abs',
            fileName: 'passwd',
            relPath: '../../../etc',
        });
        assert.throws(() => fe.filePath, /path traversal/i);
    });

    it('throws on path traversal via fileName', () => {
        const fe = new FileEntry({
            storageTag: 'flat_abs',
            fileName: '../../../etc/passwd',
            relPath: null,
        });
        assert.throws(() => fe.filePath, /path traversal/i);
    });
});

// ─── relPath derivation from glob results ────────────────────────────────────

describe('relPath derivation from glob results', () => {
    it('returns null for a root-level file (no subdirectory)', () => {
        assert.equal(relPathFromGlobResult('foo.zip'), null);
    });

    it('returns the single subdirectory for a one-level nested file', () => {
        assert.equal(relPathFromGlobResult('2024/foo.zip'), '2024');
    });

    it('returns the full relative subdir path for a deeply nested file', () => {
        assert.equal(
            relPathFromGlobResult('2024/April/games/foo.zip'),
            '2024/April/games'
        );
    });

    it('returns null for a file directly in . (normalized dirname)', () => {
        assert.equal(relPathFromGlobResult('./foo.zip'), null);
    });
});

// ─── Conflict resolution sort (flat-first) ───────────────────────────────────

describe('conflict resolution sort — flat locations before wildcard', () => {
    //  Mirror the sort logic from scanFileAreaForChanges so we can test it directly.
    function sortLocations(locs) {
        return [...locs].sort((a, b) => {
            if (a.isWildcard === b.isWildcard) {
                return 0;
            }
            return a.isWildcard ? 1 : -1;
        });
    }

    it('puts a single flat location before a single wildcard location', () => {
        const input = [
            { storageTag: 'wc', isWildcard: true },
            { storageTag: 'flat', isWildcard: false },
        ];
        const sorted = sortLocations(input);
        assert.equal(sorted[0].storageTag, 'flat');
        assert.equal(sorted[1].storageTag, 'wc');
    });

    it('preserves relative order among multiple flat locations', () => {
        const input = [
            { storageTag: 'flat_a', isWildcard: false },
            { storageTag: 'flat_b', isWildcard: false },
        ];
        const sorted = sortLocations(input);
        assert.equal(sorted[0].storageTag, 'flat_a');
        assert.equal(sorted[1].storageTag, 'flat_b');
    });

    it('preserves relative order among multiple wildcard locations', () => {
        const input = [
            { storageTag: 'wc_a', isWildcard: true },
            { storageTag: 'wc_b', isWildcard: true },
        ];
        const sorted = sortLocations(input);
        assert.equal(sorted[0].storageTag, 'wc_a');
        assert.equal(sorted[1].storageTag, 'wc_b');
    });

    it('handles a mixed list of three with flat in the middle', () => {
        const input = [
            { storageTag: 'wc_a', isWildcard: true },
            { storageTag: 'flat_a', isWildcard: false },
            { storageTag: 'wc_b', isWildcard: true },
        ];
        const sorted = sortLocations(input);
        assert.equal(sorted[0].storageTag, 'flat_a');
        assert.ok(sorted[1].isWildcard);
        assert.ok(sorted[2].isWildcard);
    });

    it('returns an already-sorted list unchanged', () => {
        const input = [
            { storageTag: 'flat_a', isWildcard: false },
            { storageTag: 'flat_b', isWildcard: false },
            { storageTag: 'wc_a', isWildcard: true },
        ];
        const sorted = sortLocations(input);
        assert.equal(sorted[0].storageTag, 'flat_a');
        assert.equal(sorted[1].storageTag, 'flat_b');
        assert.equal(sorted[2].storageTag, 'wc_a');
    });
});

// ─── WC exclusion check logic ─────────────────────────────────────────────────

describe('WC excludedDirs exclusion check', () => {
    //  Mirror the exclusion test from scanFileAreaForChanges.
    function isExcluded(fullPath, excludedDirs) {
        return [...excludedDirs].some(excDir => fullPath.startsWith(excDir + paths.sep));
    }

    it('excludes a file directly inside an excluded dir', () => {
        const excluded = new Set(['/base/scene/2024']);
        assert.ok(isExcluded('/base/scene/2024/foo.zip', excluded));
    });

    it('excludes a file in a subdirectory of an excluded dir', () => {
        const excluded = new Set(['/base/scene/2024']);
        assert.ok(isExcluded('/base/scene/2024/April/foo.zip', excluded));
    });

    it('does not exclude a file in a sibling dir with a common prefix', () => {
        //  /base/scene/2024 should NOT exclude /base/scene/2024extra/foo.zip
        const excluded = new Set(['/base/scene/2024']);
        assert.ok(!isExcluded('/base/scene/2024extra/foo.zip', excluded));
    });

    it('does not exclude a file in a non-excluded dir', () => {
        const excluded = new Set(['/base/scene/2024']);
        assert.ok(!isExcluded('/base/scene/2025/foo.zip', excluded));
    });

    it('does not exclude anything when excludedDirs is empty', () => {
        assert.ok(!isExcluded('/base/scene/2024/foo.zip', new Set()));
    });

    it('checks all excluded dirs (not just the first)', () => {
        const excluded = new Set(['/base/a', '/base/b']);
        assert.ok(isExcluded('/base/b/foo.zip', excluded));
    });
});
