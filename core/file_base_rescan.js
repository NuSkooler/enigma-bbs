/* jslint node: true */
'use strict';

//
//  Rescanning the existing file base with the configured file scanners
//  (#291, phase 3). New signatures arrive daily; a file that was clean when
//  it was uploaded may not be today.
//
//  Two ways in, one engine (rescanFileBase()):
//
//    - an event scheduler task, @method:core/file_base_rescan.js:
//      rescanFileBaseScheduledEvent (the built-in, manual-only
//      rescanFileBase event), which also shows in the WFC task list;
//    - oputil fb virus-scan.
//
//  A rescan only REPORTS. It never moves, quarantines or deletes a file and
//  never removes an entry: what to do about an infected file that may have
//  sat in the base for years is the operator's call. Per entry, by verdict:
//
//    clean             scan_result=clean, scanned_at, scanner; any old
//                      scan_signature is dropped
//    skipped           scanners ran and had no opinion. scan_result=skipped
//                      and scanned_at -- unless the entry was already clean
//                      or infected, which a "no opinion" does not overturn:
//                      then only scanner (and the attempt time) change
//    infected          scan_result=infected, scanned_at, scanner and
//                      scan_signature; reported, with the command that
//                      removes it, on every run until the operator does
//    held              the scanner failed or timed out: reported as "could
//                      not be checked"; scanned_at is not touched
//    missing / error   reported; nothing else
//
//  Every outcome records rescan_attempted_at, and candidates are taken
//  never-attempted first, then oldest attempt first: a run capped by
//  maxFiles always moves on, even past entries that never scan. Entries no
//  scanner entry would scan (fileTypes) are left out before the cap.
//
//  Only files inside their storage directory are read: a path through a
//  symbolic link (a linked subdirectory or the file itself) is an error, the
//  file is opened once without following links and must be a regular file,
//  and its hash comes from that open file. The scanners then read it by
//  path, so afterwards the path must still name the same, unchanged file, or
//  nothing is recorded.
//
//  Files are scanned ONE AT A TIME, so a rescan holds at most one of the
//  global scanner slots (fileBase.scanning.maxConcurrent) and never starves
//  uploads or TIC imports. A run stops early when several files in a row
//  could not be checked: the scanner is most likely down.
//
//  The operators get ONE inbox notice per run, and only when something needs
//  them.
//

//  ENiGMA½
const FileScanner = require('./file_scanner.js');
const { Errors, ErrorCodes } = require('./enig_error.js');

//
//  Read through config.js rather than capturing its |get|: config.js replaces
//  that export when the system configuration is created, and tests push their
//  own. file_entry.js and file_base_area.js capture the file database when
//  they load, so they are required on use, never here.
//
const configModule = require('./config.js');
const Config = () => configModule.get();

//  deps
const _ = require('lodash');
const fs = require('graceful-fs');
const fsp = require('fs').promises;
const paths = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

exports.rescanFileBase = rescanFileBase;
exports.rescanFileBaseScheduledEvent = rescanFileBaseScheduledEvent;
exports.getRescanReadyError = getRescanReadyError;
exports.parseTaskArgs = parseTaskArgs;
exports.formatSummary = formatSummary;
exports.buildRescanNotice = buildRescanNotice;
exports.removeCommand = removeCommand;
exports.isRunning = () => running;

//  What happened to one entry
const RescanResults = (exports.RescanResults = {
    Clean: 'clean',
    Skipped: 'skipped', //  scanners ran; none said clean, none rejected
    NotScanned: 'not_scanned', //  no scanner entry matched after all
    Infected: 'infected',
    Held: 'held', //  could not be checked: a scanner failed or timed out
    Missing: 'missing', //  the physical file is not there
    Error: 'error', //  anything else that stopped the entry being checked
});

const DAY_MS = 24 * 60 * 60 * 1000;

//  This many held results in a row and the run stops: the scanner is down.
const DEFAULT_STOP_AFTER_HELD = 5;
exports.DefaultStopAfterHeld = DEFAULT_STOP_AFTER_HELD;

//  Longest signature kept in scan_signature.
const MAX_SIGNATURE_LENGTH = 128;

//  Most files of each kind a notice lists; the rest are counted.
const MAX_NOTICE_FILES_PER_SECTION = 25;
//  The message reader wraps at 79 columns (see file_scanner.js).
const NOTICE_LINE_WIDTH = 79;

//  Not following a final symbolic link, and not blocking on a FIFO swapped
//  in under the name. Neither exists on Windows, where lstat() stands in for
//  the first (see openEntryFile()).
const OPEN_FLAGS =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0);

//  One run at a time per process, whichever way it was started. oputil is
//  another process: a rescan there alongside the BBS task is not locked out,
//  which is harmless as neither changes anything but scan meta.
let running = false;

//  oputil runs without the logger.
function log(level, obj, msg) {
    const Log = require('./logger.js').log;
    if (Log) {
        return Log[level](obj, msg);
    }
}

