'use strict';

const fsp = require('fs/promises');
const path = require('path');

const Address = require('../ftn_address');
const { moveFileWithCollisionHandling } = require('../file_util');
const { isPlainFileName } = require('./file_name');
const FNV1a = require('../fnv1a');
const Log = require('../logger').log;
const {
    resolveDefaultNetworkName,
    resolveNetworkDefaultZone,
    outboundDirName,
    legacyOutboundDirName,
    DEFAULT_NETWORK_DIR_NAME,
    canonicalNetworkNameForAddress,
    withCompanionTicRefs,
    companionTicPath,
} = require('../bso_util');
const bsoLock = require('../bso_lock');
const { withFlowFileLock, isBusyError } = require('../bso_lock');
const {
    FlowPathPolicy,
    basenameFallbackAllowed,
    isControlFileName,
} = require('../bso_flow_paths');
const {
    readFlowFile,
    rewriteFlowFile,
    flowLinkRefused,
    withFlowFileWrite,
    isFlowTempFileName,
    printablePath,
} = require('../bso_flow');

// In priority order (highest first)
const FLOW_EXTS = ['ilo', 'clo', 'dlo', 'flo', 'hlo'];
const DIRECT_EXTS = ['iut', 'cut', 'dut', 'out', 'hut'];

// Any BSO flow file: an 8 hex digit basename plus a flow or direct-attach
// extension. Built from the lists above so the two cannot drift apart.
// Case-insensitive: FTS-5005.003 §2 asks that software "be able to handle
// both" upper and lower case BSO filenames.
const FLOW_FILE_RE = new RegExp(
    `^([0-9a-f]{8})\\.(${FLOW_EXTS.concat(DIRECT_EXTS).join('|')})$`,
    'i'
);

// A point's outbound subdirectory, e.g. 00680024.pnt (FTS-5005.003 §2)
const POINT_DIR_RE = /^([0-9a-f]{8})\.pnt$/i;

// Default age beyond which an unreleased .bsy lock is considered orphaned
// (BBS crashed mid-session). 6× the BinkP session timeout (5 min) gives a
// generous safety margin without making post-crash recovery slow. Tunable
// via scannerTossers.ftn_bso.binkp.staleLockMaxAgeMs.
//
// Defined in core/bso_lock.js, which owns the FTS-5005 §5.1 .bsy protocol for
// both this reader and the ftn_bso writer -- see the note there on why the two
// must not carry separate implementations (issue #719).
const DEFAULT_STALE_LOCK_MAX_AGE_MS = bsoLock.DEFAULT_STALE_LOCK_MAX_AGE_MS;

// Networks we've already complained about. Module scope rather than per
// instance: a spool is rebuilt for every poll and every inbound session, but
// the complaint is about static configuration — once per process is plenty.
const warnedNetworks = new Set();

// Flow file references we've already complained about. Same reasoning as
// |warnedNetworks|: an unusable reference is a standing condition the sysop
// needs told about once, not once per poll cycle. Bounded because unlike
// networks these are unbounded in principle -- a downlink that never answers
// accumulates a uniquely named packet per export. Past the cap we start over
// rather than grow: a little repetition beats a leak.
const MAX_WARNED_FLOW_REFS = 1024;

//  key -> when we last said something about it. A dangling reference is a
//  standing fault, not an event: the file is not coming back on its own and
//  the node does not get its mail until an operator deals with it. Warning
//  once per process meant a busy system said it once at boot and then never
//  again, so the condition was invisible by the time anyone looked. Repeating
//  keeps it in the log without turning every poll into noise.
const DEFAULT_FLOW_REF_WARN_REPEAT_MS = 60 * 60 * 1000; //  1 hour
const warnedFlowRefs = new Map();

//
//  BsoSpool — filesystem adapter between BinkP sessions and the BSO outbound/
//  inbound spool that ftn_bso manages.
//
//  Responsibilities:
//    - Find outbound files (flow refs + direct-attach packets) for a remote node
//    - Manage per-node .bsy session locks
//    - Move received temp files into the configured inbound directory
//    - Mark flow file entries as done (~) after successful send
//
//  config:
//    paths.outbound   : base outbound dir  (ftn_bso writes flow/packet files here)
//    paths.inbound    : unsecured inbound dir
//    paths.secInbound : password-protected inbound dir
//    networks         : messageNetworks.ftn.networks  (for zone/dir resolution)
//    defaultNetwork   : scannerTossers.ftn_bso.defaultNetwork  (which network
//                       owns the bare outbound/ dir; see core/bso_util.js)
//    flowPaths        : flowPathSettings(config) from core/bso_flow_paths.js:
//                       protected directories, file base storage and the
//                       operator's flowDispositionRoots. Optional; the mail
//                       directories come from |paths| and the outbound scan.
//
class BsoSpool {
    //  flow file path -> tail of the in-flight rewrite chain for it. Shared
    //  with everything else in the process that rewrites a flow file; see
    //  withFlowFileWrite() in core/bso_flow.js.
    static _flowWrites = require('../bso_flow')._flowWrites;

    constructor(config) {
        this._paths = config.paths || {};
        this._networks = config.networks || {};
        this._defaultNetwork = config.defaultNetwork;
        this._staleLockMaxAgeMs =
            typeof config.staleLockMaxAgeMs === 'number'
                ? config.staleLockMaxAgeMs
                : DEFAULT_STALE_LOCK_MAX_AGE_MS;
        this._flowRefWarnRepeatMs =
            typeof config.flowRefWarnRepeatMs === 'number'
                ? config.flowRefWarnRepeatMs
                : DEFAULT_FLOW_REF_WARN_REPEAT_MS;
        this._flowPaths = config.flowPaths || {};
    }

    // ── Lock management ──────────────────────────────────────────────────────

    // Acquire the per-node .bsy lock. Returns false if already locked by another
    // process (ours or an external mailer's); throws on unexpected errors.
    // The protocol itself lives in core/bso_lock.js.
    async acquireLock(addr) {
        return bsoLock.acquire(this._bsyPath(addr), this._lockOpts());
    }

    async releaseLock(addr) {
        await bsoLock.release(this._bsyPath(addr));
    }

    _lockOpts() {
        return { staleMaxAgeMs: this._staleLockMaxAgeMs, log: Log };
    }

    // Sweep every outbound directory for orphaned .bsy lock files. Returns the
    // number of files reaped. Intended for startup so a crashed prior run
    // doesn't leave nodes permanently un-pollable.
    async reapStaleLocks() {
        const dirs = await this._allOutboundDirs();
        let reaped = 0;

        //  |recurse| descends one level into NNNNnnnn.pnt/ subdirectories,
        //  where a point's lock lives. Points do not nest.
        const sweep = async (dir, recurse) => {
            let entries;
            try {
                entries = await fsp.readdir(dir);
            } catch {
                return;
            }
            for (const file of entries) {
                if (recurse && POINT_DIR_RE.test(file)) {
                    await sweep(path.join(dir, file), false);
                    continue;
                }
                if (isFlowTempFileName(file)) {
                    //  Left by a rewrite that never finished (a crash
                    //  between writing it and renaming it into place).
                    await this._reapStaleTemp(path.join(dir, file));
                    continue;
                }
                if (!/\.bsy$/i.test(file)) continue;
                if (await this._reapIfStale(path.join(dir, file))) reaped++;
            }
        };

        for (const { dir } of dirs) {
            await sweep(dir, true);
        }
        return reaped;
    }

    // Returns true if the .bsy at |bsyPath| was older than staleLockMaxAgeMs
    // and has been removed (or was already gone). Returns false when the file
    // is still fresh, or when stat/unlink errors prevent a confident reap.
    async _reapIfStale(bsyPath) {
        return bsoLock.reapIfStale(bsyPath, this._staleLockMaxAgeMs, Log);
    }

