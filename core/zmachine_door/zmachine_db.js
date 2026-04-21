/* jslint node: true */
'use strict';

/**
 * zmachine_db.js
 *
 * SQLite schema + helpers for Z-Machine door autosave storage.
 * Runs on the main thread only — workers communicate via postMessage.
 *
 * Database path is resolved via getModDatabasePath() using the door's
 * packageName (codes.l33t.enigma.zmachine_door).
 */

const {
    getModDatabasePath,
    openDatabase: openSqliteDatabase,
} = require('../database.js');

const MODULE_INFO = {
    packageName: 'codes.l33t.enigma.zmachine_door',
};

let _db = null;

//  Prepared statements — built lazily on first openDatabase() call.
let _stmtSelectAutosave = null;
let _stmtDeleteAutosave = null;
let _stmtUpsertAutosave = null;
let _stmtAddPlayTime = null;

//  Schema. Keyed by (user_id, game_signature) — the signature is supplied by
//  ifvms.js via vm.get_signature(), derived from the z-file header, so it
//  identifies a specific release of a specific game regardless of filename.
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS zmachine_autosave (
        user_id         INTEGER NOT NULL,
        game_signature  TEXT NOT NULL,
        save_data       BLOB NOT NULL,
        updated_at      TEXT NOT NULL,
        play_count      INTEGER NOT NULL DEFAULT 0,
        total_seconds   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, game_signature)
    );

    CREATE INDEX IF NOT EXISTS idx_zmachine_autosave_user
        ON zmachine_autosave(user_id);
`;

/**
 * Open (or return the cached) database connection and ensure the schema
 * exists. Callback receives (err, db).
 *
 * Internally synchronous (better-sqlite3), but exposed as a callback API
 * so the rest of the module — and future call sites — can stay
 * callback-shaped.
 */
function openDatabase(cb) {
    if (_db) {
        return cb(null, _db);
    }

    try {
        const dbPath = getModDatabasePath(MODULE_INFO);
        _db = openSqliteDatabase(dbPath);
        _db.exec(SCHEMA);

        _stmtSelectAutosave = _db.prepare(
            'SELECT save_data FROM zmachine_autosave WHERE user_id = ? AND game_signature = ?'
        );
        _stmtDeleteAutosave = _db.prepare(
            'DELETE FROM zmachine_autosave WHERE user_id = ? AND game_signature = ?'
        );
        _stmtUpsertAutosave = _db.prepare(
            `INSERT INTO zmachine_autosave
                (user_id, game_signature, save_data, updated_at, play_count, total_seconds)
             VALUES (?, ?, ?, ?, 1, 0)
             ON CONFLICT(user_id, game_signature) DO UPDATE SET
                save_data = excluded.save_data,
                updated_at = excluded.updated_at,
                play_count = play_count + 1`
        );
        _stmtAddPlayTime = _db.prepare(
            `UPDATE zmachine_autosave
             SET total_seconds = total_seconds + ?
             WHERE user_id = ? AND game_signature = ?`
        );

        return cb(null, _db);
    } catch (err) {
        return cb(err);
    }
}

/**
 * Load the autosave blob for (userId, signature). Returns null if no
 * autosave exists. The signature is passed as a hint to the caller when
 * we don't yet have one — on initial spawn, pass null and we return null.
 */
function loadAutosave(userId, signature, cb) {
    if (!signature) {
        return cb(null, null);
    }
    openDatabase(err => {
        if (err) return cb(err);
        try {
            const row = _stmtSelectAutosave.get(userId, signature);
            return cb(null, row ? row.save_data : null);
        } catch (getErr) {
            return cb(getErr);
        }
    });
}

/**
 * Write or delete an autosave. If data is null, the row is deleted
 * (ifvms.js uses null to clear autosaves at game end).
 */
function writeAutosave(userId, signature, data, cb) {
    openDatabase(err => {
        if (err) return cb(err);

        try {
            if (data === null || data === undefined) {
                _stmtDeleteAutosave.run(userId, signature);
                return cb(null);
            }

            //  UPSERT with updated_at and accumulated play stats.
            _stmtUpsertAutosave.run(userId, signature, data, new Date().toISOString());
            return cb(null);
        } catch (runErr) {
            return cb(runErr);
        }
    });
}

/**
 * Add elapsed seconds to an existing autosave row. Called at session end
 * to accumulate per-user per-game playtime. Silently no-ops if no row exists.
 */
function addPlayTime(userId, signature, seconds, cb) {
    if (!signature || !seconds) {
        return cb(null);
    }
    openDatabase(err => {
        if (err) return cb(err);
        try {
            _stmtAddPlayTime.run(seconds, userId, signature);
            return cb(null);
        } catch (runErr) {
            return cb(runErr);
        }
    });
}

exports.MODULE_INFO = MODULE_INFO;
exports.openDatabase = openDatabase;
exports.loadAutosave = loadAutosave;
exports.writeAutosave = writeAutosave;
exports.addPlayTime = addPlayTime;