function fileEntryClass() {
    return require('./file_entry.js');
}

//  The command that removes an entry and its file. "fb rm" takes a file ID;
//  --phys-file deletes the file as well, which without it stays on disk
//  where a later "fb scan" would import it again.
function removeCommand(fileId) {
    return `./oputil.js fb rm ${fileId} --phys-file`;
}

// ── Readiness ────────────────────────────────────────────────────────────────

//  Enabled entries that would run for the rescan source, fileTypes aside.
function rescanScannerEntries() {
    const scanners = _.get(Config(), 'fileBase.scanning.scanners');
    if (!Array.isArray(scanners)) {
        return [];
    }
    return scanners.filter(
        e =>
            e &&
            _.isString(e.scanner) &&
            e.scanner &&
            false !== e.enabled &&
            (!Array.isArray(e.sources) ||
                e.sources.includes(FileScanner.ScanSources.Rescan)) &&
            !(Array.isArray(e.fileTypes) && !e.fileTypes.some(_.isString))
    );
}

//
//  Why a rescan cannot run right now, as an Error, or null if it can. A run
//  that could only hold every file (no scanner for it, or one that is not
//  registered) is refused rather than started.
//
function getRescanReadyError() {
    if (!FileScanner.isEnabled()) {
        return Errors.MissingConfig(
            'File scanning is disabled (fileBase.scanning.enabled); there is nothing to rescan with'
        );
    }

    if (0 === rescanScannerEntries().length) {
        return Errors.MissingConfig(
            'No fileBase.scanning.scanners entry scans the "rescan" source; add "rescan" to an entry\'s "sources", or leave "sources" out'
        );
    }

    if (!FileScanner.isModRegistrationComplete()) {
        return Errors.UnexpectedState(
            'Scanners from mods are not registered yet; try again once the BBS has started'
        );
    }

    const missing = FileScanner.getUnavailableScanners(FileScanner.ScanSources.Rescan);
    if (missing.length > 0) {
        return Errors.MissingConfig(
            `Scanner(s) not registered: ${missing.join(
                ', '
            )}. Every file would be held; check the mod providing it is installed and loads`
        );
    }

    if (running) {
        return Errors.UnexpectedState('A file base rescan is already running');
    }

    return null;
}

// ── Candidates ───────────────────────────────────────────────────────────────

function internalAreaTags() {
    const { WellKnownAreaTags } = require('./file_base_area.js');
    return [WellKnownAreaTags.MessageAreaAttach, WellKnownAreaTags.TempDownloads];
}

//
//  Area tags (simple wildcards allowed) to the configured, non-internal areas
//  they name. A tag that names nothing is an error rather than quietly
//  scanning less than asked.
//
function resolveAreaTags(areaTags) {
    const FileBaseArea = require('./file_base_area.js');
    const configured = Object.keys(_.get(Config(), 'fileBase.areas') || {}).filter(
        tag => !FileBaseArea.isInternalArea(tag)
    );

    if (null === areaTags) {
        return { areaTags: configured }; //  not specified: every area
    }

    const resolved = new Set();
    for (const rule of areaTags) {
        const matches = /[*?]/.test(rule)
            ? FileBaseArea.getFileAreasByTagWildcardRule(rule).map(a => a.areaTag)
            : configured.filter(tag => tag === rule);
        if (0 === matches.length) {
            return {
                error: Errors.DoesNotExist(`No file base area matches "${rule}"`),
            };
        }
        matches.forEach(tag => resolved.add(tag));
    }
    return { areaTags: Array.from(resolved) };
}

function parseTime(s) {
    const t = s ? Date.parse(s) : NaN;
    return _.isFinite(t) ? t : null; //  unreadable: as if never
}

//
//  The olderThanDays filter goes by scanned_at (never scanned always
//  qualifies); the order by the last attempt -- or, for an entry no rescan
//  has tried yet, the scan it had on the way in -- oldest first, so that
//  capped runs work through the whole selection in turn.
//
function orderAndFilterCandidates(rows, olderThanDays) {
    const cutoff = _.isFinite(olderThanDays) ? Date.now() - olderThanDays * DAY_MS : null;

    return rows
        .map(row => {
            const scannedAtMs = parseTime(row.scannedAt);
            const attemptedAtMs = parseTime(row.attemptedAt);
            return Object.assign({}, row, {
                scannedAtMs,
                orderMs: null !== attemptedAtMs ? attemptedAtMs : scannedAtMs,
            });
        })
        .filter(
            row => null === cutoff || null === row.scannedAtMs || row.scannedAtMs < cutoff
        )
        .sort((a, b) => {
            if (a.orderMs !== b.orderMs) {
                if (null === a.orderMs) {
                    return -1;
                }
                if (null === b.orderMs) {
                    return 1;
                }
                return a.orderMs - b.orderMs;
            }
            return a.fileId - b.fileId;
        });
}

// ── One entry ────────────────────────────────────────────────────────────────

