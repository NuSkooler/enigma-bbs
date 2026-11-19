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

//
//  Values reach SQLite as bound parameters, not interpolated into the
//  statement. They used to go through sanitizeString(), which escapes MySQL
//  style -- doubling '"' and backslash-escaping '\', '%' and the control
//  characters. SQLite's only string-literal escape is a doubled quote, so all
//  of that arrived as extra characters and the value could not match itself.
//
//  Never an injection -- the one escape that mattered was correct -- but a file
//  could not be found by its own name.
//
describe('FileEntry.findFiles() — values are bound, not escaped', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file_meta; DELETE FROM file;');
        done();
    });

    function persistNamed(fileName, meta, cb) {
        const entry = makeEntry({ areaTag: 'pc_dos', fileName, meta });
        entry.desc = fileName;
        entry.persist(err => cb(err, entry));
    }

    //  Every one of these is a legal filename on the systems ENiGMA runs on.
    const AWKWARD = [
        ['percent', '100% Pure.zip'],
        ['double quote', 'say "hi".txt'],
        ['backslash', 'back\\slash.zip'],
        ['single quote', "o'brien.zip"],
        ['underscore', 'my_file.zip'],
        ['newline', 'two\nlines.zip'],
        ['tab', 'a\tb.zip'],
    ];

    AWKWARD.forEach(([label, fileName]) => {
        it(`finds a file whose name contains a ${label}`, done => {
            persistNamed(fileName, {}, (err, entry) => {
                assert.ifError(err);
                FileEntry.findFiles({ fileName }, (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(
                        ids,
                        [entry.fileId],
                        `${JSON.stringify(fileName)} could not find itself`
                    );
                    done();
                });
            });
        });
    });

    it('matches an areaTag exactly, without escaping it', done => {
        persistNamed('a.zip', {}, (err, entry) => {
            assert.ifError(err);
            FileEntry.findFiles({ areaTag: 'pc_dos' }, (findErr, ids) => {
                assert.ifError(findErr);
                assert.deepEqual(ids, [entry.fileId]);
                done();
            });
        });
    });

    //
    //  Two different hazards, so two kinds of value. A '%' catches the old
    //  escaping, which mangled it; an apostrophe catches raw interpolation,
    //  which the old code got *right*. A test with only one of them passes
    //  under the other mistake.
    //
    [
        ['percent', '100%.ZIP'],
        ['apostrophe', "O'BRIEN.ZIP"],
        ['backslash', 'A\\B.ZIP'],
    ].forEach(([label, value]) => {
        it(`matches a meta value containing ${label === 'apostrophe' ? 'an' : 'a'} ${label}`, done => {
            //  short_file_name is what a TIC's "Replaces" is matched against,
            //  and all of these are legal in a DOS 8.3 name.
            persistNamed(`m-${label}.zip`, { short_file_name: value }, (err, entry) => {
                assert.ifError(err);
                FileEntry.findFiles(
                    {
                        areaTag: 'pc_dos',
                        metaPairs: [{ name: 'short_file_name', value }],
                    },
                    (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.deepEqual(ids, [entry.fileId]);
                        done();
                    }
                );
            });
        });
    });

    it('does not let a value act as SQL', done => {
        //  Never was an injection; this is the regression guard for that.
        persistNamed('safe.zip', {}, err => {
            assert.ifError(err);
            const hostile = [
                "x' OR 1=1 --",
                "x'; DROP TABLE file; --",
                'x" OR 1=1 --',
                "x\\' OR 1=1 --",
            ];
            let pending = hostile.length;
            hostile.forEach(fileName => {
                FileEntry.findFiles({ fileName }, (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(ids, [], fileName);
                    if (0 === --pending) {
                        const rows = _testDb
                            .prepare(
                                "SELECT COUNT(*) c FROM sqlite_master WHERE name='file'"
                            )
                            .get();
                        assert.equal(rows.c, 1, 'the table must still exist');
                        done();
                    }
                });
            });
        });
    });

    it('ignores a sort naming something that is not a column', done => {
        //
        //  A sort names a column and so cannot be bound; this is the allow-list.
        //  The value has to be one that *fails* when pasted in -- an unknown
        //  column is a SQLite error, whereas something like
        //  "file_id, (SELECT 1) --" is valid SQL and would pass either way.
        //
        persistNamed('sorted.zip', {}, (err, entry) => {
            assert.ifError(err);
            FileEntry.findFiles(
                { areaTag: 'pc_dos', sort: 'no_such_column' },
                (findErr, ids) => {
                    assert.ifError(findErr, 'an unknown sort must not reach the SQL');
                    assert.deepEqual(ids, [entry.fileId], 'it falls back to file_id');
                    done();
                }
            );
        });
    });

    it('still sorts by a column it does know', done => {
        persistNamed('a.zip', {}, e1 => {
            assert.ifError(e1);
            persistNamed('b.zip', {}, e2 => {
                assert.ifError(e2);
                FileEntry.findFiles(
                    { areaTag: 'pc_dos', sort: 'file_name', order: 'ascending' },
                    (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.equal(ids.length, 2);
                        done();
                    }
                );
            });
        });
    });

    it('treats a NaN limit as no limit rather than pasting it in', done => {
        persistNamed('n.zip', {}, err => {
            assert.ifError(err);
            FileEntry.findFiles(
                { areaTag: 'pc_dos', limit: Number('nope') },
                (findErr, ids) => {
                    assert.ifError(findErr, 'LIMIT NaN would be a syntax error');
                    assert.equal(ids.length, 1);
                    done();
                }
            );
        });
    });
});