    async _reapStaleTemp(tmpPath) {
        const stat = await fsp.stat(tmpPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > this._staleLockMaxAgeMs) {
            await fsp.unlink(tmpPath).catch(() => {});
        }
    }

    // ── Outbound file enumeration ────────────────────────────────────────────

    // Returns all pending outbound files for |addr|.
    // Each entry: { name, path, size, timestamp, disposition, disposeFn }
    // Call disposeFn() after the remote acknowledges receipt (file-sent event).
    async getOutboundFilesForNode(addr) {
        const results = [];
        const policy = await this._flowPathPolicy();

        for (const { dir, base, entries } of await this._spoolTargetsForNode(addr)) {
            for (const ext of DIRECT_EXTS) {
                const actual = entries.get(`${base}.${ext}`);
                if (!actual) continue;

                const filePath = path.join(dir, actual);
                try {
                    const stat = await fsp.stat(filePath);
                    // Zero-byte .ilo = poll trigger, not actual mail
                    if (stat.size === 0) continue;
                    //  Found by the scan, so the entry itself is in the
                    //  outbound and unlinking it touches nothing else; but a
                    //  symlink here must not send a protected file.
                    if (
                        await refusedTarget(
                            policy,
                            filePath,
                            addr,
                            filePath,
                            this._flowRefWarnRepeatMs
                        )
                    )
                        continue;
                    results.push({
                        //  FTS-5005.003 §3.1: a netmail flow file "must be
                        //  dynamically renamed at the moment of sending to a
                        //  remote system with a unique name and extension
                        //  'pkt'". Sending it under its NNNNnnnn.?ut name
                        //  leaves the remote with a file its tosser will not
                        //  recognise as a packet.
                        name: uniquePacketName(filePath),
                        path: filePath,
                        size: stat.size,
                        timestamp: Math.floor(stat.mtimeMs / 1000),
                        disposition: 'delete',
                        allowed: true,
                        //  Direct-attach has no flow file to annotate, and the
                        //  session layer (BinkpSession._applyDisposition) already
                        //  unlinks/truncates per the queued disposition. Nothing
                        //  for the spool layer to do post-send.
                        disposeFn: null,
                    });
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        Log.warn(
                            { path: filePath, error: err.message },
                            '[BinkP/BSO] Error stat-ing direct-attach file'
                        );
                    }
                }
            }

            for (const ext of FLOW_EXTS) {
                const actual = entries.get(`${base}.${ext}`);
                if (!actual) continue;

                const flowPath = path.join(dir, actual);
                try {
                    results.push(...(await this._parseFlowFile(flowPath, addr, policy)));
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        Log.warn(
                            { path: flowPath, error: err.message },
                            '[BinkP/BSO] Error reading flow file'
                        );
                    }
                }
            }
        }

        return results;
    }

    //
    //  Walk every outbound directory and hand |cb| one entry per spool file
    //  found, as { addr, filePath, ext, isFlow }. No judgement about whether
    //  the file has anything live in it -- that belongs to the caller, and
    //  the two callers want opposite things: the poller wants only nodes it
    //  should dial, while the operator's listing must show precisely the node
    //  whose every entry has gone missing.
    //
    async _forEachOutboundFile(cb) {
        const outboundDirs = await this._allOutboundDirs();

        //  |bossBase| is set when scanning inside a NNNNnnnn.pnt/ subdirectory,
        //  in which case each basename is a point number rather than a
        //  net/node pair (FTS-5005.003 §2).
        const scanDir = async (dir, zone, bossBase) => {
            let entries;
            try {
                entries = await fsp.readdir(dir);
            } catch {
                return;
            }

            for (const file of entries) {
                if (!bossBase) {
                    const pnt = POINT_DIR_RE.exec(file);
                    if (pnt) {
                        await scanDir(path.join(dir, file), zone, pnt[1].toLowerCase());
                        continue;
                    }
                }

                const m = FLOW_FILE_RE.exec(file);
                if (!m) continue;

                const base = m[1].toLowerCase();
                const ext = m[2].toLowerCase();

                //  A point number of zero addresses the boss node, whose files
                //  belong in the outbound directory proper.
                const point = bossBase ? parseInt(base, 16) : 0;
                if (bossBase && 0 === point) continue;

                const nodeBase = bossBase || base;
                const addr = new Address({
                    zone,
                    net: parseInt(nodeBase.slice(0, 4), 16),
                    node: parseInt(nodeBase.slice(4, 8), 16),
                    ...(point ? { point } : {}),
                });

                await cb({
                    addr,
                    filePath: path.join(dir, file),
                    ext,
                    isFlow: FLOW_EXTS.includes(ext),
                });
            }
        };

        for (const { dir, zone } of outboundDirs) {
            await scanDir(dir, zone);
        }
    }

    // Returns Address objects for every node that has at least one unsent file.
    async getNodesWithPendingMail() {
        const seen = new Set();
        const results = [];
        const policy = await this._flowPathPolicy();

        await this._forEachOutboundFile(async ({ addr, filePath, isFlow }) => {
            const key = addr.toString();
            if (seen.has(key)) return;

            if (isFlow) {
                if (
                    !(await flowHasPending(
                        filePath,
                        addr,
                        this._flowRefWarnRepeatMs,
                        policy
                    ))
                )
                    return;
            } else {
                // Direct-attach: zero-byte = poll flag, not mail
                const stat = await fsp.stat(filePath).catch(() => null);
                if (!stat || stat.size === 0) return;
                if (
                    await refusedTarget(
                        policy,
                        filePath,
                        addr,
                        filePath,
                        this._flowRefWarnRepeatMs
                    )
                )
                    return;
            }

            seen.add(key);
            results.push(addr);
        });

        return results;
    }

    //
    //  Everything sitting in the outbound, per node, whether or not it can
    //  still be sent -- the operator-facing view behind "oputil bso".
    //
    //  Returns [{ address, entries: [...] }] sorted by address, where each
    //  entry is { kind, status, path, size, timestamp, disposition, flowFile,
    //  lineIdx, line }. |status| is 'pending', 'sent', 'missing', 'unreadable'
    //  or 'refused'; a 'missing' entry is one whose reference resolves to no
    //  file on disk, which is the condition that never resolves itself. A
    //  'refused' entry names a file in a protected directory, which is never
    //  sent (see core/bso_flow_paths.js). A 'misfiled' entry's stored path is
    //  gone but a file of that name sits beside the flow file, which this
    //  entry may not be sent from (|besideFlowFile| names it): it is not
    //  missing, and must not be pruned. A pending flow entry also carries
    //  |dispositionAllowed|: false when its '^', '-' or '#' will not be
    //  carried out because the file is outside the mail directories.
    //  A 'skip' entry is a '!' line, which is never sent. An 'unknown' entry
    //  is a line whose first character is no directive and starts no path,
    //  and an 'invalid' one a line no mailer reads the same way (a control
    //  character, more than 4096 bytes, no path at all, or a path that is
    //  not UTF-8); both carry |reason|, are never sent and never pruned, and
    //  keep their flow file in place. Lines are parsed by parseFlowLine() in
    //  core/bso_flow.js. A flow file that is a symlink into a protected
    //  directory is not read: it is one 'refused' entry for the flow file
    //  itself, with |linkTarget| naming where it leads.
    //
    //
    //  |options.onUnreadable| is called with the path of any flow file that
    //  could not be read at all. This is a *report*: it skips what it cannot
    //  read and carries on, which is right for an operator listing and wrong
    //  for anything that deletes based on the answer. A caller doing the latter
    //  -- the passthrough transit sweep -- has to know the picture is
    //  incomplete, because a node whose flow file we could not read contributes
    //  zero references and its files then look unwanted.
    //
    async inspectOutbound(options = {}) {
        const byNode = new Map();
        const policy = await this._flowPathPolicy();

        const add = (addr, entry) => {
            const key = addr.toString();
            if (!byNode.has(key)) {
                byNode.set(key, { address: addr, entries: [] });
            }
            byNode.get(key).entries.push(entry);
        };

        await this._forEachOutboundFile(async ({ addr, filePath, isFlow }) => {
            if (!isFlow) {
                const stat = await fsp.stat(filePath).catch(() => null);
                //  Zero-byte direct-attach files are poll flags, not mail.
                if (!stat || 0 === stat.size) {
                    return;
                }
                const classified = await policy.classify(filePath);
                add(addr, {
                    kind: 'direct',
                    status: classified && classified.refused ? 'refused' : 'pending',
                    path: filePath,
                    size: stat.size,
                    timestamp: Math.floor(stat.mtimeMs / 1000),
                    disposition: 'delete',
                });
                return;
            }

            //  A flow file linked into a protected directory is not read; it is
            //  listed as refused itself. Quiet: this is a report.
            const linkRefused = await flowLinkRefused(filePath, policy, { quiet: true });
            if (linkRefused) {
                add(addr, {
                    kind: 'flow',
                    status: 'refused',
                    path: filePath,
                    linkTarget: linkRefused.realPath,
                    protectedDir: linkRefused.protectedDir,
                    size: null,
                    timestamp: null,
                    disposition: null,
                    flowFile: filePath,
                    lineIdx: null,
                    line: null,
                });
                return;
            }

            //  A zero length read of a flow file whose size says otherwise is
            //  a read that raced someone else's in-place rewrite, and counts
            //  as unreadable (see readFlowFile()).
            const read = await readFlowFile(filePath).catch(() => null);
            if (null === read) {
                if (options.onUnreadable) {
                    options.onUnreadable(filePath);
                }
                return;
            }

            const lines = read.lines;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if ('blank' === line.kind) continue;

                const base = {
                    kind: 'flow',
                    flowFile: filePath,
                    lineIdx: i,
                    line: line.text,
                };

                if ('skip' === line.kind) {
                    //  '~' is a line already processed; '!' one to leave
                    //  alone. Neither is sent.
                    add(addr, {
                        ...base,
                        status: '~' === line.directive ? 'sent' : 'skip',
                        //  A relative one is relative to the flow file, as
                        //  for a line still to be sent; the transit sweep
                        //  resolves these paths.
                        path:
                            textPath(flowLineTarget(filePath, line)) || displayPath(line),
                    });
                    continue;
                }

                if ('send' !== line.kind) {
                    //  Not understood: never sent, never pruned, and it keeps
                    //  the flow file in place. The operator decides.
                    add(addr, {
                        ...base,
                        status: line.kind,
                        reason: line.reason,
                        path: displayPath(line),
                        size: null,
                        timestamp: null,
                        disposition: line.disposition,
                    });
                    continue;
                }

                const disposition = line.disposition;

                if (Buffer.isBuffer(line.path)) {
                    //  Bytes that are not UTF-8. ENiGMA cannot send it under a
                    //  name, but whether it is there still decides between
                    //  something to fix and something to prune.
                    const there = !(await isGenuinelyAbsent(
                        flowLineTarget(filePath, line)
                    ));
                    add(addr, {
                        ...base,
                        status: there ? 'invalid' : 'missing',
                        reason: there ? 'path is not valid UTF-8' : undefined,
                        path: displayPath(line),
                        size: null,
                        timestamp: null,
                        disposition,
                    });
                    continue;
                }

                //  Resolve quietly: this is a report, and shouting into the
                //  log every time an operator runs it would bury the periodic
                //  warning that actually marks a change of state.
                const resolved = await resolveFlowRefQuiet(filePath, line, policy);
                const classified = resolved ? await policy.classify(resolved.path) : null;
                const dispositionCheck = resolved
                    ? await judgeDisposition(policy, disposition, resolved.path)
                    : null;
                let besideFlowFile = null;

                //  Absent is not the same as unreadable, and only the first
                //  is safe to prune. A file behind a permissions problem, a
                //  dead NFS mount or an exhausted descriptor table is still
                //  there and still owed to the node; dropping its reference
                //  would discard mail over a transient fault.
                let status = 'pending';
                if (!resolved) {
                    if (!(await isGenuinelyAbsent(flowLineTarget(filePath, line)))) {
                        status = 'unreadable';
                    } else {
                        //  Gone from where it was queued, but a file of that
                        //  name is beside the flow file -- moved, not lost.
                        //  This entry may not be sent from there (see
                        //  resolveFlowRef()), and pruning it would strand
                        //  the file, so it gets a status prune leaves alone.
                        besideFlowFile = await misfiledPath(
                            filePath,
                            line.path,
                            flowLineTarget(filePath, line)
                        );
                        status = besideFlowFile ? 'misfiled' : 'missing';
                    }
                } else if (classified && classified.refused) {
                    status = 'refused';
                }

                add(addr, {
                    ...base,
                    status,
                    path: resolved
                        ? resolved.path
                        : flowLineTarget(filePath, line) || line.path,
                    size: resolved ? resolved.stat.size : null,
                    timestamp: resolved ? Math.floor(resolved.stat.mtimeMs / 1000) : null,
                    disposition,
                    dispositionAllowed:
                        'keep' === disposition ||
                        Boolean(dispositionCheck && dispositionCheck.allowed),
                    ...(besideFlowFile ? { besideFlowFile } : {}),
                });
            }
        });

        return Array.from(byNode.values()).sort((a, b) =>
            a.address.toString().localeCompare(b.address.toString())
        );
    }

    //
    //  Drop every 'missing' reference for |addr| from its flow files.
    //
    //  Deliberately operator-driven rather than automatic: a deleted file and
    //  one that is briefly unreachable -- an unmounted store, a half-finished
    //  copy -- are the same ENOENT here, and guessing wrong throws away mail
    //  nobody asked us to discard. With |dryRun| nothing is written and the
    //  caller is told what would go.
    //
    async pruneMissingRefs(addr, { dryRun = true, lockTimeoutMs } = {}) {
        const policy = await this._flowPathPolicy();
        const target = (await this.inspectOutbound()).find(n =>
            sameAddress(n.address, addr)
        );

        const removed = (target ? target.entries : []).filter(
            e => 'missing' === e.status
        );

        if (dryRun || 0 === removed.length) {
            return { removed, busy: [] };
        }

        //  Group by flow file so each is rewritten once, and go bottom-up so
        //  an earlier removal cannot shift the index of a later one.
        const byFlow = new Map();
        for (const entry of removed) {
            if (!byFlow.has(entry.flowFile)) {
                byFlow.set(entry.flowFile, []);
            }
            byFlow.get(entry.flowFile).push(entry);
        }

        const skipped = [];
        const actuallyRemoved = [];

        for (const [flowPath, entries] of byFlow) {
            //  The in-process chain is not enough here. oputil runs as its own
            //  process, so it shares no state with the running BBS -- and
            //  ftn_bso appends refs, and a session marks them sent, under the
            //  FTS-5005 .bsy lock (see #749). Rewriting outside it means a
            //  ref queued between our read and our write is dropped on the
            //  floor, which is precisely the outbound loss that lock exists
            //  to prevent. Both guards: .bsy against other processes, the
            //  chain against ourselves.
            const gotLock = await new Promise(resolve => {
                withFlowFileLock(
                    flowPath,
                    {
                        staleMaxAgeMs: this._staleLockMaxAgeMs,
                        timeoutMs: lockTimeoutMs,
                        log: Log,
                    },
                    done => {
                        //  rewriteFlowFile() takes the in-process chain itself.
                        this._pruneFromFlowFile(flowPath, entries, policy)
                            .then(spliced => {
                                actuallyRemoved.push(...spliced);
                                done(null);
                            })
                            .catch(err => done(err));
                    },
                    err => {
                        if (err && isBusyError(err)) {
                            return resolve(false);
                        }
                        if (err) {
                            Log.warn(
                                { path: flowPath, error: err.message },
                                '[BinkP/BSO] Could not prune flow file'
                            );
                            return resolve(false);
                        }
                        resolve(true);
                    }
                );
            });

            if (!gotLock) {
                for (const entry of entries) {
                    skipped.push(entry);
                }
            }
        }

        //  Report what went, not what we set out to remove. A node we could
        //  not lock is still queued, and so is an entry whose line had moved
        //  on by the time we held the lock -- the caller has to be able to
        //  say why, or an operator sees "nothing removed" and concludes the
        //  entry was already gone.
        return {
            removed: actuallyRemoved,
            busy: Array.from(new Set(skipped.map(e => e.flowFile))),
        };
    }

    //
    //  Remove |entries| from |flowPath|, each with the TIC queued alongside it.
    //  Called with the flow file's .bsy lock held, so the read below is the
    //  file as it stands and nothing can append between it and the write.
    //
    //  The companion rule is withCompanionTicRefs() in bso_util, shared with
    //  ftn_bso's scrubFlowFileRefs(). It has to be shared: these are the only
    //  two things that remove a reference from a flow file, and while only one
    //  of them knew about companions, pruning a payload whose file had gone
    //  left the '^...tic' announcing it queued and on disk. The downlink then
    //  collects a TIC for a file it never receives -- #735, but inflicted on
    //  someone else's system under our From and our Seenby. See #862.
    //
    async _pruneFromFlowFile(flowPath, entries, policy = null) {
        let spliced = [];
        let ticPaths = [];

        const result = await rewriteFlowFile(
            flowPath,
            lines => {
                //
                //  Only entries still standing where the listing found them. The
                //  listing was taken before the lock, so ftn_bso may have appended
                //  or a session may have marked something since -- and a line that
                //  has moved says nothing trustworthy about what follows it either,
                //  so it contributes no companion.
                //
                spliced = entries.filter(
                    e =>
                        e.lineIdx < lines.length &&
                        'send' === lines[e.lineIdx].kind &&
                        lines[e.lineIdx].text === e.line
                );

                const companion = withCompanionTicRefs(
                    lines,
                    spliced.map(e => e.lineIdx)
                );
                ticPaths = companion.ticPaths;

                //
                //  Report the companions too. An operator told "removed 1" while
                //  two lines went has been told something false about their own
                //  spool.
                //
                //  Inserted in line order rather than appended, so the listing
                //  reads the way the flow file does -- a payload followed by the
                //  TIC that announces it. Appending them all at the end put two
                //  payloads above two TICs, and the CLI's "(TIC announcing it)"
                //  then named the wrong file.
                //
                for (const idx of companion.indices) {
                    if (spliced.some(e => e.lineIdx === idx)) {
                        continue;
                    }
                    spliced.push({
                        kind: 'flow',
                        status: 'companion',
                        path: companionTicPath(flowPath, lines[idx].path),
                        size: null,
                        timestamp: null,
                        disposition: 'delete',
                        flowFile: flowPath,
                        lineIdx: idx,
                        line: lines[idx].text,
                    });
                }
                spliced.sort((a, b) => a.lineIdx - b.lineIdx);

                return { remove: Array.from(companion.indices) };
            },
            { policy }
        );

        if (!result.changed) {
            return [];
        }

        //
        //  The generated TICs are ours: '^' is delete-after-send, and with the
        //  reference gone nothing will ever send them.
        //
        //  *After* the rewrite, deliberately. Unlinking first and then failing
        //  to write (ENOSPC, EROFS, EACCES) would leave the flow file naming
        //  files that no longer exist, which is the dangling reference #735 is
        //  about -- and the caller reports the entries as busy, so an operator
        //  is told nothing happened. This way a failed rewrite leaves
        //  everything exactly as it was. Best effort in the other direction:
        //  failing to unlink one leaves litter, not a broken queue.
        //
        for (const ref of ticPaths) {
            const ticPath = companionTicPath(flowPath, ref);
            if (ticPath) {
                await fsp.unlink(ticPath).catch(() => {});
            }
        }

        //  Only what actually went. Reporting an entry we decided not to
        //  touch would tell the operator a file had been dealt with while it
        //  is still sitting in the node's queue.
        return spliced;
    }

    // ── Inbound file handling ────────────────────────────────────────────────

    // Move |tempPath| (written by the session) into the configured inbound dir.
    // Returns the final path (may differ from destDir/filename if a collision was resolved).
    //
    //  |filename| has to name a file directly inside the inbound directory.
    //  The session already reduces every name from the peer to a plain file
    //  name (file_name.js); this holds the line here too, for any other
    //  caller. Anything else is refused and the temp file removed, so the
    //  data goes nowhere rather than somewhere unexpected.
    async receiveFile(tempPath, filename, isSecure) {
        const destDir = isSecure ? this._paths.secInbound : this._paths.inbound;
        const destPath = path.join(destDir, String(filename || ''));
        if (
            !isPlainFileName(filename) ||
            path.dirname(path.resolve(destPath)) !== path.resolve(destDir)
        ) {
            await fsp.unlink(tempPath).catch(() => {});
            throw new Error(
                `Inbound file name is not a plain file name: ${JSON.stringify(filename)}`
            );
        }
        await fsp.mkdir(destDir, { recursive: true });
        return new Promise((resolve, reject) => {
            moveFileWithCollisionHandling(tempPath, destPath, (err, finalPath) => {
                if (err) return reject(err);
                resolve(finalPath);
            });
        });
    }

    getInboundDir(isSecure) {
        return isSecure ? this._paths.secInbound : this._paths.inbound;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    //  Which network owns the bare outbound/ dir. Shared with ftn_bso via
    //  core/bso_util.js so the writer and this reader cannot drift.
    _defaultNetworkName() {
        return resolveDefaultNetworkName(this._networks, this._defaultNetwork);
    }

    _defaultZone(networkName) {
        return resolveNetworkDefaultZone(this._networks, networkName);
    }

    //  Best-effort network for |addr|, by zone. Only used to pick the single
    //  canonical directory the per-node .bsy lock lives in -- file lookup goes
    //  through _candidateDirsForZone() instead, which doesn't have to guess.
    _networkNameForAddr(addr) {
        //  Shared with the tosser via core/bso_util.js so the directory a file
        //  is written to and the directory its .bsy is taken in cannot drift.
        return canonicalNetworkNameForAddress(this._networks, this._defaultNetwork, addr);
    }

    //  Canonical directory for |addr|. Deterministic -- the .bsy lock must
    //  resolve to exactly one path for a given node.
    _outboundDir(addr) {
        //  An address belonging to no configured network still needs somewhere
        //  to put its lock; fall back to the first network, then to outbound/.
        const netName = this._networkNameForAddr(addr) || Object.keys(this._networks)[0];

        const dirName = netName
            ? outboundDirName(this._networks, this._defaultNetwork, netName, addr.zone)
            : DEFAULT_NETWORK_DIR_NAME;

        return path.join(this._paths.outbound, dirName);
    }

    //  Every directory that could hold mail for a node in |zone|.
    //
    //  More than one is normal: a legacy pre-0.5.1-beta directory may still be
    //  draining, and nothing stops two configured networks from sharing a zone.
    //  Scanning all of them beats guessing one and silently missing mail.
    async _candidateDirsForZone(zone) {
        const seen = new Set();
        for (const { dir, zone: dirZone } of await this._allOutboundDirs()) {
            if (dirZone === zone) {
                seen.add(dir);
            }
        }
        return Array.from(seen);
    }

    //  Every (directory, basename) pair that could hold flow or control files
    //  for |addr|, each with a case-insensitive index of that directory's
    //  entries (lowercased name -> name as it appears on disk).
    //
    //  For a point, FTS-5005.003 §2 puts the files one level down in the boss
    //  node's "<nff>.pnt" subdirectory, named from the point number rather
    //  than net/node -- 1:104/36.45 lives in outbound/00680024.pnt/0000002d.*.
    async _spoolTargetsForNode(addr) {
        //  A 2D address (no zone) matches no zone-tagged directory; fall back
        //  to the canonical one rather than reporting nothing pending.
        let dirs = await this._candidateDirsForZone(addr.zone);
        if (0 === dirs.length) {
            dirs = [this._outboundDir(addr)];
        }

        const targets = [];
        for (const dir of dirs) {
            const entries = await readDirCaseMap(dir);

            if (!addr.point) {
                targets.push({ dir, base: nodeBaseName(addr), entries });
                continue;
            }

            const pointDir = entries.get(`${nodeBaseName(addr)}.pnt`);
            if (!pointDir) continue;

            const pointDirPath = path.join(dir, pointDir);
            targets.push({
                dir: pointDirPath,
                base: pointBaseName(addr),
                entries: await readDirCaseMap(pointDirPath),
            });
        }

        return targets;
    }

    _bsyPath(addr) {
        const dir = this._outboundDir(addr);
        if (addr.point) {
            return path.join(
                dir,
                `${nodeBaseName(addr)}.pnt`,
                `${pointBaseName(addr)}.bsy`
            );
        }
        return path.join(dir, `${nodeBaseName(addr)}.bsy`);
    }

    //
    //  Which directories a flow file line may act on, for this pass. Built
    //  from the same |paths| and outbound scan used to find flow files, so a
    //  directory the spool reads flow files from is always one their '^' and
    //  '#' entries may be disposed in. See core/bso_flow_paths.js.
    //
    //  The same, for other modules that rewrite flow files in this outbound.
    flowPathPolicy() {
        return this._flowPathPolicy();
    }

    async _flowPathPolicy() {
        const outboundDirs = await this._allOutboundDirs();

        const outboundNames = new Set(
            Object.keys(this._networks).map(n => n.toLowerCase())
        );
        for (const { dir } of outboundDirs) {
            outboundNames.add(path.basename(dir).toLowerCase());
        }
        if (this._paths.outbound) {
            outboundNames.add(
                path.basename(path.resolve(this._paths.outbound)).toLowerCase()
            );
        }

        return FlowPathPolicy.build({
            settings: this._flowPaths,
            spoolDirs: [
                ...outboundDirs.map(d => d.dir),
                this._paths.inbound,
                this._paths.secInbound,
                this._paths.ticTransit,
            ],
            outboundNames,
            log: Log,
        });
    }

    async _parseFlowFile(flowPath, addr, policy) {
        if (!policy) {
            policy = await this._flowPathPolicy();
        }
        //  A flow file linked into a protected directory is not read at all.
        if (await flowLinkRefused(flowPath, policy)) {
            return [];
        }
        const { lines } = await readFlowFile(flowPath);
        const results = [];

        //  The same line twice queues its file once, and sending it marks
        //  every copy (see _applyFlowDispositionLocked()).
        const queued = new Set();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if ('unknown' === line.kind || 'invalid' === line.kind) {
                warnThrottled(
                    `unparsed\0${flowPath}`,
                    this._flowRefWarnRepeatMs,
                    {
                        node: nodeLabel(flowPath, addr),
                        line: printablePath(line.text),
                        reason: line.reason,
                        flowFile: flowPath,
                    },
                    '[BinkP/BSO] Flow file has a line that is not a directive and path ENiGMA can read; ' +
                        'leaving it in place and not sending it. See "oputil bso list"'
                );
                continue;
            }

            if ('send' !== line.kind || queued.has(line.text)) continue;

            if (Buffer.isBuffer(line.path)) {
                warnThrottled(
                    `encoding\0${flowPath}`,
                    this._flowRefWarnRepeatMs,
                    {
                        node: nodeLabel(flowPath, addr),
                        line: printablePath(line.text),
                        flowFile: flowPath,
                    },
                    '[BinkP/BSO] Flow file entry names a path that is not valid UTF-8; not sending it. ' +
                        'See "oputil bso list"'
                );
                continue;
            }

            const disposition = line.disposition;

            const resolved = await resolveFlowRef(flowPath, line, addr, {
                repeatMs: this._flowRefWarnRepeatMs,
                policy,
            });
            if (!resolved) continue;

            if (
                await refusedTarget(
                    policy,
                    resolved.path,
                    addr,
                    flowPath,
                    this._flowRefWarnRepeatMs
                )
            )
                continue;

            //  The spool decides; the session (BinkpSession._applyDisposition)
            //  carries it out, checking again just before it acts.
            let allowed = true;
            let checkTarget = null;
            if ('keep' !== disposition) {
                const classified = await judgeDisposition(
                    policy,
                    disposition,
                    resolved.path
                );
                allowed = Boolean(classified && classified.allowed);
                if (allowed) {
                    const target = resolved.path;
                    checkTarget = () => judgeDisposition(policy, disposition, target);
                } else {
                    warnThrottled(
                        `outside\0${flowPath}`,
                        this._flowRefWarnRepeatMs,
                        {
                            node: nodeLabel(flowPath, addr),
                            file: resolved.path,
                            disposition,
                            flowFile: flowPath,
                        },
                        '[BinkP/BSO] Flow file entry is outside the mail directories; sending it but ' +
                            'leaving the file in place. To have it deleted or truncated after sending, ' +
                            'add its directory to scannerTossers.ftn_bso.binkp.flowDispositionRoots'
                    );
                }
            }

            queued.add(line.text);
            const lineIdx = i;
            const captured = line.text; // close over the line as it was when read
            results.push({
                name: path.basename(resolved.path),
                path: resolved.path,
                size: resolved.stat.size,
                timestamp: Math.floor(resolved.stat.mtimeMs / 1000),
                disposition,
                allowed,
                checkTarget,
                //  Bookkeeping keys off the line as it was written, not off
                //  |resolved.path| — so a reference rescued by the fallback
                //  above is still marked sent correctly.
                disposeFn: () =>
                    this._applyFlowDisposition(flowPath, lineIdx, captured, policy),
            });
        }

        return results;
    }

    //
    //  Serialize flow file rewrites per file, within this process. See
    //  withFlowFileWrite() in core/bso_flow.js, which every flow file rewrite
    //  in the process goes through.
    //
    _withFlowFileWrite(flowPath, work) {
        return withFlowFileWrite(flowPath, work);
    }

    async _applyFlowDisposition(flowPath, lineIdx, originalText, policy = null) {
        return this._applyFlowDispositionLocked(flowPath, lineIdx, originalText, policy);
    }

    async _applyFlowDispositionLocked(flowPath, lineIdx, originalText, policy = null) {
        //  The file-side action (unlink for 'delete', truncate for 'truncate')
        //  is already performed by BinkpSession._applyDisposition before the
        //  'file-sent' event fires; session.js owns file lifecycle. This
        //  method's job is purely flow-file bookkeeping:
        //    1. Mark the entry as done: '~' and its path.
        //    2. If nothing is left waiting, remove the flow file itself so a
        //       quiet node doesn't accumulate dead-marker files indefinitely.
        //       ftn_bso recreates the flow file on the next outbound queue.
        //  rewriteFlowFile() does both, serialized with every other rewrite
        //  of this file in the process.
        try {
            await rewriteFlowFile(
                flowPath,
                lines => {
                    const same = l => 'send' === l.kind && l.text === originalText;

                    //  The line has to still be there: where we read it, or --
                    //  if lines before it were removed since -- somewhere else.
                    //  Otherwise the flow file was rewritten out from under us
                    //  (another session, a manual cleanup), and neither marking
                    //  nor removing it is safe.
                    const at = lines[lineIdx];
                    if (!(at && same(at)) && !lines.some(same)) {
                        return null;
                    }

                    //  Every copy of the line: the file went once for all of them.
                    const mark = [];
                    lines.forEach((l, idx) => {
                        if (same(l)) mark.push(idx);
                    });
                    return { mark };
                },
                { policy }
            );
        } catch (err) {
            Log.warn(
                { path: flowPath, error: err.message },
                '[BinkP/BSO] Could not finalize flow file'
            );
        }
    }

    async _allOutboundDirs() {
        const dirs = [];
        const seen = new Set();
        const push = (dirName, zone) => {
            const dir = path.join(this._paths.outbound, dirName);
            const key = `${dir}\0${zone}`;
            if (seen.has(key)) return;
            seen.add(key);
            dirs.push({ dir, zone });
        };

        let rootEntries = [];
        try {
            rootEntries = await fsp.readdir(this._paths.outbound);
        } catch {
            // outbound root does not exist yet — fine
        }

        for (const netName of Object.keys(this._networks)) {
            const defaultZone = this._defaultZone(netName);
            if (typeof defaultZone !== 'number') {
                if (!warnedNetworks.has(netName)) {
                    warnedNetworks.add(netName);
                    Log.warn(
                        { network: netName },
                        '[BinkP/BSO] Network has no resolvable default zone; skipping its outbound directories'
                    );
                }
                continue;
            }

            //  The canonical directory, plus the pre-0.5.1-beta one when the
            //  layout changed under this network (see core/bso_util.js) so
            //  anything still queued there gets sent.
            const baseNames = [
                outboundDirName(
                    this._networks,
                    this._defaultNetwork,
                    netName,
                    defaultZone
                ),
                legacyOutboundDirName(
                    this._networks,
                    this._defaultNetwork,
                    netName,
                    defaultZone
                ),
            ].filter(Boolean);

            for (const baseName of baseNames) {
                push(baseName, defaultZone);

                // Also pick up zone-specific subdirs (outbound.001, outbound.002, …)
                const prefix = `${baseName}.`;
                for (const entry of rootEntries) {
                    const lower = entry.toLowerCase();
                    if (!lower.startsWith(prefix)) continue;
                    const suffix = lower.slice(prefix.length);
                    if (!/^[0-9a-f]{3}$/.test(suffix)) continue;
                    push(entry, parseInt(suffix, 16));
                }
            }
        }

        // Fallback when no networks are configured
        if (dirs.length === 0) {
            push(DEFAULT_NETWORK_DIR_NAME, 1);
        }

        return dirs;
    }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