function fail(result, kind, error) {
    result.result = kind;
    if (error) {
        result.error = error;
    }
    return null;
}

//
//  The entry's file, opened: { path, fd, stats, parent, realParent }, or
//  null with |result| finished as Missing or Error. See the top of this file
//  for what is refused.
//
async function openEntryFile(entry, result) {
    const FileEntry = fileEntryClass();
    const storageTags = _.get(Config(), 'fileBase.storageTags') || {};
    if (!entry.storageTag || !_.has(storageTags, entry.storageTag)) {
        //  getAreaStorageDirectoryByTag() would fall back to the storage
        //  prefix itself, and a file of the same name there is not this one
        return fail(
            result,
            RescanResults.Error,
            `Unknown storage tag "${entry.storageTag}"`
        );
    }

    let filePath;
    try {
        filePath = entry.filePath; //  throws on a rel path leaving the storage dir
    } catch (e) {
        return fail(result, RescanResults.Error, e.message);
    }
    result.path = filePath;

    const storageDir = paths.resolve(
        FileEntry.getAreaStorageDirectoryByTag(entry.storageTag)
    );
    const parent = paths.dirname(filePath);

    let realParent;
    try {
        //  the storage directory itself may be a link (another disk, say)
        const realStorage = await fsp.realpath(storageDir);
        realParent = await fsp.realpath(parent);
        const expected = paths.join(realStorage, paths.relative(storageDir, parent));
        if (realParent !== expected) {
            return fail(
                result,
                RescanResults.Error,
                'Its path goes through a symbolic link; not read'
            );
        }
    } catch (err) {
        if ('ENOENT' === err.code || 'ENOTDIR' === err.code) {
            return fail(result, RescanResults.Missing);
        }
        return fail(result, RescanResults.Error, err.message);
    }

    if (!fs.constants.O_NOFOLLOW) {
        try {
            if ((await fsp.lstat(filePath)).isSymbolicLink()) {
                return fail(
                    result,
                    RescanResults.Error,
                    'It is a symbolic link; not read'
                );
            }
        } catch (err) {
            if ('ENOENT' === err.code) {
                return fail(result, RescanResults.Missing);
            }
            return fail(result, RescanResults.Error, err.message);
        }
    }

    let fd;
    try {
        fd = await promisify(fs.open)(filePath, OPEN_FLAGS);
    } catch (err) {
        if ('ENOENT' === err.code) {
            return fail(result, RescanResults.Missing);
        }
        if ('ELOOP' === err.code || 'EMLINK' === err.code) {
            return fail(result, RescanResults.Error, 'It is a symbolic link; not read');
        }
        return fail(result, RescanResults.Error, err.message);
    }

    try {
        const stats = await promisify(fs.fstat)(fd);
        if (!stats.isFile()) {
            await closeQuietly(fd);
            return fail(result, RescanResults.Error, 'Not a regular file');
        }
        return { path: filePath, fd, stats, parent, realParent };
    } catch (err) {
        await closeQuietly(fd);
        return fail(result, RescanResults.Error, err.message);
    }
}

function closeQuietly(fd) {
    return new Promise(resolve => fs.close(fd, () => resolve()));
}

//  SHA-256 and size, from the open file as it is now: an entry's stored hash
//  may be stale, and a hash lookup scanner must see the real one.
function hashFd(fd) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        let byteSize = 0;
        const stream = fs.createReadStream(null, { fd, autoClose: false, start: 0 });
        stream.on('data', chunk => {
            byteSize += chunk.length;
            hash.update(chunk);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve({ sha256: hash.digest('hex'), byteSize }));
    });
}

//  After the scan: the path still names the file that was hashed, unchanged,
//  and still inside the storage directory.
async function stillTheSameFile(opened) {
    try {
        const [now, atPath, realParent] = await Promise.all([
            promisify(fs.fstat)(opened.fd),
            fsp.lstat(opened.path),
            fsp.realpath(opened.parent),
        ]);
        return (
            !atPath.isSymbolicLink() &&
            atPath.ino === opened.stats.ino &&
            atPath.dev === opened.stats.dev &&
            now.size === opened.stats.size &&
            now.mtimeMs === opened.stats.mtimeMs &&
            realParent === opened.realParent
        );
    } catch (e) {
        return false;
    }
}

function scanFile(filePath, ctx) {
    return new Promise(resolve => {
        FileScanner.scanFile(filePath, ctx, (err, verdict) => resolve({ err, verdict }));
    });
}

function loadEntry(fileId) {
    const FileEntry = fileEntryClass();
    const entry = new FileEntry();
    return new Promise((resolve, reject) => {
        FileEntry.loadBasicEntry(fileId, entry, err => {
            if (err) {
                return reject(err);
            }
            entry.loadMeta(err => (err ? reject(err) : resolve(entry)));
        });
    });
}

function scannerNames(verdict) {
    return _.uniq((verdict.results || []).map(r => r.scanner)).join(',');
}