//  #864. A TIC's "Replaces" is a DOS style glob matched against the stored
//  |short_file_name| meta. findFiles() converted '*' to '%' and then ran the
//  result through sanitizeString(), which escapes '%' for literal values -- so
//  every wildcard came back out as the literal two characters "\%", and with no
//  ESCAPE clause on the LIKE, SQLite read that backslash literally. A wildcard
//  Replaces matched nothing, allowReplace stored a duplicate rather than
//  superseding, and the old file stayed queued for every downlink.
//
//
//  The fix itself arrived via #868, which binds values instead of escaping
//  them and pairs the LIKE with an explicit ESCAPE. These are the regression
//  tests for the wildcard path, which that change left uncovered.
describe('FileEntry.findFiles() — wildcard metaPairs (#864)', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file_meta; DELETE FROM file;');
        done();
    });

    //  A file carrying the two meta a TIC "Replaces" is matched on.
    function persistWithMeta(fileName, meta, cb) {
        const entry = makeEntry({ areaTag: 'nodelists', fileName, meta });
        entry.desc = fileName;
        entry.persist(err => cb(err, entry));
    }

    const findByReplaces = (replaces, cb) =>
        FileEntry.findFiles(
            {
                areaTag: 'nodelists',
                metaPairs: [
                    { name: 'short_file_name', value: replaces, wildcards: true },
                ],
            },
            cb
        );

    it("matches a '*' wildcard, which is the form Replaces exists for", done => {
        persistWithMeta(
            'nodelist.246',
            { short_file_name: 'NODELIST.246' },
            (err, entry) => {
                assert.ifError(err);
                findByReplaces('NODELIST.*', (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(
                        ids,
                        [entry.fileId],
                        'a weekly nodelist hatch supersedes nothing without this'
                    );
                    done();
                });
            }
        );
    });

    it("matches a '?' wildcard", done => {
        persistWithMeta(
            'nodelist.246',
            { short_file_name: 'NODELIST.246' },
            (err, entry) => {
                assert.ifError(err);
                findByReplaces('NODELIST.2?6', (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(ids, [entry.fileId]);
                    done();
                });
            }
        );
    });

    it('still matches an exact name carrying no wildcard at all', done => {
        persistWithMeta(
            'nodelist.246',
            { short_file_name: 'NODELIST.246' },
            (err, entry) => {
                assert.ifError(err);
                findByReplaces('NODELIST.246', (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(ids, [entry.fileId]);
                    done();
                });
            }
        );
    });

    it('does not match a file the pattern does not name', done => {
        persistWithMeta('readme.txt', { short_file_name: 'README.TXT' }, err => {
            assert.ifError(err);
            findByReplaces('NODELIST.*', (findErr, ids) => {
                assert.ifError(findErr);
                assert.deepEqual(ids, []);
                done();
            });
        });
    });

    it('finds every file a pattern spans, so an ambiguous one can be refused', done => {
        //  The caller's safety check depends on this: dequeueReplaced* only
        //  runs for exactly one match, and reporting one of three would delete
        //  a real file and pull it out of every downlink's queue.
        persistWithMeta('nodelist.239', { short_file_name: 'NODELIST.239' }, e1 => {
            assert.ifError(e1);
            persistWithMeta('nodelist.246', { short_file_name: 'NODELIST.246' }, e2 => {
                assert.ifError(e2);
                findByReplaces('NODELIST.*', (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.equal(ids.length, 2);
                    done();
                });
            });
        });
    });

    it("treats a literal '%' in the pattern as a literal, not a wildcard", done => {
        //  '%' is legal in a DOS 8.3 name. Escaping the caller's own
        //  metacharacters is the first half of the fix; without it "100%.ZIP"
        //  would match anything beginning "100".
        persistWithMeta('100pct.zip', { short_file_name: '100PCT.ZIP' }, e1 => {
            assert.ifError(e1);
            persistWithMeta('100%.zip', { short_file_name: '100%.ZIP' }, (e2, pct) => {
                assert.ifError(e2);
                findByReplaces('100%.ZIP', (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(ids, [pct.fileId], "'%' must not act as a wildcard");
                    done();
                });
            });
        });
    });

    it('does not mutate the caller’s metaPairs', done => {
        //  The old form assigned the converted value back into mp.value, so a
        //  filter used twice was converted twice.
        persistWithMeta('nodelist.246', { short_file_name: 'NODELIST.246' }, err => {
            assert.ifError(err);
            const metaPairs = [
                { name: 'short_file_name', value: 'NODELIST.*', wildcards: true },
            ];
            FileEntry.findFiles({ areaTag: 'nodelists', metaPairs }, findErr => {
                assert.ifError(findErr);
                assert.equal(metaPairs[0].value, 'NODELIST.*');
                done();
            });
        });
    });
});

