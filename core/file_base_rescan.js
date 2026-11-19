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
//      rescanFileBaseScheduledEvent, which also shows in the WFC task list;
//    - oputil fb virus-scan.
//
//  Per entry, by verdict:
//
//    clean / skipped   scan_result, scanned_at and scanner meta are updated
//    infected          the file gets the configured fail action (quarantine
//                      or delete; see FileScanner.applyFailAction()) and the
//                      entry is removed, so nothing is left pointing at a
//                      file that is gone. If the fail action fails, the entry
//                      stays and the run reports an error.
//    held              the scanner failed or timed out: file and entry are
//                      left exactly as they are, and scanned_at is not
//                      touched. A scanner outage must never pull existing
//                      files out of the base.
//    not_scanned       no scanner entry matched the file (fileTypes): nothing
//                      changes
//
//  A missing physical file, a symbolic link to an infected file, a path that
//  cannot be resolved: reported, nothing changed.
//
//  Files are scanned ONE AT A TIME, so a rescan holds at most one of the
//  global scanner slots (fileBase.scanning.maxConcurrent) and never starves
//  uploads or TIC imports.
//
//  The operators get ONE inbox notice per run, and only when something needs
//  them: an infected, held or missing file, or an error.
//

//  ENiGMA½
const FileScanner = require('./file_scanner.js');
const { Errors } = require('./enig_error.js');

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
const async = require('async');
const fs = require('graceful-fs');
const crypto = require('crypto');

exports.rescanFileBase = rescanFileBase;
exports.rescanFileBaseScheduledEvent = rescanFileBaseScheduledEvent;
exports.getRescanReadyError = getRescanReadyError;
exports.parseTaskArgs = parseTaskArgs;
exports.formatSummary = formatSummary;
exports.buildRescanNotice = buildRescanNotice;
exports.isRunning = () => running;

//  What happened to one entry
const RescanResults = (exports.RescanResults = {
    Clean: 'clean',
    Skipped: 'skipped', //  scanners ran; none said clean, none rejected
    NotScanned: 'not_scanned', //  no scanner entry matched (fileTypes)
    Infected: 'infected',
    Held: 'held', //  could not be checked: a scanner failed or timed out
    Missing: 'missing', //  the physical file is not there
    Error: 'error', //  anything else that stopped the entry being checked
});

const DAY_MS = 24 * 60 * 60 * 1000;

//  Most files of each kind a notice lists; the rest are counted.
const MAX_NOTICE_FILES_PER_SECTION = 25;
//  The message reader wraps at 79 columns (see file_scanner.js).
const NOTICE_LINE_WIDTH = 79;