function cleanSignature(signature) {
    return FileScanner.cleanDisplayText(signature, MAX_SIGNATURE_LENGTH) || null;
}

//  The meta a result leaves behind; see the top of this file.
function metaFor(result, entry, now) {
    const values = { rescan_attempted_at: now };
    const verdict = result.verdict;

    switch (result.result) {
        case RescanResults.Clean:
            return Object.assign(values, {
                scan_result: FileScanner.Verdicts.Clean,
                scanned_at: now,
                scanner: scannerNames(verdict),
                scan_signature: null,
            });

        case RescanResults.Skipped:
            if (result.keptResult) {
                return Object.assign(values, { scanner: scannerNames(verdict) });
            }
            return Object.assign(values, {
                scan_result: FileScanner.Verdicts.Skipped,
                scanned_at: now,
                scanner: scannerNames(verdict),
                scan_signature: null,
            });

        case RescanResults.Infected:
            return Object.assign(values, {
                scan_result: FileScanner.Verdicts.Infected,
                scanned_at: now,
                scanner: scannerNames(verdict),
                scan_signature: cleanSignature(verdict.signature) || 'unnamed threat',
            });

        default:
            return values;
    }
}

function recordMeta(fileId, values) {
    return new Promise(resolve => {
        fileEntryClass().replaceMetaValues(fileId, values, err => resolve(err));
    });
}

//
//  Resolves to the entry's result, or null when the entry has gone since the
//  candidates were listed. Never rejects.
//
async function rescanEntry(fileId, options) {
    const result = { fileId };
    let entry;

    try {
        entry = await loadEntry(fileId);
    } catch (err) {
        if (ErrorCodes.DoesNotExist === err.code) {
            return null; //  removed since the candidates were listed
        }
        return (
            fail(
                result,
                RescanResults.Error,
                `Could not load the entry: ${err.message}`
            ) || result
        );
    }

    result.fileName = entry.fileName;
    result.areaTag = entry.areaTag;
    result.storageTag = entry.storageTag;

    let opened = null;
    try {
        opened = await openEntryFile(entry, result);
        if (opened) {
            await checkOpenedFile(entry, opened, result);
        }
    } catch (err) {
        fail(result, RescanResults.Error, err.message);
    } finally {
        if (opened) {
            await closeQuietly(opened.fd);
        }
    }

    if (!options.dryRun) {
        const err = await recordMeta(
            fileId,
            metaFor(result, entry, new Date().toISOString())
        );
        if (err) {
            result.error = `Could not record the result: ${err.message}`;
        }
    }

    return result;
}

async function checkOpenedFile(entry, opened, result) {
    const hashed = await hashFd(opened.fd);
    result.sha256 = hashed.sha256;
    result.byteSize = hashed.byteSize;
    if (entry.fileSha256 && entry.fileSha256 !== hashed.sha256) {
        result.hashChanged = true;
    }

    const { err, verdict } = await scanFile(opened.path, {
        source: FileScanner.ScanSources.Rescan,
        fileName: entry.fileName,
        areaTag: entry.areaTag,
        fileId: entry.fileId,
        sha256: hashed.sha256,
        byteSize: hashed.byteSize,
    });

    if (err && !FileScanner.isFileRejected(err)) {
        return fail(result, RescanResults.Error, err.message);
    }

    if (!(await stillTheSameFile(opened))) {
        return fail(
            result,
            RescanResults.Error,
            'The file changed or moved while it was being scanned; nothing recorded'
        );
    }

    result.verdict = verdict;

    switch (verdict.result) {
        case FileScanner.Verdicts.Clean:
            result.result = RescanResults.Clean;
            break;

        case FileScanner.Verdicts.Skipped: {
            result.result = RescanResults.Skipped;
            const prev = entry.meta.scan_result;
            //  "no opinion" does not overturn an earlier verdict
            if (
                FileScanner.Verdicts.Clean === prev ||
                FileScanner.Verdicts.Infected === prev
            ) {
                result.keptResult = prev;
                if (FileScanner.Verdicts.Infected === prev) {
                    result.keptSignature = entry.meta.scan_signature || null;
                }
            }
            break;
        }

        case FileScanner.Verdicts.Infected:
            result.result = RescanResults.Infected;
            break;

        case FileScanner.Verdicts.Held:
            result.result = RescanResults.Held;
            break;

        default:
            result.result = RescanResults.NotScanned;
            break;
    }
}

// ── The run ──────────────────────────────────────────────────────────────────

function newSummary(options) {
    return {
        dryRun: !!options.dryRun,
        startedAt: new Date(),
        durationMs: 0,
        matched: 0, //  entries that matched the filters and some scanner
        unmatched: 0, //  left out: no scanner entry's fileTypes covers them
        checked: 0, //  of those, entries this run looked at (maxFiles)
        remaining: 0, //  matched but left for a later run
        counts: _.mapValues(_.invert(RescanResults), () => 0),
        stillInfected: 0, //  skipped this time, still marked infected
        errors: 0, //  entries with an error
        hashChanged: 0,
        stoppedEarly: null, //  why the run stopped before the end
        warning: null,
        files: [],
    };
}