// ─── findByFileNameWildcard: oputil fb rm / mv targets (#1020) ───────────────

describe('FileEntry.findByFileNameWildcard()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM file;');
        done();
    });

    function persistNames(names, cb) {
        let i = 0;
        const next = () => {
            if (i >= names.length) {
                return cb();
            }
            makeEntry({ fileName: names[i++] }).persist(err => {
                assert.ifError(err);
                next();
            });
        };
        next();
    }

    function find(wc, cb) {
        FileEntry.findByFileNameWildcard(wc, (err, entries) => {
            if (err) {
                //  no matches is the only error expected here
                assert.equal(
                    err.code,
                    require('../core/enig_error.js').ErrorCodes.DoesNotExist
                );
                return cb([]);
            }
            return cb(entries.map(e => e.fileName).sort());
        });
    }

    it("treats a literal '_' as itself", done => {
        persistNames(['FILE_1.ZIP', 'FILEX1.ZIP', 'FILE-1.ZIP'], () => {
            find('FILE_1.ZIP', names => {
                assert.deepEqual(names, ['FILE_1.ZIP']);
                done();
            });
        });
    });

    it("treats a literal '%' as itself", done => {
        persistNames(['100%.ZIP', '100X.ZIP', '100.ZIP'], () => {
            find('100%.ZIP', names => {
                assert.deepEqual(names, ['100%.ZIP']);
                done();
            });
        });
    });

    it("still globs '?'", done => {
        persistNames(['FILE_1.ZIP', 'FILEX1.ZIP', 'FILE12.ZIP'], () => {
            find('FILE?1.ZIP', names => {
                assert.deepEqual(names, ['FILEX1.ZIP', 'FILE_1.ZIP']);
                done();
            });
        });
    });

    it("still globs '*'", done => {
        persistNames(['A_B.ZIP', 'AXB.ZIP', 'C.ARJ'], () => {
            find('*.ZIP', names => {
                assert.deepEqual(names, ['AXB.ZIP', 'A_B.ZIP']);
                done();
            });
        });
    });

    it("a literal '_' next to a glob wildcard", done => {
        persistNames(['A_B1.ZIP', 'A_B22.ZIP', 'AXB1.ZIP'], () => {
            find('A_B?.ZIP', names => {
                assert.deepEqual(names, ['A_B1.ZIP']);
                done();
            });
        });
    });

    it('a pattern holding a control character matches nothing', done => {
        persistNames(['FILE1.ZIP', 'FILE2.ZIP'], () => {
            find('FILE' + String.fromCharCode(9) + '1.ZIP', names => {
                assert.deepEqual(names, []);
                done();
            });
        });
    });

    it('matches a name containing a backslash literally', done => {
        persistNames(['A\\B.ZIP', 'AXB.ZIP'], () => {
            find('A\\B.ZIP', names => {
                assert.deepEqual(names, ['A\\B.ZIP']);
                done();
            });
        });
    });

    it('stays case-insensitive', done => {
        persistNames(['File_1.Zip', 'FILEX1.ZIP'], () => {
            find('FILE_1.ZIP', names => {
                assert.deepEqual(names, ['File_1.Zip']);
                done();
            });
        });
    });
});

