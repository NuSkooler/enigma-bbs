'use strict';

const fsp = require('fs/promises');
const paths = require('path');
const _ = require('lodash');

//
//  Which files a BSO flow file line may act on.
//
//  A flow file names files by absolute path (FTS-5005.003 sec. 3.1), and the
//  outbound is commonly shared with other software: tossers, other mailers,
//  hand-written attaches. Three rules keep what a line can do in proportion:
//
//    * Protected directories. A file under ENiGMA's own configuration,
//      security, database or log directories (or the directory holding the
//      loaded config.hjson) is never sent and never deleted or truncated,
//      whatever the line says. No mail flow ever needs one.
//
//    * Mail directories. '^', '-' and '#' delete or truncate a file after it
//      is sent. That happens only when the file is inside a mail directory:
//      the outbound directories the spool scans, the inbound and secure
//      inbound, the TIC transit directory, and anything the operator lists
//      in scannerTossers.ftn_bso.binkp.flowDispositionRoots. Elsewhere the
//      file is still sent, but left where it is.
//
//    * The basename fallback. BsoSpool looks for a dangling reference's
//      basename beside its flow file, so mail moved between outbound
//      directories by hand still ships (#734). That rescue is for packets and
//      bundles ENiGMA queued, so it applies only to '^', '-' and '#' lines,
//      never onto a BSO control or flow file, and only when the stored path
//      points into an outbound-style directory.
//
//  Paths are compared by realpath, so a symlink is judged by where it leads
//  -- except for a delete, which removes the directory entry itself and so is
//  judged by where that entry is (see classifyEntry()).
//
//  Nothing here reads Config() at load time; the settings are passed in.
//

//
//  Extensions of BSO control and flow files, any basename. From FTS-5005.003
//  (flow ?lo, netmail ?ut in the flavours i/c/d/normal/h, .req, .bsy, .csy,
//  .hld, .try, .pnt point directories) and binkd's ftnq.c (.stc link status).
//  'n' is the outdated normal flavour FTS-5005 mentions. '.sep' is Husky's
//  separate-bundles directory.
//
//  Spelled out rather than '?ut' / '?lo': a bundle's day extension can end in
//  'ut' too ("sut", "tut" are a Sunday or Tuesday bundle), and bundles have to
//  stay rescuable.
//
const CONTROL_EXTS = new Set([
    'ilo',
    'clo',
    'dlo',
    'flo',
    'hlo',
    'nlo',
    'iut',
    'cut',
    'dut',
    'out',
    'hut',
    'nut',
    'req',
    'bsy',
    'csy',
    'hld',
    'try',
    'stc',
    'pnt',
    'sep',
]);

//  A BSO zone suffix: 3 hex digits, or 4 for zones above 4095 (FTS-5005.003 sec. 2).
const ZONE_SUFFIX_RE = /\.[0-9a-f]{3,4}$/i;

//  A point's outbound subdirectory, e.g. 00680024.pnt
const POINT_DIR_RE = /^[0-9a-f]{8}\.pnt$/i;

const DEFAULT_OUTBOUND_NAME = 'outbound';

//  Directives that delete or truncate after sending.
const DISPOSING_DIRECTIVES = ['^', '-', '#'];

//  What ENiGMA itself writes: send-and-keep, delete, truncate.
const WRITER_DIRECTIVES = ['', '^', '#'];

//  Every directive character FTS-5005.003 defines, standard or optional.
const DIRECTIVE_CHARS = '^#~!-@';

//  Synchronet binkit reads flow lines with readln(2048).
const MAX_FLOW_LINE_BYTES = 2047;

function isControlFileName(name) {
    const ext = paths.extname(String(name || ''));
    return ext.length > 1 && CONTROL_EXTS.has(ext.slice(1).toLowerCase());
}

//
//  True when |name| (one path component) looks like an outbound directory:
//  "outbound", one of |outboundNames| (lower case), either with an optional
//  zone suffix, or a point directory.
//
function isOutboundLikeDirName(name, outboundNames) {
    const lower = String(name || '').toLowerCase();
    if (!lower) {
        return false;
    }
    if (POINT_DIR_RE.test(lower)) {
        return true;
    }
    const names = outboundNames || new Set();
    const stem = lower.replace(ZONE_SUFFIX_RE, '');
    return (
        DEFAULT_OUTBOUND_NAME === stem ||
        DEFAULT_OUTBOUND_NAME === lower ||
        names.has(stem) ||
        names.has(lower)
    );
}