function tally(summary, result) {
    summary.files.push(result);
    summary.counts[result.result] += 1;
    if (result.error) {
        summary.errors += 1;
    }
    if (result.hashChanged) {
        summary.hashChanged += 1;
    }
    if (FileScanner.Verdicts.Infected === result.keptResult) {
        summary.stillInfected += 1;
    }
}

function isInfected(r) {
    return (
        RescanResults.Infected === r.result ||
        FileScanner.Verdicts.Infected === r.keptResult
    );
}

//  Files the operator should look at, each counted once.
function attentionFiles(summary) {
    return summary.files.filter(
        r =>
            isInfected(r) ||
            RescanResults.Held === r.result ||
            RescanResults.Missing === r.result ||
            !!r.error
    );
}

//
//  options: {
//      areaTags:       [ tag, ... ]; simple wildcards (*, ?) allowed
//      fileIds:        [ id, ... ]; specific entries (oputil criteria)
//                      Neither given: every area. Either given: just what
//                      they select -- an empty selection is nothing at all
//      olderThanDays:  only entries never scanned, or last scanned more
//                      than this many days ago. Unset: every entry
//      maxFiles:       check at most this many entries this run (never
//                      attempted first, then the oldest attempt); the rest
//                      are counted as remaining
//      dryRun:         scan and report only: no meta, no notice
//      notify:         false: no operator notice (default true)
//      stopAfterHeld:  stop after this many held results in a row
//                      (default 5; 0: never)
//      ranBy:          who ran it, for the notice: 'oputil', 'task', ...
//      onFileResult:   fn(result), called as each entry is done
//  }
//
//  Calls back (err) when the run could not start (see getRescanReadyError()),
//  else (null, summary). Per-entry trouble is in the summary, never an err.
//
function rescanFileBase(options, cb) {
    options = Object.assign({ notify: true }, options);

    const notReady = getRescanReadyError();
    if (notReady) {
        return cb(notReady);
    }

    const specified = !_.isUndefined(options.areaTags) || !_.isUndefined(options.fileIds);
    const fileIds = Array.isArray(options.fileIds) ? options.fileIds : [];
    let areaTags = [];
    if (!specified || (Array.isArray(options.areaTags) && options.areaTags.length > 0)) {
        const resolved = resolveAreaTags(specified ? options.areaTags : null);
        if (resolved.error) {
            return cb(resolved.error);
        }
        areaTags = resolved.areaTags;
    }

    running = true;
    const summary = newSummary(options);

    runRescan(options, summary, areaTags, fileIds)
        .catch(err => err)
        .then(err => {
            running = false;
            summary.durationMs = Date.now() - summary.startedAt.getTime();
            if (err) {
                log('error', { error: err.message }, 'File base rescan failed');
                return cb(err);
            }
            return finishRun(options, summary, cb);
        });
}

async function runRescan(options, summary, areaTags, fileIds) {
    if (0 === areaTags.length && 0 === fileIds.length) {
        summary.warning = 'Nothing was selected';
        return;
    }

    const rows = await new Promise((resolve, reject) => {
        fileEntryClass().getRescanCandidates(
            { areaTags, fileIds, excludeAreaTags: internalAreaTags() },
            (err, rows) => (err ? reject(err) : resolve(rows))
        );
    });

    let candidates = orderAndFilterCandidates(rows, options.olderThanDays).filter(row => {
        const matches = FileScanner.hasMatchingScanner({
            source: FileScanner.ScanSources.Rescan,
            fileName: row.fileName,
        });
        if (!matches) {
            summary.unmatched += 1;
        }
        return matches;
    });

    summary.matched = candidates.length;
    if (_.isFinite(options.maxFiles) && options.maxFiles >= 0) {
        summary.remaining = Math.max(0, candidates.length - options.maxFiles);
        candidates = candidates.slice(0, options.maxFiles);
    }

    log(
        'info',
        {
            matched: summary.matched,
            unmatched: summary.unmatched,
            toCheck: candidates.length,
            dryRun: summary.dryRun,
            ranBy: options.ranBy,
        },
        'File base rescan starting'
    );

    const stopAfterHeld = _.isFinite(options.stopAfterHeld)
        ? options.stopAfterHeld
        : DEFAULT_STOP_AFTER_HELD;
    let heldInARow = 0;

    //  one at a time: see the top of this file
    for (let i = 0; i < candidates.length; ++i) {
        let result;
        try {
            result = await rescanEntry(candidates[i].fileId, options);
        } catch (e) {
            //  one entry's surprise is that entry's error, not the run's end
            result = {
                fileId: candidates[i].fileId,
                fileName: candidates[i].fileName,
                result: RescanResults.Error,
                error: e.message,
            };
        }
        if (result) {
            summary.checked += 1;
            tally(summary, result);
            logResult(result, summary.dryRun);
            if (_.isFunction(options.onFileResult)) {
                try {
                    options.onFileResult(result);
                } catch (e) {
                    log(
                        'warn',
                        { error: e.message },
                        'File base rescan progress callback failed'
                    );
                }
            }

            if (RescanResults.Held === result.result) {
                heldInARow += 1;
            } else if (
                [
                    RescanResults.Clean,
                    RescanResults.Skipped,
                    RescanResults.Infected,
                ].includes(result.result)
            ) {
                heldInARow = 0;
            }

            if (stopAfterHeld > 0 && heldInARow >= stopAfterHeld) {
                summary.remaining += candidates.length - (i + 1);
                summary.stoppedEarly = `The scanner appears to be down: ${heldInARow} files in a row could not be checked, so the run stopped after ${summary.checked} file${
                    1 === summary.checked ? '' : 's'
                }`;
                break;
            }
        }
        //  a fresh stack between files
        await new Promise(resolve => setImmediate(resolve));
    }

    const c = summary.counts;
    if (
        c[RescanResults.Clean] + c[RescanResults.Skipped] + c[RescanResults.Infected] ===
        0
    ) {
        summary.warning =
            summary.checked > 0
                ? 'No file was actually scanned this run'
                : summary.unmatched > 0
                  ? 'No selected file is one any scanner entry scans (fileTypes)'
                  : 'No file was selected';
    }
}

