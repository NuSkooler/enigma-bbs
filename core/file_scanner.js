/* jslint node: true */
'use strict';

//
//  File scanning: the gate every untrusted file passes before ENiGMA½ looks
//  inside it (#291).
//
//  Core owns the registry, the chain, the policy and what happens to a file
//  that fails. Scanners themselves -- ClamAV, a VirusTotal hash lookup,
//  anything a sysop writes -- register here by name, from a mod's
//  registerFileScanners() export (see loadModFileScanners()), which both the
//  BBS and oputil call. The one scanner core ships is |command|: run a
//  program, look at its exit code, the old BBS "test batch file" contract.
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
const { moveFileWithCollisionHandling, isWindowsDeviceName } = require('./file_util.js');
const stringFormat = require('./string_format.js');
const PipeCodes = require('./pipe_codes.js');

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
const { spawn } = require('child_process');

exports.ScanResults = ScanResults();
exports.ScanSources = ScanSources();
exports.Verdicts = Verdicts();
exports.FailActions = { Quarantine: 'quarantine', Delete: 'delete' };
exports.DefaultTimeoutMs = 60 * 1000;
exports.DefaultMaxConcurrent = 2;
exports.DefaultMaxQueueWaitMs = 10 * 60 * 1000;

exports.registerScanner = registerScanner;
exports.getScanner = getScanner;
exports.registerModFileScanners = registerModFileScanners;
exports.loadModFileScanners = loadModFileScanners;
exports.isEnabled = isEnabled;
exports.getUnavailableScanners = getUnavailableScanners;
exports.getConfigWarnings = getConfigWarnings;
exports.startup = startup;
exports.scanFile = scanFile;
exports.isFileRejected = isFileRejected;
exports.applyFailAction = applyFailAction;
exports.notifyOperators = notifyOperators;
exports.sendOperatorNotice = sendOperatorNotice;
exports.hasMatchingScanner = hasMatchingScanner;
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
//  |logInfo|: extra fields for the log lines, e.g. the mod registering it.
function registerScanner(name, impl, cb, logInfo) {
    cb = cb || _.noop;

    if (!_.isString(name) || !name || !impl || !_.isFunction(impl.scan)) {
        const err = Errors.Invalid('A scanner needs a name and a scan() function');
        log('warn', { scanner: name }, err.message);
        return cb(err);
    }

    if (scanners.has(name)) {
        log(
            'warn',
            Object.assign({ scanner: name }, logInfo),
            'File scanner registered again under the same name; the last one registered is used'
        );
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

// ── Scanners from mods ───────────────────────────────────────────────────────

//
//  A mod provides scanners with a dedicated export:
//
//      exports.registerFileScanners = (registry, cb) => {
//          registry.registerScanner('clamav', impl);
//          return cb(null);
//      };
//
//  |cb| is optional: a function declared with one parameter is taken to be
//  done when it returns. |registry| has registerScanner() and ScanResults.
//
//  It is a separate export rather than something done in moduleInitialize()
//  because oputil needs the scanners too, and oputil must not run a mod's
//  moduleInitialize(), which may start servers, timers or event listeners.
//
//  How long a mod's registerFileScanners() may take to call back before
//  startup (or oputil) goes on without it.
const REGISTER_TIMEOUT_MS = 30 * 1000;

//  Mods whose registerFileScanners() has been called, by resolved path: the
//  BBS registers them before message networks start (see bbs.js) and
//  initializeModules() then sees the same mods again.
const registeredMods = new Set();

//
//  False until the mods have had their say. A scanner that is not
//  registered before then may simply not be registered *yet*, so a file it
//  would scan is held whatever its entry's onError says.
//
let modRegistrationComplete = false;

function markModRegistrationComplete() {
    modRegistrationComplete = true;
}

exports.markModRegistrationComplete = markModRegistrationComplete;
exports.isModRegistrationComplete = () => modRegistrationComplete;

//  For tests: back to the state before startup registered anything.
exports._resetModRegistration = () => {
    modRegistrationComplete = false;
    registeredMods.clear();
};

function makeModRegistry(modulePath) {
    return Object.freeze({
        registerScanner: (name, impl) =>
            registerScanner(name, impl, undefined, { modulePath }),
        ScanResults: ScanResults(),
    });
}

//
//  Calls |mod|.registerFileScanners() if it has one, once per |modulePath|.
//  Never fails: a mod that throws, calls back an error or never calls back
//  (within REGISTER_TIMEOUT_MS) is logged and skipped.
//
function registerModFileScanners(mod, modulePath, cb) {
    if (!mod || !_.isFunction(mod.registerFileScanners)) {
        return cb(null);
    }

    const key = modulePath ? paths.resolve(modulePath) : null;
    if (key && registeredMods.has(key)) {
        return cb(null); //  already done, earlier in startup
    }
    if (key) {
        registeredMods.add(key);
    }

    let called = false;
    let timer;
    const done = err => {
        if (called) {
            return;
        }
        called = true;
        clearTimeout(timer);
        if (err) {
            log(
                'warn',
                { modulePath, error: err.message || String(err) },
                'Error registering file scanners from mod'
            );
        }
        return cb(null);
    };

    const modRegistry = makeModRegistry(modulePath);

    try {
        if (mod.registerFileScanners.length < 2) {
            mod.registerFileScanners(modRegistry);
            return done(null);
        }
        timer = setTimeout(
            () =>
                done(
                    Errors.General(
                        `registerFileScanners() did not call back within ${REGISTER_TIMEOUT_MS}ms`
                    )
                ),
            exports._registerTimeoutMs || REGISTER_TIMEOUT_MS
        );
        if (timer.unref) {
            timer.unref();
        }
        mod.registerFileScanners(modRegistry, done);
    } catch (e) {
        if (called) {
            throw e; //  thrown by what |cb| went on to do, not by the mod
        }
        return done(e);
    }
}

//
//  Loads every mod under |modsPath| the way the BBS does at startup
//  (core/module_util.js initializeModules(), the same glob) and calls
//  registerFileScanners() on each that has it -- and nothing else. A mod that
//  fails to load is logged and skipped.
//
//  One at a time, in sorted order, so that two mods registering the same
//  name resolve the same way every time, in the BBS and in oputil: the one
//  loaded last wins, and the duplicate is logged.
//
//  The BBS calls this before message networks start, so that a TIC import
//  triggered at startup never runs ahead of the scanners; oputil calls it
//  before scanning. Either way, once it is done an unregistered scanner is
//  really missing (see markModRegistrationComplete()).
//
function loadModFileScanners(modsPath, cb) {
    const complete = err => {
        markModRegistrationComplete();
        return cb(err || null);
    };

    if (!_.isString(modsPath) || !modsPath) {
        return complete(null);
    }

    const registerAll = files => {
        async.eachSeries(
            files.sort(),
            (file, nextFile) => {
                const modulePath = paths.join(modsPath, file);
                let mod;
                try {
                    mod = require(modulePath);
                } catch (e) {
                    log(
                        'warn',
                        { modulePath, error: e.message },
                        'Failed to load mod while looking for file scanners'
                    );
                    return nextFile(null);
                }
                return registerModFileScanners(mod, modulePath, () => nextFile(null));
            },
            () => complete(null)
        );
    };

    //  out of the promise chain, so a throw further on is not taken for a
    //  glob failure and called back a second time
    const { glob } = require('glob');
    glob('*{.js,/*.js}', { cwd: modsPath }).then(
        files => process.nextTick(registerAll, files),
        err => process.nextTick(complete, err)
    );
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
        maxConcurrent:
            _.isFinite(scanning.maxConcurrent) && scanning.maxConcurrent >= 1
                ? Math.floor(scanning.maxConcurrent)
                : exports.DefaultMaxConcurrent,
        maxQueueWaitMs:
            _.isFinite(scanning.maxQueueWaitMs) && scanning.maxQueueWaitMs >= 0
                ? scanning.maxQueueWaitMs
                : exports.DefaultMaxQueueWaitMs,
    };
}

function isEnabled() {
    return getScanningConfig().enabled;
}

//
//  Names of configured scanners that would run for |source| but are not
//  registered -- typically because the mod providing one failed to load, or
//  registers it from moduleInitialize(), which oputil never runs. Every file
//  such an entry sees is held (unless it says onError: accept), so a caller
//  may want to refuse to start instead.
//
function getUnavailableScanners(source) {
    const scanning = getScanningConfig();
    if (!scanning.enabled) {
        return [];
    }
    return _.uniq(
        scanning.scanners
            .filter(
                e =>
                    e &&
                    _.isString(e.scanner) &&
                    false !== e.enabled &&
                    (!Array.isArray(e.sources) || e.sources.includes(source))
            )
            .filter(e => 'accept' !== e.onError && !scanners.has(e.scanner))
            .map(e => e.scanner)
    );
}

//
//  Configurations that look like they scan but let files through unscanned,
//  or hold all of them. Advisory: each is a string to log or print, and
//  nothing refuses to start over them.
//
//  |options.checkRegistered|: also report entries naming a scanner nobody
//  has registered. Only meaningful once mods have registered theirs.
//
function getConfigWarnings(options = {}) {
    const scanning = getScanningConfig();
    if (!scanning.enabled) {
        return [];
    }

    if (0 === scanning.scanners.length) {
        return [
            'File scanning is enabled but fileBase.scanning.scanners is empty: no file is scanned, and every file is accepted',
        ];
    }

    const warnings = [];
    const knownSources = _.values(exports.ScanSources);
    let runnable = 0;

    scanning.scanners.forEach((entry, index) => {
        const name = `fileBase.scanning.scanners[${index}]`;

        if (!entry || !_.isString(entry.scanner) || !entry.scanner) {
            warnings.push(`${name} has no "scanner" name and never runs`);
            return;
        }

        const what = `${name} (${entry.scanner})`;

        if (false === entry.enabled) {
            return;
        }

        if (Array.isArray(entry.fileTypes) && !entry.fileTypes.some(_.isString)) {
            warnings.push(
                `${what} has an empty "fileTypes" list and never runs; use "*" for every file`
            );
            return;
        }

        if (Array.isArray(entry.sources)) {
            const unknown = entry.sources.filter(src => !knownSources.includes(src));
            if (unknown.length > 0) {
                warnings.push(
                    `${what} has unknown "sources" ${unknown.join(
                        ', '
                    )}; known sources are ${knownSources.join(', ')}`
                );
            }
            if (!entry.sources.some(src => knownSources.includes(src))) {
                warnings.push(`${what} has no known "sources" and never runs`);
                return;
            }
        }

        if (options.checkRegistered && !scanners.has(entry.scanner)) {
            warnings.push(
                'accept' === entry.onError
                    ? `${what} names a scanner that is not registered; every file it would scan is accepted with a warning`
                    : `${what} names a scanner that is not registered; every file it would scan is held`
            );
        }

        ++runnable;
    });

    if (0 === runnable) {
        warnings.push(
            'File scanning is enabled but no scanner entry can run: no file is scanned, and every file is accepted'
        );
    }

    return warnings;
}

//
//  At startup, once mods have registered their scanners: say what in the
//  configuration will not do what it looks like it does.
//
function startup(cb) {
    getConfigWarnings({ checkRegistered: true }).forEach(warning => {
        log('warn', {}, warning);
    });
    return cb(null);
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

//
//  Windows drops trailing dots and spaces from a name, so "FOO.EXE." and
//  "FOO.EXE " are FOO.EXE the moment they land on an NTFS or SMB volume, and
//  run as one. Every extension decision here goes by the name without them.
//
function trimTrailingDotsAndSpaces(fileName) {
    return String(fileName || '').replace(/[. ]+$/, '');
}

function extOf(fileName) {
    return paths
        .extname(trimTrailingDotsAndSpaces(fileName))
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

    const wanted = (Array.isArray(fileTypes) ? fileTypes : [fileTypes])
        .filter(_.isString)
        .map(ft => ft.replace(/^\./, '').toLowerCase());
    if (wanted.includes('*')) {
        return true;
    }

    //
    //  On Windows "EVIL.EXE:x" and "EVIL.EXE::$DATA" are EVIL.EXE (a stream
    //  of it): match the name up to the first ':' as well as the whole name,
    //  so a ':' can only make an entry run, never skip it.
    //
    const name = String(ctx.fileName || '');
    const exts = [extOf(name)];
    if (name.includes(':')) {
        exts.push(extOf(name.slice(0, name.indexOf(':'))));
    }
    return exts.some(ext => wanted.includes(ext));
}

//
//  Would any configured entry scan this file? ctx: { source, fileName }. For
//  a caller choosing files to scan, e.g. a rescan skipping those no entry's
//  fileTypes covers. False when scanning is disabled.
//
function hasMatchingScanner(ctx) {
    const scanning = getScanningConfig();
    return scanning.enabled && scanning.scanners.some(e => entryMatches(e, ctx || {}));
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

//
//  At most fileBase.scanning.maxConcurrent scanners run at once, across every
//  source: a REST user firing uploads in parallel would otherwise start a
//  scanner process per file, and clamscan loads its whole database each time.
//  The rest wait their turn, first come first served. A scanner's timeout
//  starts when it starts, not while it waits.
//
//  A wait longer than maxQueueWaitMs (0: no limit) is an |error| result, and
//  so goes by the entry's onError like any other failure.
//
//  The limit is read when a slot is asked for, freed, or the config changes:
//  a hot-reload that raises maxConcurrent starts waiting scans at once rather
//  than when a running one finishes.
//
const scanQueue = { running: 0, waiting: [], listening: false };

function drainScanQueueOnConfigChange() {
    if (scanQueue.listening) {
        return;
    }
    scanQueue.listening = true;
    const Events = require('./events.js');
    Events.on(Events.getSystemEvents().ConfigChanged, drainScanQueue);
}

function makeSlotRelease() {
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        --scanQueue.running;
        drainScanQueue();
    };
}

function drainScanQueue() {
    if (0 === scanQueue.waiting.length) {
        return;
    }
    const { maxConcurrent } = getScanningConfig();
    while (scanQueue.running < maxConcurrent && scanQueue.waiting.length > 0) {
        const waiter = scanQueue.waiting.shift();
        clearTimeout(waiter.timer);
        ++scanQueue.running;
        process.nextTick(waiter.cb, null, makeSlotRelease());
    }
}

//  Calls back (null, release) once a slot is free, or (err) after waiting
//  maxQueueWaitMs. |release| must be called exactly once; extra calls are
//  ignored.
function acquireScanSlot(cb) {
    const { maxConcurrent, maxQueueWaitMs } = getScanningConfig();
    if (scanQueue.running < maxConcurrent && 0 === scanQueue.waiting.length) {
        ++scanQueue.running;
        return cb(null, makeSlotRelease());
    }

    drainScanQueueOnConfigChange();
    const waiter = { cb, timer: null };
    if (maxQueueWaitMs > 0) {
        waiter.timer = setTimeout(() => {
            _.pull(scanQueue.waiting, waiter);
            return cb(
                Errors.General(
                    `No scanner slot came free within ${maxQueueWaitMs}ms (maxConcurrent ${maxConcurrent})`
                )
            );
        }, maxQueueWaitMs);
    }
    scanQueue.waiting.push(waiter);
}

exports._scanQueueStats = () => ({
    running: scanQueue.running,
    waiting: scanQueue.waiting.length,
});

//
//  Calls back (res, { forceHold }): |forceHold| is set when the scanner is
//  not registered and mods have not finished registering theirs (see
//  markModRegistrationComplete()): such a file is held whatever onError
//  says, since the scanner may well exist a moment later.
//
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
        return cb(
            errorResult(
                modRegistrationComplete
                    ? `No scanner named "${name}" is registered`
                    : `No scanner named "${name}" is registered yet`
            ),
            { forceHold: !modRegistrationComplete }
        );
    }

    const timeout =
        _.isFinite(entry.timeout) && entry.timeout > 0
            ? entry.timeout
            : exports.DefaultTimeoutMs;

    acquireScanSlot((err, release) => {
        if (err) {
            return cb(errorResult(err.message), {});
        }

        const abort = new AbortController();
        const started = Date.now();
        let done = false;
        let timedOut = false;
        let timer;

        const finish = res => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            release();
            res.durationMs = Date.now() - started;
            return cb(res, {});
        };

        timer = setTimeout(() => {
            //  a scanner may answer from inside abort(): that answer is not
            //  the one that counts
            timedOut = true;
            abort.abort();
            return finish(errorResult(`Timed out after ${timeout}ms`));
        }, timeout);

        const scanCtx = Object.assign({}, ctx, {
            options: entry,
            timeout,
            abortSignal: abort.signal,
        });

        //
        //  |cb| runs the rest of the chain and then the caller's code. Once it
        //  has been called, a throw that reaches the catch below came from
        //  there -- or from the scanner after it answered -- and is rethrown:
        //  swallowing it would leave the chain waiting for a callback that
        //  never comes.
        //
        try {
            impl.scan(filePath, scanCtx, (err, res) => {
                if (timedOut) {
                    return;
                }
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
            if (done) {
                throw e;
            }
            return finish(errorResult(e.message));
        }
    });
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
                runOneScanner(entry, filePath, ctx, (res, how) => {
                    verdict.results.push(res);

                    switch (res.result) {
                        case exports.ScanResults.Infected:
                            decided = Object.assign(
                                { verdict: exports.Verdicts.Infected },
                                res
                            );
                            return nextEntry(true); //  stop the chain

                        case exports.ScanResults.Error:
                            if ('accept' === entry.onError && !how.forceHold) {
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
//  such as ".x" in the list becomes "._". Trailing dots and spaces go first
//  (see trimTrailingDotsAndSpaces()): "FOO.EXE." -> FOO.EX_.
//
function defangFileName(fileName, defangExtensions) {
    const list = (defangExtensions || DEFAULT_DEFANG_EXTENSIONS)
        .filter(_.isString)
        .map(e => e.replace(/^\./, '').toLowerCase());

    fileName = trimTrailingDotsAndSpaces(fileName) || fileName;

    const ext = paths.extname(fileName);
    if (!ext || ext.length < 2 || !list.includes(ext.slice(1).toLowerCase())) {
        return fileName;
    }

    return `${fileName.slice(0, -1)}_`;
}

//  Mode 0600: read/write for the owner only, no exec, setuid, setgid or
//  sticky bits. Windows has no such bits, so a failure there is expected and
//  only logged. Never fails: by now the file is in quarantine, and that is
//  what matters.
function restrictQuarantinedFile(filePath, cb) {
    fs.stat(filePath, err => {
        if (err) {
            log(
                'warn',
                { filePath, error: err.message },
                'Could not stat quarantined file to restrict its mode'
            );
            return cb(null);
        }
        fs.chmod(filePath, 0o600, err => {
            if (err) {
                log(
                    'debug',
                    { filePath, error: err.message },
                    'Could not restrict the mode of quarantined file'
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
        fs.writeFile(sidecarPath, body, { flag: 'wx', mode: 0o600 }, err => {
            if (err && 'EEXIST' === err.code && n < 100) {
                ++n;
                return attempt();
            }
            return cb(err, err ? null : sidecarPath);
        });
    };

    attempt();
}

//  Longest name, in bytes, a quarantined file is given; most file systems
//  stop at 255, and a collision suffix and ".json" still have to fit.
const MAX_QUARANTINE_NAME_BYTES = 200;

//
//  The name a rejected file gets in quarantine. It comes from outside --
//  an uploader, a TIC -- so it is made safe here: no directory part, no
//  trailing dots or spaces, defanged. A name with nothing usable left ("..",
//  ".", all dots, empty) or too long for the file system gets a generated
//  one, so a hostile name can never make the quarantine fail. The original
//  is kept in the sidecar either way.
//
//  Safe on Windows too: the characters Windows refuses become "_" -- ':'
//  above all, as "EVIL.EXE::$DATA" *is* EVIL.EXE there -- and a reserved
//  device name (CON, NUL, COM1.ZIP, ...) gets a leading "_".
//
function quarantineFileName(fileName, ctx, defangExtensions) {
    let name = trimTrailingDotsAndSpaces(
        paths
            .basename(String(fileName || '').replace(/\\/g, '/'))
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    );

    if (!name || Buffer.byteLength(name) > MAX_QUARANTINE_NAME_BYTES) {
        const ext = paths.extname(name).slice(0, 16);
        const id =
            _.isString(ctx.sha256) && ctx.sha256 ? ctx.sha256.slice(0, 16) : Date.now();
        name = `unnamed-${id}${ext}`;
    }

    if (isWindowsDeviceName(name)) {
        name = `_${name}`;
    }

    return defangFileName(name, defangExtensions);
}

exports._quarantineFileName = quarantineFileName;

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
//  An |infected| file that cannot be quarantined (a full disk, a quarantine
//  directory that cannot be made, ...) is deleted instead, loudly: it must
//  never stay where it is, where a later import could pick it up. Only if
//  that fails too is it an error. A |held| file that cannot be quarantined
//  is an error at once and is left where it is -- it may be clean -- for the
//  caller to report.
//
//  Calls back (err, disposition):
//  {
//      action:         'quarantine' | 'delete'
//      path:           final quarantine path (quarantine only)
//      sidecarPath:    the JSON record beside it (quarantine only)
//      quarantineError: why quarantine failed, when an infected file was
//                      deleted instead
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
    let finalPath;

    const quarantineFailed = err => {
        if (exports.Verdicts.Infected !== verdict.result) {
            return cb(err);
        }

        log(
            'error',
            { fileName, path: filePath, source: ctx.source, error: err.message },
            'Could not quarantine an infected file; deleting it instead'
        );

        fs.unlink(filePath, unlinkErr => {
            //  gone already is as good as deleted
            if (unlinkErr && 'ENOENT' !== unlinkErr.code) {
                log(
                    'error',
                    { fileName, path: filePath, error: unlinkErr.message },
                    'Could not delete an infected file either; it is still in place'
                );
                return cb(
                    Errors.General(
                        `Could not quarantine (${err.message}) or delete (${unlinkErr.message}) it`
                    )
                );
            }
            return cb(null, {
                action: exports.FailActions.Delete,
                quarantineError: cleanText(err.message),
            });
        });
    };

    async.series(
        [
            callback => fillHashAndSize(filePath, ctx, callback),
            //  operators only: what is in here is hostile, or may be
            callback => fse.mkdirs(quarantineDir, 0o700, err => callback(err)),
            callback => {
                //  after fillHashAndSize(): a generated name uses the hash
                const quarantineName = quarantineFileName(
                    fileName,
                    ctx,
                    scanning.defangExtensions
                );
                moveFileWithCollisionHandling(
                    filePath,
                    paths.join(quarantineDir, quarantineName),
                    (err, movedTo) => {
                        finalPath = movedTo;
                        return callback(err);
                    }
                );
            },
            callback => restrictQuarantinedFile(finalPath, callback),
        ],
        err => {
            if (err) {
                return quarantineFailed(err);
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

//  Widest line a notice has: the message reader wraps at 79 columns, and a
//  wrapped line could put text from outside at the start of a line of its
//  own -- a forged "Result:" line, say.
const NOTICE_LINE_WIDTH = 79;
//  Longest single value from outside in a notice.
const MAX_NOTICE_FIELD_LENGTH = 68;

//
//  Text from outside -- a file name, a scanner's output, a TIC field -- made
//  fit for a notice. The message reader renders bodies with pipe codes
//  (controlCodesToAnsi(), the body dialect), so "NODELIST.ZIP|00" would black
//  out everything after it: every code is stripped, and a '|' still standing
//  becomes '!' so that none can form again. Runs of white space collapse to
//  one space, and the result is capped.
//
function stripDisplayCodes(text) {
    const stripAll = t => {
        //  stripping can join the pieces of a new code: "|0|001" -> "|01"
        for (let i = 0; i < 8; ++i) {
            const stripped = PipeCodes.strip(t, { dialect: 'body', ansi: true });
            if (stripped === t) {
                return t;
            }
            t = stripped;
        }
        return null;
    };

    const stripped = stripAll(text);
    if (null === stripped) {
        return text.replace(/[|@]/g, '_'); //  pathological: no code survives this
    }
    return stripped.replace(/\|/g, '!');
}

function noticeText(s, maxLength = MAX_NOTICE_FIELD_LENGTH) {
    let text = cleanText(s, Infinity);
    if (!text) {
        return text;
    }
    text = stripDisplayCodes(text).replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

//  A path keeps its end, where the file name is.
function noticePath(s) {
    const text = noticeText(s, Infinity);
    if (!text || text.length <= MAX_NOTICE_FIELD_LENGTH) {
        return text;
    }
    return `...${text.slice(-(MAX_NOTICE_FIELD_LENGTH - 3))}`;
}

function noticeLine(label, value) {
    const line = `${`${label} `.padEnd(9)}${value}`;
    return line.length > NOTICE_LINE_WIDTH
        ? `${line.slice(0, NOTICE_LINE_WIDTH - 3)}...`
        : line;
}

//  Also for any other screen that shows these fields, e.g. the upload
//  module's rejected page.
exports.cleanDisplayText = noticeText;

//
//  rejections: [ { ctx?, verdict, disposition? } ]
//      |ctx| is per file and wins over the call's |ctx| (a rescan spans many
//      areas); |disposition| is what applyFailAction() called back. When it
//      called back an error instead, a caller passes { error, path? }: the
//      file was not moved, and |path| says where it still is.
//
//  ctx.coalesced: { windowMs, notListed } when this is the summary of
//  rejections held back by notifyOperatorsCoalesced().
//
//  Returns { subject, body }. The body is 7-bit ASCII with CRLF line ends,
//  like the other system notices. Everything from outside -- file names,
//  scanner output, TIC fields -- goes through noticeText(): no pipe codes,
//  no runs of white space, and no line wider than the reader wraps at.
//
function buildOperatorNotice(rejections, ctx) {
    ctx = ctx || {};
    const coalesced = ctx.coalesced;
    const notListed = (coalesced && coalesced.notListed) || 0;
    const count = rejections.length + notListed;
    const files = `${count} file${1 === count ? '' : 's'}`;

    const lines = [];
    if (coalesced) {
        const minutes = Math.round(coalesced.windowMs / 60000);
        lines.push(`${files} from the same uploader failed file scanning`);
        lines.push(
            `within ${minutes} minute${1 === minutes ? '' : 's'} of the last notice.`
        );
        if (notListed > 0) {
            lines.push(`${notListed} of them are not listed here; see the log.`);
        }
    } else {
        lines.push(`${files} failed file scanning.`);
    }
    lines.push('');

    rejections.forEach(rej => {
        const c = Object.assign({}, ctx, rej.ctx);
        const v = rej.verdict || {};
        const d = rej.disposition || {};
        const user = userInfo(c);

        let from = noticeText(c.source) || 'unknown';
        if (user && (user.name || user.id)) {
            from += ` (user ${noticeText(user.name, 30) || '?'} #${
                noticeText(String(user.id || ''), 12) || '?'
            })`;
        }
        if (c.ticInfo && c.ticInfo.origin) {
            from += ` (TIC origin ${noticeText(c.ticInfo.origin, 30)})`;
        }

        const outcome =
            exports.Verdicts.Infected === v.result
                ? `infected: ${noticeText(v.signature) || 'unnamed threat'}`
                : `held, scanner failed: ${noticeText(v.detail) || 'unknown error'}`;

        let action;
        let path;
        if (d.error) {
            action = `NOT moved: ${noticeText(d.error)}`;
            path = d.path;
        } else if (exports.FailActions.Delete === d.action && d.quarantineError) {
            action = `DELETED, could not be quarantined: ${noticeText(d.quarantineError)}`;
        } else if (exports.FailActions.Delete === d.action) {
            action = 'deleted';
        } else if (d.path) {
            action = 'quarantined';
            path = d.path;
        } else {
            action = 'none recorded';
        }

        lines.push(noticeLine('File:', noticeText(c.fileName) || '?'));
        lines.push(noticeLine('From:', from));
        if (c.areaTag) {
            lines.push(noticeLine('Area:', noticeText(c.areaTag)));
        }
        if (c.ticInfo) {
            const t = c.ticInfo;
            let tic = `${noticeText(t.area, 30) || '?'} from ${
                noticeText(t.from, 30) || '?'
            }`;
            if (t.passthrough) {
                tic += ' (passthrough)';
            }
            lines.push(noticeLine('TIC:', tic));
            if (t.ticFileName) {
                lines.push(noticeLine('TIC file:', noticeText(t.ticFileName)));
            }
        }
        if (c.sha256) {
            lines.push(noticeLine('SHA-256:', noticeText(c.sha256, 64)));
        }
        lines.push(noticeLine('Scanner:', noticeText(v.scanner) || '?'));
        lines.push(noticeLine('Result:', outcome));
        lines.push(noticeLine('Action:', action));
        if (path) {
            lines.push(noticeLine(d.error ? 'Still at:' : 'Path:', noticePath(path)));
        }
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
        subject: `File scan: ${files} rejected${coalesced ? ' (summary)' : ''}`,
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
    return sendOperatorNotice(subject, body, cb);
}

//
//  A notice already built -- e.g. a file base rescan's run summary -- as ONE
//  private message to each of fileBase.scanning.notifyUserIds. The caller
//  owns the text: anything from outside in it must already have been through
//  cleanDisplayText(). Like notifyOperators(), cb is always cb(null).
//
function sendOperatorNotice(subject, body, cb) {
    cb = cb || _.noop;

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

//
//  notifyOperators() for a source that one person can drive as hard as they
//  like -- a REST user can send rejected uploads back to back. The first
//  rejection under |key| (e.g. the uploader's user ID) is sent at once and
//  opens a window of |windowMs|; rejections under the same key within it are
//  held back and sent as ONE summary when it closes, which opens the next
//  window, so a flood yields a notice per window at most. Logging stays per
//  file: this only limits mail.
//
//  The timers are unref()'d. flushCoalescedNotices() sends what is held back
//  at shutdown; anything that still never goes out was logged per file.
//
const NOTICE_COALESCE_WINDOW_MS = 10 * 60 * 1000;
//  most rejections a summary lists; the rest are counted
const MAX_COALESCED_REJECTIONS = 50;

const coalescedNotices = new Map();

function openNoticeWindow(key, ctx, windowMs) {
    const window = { ctx, windowMs, pending: [], notListed: 0 };
    window.timer = setTimeout(() => closeNoticeWindow(key, true), windowMs);
    if (window.timer.unref) {
        window.timer.unref();
    }
    coalescedNotices.set(key, window);
}

function closeNoticeWindow(key, reopen, cb) {
    cb = cb || _.noop;
    const window = coalescedNotices.get(key);
    if (!window) {
        return cb(null);
    }
    coalescedNotices.delete(key);
    clearTimeout(window.timer);

    if (0 === window.pending.length) {
        return cb(null);
    }

    if (reopen) {
        //  still busy: keep holding back what comes next
        openNoticeWindow(key, window.ctx, window.windowMs);
    }

    return notifyOperators(
        window.pending,
        Object.assign({}, window.ctx, {
            coalesced: { windowMs: window.windowMs, notListed: window.notListed },
        }),
        cb
    );
}

function notifyOperatorsCoalesced(key, rejections, ctx, cb) {
    cb = cb || _.noop;
    rejections = (rejections || []).filter(Boolean);
    if (0 === rejections.length) {
        return cb(null);
    }

    const window = coalescedNotices.get(key);
    if (window) {
        rejections.forEach(rej => {
            if (window.pending.length < MAX_COALESCED_REJECTIONS) {
                window.pending.push(rej);
            } else {
                ++window.notListed;
            }
        });
        log(
            'debug',
            { key, pending: window.pending.length + window.notListed },
            'File scanning notice held back for the next summary'
        );
        return cb(null);
    }

    openNoticeWindow(
        key,
        ctx,
        exports._noticeCoalesceWindowMs || NOTICE_COALESCE_WINDOW_MS
    );
    return notifyOperators(rejections, ctx, cb);
}

//  Sends every summary held back, now. For shutdown, and tests.
function flushCoalescedNotices(cb) {
    cb = cb || _.noop;
    const keys = Array.from(coalescedNotices.keys());
    const held = keys.reduce((n, key) => {
        const w = coalescedNotices.get(key);
        return n + w.pending.length + w.notListed;
    }, 0);
    if (held > 0) {
        log('info', { held }, 'Sending held-back file scanning notices');
    }
    async.eachSeries(
        keys,
        (key, nextKey) => closeNoticeWindow(key, false, () => nextKey(null)),
        () => cb(null)
    );
}

exports.notifyOperatorsCoalesced = notifyOperatorsCoalesced;
exports.flushCoalescedNotices = flushCoalescedNotices;

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
//  The program runs without a shell. On a timeout the whole process tree is
//  killed, not just the program named: a wrapper script's own children (the
//  real scanner) go too. On POSIX it runs in a process group of its own and
//  the group gets SIGKILL; on Windows "taskkill /T /F" ends the tree. A
//  wrapper should still exec the real scanner where it can.
//
//  Output is bounded: past MAX_COMMAND_OUTPUT bytes on either stream the
//  program is killed and the result is an error.
//
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;

function killProcessTree(child) {
    if (!child || !child.pid) {
        return;
    }

    const killChild = () => {
        try {
            child.kill('SIGKILL');
        } catch (e) {
            //  already gone
        }
    };

    if ('win32' === process.platform) {
        try {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
            killer.on('error', killChild);
        } catch (e) {
            killChild();
        }
        return;
    }

    try {
        process.kill(-child.pid, 'SIGKILL'); //  the group: the child is its leader
    } catch (e) {
        killChild();
    }
}

//
//  execFile()'s callback contract -- (err, stdout, stderr), err.code the
//  exit code or a string code, err.killed / err.signal when killed -- with
//  a kill that takes the whole tree. Calls back exactly once.
//
function runCommand(cmd, args, options, cb) {
    const out = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    let done = false;
    let timer;
    let child;

    const text = which => Buffer.concat(out[which]).toString('utf8');

    const finish = err => {
        if (done) {
            return;
        }
        done = true;
        clearTimeout(timer);
        if (options.signal) {
            options.signal.removeEventListener('abort', onAbort);
        }
        return cb(err, text('stdout'), text('stderr'));
    };

    const killAndFinish = err => {
        killProcessTree(child);
        //  a grandchild that escaped the kill may hold the pipes open:
        //  do not wait for them
        if (child) {
            child.stdout && child.stdout.destroy();
            child.stderr && child.stderr.destroy();
        }
        return finish(err);
    };

    const killed = () => {
        const err = new Error(`${cmd} was killed`);
        err.killed = true;
        err.signal = 'SIGKILL';
        return err;
    };

    function onAbort() {
        return killAndFinish(killed());
    }

    try {
        child = spawn(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            //  its own process group on POSIX, so the group can be killed
            detached: 'win32' !== process.platform,
        });
    } catch (e) {
        return finish(e);
    }

    ['stdout', 'stderr'].forEach(which => {
        child[which].on('data', chunk => {
            if (done) {
                return;
            }
            size[which] += chunk.length;
            if (size[which] > MAX_COMMAND_OUTPUT) {
                const err = new Error(
                    `${which} exceeded ${MAX_COMMAND_OUTPUT} bytes; ${cmd} was killed`
                );
                err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
                return killAndFinish(err);
            }
            out[which].push(chunk);
        });
        child[which].on('error', () => {}); //  destroyed above, or the child died
    });

    child.on('error', err => finish(err)); //  failed to start: err.code is a string
    child.on('close', (code, signal) => {
        if (_.isNumber(code) && 0 === code) {
            return finish(null);
        }
        const err = new Error(
            _.isNumber(code)
                ? `${cmd} exited with code ${code}`
                : `${cmd} was killed by ${signal}`
        );
        if (_.isNumber(code)) {
            err.code = code;
        } else {
            err.code = null;
            err.signal = signal;
        }
        return finish(err);
    });

    if (options.signal) {
        if (options.signal.aborted) {
            return onAbort();
        }
        options.signal.addEventListener('abort', onAbort);
    }

    if (_.isFinite(options.timeout) && options.timeout > 0) {
        timer = setTimeout(onAbort, options.timeout);
    }
}

exports._runCommand = runCommand;

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

        runCommand(
            opts.cmd,
            args,
            {
                timeout: ctx.timeout,
                signal: ctx.abortSignal,
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
