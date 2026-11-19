/* jslint node: true */
'use strict';

//
//  The file scanning allowlist (#291, PR 4): SHA-256 hashes an operator has
//  declared safe, typically false positives. core/file_scanner.js checks it
//  before any scanner runs; a file whose bytes hash to a listed value is
//  clean, with the scanner recorded as "allowlist", from every source.
//
//  Global and keyed by SHA-256 only: there is no per-area scope and no name
//  or pattern matching, so only those exact bytes are allowed. Entries are
//  added and removed with oputil (local operator access) and nowhere else.
//  Every change is logged, and each row keeps who added it, when and why.
//
//  The table lives in the file database. The handle is read on every call,
//  never captured at load: database.js opens it after this module loads,
//  and tests swap in their own.
//

//  ENiGMA½
const { Errors } = require('./enig_error.js');

//  deps
const _ = require('lodash');

exports.AllowlistTableSql = `
    CREATE TABLE IF NOT EXISTS file_scan_allowlist (
        sha256          VARCHAR NOT NULL PRIMARY KEY,   /* lowercase hex */
        added_at        DATETIME NOT NULL,
        added_by        VARCHAR NOT NULL,
        note            VARCHAR DEFAULT NULL,
        original_name   VARCHAR DEFAULT NULL,
        signature       VARCHAR DEFAULT NULL
    );`;

exports.isValidSha256 = isValidSha256;
exports.normalizeSha256 = normalizeSha256;
exports.lookup = lookup;
exports.get = get;
exports.add = add;
exports.remove = remove;
exports.list = list;
exports.markEntriesSafe = markEntriesSafe;
exports.getFileIdsBySha256 = getFileIdsBySha256;
exports.ScannerName = 'allowlist';
exports.VerdictDetail = 'allowlisted';

//  Longest value kept per column. Notes are typed by an operator; a name and
//  signature come from an uploader, a TIC or a scanner.
const MAX_LENGTHS = {
    added_by: 64,
    note: 256,
    original_name: 255,
    signature: 128,
};

//  oputil runs without the logger until it has initialized it.
function log(level, obj, msg) {
    const Log = require('./logger.js').log;
    if (Log && _.isFunction(Log[level])) {
        return Log[level](obj, msg);
    }
    if ('error' === level || 'warn' === level) {
        console.error(`${msg}: ${JSON.stringify(obj)}`); //  eslint-disable-line no-console
    }
}

function fileDb() {
    return require('./database.js').dbs.file;
}

function isValidSha256(sha256) {
    return _.isString(sha256) && /^[0-9a-fA-F]{64}$/.test(sha256);
}

//  Lowercase hex, or null for anything that is not exactly 64 hex digits.
function normalizeSha256(sha256) {
    return isValidSha256(sha256) ? sha256.toLowerCase() : null;
}

//  No control characters, trimmed and capped; null when nothing is left.
function cleanColumn(name, value) {
    if (_.isNil(value)) {
        return null;
    }
    const cleaned = String(value)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .trim();
    if (!cleaned) {
        return null;
    }
    return cleaned.slice(0, MAX_LENGTHS[name]);
}

function rowToEntry(row) {
    return {
        sha256: row.sha256,
        addedAt: row.added_at,
        addedBy: row.added_by,
        note: row.note || null,
        originalName: row.original_name || null,
        signature: row.signature || null,
    };
}

//
//  Synchronous, for the scanner's hot path: the entry for |sha256|, or null
//  when it is not listed. Throws when the lookup itself fails (no database,
//  no table); the caller decides what that means -- for file scanning it is
//  "not allowlisted".
//
function lookup(sha256) {
    const key = normalizeSha256(sha256);
    if (!key) {
        return null;
    }
    const db = fileDb();
    if (!db) {
        throw Errors.UnexpectedState('The file database is not open');
    }
    const row = db
        .prepare(
            `SELECT sha256, added_at, added_by, note, original_name, signature
            FROM file_scan_allowlist
            WHERE sha256 = ?
            LIMIT 1;`
        )
        .get(key);
    return row ? rowToEntry(row) : null;
}

function get(sha256, cb) {
    if (!isValidSha256(sha256)) {
        return cb(Errors.Invalid('A SHA-256 is 64 hexadecimal digits'));
    }
    try {
        return cb(null, lookup(sha256));
    } catch (err) {
        return cb(err);
    }
}

