/* jslint node: true */
'use strict';

//
//  File scanning: the gate every untrusted file passes before ENiGMA½ looks
//  inside it (#291).
//
//  Core owns the registry, the chain, the policy and what happens to a file
//  that fails. Scanners themselves -- ClamAV, a VirusTotal hash lookup,
//  anything a sysop writes -- register here by name, normally from a mod's
//  moduleInitialize(). The one scanner core ships is |command|: run a program,
//  look at its exit code, the old BBS "test batch file" contract.
//
//  Nothing here is on unless fileBase.scanning.enabled is set. Disabled,
//  scanFile() answers "not scanned" at once and touches nothing.
//
//  A rejected file reaches the caller as an error (ErrorCodes.FileRejected)
//  carrying the verdict, never as an extra callback argument: a caller that
//  forgets to handle it then aborts rather than persisting the file.
//
//  What a caller does with a rejection is its own business -- an upload has
//  a "rejected" bucket, TIC has its reject directory -- but every one of them
//  hands the file to applyFailAction() and collects the results into ONE
//  notifyOperators() call per session or run.
//

//  ENiGMA½
const { Errors, ErrorCodes, ErrorReasons } = require('./enig_error.js');
const { moveFileWithCollisionHandling } = require('./file_util.js');
const stringFormat = require('./string_format.js');

//
//  Read through config.js rather than capturing its |get|: config.js replaces
//  that export when the system configuration is created, and tests push their
//  own. See core/user_time.js.
//
const configModule = require('./config.js');
const Config = () => (_.isFunction(configModule.get) ? configModule.get() : null);

//  deps
const _ = require('lodash');
const async = require('async');
const fs = require('graceful-fs');
const fse = require('fs-extra');
const paths = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

exports.ScanResults = ScanResults();
exports.ScanSources = ScanSources();
exports.Verdicts = Verdicts();
exports.FailActions = { Quarantine: 'quarantine', Delete: 'delete' };
exports.DefaultTimeoutMs = 60 * 1000;

exports.registerScanner = registerScanner;
exports.getScanner = getScanner;
exports.isEnabled = isEnabled;
exports.scanFile = scanFile;
exports.isFileRejected = isFileRejected;
exports.applyFailAction = applyFailAction;
exports.notifyOperators = notifyOperators;
exports.defangFileName = defangFileName;
exports.getQuarantinePath = getQuarantinePath;
exports.buildOperatorNotice = buildOperatorNotice;

//  What a single scanner says about a file.
function ScanResults() {
    return {
        Clean: 'clean',
        Infected: 'infected',
        Error: 'error',
        Skipped: 'skipped', //  "not for me": unknown hash, over a size limit, ...
    };
}

//  The ways an untrusted file comes in. An entry's |sources| picks from these.
function ScanSources() {
    return {
        Upload: 'upload', //  telnet/SSH upload
        Web: 'web', //  REST upload
        Tic: 'tic', //  TIC import, including passthrough
        Oputil: 'oputil', //  oputil fb scan, opt-in
        Rescan: 'rescan', //  rescan of the existing file base
    };
}

//  The verdict on a file once the whole chain has run.
function Verdicts() {
    return {
        NotScanned: 'not_scanned', //  scanning disabled, or no entry matched
        Clean: 'clean', //  at least one scanner said clean, none said otherwise
        Skipped: 'skipped', //  scanners ran, none said clean, none rejected
        Infected: 'infected', //  rejected: a scanner found something
        Held: 'held', //  rejected: a scanner failed and its entry holds on error
    };
}

const DEFAULT_DEFANG_EXTENSIONS = [
    'exe',
    'com',
    'bat',
    'cmd',
    'scr',
    'pif',
    'ps1',
    'vbs',
    'js',
    'sh',
];

//  Scanner output is untrusted and ends up in logs, sidecars and mail.
const MAX_DETAIL_LENGTH = 512;

//  oputil runs without the logger.
function log(level, obj, msg) {
    const Log = require('./logger.js').log;
    if (Log) {
        return Log[level](obj, msg);
    }
    if ('error' === level || 'warn' === level) {
        console.error(`${msg}: ${JSON.stringify(obj)}`); //  eslint-disable-line no-console
    }
}

// ── Registry ─────────────────────────────────────────────────────────────────

const scanners = new Map();