//  One run at a time per process, whichever way it was started.
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
//  they name. No tags at all: every such area. A tag that names nothing is an
//  error rather than quietly scanning less than asked.
//
function resolveAreaTags(areaTags) {
    const FileBaseArea = require('./file_base_area.js');
    const configured = Object.keys(_.get(Config(), 'fileBase.areas') || {}).filter(
        tag => !FileBaseArea.isInternalArea(tag)
    );

    if (!Array.isArray(areaTags) || 0 === areaTags.length) {
        return { areaTags: configured };
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

//
//  Never scanned first, then oldest scanned_at first, so that runs capped by
//  maxFiles work through the whole base in turn.
//
function orderAndFilterCandidates(rows, olderThanDays) {
    const cutoff = _.isFinite(olderThanDays) ? Date.now() - olderThanDays * DAY_MS : null;

    const when = row => {
        const t = row.scannedAt ? Date.parse(row.scannedAt) : NaN;
        return _.isFinite(t) ? t : null; //  unreadable: as if never scanned
    };

    return rows
        .map(row => Object.assign({}, row, { scannedAtMs: when(row) }))
        .filter(
            row => null === cutoff || null === row.scannedAtMs || row.scannedAtMs < cutoff
        )
        .sort((a, b) => {
            if (a.scannedAtMs !== b.scannedAtMs) {
                if (null === a.scannedAtMs) {
                    return -1;
                }
                if (null === b.scannedAtMs) {
                    return 1;
                }
                return a.scannedAtMs - b.scannedAtMs;
            }
            return a.fileId - b.fileId;
        });
}

// ── One entry ────────────────────────────────────────────────────────────────

//  SHA-256 and size, read from the file as it is now: an entry's stored hash
//  may be stale, and a hash lookup scanner must see the real one.
function hashFile(filePath, cb) {
    const hash = crypto.createHash('sha256');
    let byteSize = 0;
    let done = false;
    const finish = (err, res) => {
        if (!done) {
            done = true;
            return cb(err, res);
        }
    };
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => {
        byteSize += chunk.length;
        hash.update(chunk);
    });
    stream.on('error', err => finish(err));
    stream.on('end', () => finish(null, { sha256: hash.digest('hex'), byteSize }));
}

//
//  Where the entry's file is, and whether it is a plain file there. Calls
//  back (null, { path, symlink }) or (null, null, result) with a finished
//  Missing / Error result.
//
function locateFile(entry, result, cb) {
    const storageTags = _.get(Config(), 'fileBase.storageTags') || {};
    if (!entry.storageTag || !_.has(storageTags, entry.storageTag)) {
        //  getAreaStorageDirectoryByTag() would fall back to the storage
        //  prefix itself, and a file of the same name there is not this one
        result.result = RescanResults.Error;
        result.error = `Unknown storage tag "${entry.storageTag}"`;
        return cb(null, null, result);
    }

    let filePath;
    try {
        filePath = entry.filePath; //  throws on a rel path leaving the storage dir
    } catch (e) {
        result.result = RescanResults.Error;
        result.error = e.message;
        return cb(null, null, result);
    }
    result.path = filePath;

    fs.lstat(filePath, (err, lstats) => {
        if (err) {
            if ('ENOENT' === err.code || 'ENOTDIR' === err.code) {
                result.result = RescanResults.Missing;
                return cb(null, null, result);
            }
            result.result = RescanResults.Error;
            result.error = err.message;
            return cb(null, null, result);
        }

        const symlink = lstats.isSymbolicLink();
        const check = (err, stats) => {
            if (err) {
                result.result =
                    'ENOENT' === err.code ? RescanResults.Missing : RescanResults.Error;
                if (RescanResults.Error === result.result) {
                    result.error = err.message;
                } else {
                    result.danglingLink = true;
                }
                return cb(null, null, result);
            }
            //  a FIFO or device would hang or mislead the hash and the scanner
            if (!stats.isFile()) {
                result.result = RescanResults.Error;
                result.error = 'Not a regular file';
                return cb(null, null, result);
            }
            if (symlink) {
                result.symlink = true;
            }
            return cb(null, { path: filePath, symlink });
        };

        return symlink ? fs.stat(filePath, check) : check(null, lstats);
    });
}

function scannerNames(verdict) {
    return _.uniq((verdict.results || []).map(r => r.scanner)).join(',');
}

//
//  Infected and not a dry run: fail action, then the entry goes. Always
//  calls back cb(null); what happened is in |result|.
//
function disposeOfInfected(entry, located, verdict, scanContext, result, cb) {
    if (located.symlink) {
        //  moving the link would leave the infected file it points at in
        //  place, and that may be outside the file base altogether
        result.error =
            'It is a symbolic link: neither it nor the file it points at was moved, and the entry was kept';
        return cb(null);
    }

    FileScanner.applyFailAction(
        located.path,
        verdict,
        scanContext,
        (err, disposition) => {
            if (err) {
                result.disposition = { error: err.message, path: located.path };
                result.error = `Could not quarantine or delete it (${err.message}); the entry was kept`;
                return cb(null);
            }

            result.disposition = disposition;
            fileEntryClass().removeEntry(entry, {}, err => {
                if (err) {
                    result.error = `The file was dealt with, but removing its entry failed: ${err.message}`;
                } else {
                    result.entryRemoved = true;
                }
                return cb(null);
            });
        }
    );
}

function rescanEntry(fileId, options, cb) {
    const FileEntry = fileEntryClass();
    const entry = new FileEntry();

    FileEntry.loadBasicEntry(fileId, entry, err => {
        if (err) {
            //  removed since the candidates were listed: nothing to do
            return cb(null, null);
        }

        const result = {
            fileId,
            fileName: entry.fileName,
            areaTag: entry.areaTag,
            storageTag: entry.storageTag,
        };

        locateFile(entry, result, (err, located, finished) => {
            if (finished) {
                return cb(null, finished);
            }

            hashFile(located.path, (err, hashed) => {
                if (err) {
                    result.result = RescanResults.Error;
                    result.error = err.message;
                    return cb(null, result);
                }

                result.sha256 = hashed.sha256;
                result.byteSize = hashed.byteSize;
                if (entry.fileSha256 && entry.fileSha256 !== hashed.sha256) {
                    result.hashChanged = true;
                }

                const scanCtx = {
                    source: FileScanner.ScanSources.Rescan,
                    fileName: entry.fileName,
                    areaTag: entry.areaTag,
                    fileId,
                    sha256: hashed.sha256,
                    byteSize: hashed.byteSize,
                };

                FileScanner.scanFile(located.path, scanCtx, (err, verdict) => {
                    if (err && !FileScanner.isFileRejected(err)) {
                        result.result = RescanResults.Error;
                        result.error = err.message;
                        return cb(null, result);
                    }

                    result.verdict = verdict;

                    if (!err) {
                        switch (verdict.result) {
                            case FileScanner.Verdicts.Clean:
                                result.result = RescanResults.Clean;
                                break;
                            case FileScanner.Verdicts.Skipped:
                                result.result = RescanResults.Skipped;
                                break;
                            default:
                                result.result = RescanResults.NotScanned;
                                return cb(null, result);
                        }

                        if (options.dryRun) {
                            return cb(null, result);
                        }

                        return FileEntry.replaceMetaValues(
                            fileId,
                            {
                                scan_result: verdict.result,
                                scanned_at: new Date().toISOString(),
                                scanner: scannerNames(verdict),
                            },
                            err => {
                                if (err) {
                                    result.error = `Could not record the result: ${err.message}`;
                                }
                                return cb(null, result);
                            }
                        );
                    }

                    if (FileScanner.Verdicts.Held === verdict.result) {
                        //  left as it is; see the top of this file
                        result.result = RescanResults.Held;
                        return cb(null, result);
                    }

                    result.result = RescanResults.Infected;
                    if (options.dryRun) {
                        return cb(null, result);
                    }

                    return disposeOfInfected(
                        entry,
                        located,
                        verdict,
                        err.scanContext,
                        result,
                        () => cb(null, result)
                    );
                });
            });
        });
    });
}

// ── The run ──────────────────────────────────────────────────────────────────

function newSummary(options) {
    return {
        dryRun: !!options.dryRun,
        startedAt: new Date(),
        durationMs: 0,
        matched: 0, //  entries that matched the filters
        checked: 0, //  of those, entries this run looked at (maxFiles)
        remaining: 0, //  matched but left for a later run
        counts: _.mapValues(_.invert(RescanResults), () => 0),
        removed: 0, //  infected entries removed
        errors: 0, //  entries with an error, including a failed fail action
        hashChanged: 0,
        files: [],
    };
}

function tally(summary, result) {
    summary.files.push(result);
    summary.counts[result.result] += 1;
    if (result.entryRemoved) {
        summary.removed += 1;
    }
    if (result.error) {
        summary.errors += 1;
    }
    if (result.hashChanged) {
        summary.hashChanged += 1;
    }
}

function needsOperator(summary) {
    const c = summary.counts;
    return (
        c[RescanResults.Infected] + c[RescanResults.Held] + c[RescanResults.Missing] >
            0 || summary.errors > 0
    );
}

//
//  options: {
//      areaTags:       [ tag, ... ]; simple wildcards (*, ?) allowed. With
//                      neither this nor |fileIds|: every area
//      fileIds:        [ id, ... ]; specific entries (oputil criteria)
//      olderThanDays:  only entries never scanned, or last scanned more than
//                      this many days ago. Unset: every entry
//      maxFiles:       check at most this many entries this run (the ones
//                      scanned longest ago first); the rest are counted as
//                      remaining
//      dryRun:         scan and report only: no meta, no fail action, no
//                      entry removal, no notice
//      notify:         false: no operator notice (default true)
//      ranBy:          who ran it, for the notice: 'oputil', 'task NAME', ...
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

    const haveFileIds = Array.isArray(options.fileIds) && options.fileIds.length > 0;
    const haveAreaTags = Array.isArray(options.areaTags) && options.areaTags.length > 0;
    let areaTags = [];
    if (haveAreaTags || !haveFileIds) {
        const resolved = resolveAreaTags(options.areaTags);
        if (resolved.error) {
            return cb(resolved.error);
        }
        areaTags = resolved.areaTags;
    }

    running = true;
    const summary = newSummary(options);

    const finish = err => {
        running = false;
        summary.durationMs = Date.now() - summary.startedAt.getTime();
        if (err) {
            return cb(err);
        }

        const logObj = {
            dryRun: summary.dryRun,
            matched: summary.matched,
            checked: summary.checked,
            remaining: summary.remaining,
            counts: summary.counts,
            removed: summary.removed,
            errors: summary.errors,
            hashChanged: summary.hashChanged,
            durationMs: summary.durationMs,
            ranBy: options.ranBy,
        };
        log(
            summary.errors > 0 || summary.counts[RescanResults.Held] > 0
                ? 'warn'
                : 'info',
            logObj,
            'File base rescan finished'
        );

        if (summary.dryRun || false === options.notify || !needsOperator(summary)) {
            return cb(null, summary);
        }

        const { subject, body } = buildRescanNotice(summary, options);
        FileScanner.sendOperatorNotice(subject, body, () => cb(null, summary));
    };

    fileEntryClass().getRescanCandidates(
        {
            areaTags,
            fileIds: haveFileIds ? options.fileIds : [],
            excludeAreaTags: internalAreaTags(),
        },
        (err, rows) => {
            if (err) {
                return finish(err);
            }

            let candidates = orderAndFilterCandidates(rows, options.olderThanDays);
            summary.matched = candidates.length;
            if (_.isFinite(options.maxFiles) && options.maxFiles >= 0) {
                summary.remaining = Math.max(0, candidates.length - options.maxFiles);
                candidates = candidates.slice(0, options.maxFiles);
            }

            log(
                'info',
                {
                    matched: summary.matched,
                    toCheck: candidates.length,
                    dryRun: summary.dryRun,
                    ranBy: options.ranBy,
                },
                'File base rescan starting'
            );

            //  one at a time: see the top of this file
            async.eachSeries(
                candidates,
                (candidate, nextCandidate) => {
                    rescanEntry(candidate.fileId, options, (err, result) => {
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
                        }
                        //  a fresh stack between files
                        return setImmediate(nextCandidate);
                    });
                },
                () => finish(null)
            );
        }
    );
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
    if (result.disposition) {
        obj.action = result.disposition.action;
        obj.quarantinePath = result.disposition.path;
    }
    if (result.entryRemoved) {
        obj.entryRemoved = true;
    }
    if (result.hashChanged) {
        obj.hashChanged = true;
    }
    if (result.error) {
        obj.error = result.error;
    }

    let level = 'debug';
    let msg = 'File base rescan: file checked';
    switch (result.result) {
        case RescanResults.Infected:
            level = result.error ? 'error' : 'warn';
            msg = dryRun
                ? 'File base rescan: infected file found (dry run, nothing changed)'
                : result.error
                  ? 'File base rescan: INFECTED file could not be dealt with'
                  : 'File base rescan: infected file removed from the file base';
            break;
        case RescanResults.Held:
            level = 'warn';
            msg = 'File base rescan: file could not be checked; left in place';
            break;
        case RescanResults.Missing:
            level = 'warn';
            msg = 'File base rescan: physical file is missing; entry kept';
            break;
        case RescanResults.Error:
            level = 'warn';
            msg = 'File base rescan: file could not be checked';
            break;
        default:
            if (result.error) {
                level = 'warn';
            }
            break;
    }
    log(level, obj, msg);
}