//
//  entry: { sha256, addedBy, note?, originalName?, signature? }
//
//  Calls back (err, { added, entry }). A hash already listed is left as it
//  is -- who added it and when stay on record -- and |added| is false.
//
function add(entry, cb) {
    entry = entry || {};
    const sha256 = normalizeSha256(entry.sha256);
    if (!sha256) {
        return cb(Errors.Invalid('A SHA-256 is 64 hexadecimal digits'));
    }
    const addedBy = cleanColumn('added_by', entry.addedBy);
    if (!addedBy) {
        return cb(Errors.MissingParam('Who is adding the entry must be recorded'));
    }

    try {
        const db = fileDb();
        if (!db) {
            throw Errors.UnexpectedState('The file database is not open');
        }
        const info = db
            .prepare(
                `INSERT OR IGNORE INTO file_scan_allowlist
                    (sha256, added_at, added_by, note, original_name, signature)
                VALUES (?, ?, ?, ?, ?, ?);`
            )
            .run(
                sha256,
                new Date().toISOString(),
                addedBy,
                cleanColumn('note', entry.note),
                cleanColumn('original_name', entry.originalName),
                cleanColumn('signature', entry.signature)
            );

        const added = info.changes > 0;
        const row = lookup(sha256);
        if (added) {
            log(
                'info',
                {
                    sha256,
                    addedBy,
                    note: row.note,
                    originalName: row.originalName,
                    signature: row.signature,
                },
                'File scanning allowlist: hash added'
            );
        }
        return cb(null, { added, entry: row });
    } catch (err) {
        return cb(err);
    }
}

//  Calls back (err, removedEntry | null).
function remove(sha256, removedBy, cb) {
    const key = normalizeSha256(sha256);
    if (!key) {
        return cb(Errors.Invalid('A SHA-256 is 64 hexadecimal digits'));
    }

    try {
        const existing = lookup(key);
        if (!existing) {
            return cb(null, null);
        }
        fileDb().prepare(`DELETE FROM file_scan_allowlist WHERE sha256 = ?;`).run(key);
        log(
            'info',
            {
                sha256: key,
                removedBy: cleanColumn('added_by', removedBy) || 'unknown',
                addedBy: existing.addedBy,
                note: existing.note,
            },
            'File scanning allowlist: hash removed'
        );
        return cb(null, existing);
    } catch (err) {
        return cb(err);
    }
}

//  Every entry, oldest first.
function list(cb) {
    try {
        const db = fileDb();
        if (!db) {
            throw Errors.UnexpectedState('The file database is not open');
        }
        const rows = db
            .prepare(
                `SELECT sha256, added_at, added_by, note, original_name, signature
                FROM file_scan_allowlist
                ORDER BY added_at, sha256;`
            )
            .all();
        return cb(null, rows.map(rowToEntry));
    } catch (err) {
        return cb(err);
    }
}

//  File IDs of every entry whose file_sha256 is exactly |sha256|.
function getFileIdsBySha256(sha256, cb) {
    const key = normalizeSha256(sha256);
    if (!key) {
        return cb(Errors.Invalid('A SHA-256 is 64 hexadecimal digits'));
    }
    try {
        const rows = fileDb()
            .prepare(`SELECT file_id FROM file WHERE file_sha256 = ? ORDER BY file_id;`)
            .all(key);
        return cb(
            null,
            rows.map(r => r.file_id)
        );
    } catch (err) {
        return cb(err);
    }
}

//
//  After a hash is allowlisted: every entry with that hash that a scan or
//  rescan marked infected becomes scan_result=clean, scanner=allowlist, and
//  loses its scan_signature. Entries with any other result are left alone.
//
//  Calls back (err, [ fileId, ... ]) with the entries changed.
//
function markEntriesSafe(sha256, cb) {
    getFileIdsBySha256(sha256, (err, fileIds) => {
        if (err) {
            return cb(err);
        }
        if (0 === fileIds.length) {
            return cb(null, []);
        }

        let infectedIds;
        try {
            const placeholders = fileIds.map(() => '?').join(', ');
            infectedIds = fileDb()
                .prepare(
                    `SELECT DISTINCT file_id FROM file_meta
                    WHERE meta_name = 'scan_result' AND meta_value = 'infected'
                        AND file_id IN (${placeholders})
                    ORDER BY file_id;`
                )
                .all(...fileIds)
                .map(r => r.file_id);
        } catch (e) {
            return cb(e);
        }

        const FileEntry = require('./file_entry.js');
        const changed = [];
        const next = i => {
            if (i >= infectedIds.length) {
                return cb(null, changed);
            }
            const fileId = infectedIds[i];
            FileEntry.replaceMetaValues(
                fileId,
                {
                    scan_result: 'clean',
                    scanner: exports.ScannerName,
                    scan_signature: null,
                },
                err => {
                    if (err) {
                        return cb(err, changed);
                    }
                    changed.push(fileId);
                    return next(i + 1);
                }
            );
        };
        return next(0);
    });
}