function finishRun(options, summary, cb) {
    const logObj = {
        dryRun: summary.dryRun,
        matched: summary.matched,
        unmatched: summary.unmatched,
        checked: summary.checked,
        remaining: summary.remaining,
        counts: summary.counts,
        stillInfected: summary.stillInfected,
        errors: summary.errors,
        hashChanged: summary.hashChanged,
        stoppedEarly: summary.stoppedEarly,
        warning: summary.warning,
        durationMs: summary.durationMs,
        ranBy: options.ranBy,
    };
    const worrying =
        summary.errors > 0 ||
        summary.counts[RescanResults.Held] > 0 ||
        summary.stoppedEarly ||
        (summary.warning && summary.checked > 0);
    log(worrying ? 'warn' : 'info', logObj, 'File base rescan finished');

    if (
        summary.dryRun ||
        false === options.notify ||
        0 === attentionFiles(summary).length
    ) {
        return cb(null, summary);
    }

    const { subject, body } = buildRescanNotice(summary, options);
    FileScanner.sendOperatorNotice(subject, body, () => cb(null, summary));
}

function logResult(result, dryRun) {
    const obj = {
        fileId: result.fileId,
        fileName: result.fileName,
        areaTag: result.areaTag,
        path: result.path,
        result: result.result,
        dryRun,
    };
    if (result.verdict) {
        obj.scanner = result.verdict.scanner;
        obj.signature = result.verdict.signature;
        obj.detail = result.verdict.detail;
    }
    if (result.keptResult) {
        obj.keptResult = result.keptResult;
    }
    if (result.hashChanged) {
        obj.hashChanged = true;
    }
    if (result.error) {
        obj.error = result.error;
    }

    let level = result.error ? 'warn' : 'debug';
    let msg = 'File base rescan: file checked';
    switch (result.result) {
        case RescanResults.Infected:
            level = 'warn';
            msg =
                'File base rescan: infected file in the file base (reported, not moved)';
            break;
        case RescanResults.Held:
            level = 'warn';
            msg = 'File base rescan: file could not be checked';
            break;
        case RescanResults.Missing:
            level = 'warn';
            msg = 'File base rescan: physical file is missing';
            break;
        case RescanResults.Error:
            level = 'warn';
            msg = 'File base rescan: file could not be checked';
            break;
        default:
            if (FileScanner.Verdicts.Infected === result.keptResult) {
                level = 'warn';
                msg =
                    'File base rescan: file still marked infected (scanners had no opinion)';
            }
            break;
    }
    log(level, obj, msg);
}

// ── Reporting ────────────────────────────────────────────────────────────────

//  One line (or a few), e.g. "Checked 12 of 40 matching files: 10 clean, ..."
function formatSummary(summary) {
    const c = summary.counts;
    const stillInfected = summary.stillInfected || 0;
    const infected = c[RescanResults.Infected] + stillInfected;
    const parts = [
        `${c[RescanResults.Clean]} clean`,
        `${c[RescanResults.Skipped] - stillInfected} skipped`,
        `${infected} infected`,
        `${c[RescanResults.Held]} could not be checked`,
        `${c[RescanResults.Missing]} missing`,
    ];
    if (c[RescanResults.NotScanned] > 0) {
        parts.push(`${c[RescanResults.NotScanned]} not matched by any scanner`);
    }
    parts.push(`${summary.errors} error${1 === summary.errors ? '' : 's'}`);

    let text = `${summary.dryRun ? 'DRY RUN, nothing recorded. ' : ''}Checked ${
        summary.checked
    } of ${summary.matched} matching file${1 === summary.matched ? '' : 's'}: ${parts.join(
        ', '
    )}.`;
    if (summary.unmatched > 0) {
        text += ` ${summary.unmatched} left out: no scanner entry scans their type.`;
    }
    if (summary.hashChanged > 0) {
        text += ` ${summary.hashChanged} file${
            1 === summary.hashChanged ? ' has' : 's have'
        } changed since import.`;
    }
    if (summary.remaining > 0) {
        text += ` ${summary.remaining} left for a later run.`;
    }
    if (summary.stoppedEarly) {
        text += ` ${summary.stoppedEarly}.`;
    }
    if (summary.warning) {
        text += ` Warning: ${summary.warning}.`;
    }
    if (infected > 0 && !summary.dryRun) {
        text +=
            ' Nothing was moved or removed: remove infected files with "fb rm FILE_ID --phys-file".';
    }
    return text;
}