//
//  |impl|: { scan(filePath, ctx, cb), init?(entries, cb) }
//
//  scan() calls back (err, { result, signature?, detail? }). An |err|, a
//  throw, a result that is not one of ScanResults, or no answer within the
//  entry's timeout is an |error| result. ctx carries the entry's own config as
//  |ctx.options| and an AbortSignal as |ctx.abortSignal| that fires on timeout;
//  a scanner that holds a socket or a child process should honour it.
//
//  init() is a startup health check -- e.g. PING clamd and warn if it is not
//  there. It is given the configured entries that name this scanner, runs
//  only when scanning is enabled, and nothing waits for it: scan() must work
//  without it having finished, or at all.
//
//  A second registration under the same name replaces the first, with a
//  warning. That lets a mod that is reloaded register again, and lets a sysop
//  deliberately replace a scanner; it is all trusted code either way.
//
function registerScanner(name, impl, cb) {
    cb = cb || _.noop;

    if (!_.isString(name) || !name || !impl || !_.isFunction(impl.scan)) {
        const err = Errors.Invalid('A scanner needs a name and a scan() function');
        log('warn', { scanner: name }, err.message);
        return cb(err);
    }

    if (scanners.has(name)) {
        log('warn', { scanner: name }, 'File scanner registered again; replacing it');
    }

    scanners.set(name, impl);

    if (!_.isFunction(impl.init) || !isEnabled()) {
        return cb(null);
    }

    const entries = getScanningConfig().scanners.filter(e => e && name === e.scanner);
    const initDone = err => {
        if (err) {
            log(
                'warn',
                { scanner: name, error: err.message },
                'File scanner failed to initialize'
            );
        }
        return cb(null);
    };

    try {
        if (impl.init.length < 2) {
            impl.init(initDone);
        } else {
            impl.init(entries, initDone);
        }
    } catch (e) {
        initDone(e);
    }
}

function getScanner(name) {
    return scanners.get(name);
}

// ── Config ───────────────────────────────────────────────────────────────────

function getScanningConfig() {
    const config = Config() || {};
    const scanning = _.get(config, 'fileBase.scanning') || {};
    return {
        enabled: true === scanning.enabled,
        failAction:
            exports.FailActions.Delete === scanning.failAction
                ? exports.FailActions.Delete
                : exports.FailActions.Quarantine,
        quarantinePath: scanning.quarantinePath,
        notifyUserIds: Array.isArray(scanning.notifyUserIds)
            ? scanning.notifyUserIds
            : [1],
        defangExtensions: Array.isArray(scanning.defangExtensions)
            ? scanning.defangExtensions
            : DEFAULT_DEFANG_EXTENSIONS,
        scanners: Array.isArray(scanning.scanners) ? scanning.scanners : [],
    };
}

function isEnabled() {
    return getScanningConfig().enabled;
}

//
//  Relative paths resolve against fileBase.areaStoragePrefix, as storage tags
//  do. The default is a dot directory there: oputil's recursive scan of a
//  wildcard storage tag uses a glob that skips dot entries, so quarantined
//  files cannot be picked back up even with a "/*" tag over the whole prefix.
//
function getQuarantinePath() {
    const config = Config() || {};
    const prefix = _.get(config, 'fileBase.areaStoragePrefix') || process.cwd();
    const quarantinePath = getScanningConfig().quarantinePath || '.quarantine';
    return paths.resolve(prefix, quarantinePath);
}

// ── Scanning ─────────────────────────────────────────────────────────────────

function extOf(fileName) {
    return paths
        .extname(fileName || '')
        .replace(/^\./, '')
        .toLowerCase();
}

function entryMatches(entry, ctx) {
    if (!entry || !_.isString(entry.scanner)) {
        return false;
    }

    if (false === entry.enabled) {
        return false;
    }

    if (Array.isArray(entry.sources) && !entry.sources.includes(ctx.source)) {
        return false;
    }

    const fileTypes = _.isUndefined(entry.fileTypes) ? '*' : entry.fileTypes;
    if ('*' === fileTypes) {
        return true;
    }

    const ext = extOf(ctx.fileName);
    const wanted = (Array.isArray(fileTypes) ? fileTypes : [fileTypes])
        .filter(_.isString)
        .map(ft => ft.replace(/^\./, '').toLowerCase());
    return wanted.includes('*') || wanted.includes(ext);
}