// BSO base filename for a node: 4-hex-net + 4-hex-node, lowercase
function nodeBaseName(addr) {
    const net = `0000${addr.net.toString(16)}`.slice(-4);
    const node = `0000${addr.node.toString(16)}`.slice(-4);
    return `${net}${node}`;
}

// BSO base filename for a point, inside its boss node's .pnt subdirectory:
// the point number as 8 hex digits, zero padded (FTS-5005.003 §2)
function pointBaseName(addr) {
    return `00000000${addr.point.toString(16)}`.slice(-8);
}

// Index a directory by lowercased entry name -> the name as it appears on
// disk, so lookups can be case-insensitive (FTS-5005.003 §2). An absent
// directory yields an empty map; anything else is reported and treated the
// same, since a directory we cannot read holds no mail we can send.
async function readDirCaseMap(dir) {
    const map = new Map();

    let names;
    try {
        names = await fsp.readdir(dir);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            Log.warn(
                { path: dir, error: err.message },
                '[BinkP/BSO] Error reading outbound directory'
            );
        }
        return map;
    }

    for (const name of names) {
        const lower = name.toLowerCase();
        //  A case-insensitive filesystem cannot hold two spellings at once; on
        //  a case-sensitive one, prefer the lower case name the spec prefers.
        if (!map.has(lower) || name === lower) {
            map.set(lower, name);
        }
    }

    return map;
}

