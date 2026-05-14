'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const Log = require('../logger').log;

//
//  FREQ (File REQuest) resolver for inbound BinkP sessions.
//
//  BinkP FREQ convention: the originating node transfers a file whose name
//  ends with ".req" (e.g. "0001000f.req"). Each line in the file is a
//  requested filename or magic name, optionally followed by a password
//  separated by "!" (FTS-0006 style, which we ignore for now).
//
//  Example .req content:
//    NODELIST
//    ALLFIX.NA
//    somefile.zip
//
//  FreqResolver resolves each name against:
//    1. A magic-name map  (config.magic)  — name → absolute file path
//    2. A list of search dirs (config.dirs) — searched in order; wildcards
//       are NOT expanded (plain filename match only); the newest matching
//       file in each dir is returned when multiple exist (e.g. NODELIST.365)
//
//  config keys (all optional):
//    magic    : { 'NODELIST': '/path/to/latest-nodelist', ... }
//    dirs     : ['/path/to/files', ...]
//    maxFiles : 10  — cap on files returned per session (default 10)
//    secure   : true — only honour FREQs from authenticated (P_SECURE) sessions
//

const DEFAULT_MAX_FILES = 10;
const REQ_FILE_RE = /\.req$/i;

class FreqResolver {
    constructor(config = {}) {
        this._magic = config.magic || {};
        this._dirs = config.dirs || [];
        this._maxFiles = typeof config.maxFiles === 'number' ? config.maxFiles : DEFAULT_MAX_FILES;
    }

    // Parse a .req temp file and resolve each name. Returns an array of
    // { filePath, name, size, timestamp } objects ready to pass to queueFile.
    // Names that can't be resolved are silently skipped (logged at debug level).
    async resolveReqFile(reqTempPath) {
        let text;
        try {
            text = await fsp.readFile(reqTempPath, 'utf8');
        } catch (err) {
            Log.warn({ path: reqTempPath, error: err.message }, '[BinkP/FREQ] Could not read .req file');
            return [];
        }

        const names = text
            .split(/\r?\n/)
            .map(line => line.split('!')[0].trim())  // strip optional password
            .filter(Boolean);

        return this._resolveNames(names);
    }

    // Resolve a list of raw requested names (no parsing). Used in tests.
    async resolveNames(names) {
        return this._resolveNames(names);
    }

    // ── Private ────────────────────────────────────────────────────────────────

    async _resolveNames(names) {
        const results = [];
        for (const name of names) {
            if (results.length >= this._maxFiles) {
                Log.debug(
                    { maxFiles: this._maxFiles },
                    '[BinkP/FREQ] Reached maxFiles limit; skipping remaining requests'
                );
                break;
            }
            const resolved = await this._resolveName(name);
            if (resolved) {
                results.push(resolved);
            } else {
                Log.debug({ name }, '[BinkP/FREQ] Could not resolve FREQ name');
            }
        }
        return results;
    }

    async _resolveName(name) {
        // 1. Magic name lookup (case-insensitive)
        const upperName = name.toUpperCase();
        for (const [magic, filePath] of Object.entries(this._magic)) {
            if (magic.toUpperCase() === upperName) {
                return this._statFile(filePath, path.basename(filePath));
            }
        }

        // 2. Search dirs — look for a file whose basename starts with |name|
        //    (case-insensitive prefix match), return the newest one found.
        //    This handles nodelist-style versioning: requesting "NODELIST"
        //    matches "NODELIST.365", "NODELIST.001", etc.
        for (const dir of this._dirs) {
            const found = await this._findInDir(dir, name);
            if (found) return found;
        }

        return null;
    }

    async _findInDir(dir, name) {
        let entries;
        try {
            entries = await fsp.readdir(dir);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                Log.warn({ dir, error: err.message }, '[BinkP/FREQ] Could not read FREQ dir');
            }
            return null;
        }

        const lowerName = name.toLowerCase();
        // Exact match first, then prefix match
        const exactMatch = entries.find(e => e.toLowerCase() === lowerName);
        if (exactMatch) {
            return this._statFile(path.join(dir, exactMatch), exactMatch);
        }

        // Prefix match: pick the newest file whose name starts with |name|
        const prefix = lowerName + '.';
        const candidates = entries.filter(e => e.toLowerCase().startsWith(prefix));
        if (candidates.length === 0) return null;

        let newest = null;
        let newestMtime = -1;
        for (const entry of candidates) {
            const filePath = path.join(dir, entry);
            try {
                const stat = await fsp.stat(filePath);
                if (!stat.isFile()) continue;
                if (stat.mtimeMs > newestMtime) {
                    newestMtime = stat.mtimeMs;
                    newest = { filePath, name: entry, size: stat.size, timestamp: Math.floor(stat.mtimeMs / 1000) };
                }
            } catch (_) {
                // skip
            }
        }
        return newest;
    }

    async _statFile(filePath, name) {
        try {
            const stat = await fsp.stat(filePath);
            if (!stat.isFile()) return null;
            return { filePath, name, size: stat.size, timestamp: Math.floor(stat.mtimeMs / 1000) };
        } catch (_) {
            return null;
        }
    }
}

