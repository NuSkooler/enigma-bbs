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

const { getModDatabasePath, getTransactionDatabase } = require('../database.js');
const sqlite3 = require('sqlite3');

const MODULE_INFO = {
    packageName: 'codes.l33t.enigma.zmachine_door',
};

let _db = null;

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
 */
function openDatabase(cb) {
    if (_db) {
        return cb(null, _db);
    }

    const dbPath = getModDatabasePath(MODULE_INFO);
    const raw = new sqlite3.Database(dbPath, err => {
        if (err) {
            return cb(err);
        }

        _db = getTransactionDatabase(raw);
        _db.exec(SCHEMA, schemaErr => {
            if (schemaErr) {
                return cb(schemaErr);
            }
            return cb(null, _db);
        });
    });
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
    openDatabase((err, db) => {
        if (err) return cb(err);
        db.get(
            'SELECT save_data FROM zmachine_autosave WHERE user_id = ? AND game_signature = ?',
            [userId, signature],
            (getErr, row) => {
                if (getErr) return cb(getErr);
                return cb(null, row ? row.save_data : null);
            }
        );
    });
}

/**
 * Write or delete an autosave. If data is null, the row is deleted
 * (ifvms.js uses null to clear autosaves at game end).
 */
function writeAutosave(userId, signature, data, cb) {
    openDatabase((err, db) => {
        if (err) return cb(err);

        if (data === null || data === undefined) {
            db.run(
                'DELETE FROM zmachine_autosave WHERE user_id = ? AND game_signature = ?',
                [userId, signature],
                cb
            );
            return;
        }

        //  UPSERT with updated_at and accumulated play stats.
        db.run(
            `INSERT INTO zmachine_autosave
                (user_id, game_signature, save_data, updated_at, play_count, total_seconds)
             VALUES (?, ?, ?, ?, 1, 0)
             ON CONFLICT(user_id, game_signature) DO UPDATE SET
                save_data = excluded.save_data,
                updated_at = excluded.updated_at,
                play_count = play_count + 1`,
            [userId, signature, data, new Date().toISOString()],
            cb
        );
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
    openDatabase((err, db) => {
        if (err) return cb(err);
        db.run(
            `UPDATE zmachine_autosave
             SET total_seconds = total_seconds + ?
             WHERE user_id = ? AND game_signature = ?`,
            [seconds, userId, signature],
            cb
        );
    });
}

exports.MODULE_INFO = MODULE_INFO;
exports.openDatabase = openDatabase;
exports.loadAutosave = loadAutosave;
exports.writeAutosave = writeAutosave;
exports.addPlayTime = addPlayTime;