// A unique "NNNNNNNN.pkt" wire name for a direct-attach netmail flow file.
// FTS-5005.003 §3.1 requires the rename and leaves the naming method to the
// implementation. Mirrors ftn_util.getMessageSerialNumber(): the clock keeps
// names distinct between sessions, the path between files queued within one.
function uniquePacketName(filePath) {
    const hash = Math.abs(
        new FNV1a(`${Date.now() - Date.UTC(2016, 1, 1)}${filePath}`).value
    ).toString(16);
    return `${`00000000${hash}`.slice(-8)}.pkt`;
}

//
//  True when |flowPath| has at least one entry that is neither already marked
//  sent ('~') nor dangling.
//
//  The existence check matters: a flow file whose live entries all resolve to
//  nothing would otherwise keep its node in the pending list forever, and the
//  poller would dial it every cycle only to transfer nothing and log a clean
//  "Session complete".
//
async function flowHasPending(flowPath, addr, repeatMs, policy) {
    if (await flowLinkRefused(flowPath, policy)) {
        return false;
    }
    const read = await readFlowFile(flowPath).catch(() => null);
    if (!read) {
        return false;
    }
    for (const line of read.lines) {
        //  Lines not understood, and paths ENiGMA cannot send under a name,
        //  give no reason to dial; _parseFlowFile() says so when it runs.
        if ('send' !== line.kind || Buffer.isBuffer(line.path)) continue;

        const resolved = await resolveFlowRef(flowPath, line, addr, {
            repeatMs,
            policy,
        });
        if (!resolved) continue;

        //  A file that will never be sent gives no reason to dial.
        if (await refusedTarget(policy, resolved.path, addr, flowPath, repeatMs))
            continue;
        return true;
    }
    return false;
}