//
//  parseReqFile — read a .req temp file and return requested names (stripped of
//  passwords). Called eagerly in the 'file-received' handler before the spool
//  moves or deletes the temp file.
//
async function parseReqFile(tempPath) {
    let text;
    try {
        text = await fsp.readFile(tempPath, 'utf8');
    } catch (err) {
        Log.warn({ path: tempPath, error: err.message }, '[BinkP/FREQ] Could not read .req file');
        return [];
    }
    return _splitReqContent(text);
}

//
//  readReqFileSync — synchronous variant for use inside EventEmitter listeners
//  where we must read the file before another listener (e.g. the BSO spool)
//  moves or unlinks it. For the tiny .req files used in FidoNet (typically
//  under 1 KB), synchronous I/O is acceptable.
//
function readReqFileSync(tempPath) {
    try {
        return _splitReqContent(fs.readFileSync(tempPath, 'utf8'));
    } catch (_) {
        return [];
    }
}

function _splitReqContent(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.split('!')[0].trim())
        .filter(Boolean);
}

//
//  attachFreqToSession — wire FREQ handling onto an answering BinkpSession.
//
//  Uses two events:
//    'incoming-file' — fires when M_FILE is received; calls holdEOB() for .req
//                      files so M_EOB is blocked while resolution is in-flight.
//    'file-received' — fires when the file is written; reads content, resolves
//                      names, queues responses, then calls releaseEOB().
//
//  The answering-side session already defers its own M_EOB until the remote's
//  M_EOB is received. Combined with holdEOB/releaseEOB, this ensures FREQ
//  responses are sent in the SAME session (before M_EOB goes out), regardless
//  of whether the .req write or the remote's M_EOB arrives first.
//
//  Must be called BEFORE other 'file-received' listeners so readReqFileSync
//  runs while the temp file is still in place.
//
//  opts:
//    requirePwd: boolean — if true, ignore FREQs from non-secure sessions
//    isSecure  : () => boolean — checked when incoming-file fires
//
function attachFreqToSession(session, resolver, opts = {}) {
    session.on('incoming-file', (name) => {
        if (!REQ_FILE_RE.test(name)) return;
        if (opts.requirePwd && !opts.isSecure()) return;
        //  Hold M_EOB as soon as we know a .req is coming in. This is before
        //  the async writeStream finishes, so it beats the _remoteEOB trigger.
        session.holdEOB();
    });

    session.on('file-received', (name, size, ts, tempPath) => {
        if (!REQ_FILE_RE.test(name)) return;

        if (opts.requirePwd && !opts.isSecure()) {
            session.releaseEOB();
            return;
        }

        const names = readReqFileSync(tempPath);

        resolver
            .resolveNames(names)
            .then(files => {
                for (const f of files) {
                    session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
                }
                if (files.length > 0) {
                    Log.info({ queued: files.length }, '[BinkP/FREQ] Queued FREQ responses');
                }
            })
            .catch(err => {
                Log.warn({ error: err.message }, '[BinkP/FREQ] resolveNames error');
            })
            .finally(() => session.releaseEOB());
    });
}

//  Kept for backwards compatibility / alternative use.
function createFreqFileReceivedHandler(session, resolver, opts = {}) {
    attachFreqToSession(session, resolver, opts);
}

//
//  createFreqOnBatchEnd — alternative hook for processing FREQs in a second
//  batch via the onBatchEnd mechanism. Useful when the receiver wants to
//  inspect the whole batch before deciding what to serve.
//
//  |pendingFreqNames| is populated by the caller using readReqFileSync() in
//  a 'file-received' listener (must run before any spool handler moves the
//  temp file).
//
function createFreqOnBatchEnd(pendingFreqNames, resolver, opts = {}) {
    return async function freqOnBatchEnd(session) {
        const names = pendingFreqNames.splice(0);
        if (names.length === 0) return;

        if (opts.requirePwd && !opts.isSecure()) {
            Log.info('[BinkP/FREQ] Ignoring FREQ from non-secure session (requirePwd=true)');
            return;
        }

        const files = await resolver.resolveNames(names).catch(err => {
            Log.warn({ error: err.message }, '[BinkP/FREQ] resolveNames error');
            return [];
        });

        for (const f of files) {
            session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
        }

        if (files.length > 0) {
            Log.info({ queued: files.length }, '[BinkP/FREQ] Queued FREQ responses for next batch');
        }
    };
}

module.exports = {
    FreqResolver,
    attachFreqToSession,
    createFreqFileReceivedHandler,  // alias for attachFreqToSession
    createFreqOnBatchEnd,
    parseReqFile,
    readReqFileSync,
    REQ_FILE_RE,
};