// ── Reporting ────────────────────────────────────────────────────────────────

//  One line, e.g. "Checked 12 of 40 matching files: 10 clean, ..."
function formatSummary(summary) {
    const c = summary.counts;
    const parts = [
        `${c[RescanResults.Clean]} clean`,
        `${c[RescanResults.Skipped]} skipped`,
        `${c[RescanResults.Infected]} infected${
            summary.dryRun ? '' : ` (${summary.removed} removed)`
        }`,
        `${c[RescanResults.Held]} could not be checked`,
        `${c[RescanResults.Missing]} missing`,
    ];
    if (c[RescanResults.NotScanned] > 0) {
        parts.push(`${c[RescanResults.NotScanned]} not matched by any scanner`);
    }
    parts.push(`${summary.errors} error${1 === summary.errors ? '' : 's'}`);

    let text = `${summary.dryRun ? 'DRY RUN, nothing changed. ' : ''}Checked ${
        summary.checked
    } of ${summary.matched} matching file${1 === summary.matched ? '' : 's'}: ${parts.join(
        ', '
    )}.`;
    if (summary.hashChanged > 0) {
        text += ` ${summary.hashChanged} file${
            1 === summary.hashChanged ? ' has' : 's have'
        } changed since import.`;
    }
    if (summary.remaining > 0) {
        text += ` ${summary.remaining} left for a later run.`;
    }
    return text;
}