//
//  The filesystem path a 'send' line names, before any fallback, or null
//  when it names nothing on this platform.
//
//  A relative path (name.pkt, sub/name.pkt) is relative to the flow file's
//  own directory, the first place FTS-5005.003 suggests and where hpt
//  resolves them -- never to whatever directory this process happens to be
//  running in. A DOS path is a path
//  only on Windows; elsewhere only the basename fallback can find it.
//
function flowLineTarget(flowPath, line) {
    if (!line || null === line.path || undefined === line.path) {
        return null;
    }
    if (line.relative) {
        return Buffer.isBuffer(line.path)
            ? Buffer.concat([Buffer.from(path.dirname(flowPath) + path.sep), line.path])
            : path.join(path.dirname(flowPath), line.path);
    }
    if (line.dos && 'win32' !== process.platform) {
        return null;
    }
    return line.path;
}

//  |p| when it is a path as text, else null (no path, or one that is not
//  UTF-8).
function textPath(p) {
    return 'string' === typeof p ? p : null;
}

//  A line's path as text for a listing: the path when it is UTF-8, the raw
//  bytes shown one per character when it is not.
function displayPath(line) {
    if ('string' === typeof line.path) {
        return line.path;
    }
    return line.body || line.text;
}

//
//  True, after saying so, when |filePath| lies in a protected directory and
//  must not be sent. Warned at first sight and again each |repeatMs| per
//  flow file and path: it is a standing condition, and up to four places
//  ask about it on every poll.
//
//  A file that vanished between resolving and classifying is treated the
//  same way -- there is nothing to send.
//
async function refusedTarget(policy, filePath, addr, flowPath, repeatMs) {
    const classified = await policy.classify(filePath);
    if (!classified) {
        return true;
    }
    if (!classified.refused) {
        return false;
    }
    warnThrottled(
        `refused\0${flowPath}\0${filePath}`,
        typeof repeatMs === 'number' ? repeatMs : DEFAULT_FLOW_REF_WARN_REPEAT_MS,
        {
            node: nodeLabel(flowPath, addr),
            file: filePath,
            protectedDir: classified.protectedDir,
            flowFile: flowPath,
        },
        '[BinkP/BSO] Outbound entry names a file in a protected directory; not sending it'
    );
    return true;
}

