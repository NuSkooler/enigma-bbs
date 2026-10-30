'use strict';

//
//  core/database.js maintenance tasks behind the checkpointDatabases and
//  backupDatabases scheduler entries, run against throwaway databases.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

describe('database maintenance tasks', () => {
    let database;
    let tmpDir;
    let handles;

    before(() => {
        database = require('../core/database.js');
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-db-maint-'));
        handles = {};
        ['alpha', 'beta'].forEach(name => {
            const db = database.openDatabase(paths.join(tmpDir, `${name}.sqlite3`));
            db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
            const insert = db.prepare('INSERT INTO t (v) VALUES (?);');
            for (let i = 0; i < 200; ++i) {
                insert.run(`${name}-${i}`);
            }
            handles[name] = db;
        });
    });

    afterEach(() => {
        Object.values(handles).forEach(db => db.close());
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('checkpointDatabases()', () => {
        it('checkpoints and truncates each WAL', () => {
            const walPath = paths.join(tmpDir, 'alpha.sqlite3-wal');
            assert.ok(fs.statSync(walPath).size > 0, 'writes left something in the WAL');

            const results = database.checkpointDatabases(handles);

            assert.deepEqual(
                results.map(r => r.database),
                ['alpha', 'beta']
            );
            results.forEach(r => {
                assert.equal(r.busy, false);
                assert.equal(typeof r.logFrames, 'number');
            });
            assert.equal(fs.statSync(walPath).size, 0, 'TRUNCATE empties the WAL');
        });
    });

    describe('backupDatabases()', () => {
        it('writes a complete set into a new directory, creating it as needed', async () => {
            const dir = paths.join(tmpDir, 'backup', 'nested');

            const result = await database.backupDatabases(handles, { dir, keep: 3 });

            assert.deepEqual(result.files, ['alpha.sqlite3', 'beta.sqlite3']);
            assert.match(paths.basename(result.dir), /^\d{8}-\d{6}$/);
            assert.deepEqual(fs.readdirSync(dir), [paths.basename(result.dir)]);

            //  the copy is a working database with everything in it
            const copy = database.openDatabase(paths.join(result.dir, 'beta.sqlite3'));
            try {
                assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM t;').get().n, 200);
            } finally {
                copy.close();
            }
        });

        it('keeps only the newest |keep| sets', async () => {
            const dir = paths.join(tmpDir, 'backup');
            fs.mkdirSync(dir);
            //  older sets from earlier runs, plus things that are not sets
            ['20200101-000000', '20210101-000000', '20220101-000000'].forEach(name =>
                fs.mkdirSync(paths.join(dir, name))
            );
            fs.mkdirSync(paths.join(dir, 'keep-me'));
            fs.writeFileSync(paths.join(dir, 'notes.txt'), 'x');

            const result = await database.backupDatabases(handles, { dir, keep: 2 });

            assert.deepEqual(result.pruned, ['20200101-000000', '20210101-000000']);
            assert.deepEqual(
                fs.readdirSync(dir).sort(),
                [
                    '20220101-000000',
                    paths.basename(result.dir),
                    'keep-me',
                    'notes.txt',
                ].sort()
            );
        });

        it('does not overwrite a set made in the same second', async () => {
            const dir = paths.join(tmpDir, 'backup');
            const first = await database.backupDatabases(handles, { dir, keep: 5 });
            const second = await database.backupDatabases(handles, { dir, keep: 5 });
            assert.notEqual(first.dir, second.dir);
            assert.ok(fs.existsSync(paths.join(first.dir, 'alpha.sqlite3')));
            assert.ok(fs.existsSync(paths.join(second.dir, 'alpha.sqlite3')));
        });

        it('leaves no partial set behind when a backup fails', async () => {
            const dir = paths.join(tmpDir, 'backup');
            handles.beta.close();

            await assert.rejects(database.backupDatabases(handles, { dir, keep: 3 }));
            assert.deepEqual(fs.readdirSync(dir), []);

            //  reopen so afterEach can close it
            handles.beta = database.openDatabase(paths.join(tmpDir, 'beta.sqlite3'));
        });

        it('refuses a second backup while one is running', async () => {
            const dir = paths.join(tmpDir, 'backup');
            const first = database.backupDatabases(handles, { dir, keep: 3 });

            await assert.rejects(
                database.backupDatabases(handles, { dir, keep: 3 }),
                /already running/
            );

            const result = await first;
            assert.ok(fs.existsSync(paths.join(result.dir, 'alpha.sqlite3')));
            assert.ok(fs.existsSync(paths.join(result.dir, 'beta.sqlite3')));

            //  and the guard is released afterwards
            await database.backupDatabases(handles, { dir, keep: 3 });
        });

        it('removes a .partial set a crashed backup left behind', async () => {
            const dir = paths.join(tmpDir, 'backup');
            fs.mkdirSync(paths.join(dir, '20200101-000000.partial'), { recursive: true });
            fs.writeFileSync(paths.join(dir, '20200101-000000.partial', 'x'), 'x');
            fs.mkdirSync(paths.join(dir, 'mine.partial'));

            await database.backupDatabases(handles, { dir, keep: 3 });

            assert.ok(!fs.existsSync(paths.join(dir, '20200101-000000.partial')));
            assert.ok(fs.existsSync(paths.join(dir, 'mine.partial')), 'not ours');
        });

        it('yields to the event loop while it copies', async () => {
            //  a larger database, so the copy takes several steps
            const big = handles.alpha;
            big.exec('CREATE TABLE blob_t (b BLOB);');
            const insert = big.prepare('INSERT INTO blob_t (b) VALUES (?);');
            const chunk = Buffer.alloc(16 * 1024, 1);
            big.transaction(() => {
                for (let i = 0; i < 200; ++i) {
                    insert.run(chunk);
                }
            })();

            //  other work queued on the event loop gets turns between steps
            let ticks = 0;
            let running = true;
            const tick = () => {
                if (running) {
                    ++ticks;
                    setImmediate(tick);
                }
            };
            setImmediate(tick);
            try {
                await database.backupDatabases(
                    { alpha: big },
                    { dir: paths.join(tmpDir, 'backup'), keep: 1 }
                );
            } finally {
                running = false;
            }
            assert.ok(ticks > 2, `the event loop turned during the backup (${ticks})`);
        });
    });
});
