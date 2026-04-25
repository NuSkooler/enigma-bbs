'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — must be in place before requiring any module that captures
//  Config.get at load time.  Use the same storageTags as
//  file_base_storage_tags.test.js so that both test files can share the
//  cached FileEntry module without conflict.
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

//
//  In-memory DB injection — must happen before requiring file_entry.js, which
//  captures `fileDb = require('./database.js').dbs.file` at load time.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
_testDb.pragma('foreign_keys = ON');
dbModule.dbs.file = _testDb;

//  Modules under test — loaded after both Config mock and DB are in place.
const FileEntry = require('../core/file_entry.js');

// ─── schema ──────────────────────────────────────────────────────────────────

//  Minimal file-DB schema that mirrors database.js, executed once before
//  any test suite in this file touches the DB.
function applySchema(db, done) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS file (
            file_id                 INTEGER PRIMARY KEY,
            area_tag                VARCHAR NOT NULL,
            file_sha256             VARCHAR NOT NULL,
            file_name,
            storage_tag             VARCHAR NOT NULL,
            storage_tag_rel_path    VARCHAR DEFAULT NULL,
            desc,
            desc_long,
            upload_timestamp        DATETIME NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_meta (
            file_id     INTEGER NOT NULL,
            meta_name   VARCHAR NOT NULL,
            meta_value  VARCHAR NOT NULL,
            UNIQUE(file_id, meta_name, meta_value),
            FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS hash_tag (
            hash_tag_id INTEGER PRIMARY KEY,
            hash_tag    VARCHAR NOT NULL,
            UNIQUE(hash_tag)
        );

        CREATE TABLE IF NOT EXISTS file_hash_tag (
            hash_tag_id INTEGER NOT NULL,
            file_id     INTEGER NOT NULL,
            UNIQUE(hash_tag_id, file_id),
            FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS file_user_rating (
            file_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            rating  INTEGER NOT NULL,
            UNIQUE(file_id, user_id),
            FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts4 (
            content="file",
            file_name,
            desc,
            desc_long
        );

        CREATE TRIGGER IF NOT EXISTS file_before_update BEFORE UPDATE ON file BEGIN
            DELETE FROM file_fts WHERE docid=old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS file_before_delete BEFORE DELETE ON file BEGIN
            DELETE FROM file_fts WHERE docid=old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS file_after_update AFTER UPDATE ON file BEGIN
            INSERT INTO file_fts(docid, file_name, desc, desc_long) VALUES(new.rowid, new.file_name, new.desc, new.desc_long);
        END;
        CREATE TRIGGER IF NOT EXISTS file_after_insert AFTER INSERT ON file BEGIN
            INSERT INTO file_fts(docid, file_name, desc, desc_long) VALUES(new.rowid, new.file_name, new.desc, new.desc_long);
        END;
    `);
    return done(null);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

//  A fixed sha256 hex string used wherever we want to skip real file I/O.
//  persist() only reads the file when fileSha256 is falsy.
const FAKE_SHA256 = 'a'.repeat(64);

function makeEntry(overrides) {
    return new FileEntry(
        Object.assign(
            {
                areaTag: 'test_area',
                fileName: 'test.zip',
                storageTag: 'flat_abs',
                fileSha256: FAKE_SHA256,
                relPath: null,
            },
            overrides
        )
    );
}

// ─── quickCheckExistsByPath ───────────────────────────────────────────────────

describe('FileEntry.quickCheckExistsByPath()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file;');
        done();
    });

    it('returns false when the table is empty', done => {
        FileEntry.quickCheckExistsByPath(
            '/srv/files/flat/test.zip',
            'flat_abs',
            null,
            (err, exists) => {
                assert.ifError(err);
                assert.equal(exists, false);
                done();
            }
        );
    });

    it('returns true for (fileName, storageTag, relPath=null) that already exists', done => {
        const entry = makeEntry();

        entry.persist(insertErr => {
            assert.ifError(insertErr);

            FileEntry.quickCheckExistsByPath(
                '/srv/files/flat/test.zip',
                'flat_abs',
                null,
                (err, exists) => {
                    assert.ifError(err);
                    assert.equal(exists, true);
                    done();
                }
            );
        });
    });

    it('returns true for (fileName, storageTag, relPath) when relPath matches', done => {
        const entry = makeEntry({ relPath: '2024/April' });

        entry.persist(insertErr => {
            assert.ifError(insertErr);

            FileEntry.quickCheckExistsByPath(
                '/srv/files/flat/2024/April/test.zip',
                'flat_abs',
                '2024/April',
                (err, exists) => {
                    assert.ifError(err);
                    assert.equal(exists, true);
                    done();
                }
            );
        });
    });

    it('returns false when fileName matches but relPath differs', done => {
        //  Record stored with relPath='2024/April'
        const entry = makeEntry({ relPath: '2024/April' });

        entry.persist(insertErr => {
            assert.ifError(insertErr);

            //  Look for same file at the root (relPath=null) — should NOT match
            FileEntry.quickCheckExistsByPath(
                '/srv/files/flat/test.zip',
                'flat_abs',
                null,
                (err, exists) => {
                    assert.ifError(err);
                    assert.equal(exists, false);
                    done();
                }
            );
        });
    });

    it('returns false when fileName and relPath match but storageTag differs', done => {
        const entry = makeEntry({ storageTag: 'flat_abs', relPath: null });

        entry.persist(insertErr => {
            assert.ifError(insertErr);

            //  Ask for a different tag — different physical location
            FileEntry.quickCheckExistsByPath(
                '/srv/files/wc/test.zip',
                'wc_abs',
                null,
                (err, exists) => {
                    assert.ifError(err);
                    assert.equal(exists, false);
                    done();
                }
            );
        });
    });

    it('returns false when only the relPath subdirectory prefix matches (not an exact match)', done => {
        //  Stored under '2024'
        const entry = makeEntry({ relPath: '2024' });

        entry.persist(insertErr => {
            assert.ifError(insertErr);

            //  Looking for '2024/April' — deeper path, different record
            FileEntry.quickCheckExistsByPath(
                '/srv/files/flat/2024/April/test.zip',
                'flat_abs',
                '2024/April',
                (err, exists) => {
                    assert.ifError(err);
                    assert.equal(exists, false);
                    done();
                }
            );
        });
    });

    it('distinguishes two records with the same fileName in different subdirs', done => {
        const entryA = makeEntry({ relPath: '2024/January' });
        const entryB = makeEntry({ relPath: '2024/February' });

        entryA.persist(errA => {
            assert.ifError(errA);
            entryB.persist(errB => {
                assert.ifError(errB);

                FileEntry.quickCheckExistsByPath(
                    '/srv/files/flat/2024/January/test.zip',
                    'flat_abs',
                    '2024/January',
                    (err, existsA) => {
                        assert.ifError(err);
                        assert.equal(existsA, true, 'January record should exist');

                        FileEntry.quickCheckExistsByPath(
                            '/srv/files/flat/2024/March/test.zip',
                            'flat_abs',
                            '2024/March',
                            (err2, existsC) => {
                                assert.ifError(err2);
                                assert.equal(
                                    existsC,
                                    false,
                                    'March record should not exist'
                                );
                                done();
                            }
                        );
                    }
                );
            });
        });
    });
});

// ─── persist / load round-trip ────────────────────────────────────────────────

describe('FileEntry persist() / load() — relPath round-trip', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file;');
        done();
    });

    it('round-trips relPath=null (flat file at storage root)', done => {
        const entry = makeEntry({ relPath: null });

        entry.persist(persistErr => {
            assert.ifError(persistErr);
            assert.ok(entry.fileId > 0, 'fileId must be set after persist');

            const loaded = new FileEntry();
            loaded.load(entry.fileId, loadErr => {
                assert.ifError(loadErr);
                assert.equal(loaded.relPath, null);
                assert.equal(loaded.fileName, 'test.zip');
                assert.equal(loaded.storageTag, 'flat_abs');
                done();
            });
        });
    });

    it('round-trips a single-level relPath', done => {
        const entry = makeEntry({ relPath: '2024' });

        entry.persist(persistErr => {
            assert.ifError(persistErr);

            const loaded = new FileEntry();
            loaded.load(entry.fileId, loadErr => {
                assert.ifError(loadErr);
                assert.equal(loaded.relPath, '2024');
                done();
            });
        });
    });

    it('round-trips a multi-level relPath', done => {
        const entry = makeEntry({ relPath: '2024/April/games' });

        entry.persist(persistErr => {
            assert.ifError(persistErr);

            const loaded = new FileEntry();
            loaded.load(entry.fileId, loadErr => {
                assert.ifError(loadErr);
                assert.equal(loaded.relPath, '2024/April/games');
                done();
            });
        });
    });

    it('two entries with the same fileName but different relPaths are independent records', done => {
        const entryRoot = makeEntry({ relPath: null });
        const entryNested = makeEntry({ relPath: '2024' });

        entryRoot.persist(err1 => {
            assert.ifError(err1);
            entryNested.persist(err2 => {
                assert.ifError(err2);

                assert.notEqual(entryRoot.fileId, entryNested.fileId);

                const loadedRoot = new FileEntry();
                loadedRoot.load(entryRoot.fileId, loadErr => {
                    assert.ifError(loadErr);
                    assert.equal(loadedRoot.relPath, null);

                    const loadedNested = new FileEntry();
                    loadedNested.load(entryNested.fileId, loadErr2 => {
                        assert.ifError(loadErr2);
                        assert.equal(loadedNested.relPath, '2024');
                        done();
                    });
                });
            });
        });
    });

    it('relPath survives an update (REPLACE INTO with explicit fileId)', done => {
        const entry = makeEntry({ relPath: null });

        entry.persist(persistErr => {
            assert.ifError(persistErr);
            const id = entry.fileId;

            //  Update with a new relPath
            entry.relPath = '2025/January';
            entry.persist(true /*isUpdate*/, updateErr => {
                assert.ifError(updateErr);
                assert.equal(entry.fileId, id, 'fileId must be unchanged after update');

                const loaded = new FileEntry();
                loaded.load(id, loadErr => {
                    assert.ifError(loadErr);
                    assert.equal(loaded.relPath, '2025/January');
                    done();
                });
            });
        });
    });
});

// ─── loadBasicEntry static ────────────────────────────────────────────────────

describe('FileEntry.loadBasicEntry() — relPath aliasing', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file;');
        done();
    });

    it('exposes storage_tag_rel_path as relPath (not storageTagRelPath)', done => {
        const entry = makeEntry({ relPath: 'scene/2024' });

        entry.persist(persistErr => {
            assert.ifError(persistErr);

            const dest = {};
            FileEntry.loadBasicEntry(entry.fileId, dest, loadErr => {
                assert.ifError(loadErr);
                assert.equal(dest.relPath, 'scene/2024', 'relPath alias must be set');
                //  The camelCase auto-mapped name should also exist but the
                //  canonical property is relPath.
                assert.equal(dest.storageTagRelPath, 'scene/2024');
                done();
            });
        });
    });

    it('relPath is null (not undefined) when storage_tag_rel_path is NULL in DB', done => {
        const entry = makeEntry({ relPath: null });

        entry.persist(persistErr => {
            assert.ifError(persistErr);

            const dest = {};
            FileEntry.loadBasicEntry(entry.fileId, dest, loadErr => {
                assert.ifError(loadErr);
                assert.equal(dest.relPath, null);
                done();
            });
        });
    });
});

// ─── findFiles: FTS terms search ──────────────────────────────────────────────
//
//  Regression guard for the SQLITE_DQS=0 bug: better-sqlite3 v12 ships SQLite
//  with double-quoted strings parsed as identifiers, so any FTS MATCH operand
//  built with double quotes ("…") fails as "no such column: …" rather than
//  matching. These tests exercise the live SQL through findFiles() so a
//  re-introduction of double-quoted MATCH operands fails immediately.

describe('FileEntry.findFiles() — FTS terms search', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file;');
        done();
    });

    //  FileEntry's constructor only copies a fixed set of properties from
    //  options (areaTag, fileName, storageTag, fileSha256, relPath, ...).
    //  desc/descLong are populated post-construction in production via SAUCE
    //  parsing — here we just assign them directly so persist() writes them.
    function persistFile(overrides, cb) {
        const ctorOpts = Object.assign(
            { areaTag: 'pc_dos', fileName: 'sample.zip' },
            overrides
        );
        const desc = overrides.desc !== undefined ? overrides.desc : 'short description';
        const descLong =
            overrides.descLong !== undefined
                ? overrides.descLong
                : 'long description body';

        delete ctorOpts.desc;
        delete ctorOpts.descLong;

        const entry = makeEntry(ctorOpts);
        entry.desc = desc;
        entry.descLong = descLong;
        entry.persist(err => cb(err, entry));
    }

    it('returns matching file_ids for a simple term in file_name', done => {
        persistFile({ fileName: 'doom-shareware.zip', desc: 'a game' }, (err, e) => {
            assert.ifError(err);
            FileEntry.findFiles({ terms: 'doom' }, (findErr, ids) => {
                assert.ifError(findErr);
                assert.ok(Array.isArray(ids));
                assert.ok(
                    ids.includes(e.fileId),
                    'matching fileId should appear in results'
                );
                done();
            });
        });
    });

    it('returns matching file_ids for a term in desc (short description)', done => {
        persistFile(
            { fileName: 'misc.zip', desc: 'an interactive fiction adventure' },
            (err, e) => {
                assert.ifError(err);
                FileEntry.findFiles({ terms: 'adventure' }, (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.ok(ids.includes(e.fileId));
                    done();
                });
            }
        );
    });

    it('returns matching file_ids for a term in desc_long', done => {
        persistFile(
            {
                fileName: 'pkg.zip',
                desc: 'short',
                descLong: 'a sprawling treatise on assembly programming',
            },
            (err, e) => {
                assert.ifError(err);
                FileEntry.findFiles({ terms: 'treatise' }, (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.ok(ids.includes(e.fileId));
                    done();
                });
            }
        );
    });

    it('returns an empty list when no rows match (not an error)', done => {
        persistFile({ fileName: 'doom.zip' }, err => {
            assert.ifError(err);
            FileEntry.findFiles({ terms: 'unicorn-no-such-word' }, (findErr, ids) => {
                assert.ifError(findErr);
                assert.deepEqual(ids, []);
                done();
            });
        });
    });

    it('rejects DQS=0 regression: bare-string MATCH must not error and must return results', done => {
        //  Two records, both contain the term, in different fields. If the
        //  underlying SQL quotes the FTS operand with " (DQS=0 regression),
        //  the SqliteError "no such column" will surface here rather than a
        //  result list.
        persistFile({ fileName: 'alpha-doom.zip', desc: 'unrelated' }, (e1, a) => {
            assert.ifError(e1);
            persistFile(
                { fileName: 'unrelated.zip', desc: 'doom inside desc' },
                (e2, b) => {
                    assert.ifError(e2);
                    FileEntry.findFiles({ terms: 'doom' }, (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.ok(ids.includes(a.fileId));
                        assert.ok(ids.includes(b.fileId));
                        done();
                    });
                }
            );
        });
    });

    it('combines FTS terms with an areaTag filter', done => {
        persistFile({ areaTag: 'pc_dos', fileName: 'doom-pc.zip' }, (e1, pc) => {
            assert.ifError(e1);
            persistFile({ areaTag: 'amiga', fileName: 'doom-amiga.zip' }, (e2, am) => {
                assert.ifError(e2);
                FileEntry.findFiles(
                    { terms: 'doom', areaTag: 'pc_dos' },
                    (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.ok(ids.includes(pc.fileId));
                        assert.ok(
                            !ids.includes(am.fileId),
                            'amiga record must be filtered out by areaTag'
                        );
                        done();
                    }
                );
            });
        });
    });
});