//
//  Whether |disposition| may be carried out on |filePath|. A delete removes
//  the directory entry, never what a symlink points to, so it is judged by
//  where the entry is; a truncate writes to the file itself, so it is judged
//  by where the file really is (and the session never truncates through a
//  symlink in any case).
//
function judgeDisposition(policy, disposition, filePath) {
    return 'delete' === disposition
        ? policy.classifyEntry(filePath)
        : policy.classify(filePath);
}

//
//  The file of |ref|'s name beside |flowPath|, when its stored path is gone
//  and one is there -- a file moved rather than lost. Not for a BSO control
//  or flow file name: that is some other node's file, not this entry's, and
//  the entry is simply missing.
//
async function misfiledPath(flowPath, ref, target = ref) {
    const base = String(ref || '')
        .split(/[\\/]/)
        .pop();
    if (!base || '.' === base || '..' === base || isControlFileName(base)) {
        return null;
    }
    const alt = path.join(path.dirname(flowPath), base);
    if (alt === ref || alt === target) {
        return null;
    }
    const stat = await fsp.stat(alt).catch(() => null);
    return stat && stat.isFile() ? alt : null;
}

//
//  Log |message| unless |key| was logged within |repeatMs|. A standing
//  condition is said again now and then rather than once per process, where
//  it scrolls away, or once per poll, where it buries everything else.
//
function warnThrottled(key, repeatMs, fields, message) {
    const now = Date.now();
    const last = warnedFlowRefs.get(key);
    if (last && now - last < repeatMs) return;
    if (warnedFlowRefs.size >= MAX_WARNED_FLOW_REFS) {
        //  Drop what has aged out first. Clearing wholesale would throw away
        //  entries warned seconds ago and let them repeat straight away,
        //  which on a spool with many dangling refs turns the throttle into
        //  a firehose.
        for (const [k, when] of warnedFlowRefs) {
            if (now - when >= repeatMs) warnedFlowRefs.delete(k);
        }
        if (warnedFlowRefs.size >= MAX_WARNED_FLOW_REFS) warnedFlowRefs.clear();
    }
    warnedFlowRefs.set(key, now);
    Log.warn(fields, message);
}