//  From outside (file names, scanner output): no pipe codes, capped.
function clean(s, maxLength) {
    return FileScanner.cleanDisplayText(
        _.isUndefined(s) || null === s ? s : String(s),
        maxLength
    );
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
    return lines;
}

function fileLines(r) {
    const lines = [
        noticeLine('File:', clean(r.fileName) || '?'),
        noticeLine('Area:', clean(r.areaTag) || '?'),
        noticeLine('File ID:', `#${r.fileId}`),
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

    lines.push(...wrap(`File base rescan${by}.`));
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

    const of = result => summary.files.filter(r => result === r.result);

    section('INFECTED:', of(RescanResults.Infected), r => {
        const out = [
            noticeLine(
                'Result:',
                `infected: ${clean(r.verdict && r.verdict.signature) || 'unnamed threat'}`
            ),
        ];
        const d = r.disposition || {};
        if (summary.dryRun) {
            out.push(noticeLine('Action:', 'none (dry run)'));
        } else if (d.error) {
            out.push(noticeLine('Action:', `NOT moved: ${clean(d.error)}`));
            out.push(noticeLine('Still at:', noticePath(d.path)));
        } else if (!r.disposition) {
            out.push(noticeLine('Action:', `NOT moved: ${clean(r.error) || 'unknown'}`));
            out.push(noticeLine('Still at:', noticePath(r.path)));
        } else {
            if (FileScanner.FailActions.Delete === d.action && d.quarantineError) {
                out.push(
                    noticeLine(
                        'Action:',
                        `DELETED, could not be quarantined: ${clean(d.quarantineError)}`
                    )
                );
            } else if (FileScanner.FailActions.Delete === d.action) {
                out.push(noticeLine('Action:', 'deleted'));
            } else {
                out.push(noticeLine('Action:', 'quarantined'));
                out.push(noticeLine('Path:', noticePath(d.path)));
            }
            out.push(
                noticeLine(
                    'Entry:',
                    r.entryRemoved
                        ? 'removed from the file base'
                        : `NOT removed: ${clean(r.error) || 'unknown'}`
                )
            );
        }
        return out;
    });

    section(
        'COULD NOT BE CHECKED (file and entry left as they are):',
        of(RescanResults.Held),
        r => [
            noticeLine(
                'Detail:',
                `scanner failed: ${clean(r.verdict && r.verdict.detail) || 'unknown error'}`
            ),
        ]
    );

    section(
        'MISSING (the entry is kept; nothing was changed):',
        of(RescanResults.Missing),
        r => [noticeLine(r.danglingLink ? 'Link at:' : 'Path:', noticePath(r.path))]
    );

    section(
        'ERRORS:',
        summary.files.filter(r => r.error && RescanResults.Infected !== r.result),
        r => [noticeLine('Error:', clean(r.error) || '?')]
    );

    if (of(RescanResults.Held).length > 0) {
        lines.push(
            ...wrap(
                'A file that could not be checked was not found to be infected: a scanner failed or timed out. Check the scanner; the next rescan tries the file again.'
            )
        );
        lines.push('');
    }

    const c = summary.counts;
    const attention =
        c[RescanResults.Infected] + c[RescanResults.Held] + c[RescanResults.Missing];
    return {
        subject: `File base rescan: ${attention + summary.errors} problem${
            1 === attention + summary.errors ? '' : 's'
        }${c[RescanResults.Infected] > 0 ? `, ${c[RescanResults.Infected]} infected` : ''}`,
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
    if (_.isUndefined(args) || null === args) {
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
//  The run fails when it could not start, when a file could not be checked
//  (a scanner failed), or on any error; the operator notice has the detail.
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
        const held = summary.counts[RescanResults.Held];
        if (summary.errors > 0 || held > 0) {
            const why = [];
            if (held > 0) {
                why.push(`${held} file${1 === held ? '' : 's'} could not be checked`);
            }
            if (summary.errors > 0) {
                why.push(`${summary.errors} error${1 === summary.errors ? '' : 's'}`);
            }
            return cb(new Error(why.join(', ')), output);
        }
        return cb(null, output);
    });
}