//  Scanner output goes into logs, sidecars and mail: printable ASCII only.
function cleanText(s, maxLength = MAX_DETAIL_LENGTH) {
    if (_.isUndefined(s) || null === s) {
        return undefined;
    }
    const cleaned = String(s)
        .replace(/[^\x20-\x7e]+/g, ' ')
        .trim();
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function runOneScanner(entry, filePath, ctx, cb) {
    const name = entry.scanner;
    const impl = scanners.get(name);
    const errorResult = detail => ({
        result: exports.ScanResults.Error,
        detail: cleanText(detail),
        scanner: name,
    });

    if (!impl) {
        //  most likely the mod providing it is missing or failed to load
        return cb(errorResult(`No scanner named "${name}" is registered`));
    }

    const timeout =
        _.isFinite(entry.timeout) && entry.timeout > 0
            ? entry.timeout
            : exports.DefaultTimeoutMs;

    const abort = new AbortController();
    const started = Date.now();
    let done = false;
    let timer;

    const finish = res => {
        if (done) {
            return;
        }
        done = true;
        clearTimeout(timer);
        res.durationMs = Date.now() - started;
        return cb(res);
    };

    timer = setTimeout(() => {
        abort.abort();
        return finish(errorResult(`Timed out after ${timeout}ms`));
    }, timeout);

    const scanCtx = Object.assign({}, ctx, {
        options: entry,
        timeout,
        abortSignal: abort.signal,
    });

    try {
        impl.scan(filePath, scanCtx, (err, res) => {
            if (err) {
                return finish(errorResult(err.message || String(err)));
            }

            const result = _.get(res, 'result');
            if (!_.values(exports.ScanResults).includes(result)) {
                return finish(errorResult(`Unrecognised scan result "${result}"`));
            }

            const out = { result, scanner: name };
            const signature = cleanText(res.signature);
            const detail = cleanText(res.detail);
            if (signature) {
                out.signature = signature;
            }
            if (detail) {
                out.detail = detail;
            }
            return finish(out);
        });
    } catch (e) {
        return finish(errorResult(e.message));
    }
}

//  Hash and size for scanners that want them (VirusTotal looks up the SHA-256),
//  when the caller has not already worked them out.
function fillHashAndSize(filePath, ctx, cb) {
    if (ctx.sha256 && _.isFinite(ctx.byteSize)) {
        return cb(null);
    }

    const hash = crypto.createHash('sha256');
    let byteSize = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => {
        byteSize += chunk.length;
        hash.update(chunk);
    });
    stream.on('error', err => cb(err));
    stream.on('end', () => {
        ctx.sha256 = ctx.sha256 || hash.digest('hex');
        if (!_.isFinite(ctx.byteSize)) {
            ctx.byteSize = byteSize;
        }
        return cb(null);
    });
}

function makeRejectedError(verdict, ctx) {
    const err = Errors.FileRejected(
        Verdicts().Infected === verdict.result
            ? `${verdict.scanner} found ${verdict.signature || 'a threat'}`
            : `${verdict.scanner} failed: ${verdict.detail || 'unknown error'}`,
        Verdicts().Infected === verdict.result ? ErrorReasons.Infected : ErrorReasons.Held
    );
    err.verdict = verdict;
    err.scanContext = ctx;
    return err;
}

function isFileRejected(err) {
    return !!err && ErrorCodes.FileRejected === err.code;
}