//
//  Resolve a flow file reference to a file that exists, as { path, stat }, or
//  null when it resolves nowhere.
//
//  Flow files carry absolute paths (FTS-5005.003 §3.1). A stored path that no
//  longer resolves means the file moved out from under the reference — a
//  relocated outbound tree, or a sysop hand-recovering mail that was filed in
//  the wrong directory (#734). Before giving up we look for the referenced
//  basename in the flow file's own directory, which makes that recovery a
//  matter of moving files rather than also hand-editing flow files.
//
//  That rescue is for the packets, bundles and TICs queued with '^' (or '#',
//  '-'), whose home is an outbound directory. It is not tried for a
//  send-and-keep line, whose file never lives in the outbound; nor onto a BSO
//  control or flow file name; nor unless the stored path's own directory is
//  named like an outbound. See basenameFallbackAllowed() in
//  core/bso_flow_paths.js. |line| is a 'send' line from parseFlowLine() in
//  core/bso_flow.js.
//
//  A reference that resolves nowhere is logged once per process. Silence here
//  is how misfiled outbound mail hides: the session finds nothing to send and
//  reports success.
//
async function resolveFlowRef(
    flowPath,
    line,
    addr,
    { quiet = false, repeatMs = DEFAULT_FLOW_REF_WARN_REPEAT_MS, policy = null } = {}
) {
    const ref = line.path;
    const directive = line.directive;
    const target = flowLineTarget(flowPath, line);

    const warnEvery = (key, fields, message) => {
        if (quiet) return;
        warnThrottled(key, repeatMs, fields, message);
    };

    const tryStat = async p => {
        try {
            const stat = await fsp.stat(p);
            //  A reference has to name a regular file. A directory sitting at
            //  the path would queue, fail to open, and leave its node pending
            //  forever — the very loop the existence check above exists to
            //  break. The fallback below can also collapse a wholly dangling
            //  reference onto one: a path ending in ".." lands on the parent
            //  of the outbound directory.
            return stat.isFile() ? stat : null;
        } catch (err) {
            if ('ENOENT' !== err.code && 'ENOTDIR' !== err.code) {
                warnEvery(
                    `stat\0${p}`,
                    { node: nodeLabel(flowPath, addr), path: p, error: err.message },
                    '[BinkP/BSO] Error stat-ing flow file reference'
                );
            }
            return null;
        }
    };

    let stat = target ? await tryStat(target) : null;
    if (stat) return { path: target, stat };

    //  Split on either separator — the reference may have been written by a
    //  mailer running on the other sort of platform.
    if (basenameFallbackAllowed(ref, directive, policy ? policy.outboundNames : null)) {
        const base = ref.split(/[\\/]/).pop();
        const alt = base && path.join(path.dirname(flowPath), base);
        if (alt && alt !== target) {
            stat = await tryStat(alt);
            if (stat) return { path: alt, stat };
        }
    } else if (!quiet) {
        //  Not the same thing as missing, and the operator needs to tell them
        //  apart: the file is right there, this entry just may not use it.
        const beside = await misfiledPath(flowPath, ref, target);
        if (beside) {
            warnEvery(
                `misfiled\0${flowPath}\0${ref}`,
                {
                    node: nodeLabel(flowPath, addr),
                    file: path.basename(beside),
                    ref,
                    besideFlowFile: beside,
                    flowFile: flowPath,
                },
                '[BinkP/BSO] Queued file is not at its stored path. A file of that name is ' +
                    'beside the flow file, but this entry may not be sent from there; fix ' +
                    'the path in the flow file or move the file back. See "oputil bso status"'
            );
            return null;
        }
    }

    //  Name the node and the file, not just the path: the operator's question
    //  is "who is missing what", and a bare absolute path answers neither.
    //  Say plainly that it will not be delivered -- "skipping entry" reads
    //  like a transient step, and this one never resolves itself.
    warnEvery(
        `ref\0${flowPath}\0${ref}`,
        {
            node: nodeLabel(flowPath, addr),
            file: path.basename(ref),
            ref,
            flowFile: flowPath,
        },
        '[BinkP/BSO] Queued file is missing; this node will never receive it. ' +
            'See "oputil bso status"'
    );

    return null;
}

//  Compare two addresses by value. The spool's callers pass anything
//  address-shaped -- an Address, or the plain object a test or a config
//  reader hands over -- so this cannot go through Address.toString().
function sameAddress(a, b) {
    if (!a || !b) {
        return false;
    }
    return (
        a.zone === b.zone &&
        a.net === b.net &&
        a.node === b.node &&
        (a.point || 0) === (b.point || 0)
    );
}