//
//  May a dangling reference |ref| written with |directive| be looked for by
//  basename beside its flow file?
//
//  Split on either separator, since the line may have been written on the
//  other sort of platform (C:\fido\outbound\0000fc9c.mo1). A bare name with
//  no directory at all keeps the fallback it always had: the flow file's own
//  directory is the first place FTS-5005.003 suggests for one.
//
function basenameFallbackAllowed(ref, directive, outboundNames) {
    if (!DISPOSING_DIRECTIVES.includes(directive)) {
        return false;
    }

    const parts = String(ref || '').split(/[\\/]/);
    const base = parts.pop();
    if (!base || '.' === base || '..' === base || isControlFileName(base)) {
        return false;
    }

    if (0 === parts.length) {
        //  "C:name" is relative to a drive's current directory; not a bare name.
        return !base.includes(':');
    }

    return isOutboundLikeDirName(parts.pop(), outboundNames);
}

//
//  Why |directive| + |refPath| should not be written to a flow file, or null
//  when it is fine.
//
//  Readers differ (see FTS-5005.003 and the mailers that implement it): a line
//  break or NUL splits or ends a line, leading whitespace is part of the path
//  to binkd, trailing whitespace is trimmed by most readers, a second directive character is read as a directive by some and
//  as part of the path by others, and binkit cuts lines at 2048 bytes.
//
function flowRefLineProblem(directive, refPath) {
    if (!WRITER_DIRECTIVES.includes(directive)) {
        return `unsupported directive ${JSON.stringify(directive)}`;
    }
    if ('string' !== typeof refPath || 0 === refPath.length) {
        return 'empty path';
    }
    for (let i = 0; i < refPath.length; i++) {
        const c = refPath.charCodeAt(i);
        if (c < 0x20 || 0x7f === c) {
            return 'path contains a control character';
        }
    }
    if (/^\s/.test(refPath)) {
        return 'path starts with whitespace';
    }
    if (/\s$/.test(refPath)) {
        //  Readers trim it, so the file they look for is not this one.
        return 'path ends with whitespace';
    }
    if (DIRECTIVE_CHARS.includes(refPath[0])) {
        return 'path starts with a directive character';
    }
    if (!paths.isAbsolute(refPath)) {
        return 'path is not absolute';
    }
    if (Buffer.byteLength(`${directive}${refPath}`, 'utf8') > MAX_FLOW_LINE_BYTES) {
        return `line is longer than ${MAX_FLOW_LINE_BYTES} bytes`;
    }
    return null;
}

function stringList(list) {
    return (Array.isArray(list) ? list : []).filter(
        p => 'string' === typeof p && p.length > 0
    );
}

//
//  The configuration-derived inputs to a FlowPathPolicy, from a full Config()
//  object. The mail directories are not here: BsoSpool adds them from the
//  same |paths| and outbound scan it uses to find flow files, so the two
//  cannot drift.
//
//  |configFilePath| defaults to the config.hjson the process loaded.
//
function flowPathSettings(config, { configFilePath } = {}) {
    const sysPaths = _.get(config, 'paths', {}) || {};

    if (undefined === configFilePath) {
        try {
            configFilePath = require('./config.js').Config.getBasePath();
        } catch {
            configFilePath = undefined;
        }
    }

    const protectedDirs = [
        sysPaths.config,
        sysPaths.security,
        sysPaths.db,
        sysPaths.modsDb,
        sysPaths.logs,
    ];
    if ('string' === typeof configFilePath && configFilePath) {
        protectedDirs.push(paths.dirname(paths.resolve(configFilePath)));
    }

    //  File base storage. Payloads forwarded to downlinks are queued from
    //  here, so a protected directory that happens to contain the file base
    //  (config.hjson kept at the top of the install, say) must not stop them.
    const storeDirs = [];
    const prefix = _.get(config, 'fileBase.areaStoragePrefix');
    if ('string' === typeof prefix && prefix) {
        storeDirs.push(prefix);
        _.forEach(_.get(config, 'fileBase.storageTags', {}), location => {
            if ('string' === typeof location) {
                storeDirs.push(paths.resolve(prefix, location.replace(/\/\*$/, '')));
            }
        });
    }

    return {
        protectedDirs: stringList(protectedDirs),
        storeDirs: stringList(storeDirs),
        dispositionRoots: stringList(
            _.get(config, 'scannerTossers.ftn_bso.binkp.flowDispositionRoots')
        ),
    };
}

function isInside(target, dir) {
    if (target === dir) {
        return true;
    }
    const prefix = dir.endsWith(paths.sep) ? dir : `${dir}${paths.sep}`;
    return target.startsWith(prefix);
}

async function realDir(dir) {
    try {
        return await fsp.realpath(paths.resolve(dir));
    } catch {
        //  A directory that does not exist contains nothing.
        return null;
    }
}

//  Overlap reports already logged, so a spool rebuilt per poll says it once.
const reportedOverlaps = new Set();