//
//  ctx: { source, fileName?, areaTag?, user?, sha256?, byteSize?, ticInfo? }
//
//  |source| is required and is one of ScanSources. |fileName| is the name the
//  file will have (it defaults to the base name of |filePath|, which for an
//  upload may well be a temp name); |fileTypes| matching uses it. A missing
//  sha256 / byteSize is worked out here, but only if some entry is going to
//  run.
//
//  Calls back (null, verdict) when the file may proceed, and
//  (Errors.FileRejected, verdict) when it may not; the error also carries
//  |verdict| and |scanContext|. Any other error is a failure to scan at all
//  (missing parameter, unreadable file) and also means "do not proceed".
//
//  verdict: {
//      result:     one of Verdicts
//      rejected:   true for infected / held
//      scanner, signature?, detail?:   from the deciding result
//      results:    every scanner result, in order:
//                  { result, scanner, signature?, detail?, durationMs }
//  }
//
function scanFile(filePath, ctx, cb) {
    ctx = Object.assign({}, ctx);

    if (!_.values(exports.ScanSources).includes(ctx.source)) {
        return cb(Errors.MissingParam(`Invalid or missing scan source "${ctx.source}"`));
    }

    ctx.fileName = ctx.fileName || paths.basename(filePath);

    const verdict = {
        result: exports.Verdicts.NotScanned,
        rejected: false,
        results: [],
    };

    const scanning = getScanningConfig();
    if (!scanning.enabled) {
        return cb(null, verdict);
    }

    const entries = scanning.scanners.filter(e => entryMatches(e, ctx));
    if (0 === entries.length) {
        return cb(null, verdict);
    }

    fillHashAndSize(filePath, ctx, err => {
        if (err) {
            return cb(err);
        }

        let decided = null;

        async.eachSeries(
            entries,
            (entry, nextEntry) => {
                runOneScanner(entry, filePath, ctx, res => {
                    verdict.results.push(res);

                    switch (res.result) {
                        case exports.ScanResults.Infected:
                            decided = Object.assign(
                                { verdict: exports.Verdicts.Infected },
                                res
                            );
                            return nextEntry(true); //  stop the chain

                        case exports.ScanResults.Error:
                            if ('accept' === entry.onError) {
                                log(
                                    'warn',
                                    {
                                        scanner: res.scanner,
                                        fileName: ctx.fileName,
                                        detail: res.detail,
                                    },
                                    'File scanner failed; accepting the file as configured'
                                );
                                return nextEntry(null);
                            }
                            decided = Object.assign(
                                { verdict: exports.Verdicts.Held },
                                res
                            );
                            return nextEntry(true);

                        default:
                            return nextEntry(null);
                    }
                });
            },
            () => {
                if (decided) {
                    verdict.result = decided.verdict;
                    verdict.rejected = true;
                } else {
                    const clean = _.findLast(
                        verdict.results,
                        r => exports.ScanResults.Clean === r.result
                    );
                    decided = clean || _.last(verdict.results);
                    verdict.result = clean
                        ? exports.Verdicts.Clean
                        : exports.Verdicts.Skipped;
                }

                verdict.scanner = decided.scanner;
                if (decided.signature) {
                    verdict.signature = decided.signature;
                }
                if (decided.detail) {
                    verdict.detail = decided.detail;
                }

                const logObj = {
                    fileName: ctx.fileName,
                    source: ctx.source,
                    areaTag: ctx.areaTag,
                    sha256: ctx.sha256,
                    verdict: verdict.result,
                    scanner: verdict.scanner,
                    signature: verdict.signature,
                    detail: verdict.detail,
                };

                if (verdict.rejected) {
                    log('warn', logObj, 'File rejected by file scanning');
                    return cb(makeRejectedError(verdict, ctx), verdict);
                }

                log('debug', logObj, 'File passed file scanning');
                return cb(null, verdict);
            }
        );
    });
}

// ── Quarantine / delete ──────────────────────────────────────────────────────

//
//  DOS convention: the last character of an executable-looking extension
//  becomes "_" (FOO.EXE -> FOO.EX_). Case is kept. A one-character extension
//  such as ".x" in the list becomes "._".
//
function defangFileName(fileName, defangExtensions) {
    const list = (defangExtensions || DEFAULT_DEFANG_EXTENSIONS)
        .filter(_.isString)
        .map(e => e.replace(/^\./, '').toLowerCase());

    const ext = paths.extname(fileName);
    if (!ext || ext.length < 2 || !list.includes(ext.slice(1).toLowerCase())) {
        return fileName;
    }

    return `${fileName.slice(0, -1)}_`;
}

//  Strips exec (and setuid/setgid/sticky) bits. Windows has none to strip, so
//  a failure there is expected and only logged.
function stripExecBits(filePath, cb) {
    fs.stat(filePath, (err, stats) => {
        if (err) {
            return cb(err);
        }
        const mode = stats.mode & 0o7777 & ~0o7111;
        fs.chmod(filePath, mode, err => {
            if (err) {
                log(
                    'debug',
                    { filePath, error: err.message },
                    'Could not strip exec bits from quarantined file'
                );
            }
            return cb(null);
        });
    });
}