//  From outside (file names, scanner output): no pipe codes, capped.
function clean(s, maxLength) {
    return FileScanner.cleanDisplayText(_.isNil(s) ? s : String(s), maxLength);
}

function noticeLine(label, value) {
    const line = `${`${label} `.padEnd(9)}${value}`;
    return line.length > NOTICE_LINE_WIDTH
        ? `${line.slice(0, NOTICE_LINE_WIDTH - 3)}...`
        : line;
}

//  A path keeps its end, where the file name is.
function noticePath(p) {
    const text = clean(p, Infinity) || '?';
    const max = NOTICE_LINE_WIDTH - 9;
    return text.length > max ? `...${text.slice(-(max - 3))}` : text;
}

//  Wrapped to the notice width at spaces.
function wrap(text) {
    const lines = [];
    let line = '';
    text.split(' ').forEach(word => {
        if (line && line.length + 1 + word.length > NOTICE_LINE_WIDTH) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    });
    if (line) {
        lines.push(line);
    }
    return lines.map(l =>
        l.length > NOTICE_LINE_WIDTH ? l.slice(0, NOTICE_LINE_WIDTH) : l
    );
}

function fileLines(r) {
    const lines = [
        noticeLine('File:', clean(r.fileName) || '?'),
        noticeLine('Area:', clean(r.areaTag) || '?'),
        noticeLine('File ID:', `${r.fileId}`),
    ];
    if (r.sha256) {
        lines.push(noticeLine('SHA-256:', clean(r.sha256, 64)));
    }
    if (r.verdict && r.verdict.scanner) {
        lines.push(noticeLine('Scanner:', clean(r.verdict.scanner)));
    }
    return lines;
}

//
//  The run's one inbox notice. Everything from outside goes through
//  FileScanner.cleanDisplayText(), as in the upload/TIC notices: no pipe
//  codes, no runs of white space, no line wider than the reader wraps at.
//
function buildRescanNotice(summary, options) {
    options = options || {};
    const lines = [];
    const by = options.ranBy ? ` (${clean(options.ranBy, 40)})` : '';

    lines.push(
        ...wrap(
            `File base rescan${by}. A rescan only reports: nothing was moved or removed.`
        )
    );
    lines.push(...wrap(formatSummary(summary)));
    lines.push('');

    const section = (title, results, describe) => {
        if (0 === results.length) {
            return;
        }
        lines.push(...wrap(title));
        lines.push('');
        results.slice(0, MAX_NOTICE_FILES_PER_SECTION).forEach(r => {
            lines.push(...fileLines(r), ...describe(r), '');
        });
        const more = results.length - MAX_NOTICE_FILES_PER_SECTION;
        if (more > 0) {
            lines.push(`...and ${more} more; see the log.`, '');
        }
    };

    const infected = summary.files.filter(isInfected);
    section('INFECTED (still in the file base):', infected, r => {
        const out = [];
        if (RescanResults.Infected === r.result) {
            out.push(
                noticeLine(
                    'Result:',
                    `infected: ${clean(r.verdict && r.verdict.signature) || 'unnamed threat'}`
                )
            );
        } else {
            out.push(
                noticeLine(
                    'Result:',
                    `still marked infected: ${clean(r.keptSignature) || 'unnamed threat'}`
                )
            );
            out.push(noticeLine('', '(the scanners had no opinion this time)'));
        }
        out.push(noticeLine('Remove:', removeCommand(r.fileId)));
        return out;
    });

    section(
        'COULD NOT BE CHECKED:',
        summary.files.filter(r => RescanResults.Held === r.result),
        r => [
            noticeLine(
                'Detail:',
                `scanner failed: ${clean(r.verdict && r.verdict.detail) || 'unknown error'}`
            ),
        ]
    );

    section(
        'MISSING (the physical file is not there):',
        summary.files.filter(r => RescanResults.Missing === r.result),
        r => [noticeLine('Path:', noticePath(r.path))]
    );

    section(
        'ERRORS:',
        summary.files.filter(r => r.error && RescanResults.Missing !== r.result),
        r => [noticeLine('Error:', clean(r.error) || '?')]
    );

    if (infected.length > 0) {
        lines.push(
            ...wrap(
                `To remove an infected file and its entry, run the "Remove" command from the ENiGMA directory. It deletes the file too; without --phys-file only the entry goes and the file stays on disk, where a later "fb scan" would import it again. An infected file is reported on every rescan until it is removed.`
            )
        );
        lines.push('');
    }

    if (summary.counts[RescanResults.Held] > 0) {
        lines.push(
            ...wrap(
                'A file that could not be checked was not found to be infected: a scanner failed or timed out. Check the scanner; the next rescan tries the file again.'
            )
        );
        lines.push('');
    }

    const problems = attentionFiles(summary).length;
    return {
        subject: `File base rescan: ${problems} file${1 === problems ? '' : 's'} to check${
            infected.length > 0 ? `, ${infected.length} infected` : ''
        }`,
        body: lines.join('\r\n'),
    };
}