// ─── hash tags ────────────────────────────────────────────────────────────────

//
//  An area's hashTags reach a new entry as configured: a string ("uploads",
//  "a,b"), an array or a Set. A string kept as is was iterated as single
//  characters, so uploads were tagged u,p,l,o,a,d,s.
//
describe('FileEntry hash tags', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec(
            'DELETE FROM file; DELETE FROM file_hash_tag; DELETE FROM hash_tag;'
        );
        done();
    });

    const tagsOf = entry => Array.from(entry.hashTags).sort();

    describe('constructor', () => {
        it('takes a single tag string as one tag', () => {
            assert.deepEqual(tagsOf(makeEntry({ hashTags: 'uploads' })), ['uploads']);
        });

        it('splits a string on commas and whitespace, dropping empty tags', () => {
            const entry = makeEntry({ hashTags: ' msk, scene,,audio  bbs ' });
            assert.deepEqual(tagsOf(entry), ['audio', 'bbs', 'msk', 'scene']);
        });

        it('takes an array, trimmed, without empty or duplicate tags', () => {
            const entry = makeEntry({ hashTags: [' scene ', 'scene', '', 'art'] });
            assert.deepEqual(tagsOf(entry), ['art', 'scene']);
        });

        it('keeps numeric tags (HJSON reads [ 1990 ] as a number)', () => {
            assert.deepEqual(tagsOf(makeEntry({ hashTags: [1990, 'demo'] })), [
                '1990',
                'demo',
            ]);
        });

        it('copies a Set rather than sharing it', () => {
            //  an area's Set lives in the cached config; tagging one entry
            //  must not tag the area
            const areaTags = new Set(['uploads']);
            const entry = makeEntry({ hashTags: areaTags });
            entry.hashTags.add('extra');
            assert.deepEqual(Array.from(areaTags), ['uploads']);
            assert.deepEqual(tagsOf(entry), ['extra', 'uploads']);
        });

        it('is an empty Set without hashTags, or with something unusable', () => {
            for (const hashTags of [undefined, null, 42, { a: 1 }]) {
                const entry = makeEntry({ hashTags });
                assert.ok(entry.hashTags instanceof Set);
                assert.equal(entry.hashTags.size, 0);
            }
        });
    });

    describe('setHashTags()', () => {
        it('replaces the tags from a string a user typed', () => {
            const entry = makeEntry({ hashTags: 'uploads' });
            entry.setHashTags('testfile, demo');
            assert.deepEqual(tagsOf(entry), ['demo', 'testfile']);
        });

        it('keeps the current tags when given something unusable', () => {
            const entry = makeEntry({ hashTags: 'uploads' });
            entry.setHashTags(undefined);
            assert.deepEqual(tagsOf(entry), ['uploads']);
        });
    });

    describe('persist()', () => {
        it('stores an area tag string as one tag, not one per character', done => {
            const entry = makeEntry({ hashTags: 'uploads' });
            entry.persist(err => {
                assert.ifError(err);
                const loaded = new FileEntry();
                loaded.load(entry.fileId, loadErr => {
                    assert.ifError(loadErr);
                    assert.deepEqual(tagsOf(loaded), ['uploads']);
                    const stored = _testDb
                        .prepare('SELECT hash_tag FROM hash_tag ORDER BY hash_tag')
                        .all()
                        .map(r => r.hash_tag);
                    assert.deepEqual(stored, ['uploads']);
                    done();
                });
            });
        });
    });
});