//  Writes |data| beside |finalPath| without ever replacing an existing file:
//  a quarantined file may itself be called "<something>.json".
function writeSidecar(finalPath, data, cb) {
    const body = JSON.stringify(data, null, 2) + '\n';
    let n = 0;

    const attempt = () => {
        const sidecarPath = 0 === n ? `${finalPath}.json` : `${finalPath}.${n}.json`;
        fs.writeFile(sidecarPath, body, { flag: 'wx', mode: 0o640 }, err => {
            if (err && 'EEXIST' === err.code && n < 100) {
                ++n;
                return attempt();
            }
            return cb(err, err ? null : sidecarPath);
        });
    };

    attempt();
}

function userInfo(ctx) {
    const user = ctx.user;
    if (!user) {
        return undefined;
    }
    return {
        id: user.userId,
        name: user.username,
    };
}

//
//  Puts a rejected file where the operator asked: quarantine (default) or
//  delete. A |held| file -- the scanner failed, so it may be perfectly
//  clean -- is always quarantined, whatever failAction says.
//
//  Calls back (err, disposition):
//  {
//      action:         'quarantine' | 'delete'
//      path:           final quarantine path (quarantine only)
//      sidecarPath:    the JSON record beside it (quarantine only)
//  }
//
function applyFailAction(filePath, verdict, ctx, cb) {
    ctx = Object.assign({}, ctx);

    if (!verdict || !verdict.rejected) {
        return cb(Errors.Invalid('applyFailAction() given a file that was not rejected'));
    }

    const scanning = getScanningConfig();
    const action =
        exports.Verdicts.Held === verdict.result
            ? exports.FailActions.Quarantine
            : scanning.failAction;

    const fileName = ctx.fileName || paths.basename(filePath);

    if (exports.FailActions.Delete === action) {
        return fs.unlink(filePath, err => {
            if (err) {
                return cb(err);
            }
            log(
                'info',
                { fileName, source: ctx.source, verdict: verdict.result },
                'Deleted rejected file'
            );
            return cb(null, { action });
        });
    }

    const quarantineDir = getQuarantinePath();
    const quarantineName = defangFileName(
        //  never let a name pick its own directory
        paths.basename(fileName.replace(/\\/g, '/')),
        scanning.defangExtensions
    );

    let finalPath;

    async.series(
        [
            callback => fillHashAndSize(filePath, ctx, callback),
            callback => fse.mkdirs(quarantineDir, err => callback(err)),
            callback => {
                moveFileWithCollisionHandling(
                    filePath,
                    paths.join(quarantineDir, quarantineName),
                    (err, movedTo) => {
                        finalPath = movedTo;
                        return callback(err);
                    }
                );
            },
            callback => stripExecBits(finalPath, callback),
        ],
        err => {
            if (err) {
                return cb(err);
            }

            const record = {
                originalName: fileName,
                originalPath: filePath,
                quarantineName: paths.basename(finalPath),
                sha256: ctx.sha256,
                byteSize: ctx.byteSize,
                source: ctx.source,
                user: userInfo(ctx),
                areaTag: ctx.areaTag,
                ticInfo: ctx.ticInfo,
                verdict: verdict.result,
                scanner: verdict.scanner,
                signature: verdict.signature,
                detail: verdict.detail,
                results: verdict.results,
                action,
                quarantinedAt: new Date().toISOString(),
            };

            writeSidecar(finalPath, record, (err, sidecarPath) => {
                if (err) {
                    //  the file itself is safely put away; say so and go on
                    log(
                        'warn',
                        { path: finalPath, error: err.message },
                        'Failed to write quarantine sidecar'
                    );
                }

                log(
                    'info',
                    {
                        fileName,
                        path: finalPath,
                        source: ctx.source,
                        verdict: verdict.result,
                    },
                    'Quarantined rejected file'
                );

                return cb(null, {
                    action,
                    path: finalPath,
                    sidecarPath: sidecarPath || undefined,
                });
            });
        }
    );
}

// ── Operator notice ──────────────────────────────────────────────────────────