//  True when the path is absent rather than merely unreachable. ENOENT is
//  "no such file"; ENOTDIR is a component of the path not being a directory,
//  which for a stored absolute path means the same thing. Anything else --
//  EACCES, EIO, ESTALE, EMFILE -- says the file may well exist and we simply
//  could not look.
async function isGenuinelyAbsent(p) {
    if (!p) {
        //  A path that names nothing on this platform (a DOS path here).
        return true;
    }
    try {
        await fsp.stat(p);
        return false;
    } catch (err) {
        return 'ENOENT' === err.code || 'ENOTDIR' === err.code;
    }
}

//  Resolve without logging. The operator's listing asks about every entry
//  every time it runs; the periodic warning is what marks a change of state,
//  and burying it under one line per run per reference defeats it.
function resolveFlowRefQuiet(flowPath, line, policy) {
    return resolveFlowRef(flowPath, line, null, { quiet: true, policy });
}

//
//  Best-effort label for whichever node a flow file belongs to. The caller
//  knows the full 5D address when it is acting for one node; when it is
//  sweeping the outbound it does not, and the file name carries net/node (and
//  the parent directory the point) in hex -- everything but the zone.
//
function nodeLabel(flowPath, addr) {
    //  Not addr.toString(): callers pass anything address-shaped, including
    //  the plain objects the spool accepts everywhere else, and those
    //  stringify to "[object Object]".
    if (addr && undefined !== addr.net && undefined !== addr.node) {
        const zone = undefined === addr.zone ? '' : `${addr.zone}:`;
        const point = addr.point ? `.${addr.point}` : '';
        return `${zone}${addr.net}/${addr.node}${point}`;
    }

    const base = path.basename(flowPath).split('.')[0];
    const parsed = /^([0-9a-f]{4})([0-9a-f]{4})$/i.exec(base);
    if (!parsed) {
        return path.basename(flowPath);
    }

    const net = parseInt(parsed[1], 16);
    const node = parseInt(parsed[2], 16);

    const pointDir = POINT_DIR_RE.exec(path.basename(path.dirname(flowPath)));
    if (pointDir) {
        //  Inside NNNNnnnn.pnt/ the file name is the point and the directory
        //  is the boss (FTS-5005.003 sec. 2).
        const boss = /^([0-9a-f]{4})([0-9a-f]{4})$/i.exec(pointDir[1]);
        if (boss) {
            return `${parseInt(boss[1], 16)}/${parseInt(boss[2], 16)}.${parseInt(
                base,
                16
            )}`;
        }
    }

    return `${net}/${node}`;
}

//
//  Wire a BsoSpool to a BinkpSession for the standard inbound/outbound case.
//
//  For the originating (outbound) side:
//    Pass the known remote addresses in |remoteAddrs|. Files are queued
//    synchronously before session.start() is called.
//
//  For the answering (inbound) side:
//    Pass remoteAddrs = null. The function listens for the 'authenticated'
//    event, holds M_EOB until the async spool read completes, then queues
//    whatever is pending for the addresses the session authenticated.
//
//  Returns the disposeMap so callers can add extra entries if needed.
//
async function attachSpoolToSession(session, spool, remoteAddrs) {
    const disposeMap = new Map();

    //  Direct-attach files don't have a flow-file annotation step, so their
    //  disposeFn is null and we skip the disposeMap entry entirely. Only flow
    //  entries register a post-send hook (to mark the line with '~' and GC the
    //  flow file when no live entries remain).
    //
    //  Two entries can share a key: the same file listed by two flow files
    //  (a legacy directory still draining, two flavours). Both lines are
    //  finished with when the file has gone, so both are marked; replacing
    //  the first hook left its line looking unsent.
    //
    const registerDispose = f => {
        if (!f.disposeFn) {
            return;
        }
        const key = `${f.name}\0${f.size}\0${f.timestamp}`;
        const prev = disposeMap.get(key);
        const next = f.disposeFn;
        disposeMap.set(
            key,
            'function' === typeof prev ? () => prev().then(() => next()) : next
        );
    };

    if (remoteAddrs && remoteAddrs.length > 0) {
        // Originating side: addresses are known up-front
        for (const addr of remoteAddrs) {
            const files = await spool.getOutboundFilesForNode(addr);
            for (const f of files) {
                session.queueFile(f.path, f.name, f.size, f.timestamp, f.disposition, {
                    allowed: f.allowed,
                    checkTarget: f.checkTarget,
                });
                registerDispose(f);
            }
        }
    } else {
        //
        //  Answering side: once the caller has authenticated, resolve what we
        //  have queued for the addresses the session covers.
        //
        //  On 'authenticated', not on 'addresses' (M_ADR). Mail is only ever
        //  looked up for addresses the session has authenticated for: every
        //  presented address on a secure session, only the unpassworded ones
        //  on a non-secure one (BinkpSession._authenticatedAddresses). A
        //  caller that fails authentication is refused before this fires, so
        //  nothing is queued for it at all.
        //
        //  holdEOB(), not holdSend(). The two are not interchangeable and the
        //  difference decides whether the peer gets its mail at all.
        //
        //  |_sendHeld| is consulted in exactly one place -- _enterTransfer()'s
        //  initial _sendNext(). It does not gate _sendNext() itself, and the
        //  peer's own M_EOB reaches _sendNext() by another route entirely:
        //  _onEob() sets _remoteEOB and calls it directly. That commonly beats
        //  this asynchronous lookup. _sendNext() then finds an empty queue,
        //  sees the answering-side "wait for _remoteEOB" condition already
        //  satisfied, and sends our M_EOB -- after which releaseSend()'s
        //  |!this._localEOBSent| guard makes it a no-op and the files we just
        //  queued are never offered.
        //
        //  |_eobHold| is tested inside _sendNext() at the point M_EOB would go
        //  out, so it holds however _sendNext() was reached. That is what this
        //  needs. The FREQ resolver already uses it for the same reason. It is
        //  taken synchronously here: the session emits 'authenticated' before
        //  _enterTransfer() schedules the first _sendNext().
        //
        //  Reported as #747, and it is not TIC-specific: it affects any
        //  answering session with something queued for the caller. It matters
        //  especially for file echoes, because a downlink normally polls its
        //  hub rather than being dialled.
        //
        session.on('authenticated', async (secure, addrStrings) => {
            session.holdEOB();
            try {
                for (const addrStr of addrStrings || []) {
                    const addr = Address.fromString(addrStr);
                    if (!addr || !addr.isValid()) continue;
                    const files = await spool.getOutboundFilesForNode(addr);
                    for (const f of files) {
                        session.queueFile(
                            f.path,
                            f.name,
                            f.size,
                            f.timestamp,
                            f.disposition,
                            { allowed: f.allowed, checkTarget: f.checkTarget }
                        );
                        registerDispose(f);
                    }
                }
            } finally {
                session.releaseEOB();
            }
        });
    }

    // isSecure is determined at authentication time; use a mutable binding
    let isSecure = false;
    session.on('authenticated', secure => {
        isSecure = secure;
    });

    session.on('file-received', async (name, size, ts, tempPath) => {
        await spool
            .receiveFile(tempPath, name, isSecure)
            .catch(err =>
                Log.warn(
                    { name, error: err.message },
                    '[BinkP/BSO] Error moving received file'
                )
            );
    });

    session.on('file-sent', async (name, size, ts) => {
        const key = `${name}\0${size}\0${ts}`;
        const fn = disposeMap.get(key);
        if (typeof fn === 'function') {
            disposeMap.delete(key);
            await fn().catch(err =>
                Log.warn(
                    { name, error: err.message },
                    '[BinkP/BSO] Error applying file disposition'
                )
            );
        } else if (fn !== undefined) {
            disposeMap.delete(key);
            Log.warn({ name }, '[BinkP/BSO] Invalid file disposition handler; skipping');
        }
    });

    return disposeMap;
}

module.exports = {
    sameAddress,
    BsoSpool,
    attachSpoolToSession,
    nodeBaseName,
};