// ── Event scheduler task ─────────────────────────────────────────────────────

const TASK_ARG_KEYS = ['areas', 'olderThanDays', 'maxFiles', 'dryRun'];

//
//  args: [] or [ { areas, olderThanDays, maxFiles, dryRun } ]
//
//  areas: a tag or a list of tags, simple wildcards allowed; default every
//  area. An unknown key is an error rather than ignored: a misspelled
//  olderThanDays would otherwise rescan the whole base every run.
//
//  Returns { options } or { error }.
//
function parseTaskArgs(args) {
    if (_.isNil(args)) {
        args = [];
    }
    if (
        !Array.isArray(args) ||
        args.length > 1 ||
        (1 === args.length && !_.isPlainObject(args[0]))
    ) {
        return {
            error: Errors.Invalid(
                'args must be [] or [ { areas, olderThanDays, maxFiles, dryRun } ]'
            ),
        };
    }

    const given = args[0] || {};
    const unknown = Object.keys(given).filter(k => !TASK_ARG_KEYS.includes(k));
    if (unknown.length > 0) {
        return {
            error: Errors.Invalid(
                `Unknown argument(s) ${unknown.join(', ')}; known are ${TASK_ARG_KEYS.join(
                    ', '
                )}`
            ),
        };
    }

    const options = {};

    if (!_.isUndefined(given.areas)) {
        const areas = _.isString(given.areas) ? [given.areas] : given.areas;
        if (
            !Array.isArray(areas) ||
            0 === areas.length ||
            !areas.every(a => _.isString(a) && a)
        ) {
            return {
                error: Errors.Invalid('"areas" must be an area tag or a list of them'),
            };
        }
        options.areaTags = areas;
    }

    for (const key of ['olderThanDays', 'maxFiles']) {
        if (_.isUndefined(given[key])) {
            continue;
        }
        const n = given[key];
        if (!_.isFinite(n) || n < 0 || ('maxFiles' === key && !Number.isInteger(n))) {
            return { error: Errors.Invalid(`"${key}" must be a number, 0 or more`) };
        }
        options[key] = n;
    }

    if (!_.isUndefined(given.dryRun)) {
        if (!_.isBoolean(given.dryRun)) {
            return { error: Errors.Invalid('"dryRun" must be true or false') };
        }
        options.dryRun = given.dryRun;
    }

    return { options };
}

//
//  @method:core/file_base_rescan.js:rescanFileBaseScheduledEvent
//
//  Calls back (err, output): |output| is the run summary, which the
//  scheduler keeps as the run's output (shown in the WFC task detail).
//  The run fails -- so the WFC flags it -- when it could not start, when an
//  infected file is in the base, when a file could not be checked, when it
//  stopped early, or on any error; the operator notice has the detail.
//
function rescanFileBaseScheduledEvent(args, cb) {
    const parsed = parseTaskArgs(args);
    if (parsed.error) {
        log('warn', { error: parsed.error.message }, 'File base rescan task: bad args');
        return cb(parsed.error);
    }

    const options = Object.assign({ ranBy: 'scheduled task' }, parsed.options);

    rescanFileBase(options, (err, summary) => {
        if (err) {
            log('warn', { error: err.message }, 'File base rescan could not run');
            return cb(err);
        }

        const output = formatSummary(summary);
        const infected = summary.counts[RescanResults.Infected] + summary.stillInfected;
        const held = summary.counts[RescanResults.Held];
        const plural = (n, what) => `${n} ${what}${1 === n ? '' : 's'}`;
        const why = [];
        if (infected > 0) {
            why.push(`${plural(infected, 'infected file')} in the file base`);
        }
        if (held > 0) {
            why.push(`${plural(held, 'file')} could not be checked`);
        }
        if (summary.errors > 0) {
            why.push(plural(summary.errors, 'error'));
        }
        if (summary.stoppedEarly) {
            why.push('stopped early');
        }
        if (why.length > 0) {
            return cb(new Error(why.join(', ')), output);
        }
        return cb(null, output);
    });
}