//
//  rejections: [ { ctx?, verdict, disposition? } ]
//      |ctx| is per file and wins over the call's |ctx| (a rescan spans many
//      areas); |disposition| is what applyFailAction() called back.
//
//  Returns { subject, body }. The body is 7-bit ASCII with CRLF line ends,
//  like the other system notices; file names and scanner output are cleaned
//  of anything else, since both come from outside.
//
function buildOperatorNotice(rejections, ctx) {
    ctx = ctx || {};
    const count = rejections.length;
    const lines = [`${count} file${1 === count ? '' : 's'} failed file scanning.`, ''];

    rejections.forEach(rej => {
        const c = Object.assign({}, ctx, rej.ctx);
        const v = rej.verdict || {};
        const d = rej.disposition || {};
        const user = userInfo(c);

        let from = cleanText(c.source) || 'unknown';
        if (user && (user.name || user.id)) {
            from += ` (user ${cleanText(user.name) || '?'} #${user.id || '?'})`;
        }
        if (c.ticInfo && c.ticInfo.origin) {
            from += ` (TIC origin ${cleanText(c.ticInfo.origin)})`;
        }

        let outcome =
            exports.Verdicts.Infected === v.result
                ? `infected: ${v.signature || 'unnamed threat'}`
                : `held, scanner failed: ${v.detail || 'unknown error'}`;

        let action;
        if (exports.FailActions.Delete === d.action) {
            action = 'deleted';
        } else if (d.path) {
            action = `quarantined to ${d.path}`;
        } else {
            action = 'none recorded';
        }

        lines.push(`File:    ${cleanText(c.fileName) || '?'}`);
        lines.push(`From:    ${from}`);
        if (c.areaTag) {
            lines.push(`Area:    ${cleanText(c.areaTag)}`);
        }
        if (c.ticInfo) {
            const t = c.ticInfo;
            let tic = `${cleanText(t.area) || '?'} from ${cleanText(t.from) || '?'}`;
            if (t.ticFileName) {
                tic += ` in ${cleanText(t.ticFileName)}`;
            }
            if (t.passthrough) {
                tic += ' (passthrough)';
            }
            lines.push(`TIC:     ${tic}`);
        }
        if (c.sha256) {
            lines.push(`SHA-256: ${cleanText(c.sha256)}`);
        }
        lines.push(`Scanner: ${cleanText(v.scanner) || '?'}`);
        lines.push(`Result:  ${cleanText(outcome)}`);
        lines.push(`Action:  ${cleanText(action, 1024)}`);
        lines.push('');
    });

    const anyHeld = rejections.some(
        r => exports.Verdicts.Held === _.get(r, 'verdict.result')
    );
    if (anyHeld) {
        lines.push(
            'A held file was not found to be infected: a scanner failed or timed out.'
        );
        lines.push('It may be clean; check the scanner, then release it by hand.');
        lines.push('');
    }

    return {
        subject: `File scan: ${count} file${1 === count ? '' : 's'} rejected`,
        body: lines.join('\r\n'),
    };
}

//  Default notice writer: one private message to |userId|. Replaceable for
//  tests, which have no message or user database.
function persistNotice(userId, subject, body, cb) {
    const User = require('./user.js');
    const Message = require('./message.js');

    User.getUserName(userId, (err, userName) => {
        if (err) {
            return cb(err);
        }

        const notice = new Message({
            areaTag: Message.WellKnownAreaTags.Private,
            toUserName: userName,
            fromUserName: 'ENiGMA½ BBS',
            subject,
            message: body,
        });
        notice.setLocalToUserId(userId);
        return notice.persist(cb);
    });
}

let noticeWriter = persistNotice;

exports._setNoticeWriter = writer => {
    const prev = noticeWriter;
    noticeWriter = writer || persistNotice;
    return prev;
};

//
//  ONE private message per call to each of fileBase.scanning.notifyUserIds.
//  Callers batch: one call per upload session, per rescan run. A failure to
//  notify is logged and never fails the caller: cb is always cb(null).
//
function notifyOperators(rejections, ctx, cb) {
    if (!cb && _.isFunction(ctx)) {
        cb = ctx;
        ctx = {};
    }
    cb = cb || _.noop;

    rejections = (rejections || []).filter(Boolean);
    if (0 === rejections.length) {
        return cb(null);
    }

    const { subject, body } = buildOperatorNotice(rejections, ctx);
    const userIds = _.uniq(
        getScanningConfig()
            .notifyUserIds.map(id => parseInt(id, 10))
            .filter(id => id > 0)
    );

    async.each(
        userIds,
        (userId, nextUser) => {
            noticeWriter(userId, subject, body, err => {
                if (err) {
                    log(
                        'warn',
                        { userId, error: err.message },
                        'Failed to send file scanning notice'
                    );
                }
                return nextUser(null);
            });
        },
        () => cb(null)
    );
}