//
//  Built per spool operation from the directories in force at that moment.
//
//  Entry kinds:
//    protected   never sent, never disposed
//    mail        may be disposed; also exempt from an enclosing protected dir
//    store       exempt from an enclosing protected dir; not disposable
//    extra       operator flowDispositionRoots: may be disposed, exempts nothing
//
//  The most specific (longest) directory decides between protected and an
//  exemption; on a tie the protected entry wins.
//
class FlowPathPolicy {
    constructor(entries, outboundNames) {
        this._entries = entries;
        this.outboundNames = outboundNames || new Set();
    }

    static async build({ settings = {}, spoolDirs = [], outboundNames, log } = {}) {
        const entries = [];
        const add = async (dirs, kind) => {
            for (const dir of stringList(dirs)) {
                const real = await realDir(dir);
                if (real) {
                    entries.push({ dir: real, kind, configured: dir });
                }
            }
        };

        await add(settings.protectedDirs, 'protected');
        await add(spoolDirs, 'mail');
        await add(settings.storeDirs, 'store');
        await add(settings.dispositionRoots, 'extra');

        const policy = new FlowPathPolicy(entries, outboundNames);
        policy._reportOverlaps(log);
        return policy;
    }

    //
    //  A mail directory inside a protected one is fine and stays usable --
    //  it is what a config.hjson at the top of the install looks like -- but
    //  the operator should know which way each overlap went.
    //
    _reportOverlaps(log) {
        if (!log) {
            return;
        }

        const protectedDirs = this._entries.filter(e => 'protected' === e.kind);
        const overlaps = [];
        for (const e of this._entries) {
            if ('protected' === e.kind) {
                continue;
            }
            const within = protectedDirs.find(p => isInside(e.dir, p.dir));
            if (!within) {
                continue;
            }
            const usable = !this.classifyRealPath(e.dir).refused;
            overlaps.push({ dir: e.dir, kind: e.kind, protectedDir: within.dir, usable });
        }

        if (0 === overlaps.length) {
            return;
        }

        const key = JSON.stringify(overlaps);
        if (reportedOverlaps.has(key)) {
            return;
        }
        reportedOverlaps.add(key);

        const blocked = overlaps.filter(o => !o.usable);
        if (blocked.length > 0) {
            log.warn(
                { overlaps: blocked },
                '[BinkP/BSO] Mail directory is a protected directory, or a flowDispositionRoots entry ' +
                    'lies inside one; flow file entries there are not sent'
            );
        }
        const usable = overlaps.filter(o => o.usable);
        if (usable.length > 0) {
            log.info(
                { overlaps: usable },
                '[BinkP/BSO] Mail directory lies inside a protected directory; files under the mail directory are still sent'
            );
        }
    }

    //
    //  { realPath, refused, allowed, protectedDir } for an existing |filePath|,
    //  or null when it cannot be resolved (it went away).
    //
    //  |refused|: inside a protected directory; never send or dispose.
    //  |allowed|: '^', '-' and '#' may delete or truncate it.
    //
    async classify(filePath) {
        let realPath;
        try {
            realPath = await fsp.realpath(filePath);
        } catch {
            return null;
        }
        return { realPath, ...this.classifyRealPath(realPath) };
    }

    //
    //  As classify(), but for the directory entry itself rather than what it
    //  points to: realpath of its directory plus its own name. This is what a
    //  delete acts on -- unlink() never follows the final component -- so
    //  removing a symlink that sits in a mail directory is always in bounds,
    //  wherever it leads. Sending and truncating go by classify().
    //
    async classifyEntry(filePath) {
        let realPath;
        try {
            realPath = paths.join(
                await fsp.realpath(paths.dirname(filePath)),
                paths.basename(filePath)
            );
        } catch {
            return null;
        }
        return { realPath, ...this.classifyRealPath(realPath) };
    }

    classifyRealPath(realPath) {
        let protectedLen = -1;
        let protectedDir;
        let exemptLen = -1;
        let disposable = false;

        for (const { dir, kind } of this._entries) {
            if (!isInside(realPath, dir)) {
                continue;
            }
            if ('protected' === kind) {
                if (dir.length > protectedLen) {
                    protectedLen = dir.length;
                    protectedDir = dir;
                }
                continue;
            }
            if ('mail' === kind || 'store' === kind) {
                exemptLen = Math.max(exemptLen, dir.length);
            }
            if ('mail' === kind || 'extra' === kind) {
                disposable = true;
            }
        }

        const refused = protectedLen >= 0 && exemptLen <= protectedLen;
        return {
            refused,
            allowed: !refused && disposable,
            protectedDir: refused ? protectedDir : undefined,
        };
    }
}

module.exports = {
    CONTROL_EXTS,
    MAX_FLOW_LINE_BYTES,
    isControlFileName,
    isOutboundLikeDirName,
    basenameFallbackAllowed,
    flowRefLineProblem,
    flowPathSettings,
    FlowPathPolicy,
};
