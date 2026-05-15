'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { glob } = require('glob');

const Log = require('../logger').log;

//
//  FREQ (File REQuest) resolver for inbound BinkP sessions.
//
//  BinkP FREQ convention: the originating node transfers a file whose name
//  ends with ".req" (e.g. "0001000f.req"). Each line in the file is a
//  requested filename or magic name, optionally followed by a password
//  separated by "!" (FTS-0006 style, which we ignore).
//
//  Example .req content:
//    NODELIST
//    ALLFIX.NA
//    somefile.zip
//
//  FreqResolver resolves each name against three sources, in order:
//
//  1. Magic-name map  (config.magic)  — name → absolute file path (may
//     contain glob wildcards; the newest matching file is returned)
//  2. File base areas (config.areas)  — queries the ENiGMA file base by
//     area tag; exact name then prefix match; newest by upload_timestamp
//  3. Search dirs     (config.dirs)   — fs.readdir scan; exact name then
//     prefix match (e.g. NODELIST matches NODELIST.365); newest by mtime
//
//  config keys (all optional):
//    magic    : { 'NODELIST': '/path/to/NODELIST.*', ... }
//    areas    : [ { areaTag: 'nodelists' }, ... ]
//    dirs     : ['/path/to/files', ...]
//    maxFiles : 10  — cap on files returned per session (default 10)
//    secure   : true — only honour FREQs from authenticated (P_SECURE) sessions
//

const DEFAULT_MAX_FILES = 10;
const REQ_FILE_RE = /\.req$/i;

class FreqResolver {
    constructor(config = {}) {
        this._magic = config.magic || {};
        this._areas = config.areas || [];
        this._dirs  = config.dirs  || [];
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
            .map(line => line.split('!')[0].trim())
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
        // 1. Magic name lookup (case-insensitive; path may contain glob wildcards)
        const upperName = name.toUpperCase();
        for (const [magic, pattern] of Object.entries(this._magic)) {
            if (magic.toUpperCase() === upperName) {
                return this._resolveGlobPattern(pattern);
            }
        }

        // 2. File base area search
        for (const areaCfg of this._areas) {
            const found = await this._findInArea(areaCfg.areaTag, name);
            if (found) return found;
        }

        // 3. Directory search
        for (const dir of this._dirs) {
            const found = await this._findInDir(dir, name);
            if (found) return found;
        }

        return null;
    }

    // Resolve a path that may contain glob wildcards.  When the pattern has no
    // wildcards it behaves identically to the original static magic lookup.
    async _resolveGlobPattern(pattern) {
        if (!glob.hasMagic(pattern)) {
            return this._statFile(pattern, path.basename(pattern));
        }

        let matches;
        try {
            matches = await glob(pattern, { nodir: true });
        } catch (err) {
            Log.warn({ pattern, error: err.message }, '[BinkP/FREQ] Glob expansion error');
            return null;
        }

        if (matches.length === 0) return null;

        // Pick newest by mtime
        let newest = null;
        let newestMtime = -1;
        for (const filePath of matches) {
            try {
                const stat = await fsp.stat(filePath);
                if (stat.mtimeMs > newestMtime) {
                    newestMtime = stat.mtimeMs;
                    newest = {
                        filePath,
                        name: path.basename(filePath),
                        size: stat.size,
                        timestamp: Math.floor(stat.mtimeMs / 1000),
                    };
                }
            } catch (_) {
                // skip
            }
        }
        return newest;
    }

    // Query the ENiGMA file base for the named file within a given area.
    // Requires the file base database to be initialised (i.e. runs in the
    // main ENiGMA process; unit tests that don't load the full system should
    // not configure areas).
    async _findInArea(areaTag, name) {
        // Lazy-require to avoid pulling in the full file base on every require
        // of this module (important for test environments that stub the DB).
        let FileEntry;
        try {
            FileEntry = require('../file_entry.js');
        } catch (_) {
            return null;
        }

        const lowerName = name.toLowerCase();

        return new Promise(resolve => {
            FileEntry.findFiles(
                {
                    areaTag,
                    sort: 'upload_timestamp',
                    order: 'descending',
                },
                (err, fileIds) => {
                    if (err || !fileIds || fileIds.length === 0) {
                        return resolve(null);
                    }

                    // Walk file IDs (newest first) and pick the first that
                    // matches by exact name or prefix.
                    const prefix = lowerName + '.';
                    let idx = 0;

                    const next = () => {
                        if (idx >= fileIds.length) return resolve(null);
                        const fileId = fileIds[idx++];

                        FileEntry.loadBasicEntry(fileId, {}, (loadErr, entry) => {
                            if (loadErr) return next();
                            const entryName = (entry.fileName || '').toLowerCase();
                            if (
                                entryName === lowerName ||
                                entryName.startsWith(prefix)
                            ) {
                                // Build the result the same way _statFile does.
                                // entry.filePath is a getter on the FileEntry
                                // class; loadBasicEntry populates a plain object
                                // so we resolve the path manually.
                                let filePath;
                                try {
                                    const fe = new FileEntry(entry);
                                    filePath = fe.filePath;
                                } catch (_) {
                                    return next();
                                }

                                fsp.stat(filePath)
                                    .then(stat => {
                                        resolve({
                                            filePath,
                                            name: entry.fileName,
                                            size: stat.size,
                                            timestamp: Math.floor(stat.mtimeMs / 1000),
                                        });
                                    })
                                    .catch(() => next());
                            } else {
                                next();
                            }
                        });
                    };

                    next();
                }
            );
        });
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
        const exactMatch = entries.find(e => e.toLowerCase() === lowerName);
        if (exactMatch) {
            return this._statFile(path.join(dir, exactMatch), exactMatch);
        }

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
//  moves or unlinks it.
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
//  batch via the onBatchEnd mechanism.
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
    createFreqFileReceivedHandler,
    createFreqOnBatchEnd,
    parseReqFile,
    readReqFileSync,
    REQ_FILE_RE,
};