// ── Built-in: command ────────────────────────────────────────────────────────

//
//  Runs an external program per file and maps its exit code. Entry options:
//
//      cmd:            program to run (never through a shell)
//      args:           argument list; default [ "{filePath}" ]. Substitutes
//                      {filePath} (always absolute), {fileName}, {areaTag},
//                      {source} and {sha256}. {fileName} is whatever the
//                      uploader called the file -- it may start with "-" --
//                      so keep it out of a position a program would read as
//                      an option.
//      exitCodes:      { clean: [ 0 ], infected: [ 1 ] }. Any other code,
//                      a signal, or a failure to start is an error.
//      signatureRegex: applied to stdout + stderr when infected; the first
//                      capture group (or the whole match) is the signature.
//      infectedRegex:  for tools whose exit code cannot tell "found" from
//                      "failed" -- Windows Defender's MpCmdRun exits 2 for
//                      both. If set and it matches stdout + stderr, the file
//                      is infected whatever the exit code, and its first
//                      capture group is the signature unless signatureRegex
//                      gives one. If it does not match, the exit code decides
//                      as usual, so leave the ambiguous code out of
//                      |infected| and it becomes an error.
//
//  Regex options are strings, applied with the "m" flag so ^ and $ work per
//  line.
//
function compileRegex(source) {
    if (!_.isString(source) || !source) {
        return null;
    }
    return new RegExp(source, 'm');
}

function firstMatch(re, text) {
    const m = re ? re.exec(text) : null;
    if (!m) {
        return null;
    }
    return m[1] || m[0];
}

const commandScanner = {
    scan(filePath, ctx, cb) {
        const opts = ctx.options || {};
        if (!_.isString(opts.cmd) || !opts.cmd) {
            return cb(Errors.MissingConfig('command scanner entry has no "cmd"'));
        }

        let signatureRe;
        let infectedRe;
        let args;
        try {
            signatureRe = compileRegex(opts.signatureRegex);
            infectedRe = compileRegex(opts.infectedRegex);

            const formatObj = {
                filePath: paths.resolve(filePath),
                fileName: ctx.fileName || paths.basename(filePath),
                areaTag: ctx.areaTag || '',
                source: ctx.source || '',
                sha256: ctx.sha256 || '',
            };
            args = (Array.isArray(opts.args) ? opts.args : ['{filePath}']).map(arg =>
                stringFormat(String(arg), formatObj)
            );
        } catch (e) {
            return cb(Errors.Invalid(`command scanner entry: ${e.message}`));
        }

        const exitCodes = Object.assign({ clean: [0], infected: [1] }, opts.exitCodes);
        const codeIn = (list, code) =>
            (Array.isArray(list) ? list : [list]).map(Number).includes(code);

        execFile(
            opts.cmd,
            args,
            {
                timeout: ctx.timeout,
                killSignal: 'SIGKILL',
                signal: ctx.abortSignal,
                windowsHide: true,
                maxBuffer: 4 * 1024 * 1024,
            },
            (err, stdout, stderr) => {
                const output = `${stdout || ''}\n${stderr || ''}`;

                if (infectedRe) {
                    const found = firstMatch(infectedRe, output);
                    if (found) {
                        return cb(null, {
                            result: ScanResults().Infected,
                            signature: firstMatch(signatureRe, output) || found,
                        });
                    }
                }

                if (err && !_.isNumber(err.code)) {
                    //  failed to start, killed, timed out, too much output
                    const why =
                        err.killed || err.signal
                            ? `${opts.cmd} was killed (${err.signal || 'timeout'})`
                            : err.message;
                    return cb(null, {
                        result: ScanResults().Error,
                        detail: why,
                    });
                }

                const code = err ? err.code : 0;

                if (codeIn(exitCodes.infected, code)) {
                    return cb(null, {
                        result: ScanResults().Infected,
                        signature: firstMatch(signatureRe, output) || undefined,
                    });
                }

                if (codeIn(exitCodes.clean, code)) {
                    return cb(null, { result: ScanResults().Clean });
                }

                return cb(null, {
                    result: ScanResults().Error,
                    detail: `${opts.cmd} exited with code ${code}: ${output.trim()}`,
                });
            }
        );
    },
};

registerScanner('command', commandScanner);
