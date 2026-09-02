'use strict';

const fsp = require('fs/promises');
const path = require('path');

const Address = require('../ftn_address');
const { moveFileWithCollisionHandling } = require('../file_util');
const FNV1a = require('../fnv1a');
const Log = require('../logger').log;
const {
    resolveDefaultNetworkName,
    resolveNetworkDefaultZone,
    outboundDirName,
    legacyOutboundDirName,
    DEFAULT_NETWORK_DIR_NAME,
} = require('../bso_util');
const bsoLock = require('../bso_lock');

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
const warnedFlowRefs = new Set();

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
//
class BsoSpool {
    constructor(config) {
        this._paths = config.paths || {};
        this._networks = config.networks || {};
        this._defaultNetwork = config.defaultNetwork;
        this._staleLockMaxAgeMs =
            typeof config.staleLockMaxAgeMs === 'number'
                ? config.staleLockMaxAgeMs
                : DEFAULT_STALE_LOCK_MAX_AGE_MS;
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

    // ── Outbound file enumeration ────────────────────────────────────────────

    // Returns all pending outbound files for |addr|.
    // Each entry: { name, path, size, timestamp, disposition, disposeFn }
    // Call disposeFn() after the remote acknowledges receipt (file-sent event).
    async getOutboundFilesForNode(addr) {
        const results = [];

        for (const { dir, base, entries } of await this._spoolTargetsForNode(addr)) {
            for (const ext of DIRECT_EXTS) {
                const actual = entries.get(`${base}.${ext}`);
                if (!actual) continue;

                const filePath = path.join(dir, actual);
                try {
                    const stat = await fsp.stat(filePath);
                    // Zero-byte .ilo = poll trigger, not actual mail
                    if (stat.size === 0) continue;
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
                    results.push(...(await this._parseFlowFile(flowPath)));
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

    // Returns Address objects for every node that has at least one unsent file.
    async getNodesWithPendingMail() {
        const outboundDirs = await this._allOutboundDirs();
        const seen = new Set();
        const results = [];

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
                const key = bossBase ? `${zone}:${bossBase}.${base}` : `${zone}:${base}`;
                if (seen.has(key)) continue;

                //  A point number of zero addresses the boss node, whose files
                //  belong in the outbound directory proper.
                const point = bossBase ? parseInt(base, 16) : 0;
                if (bossBase && 0 === point) continue;

                const filePath = path.join(dir, file);

                if (FLOW_EXTS.includes(ext)) {
                    if (!(await flowHasPending(filePath))) continue;
                } else {
                    // Direct-attach: zero-byte = poll flag, not mail
                    const stat = await fsp.stat(filePath).catch(() => null);
                    if (!stat || stat.size === 0) continue;
                }

                seen.add(key);
                const nodeBase = bossBase || base;
                results.push(
                    new Address({
                        zone,
                        net: parseInt(nodeBase.slice(0, 4), 16),
                        node: parseInt(nodeBase.slice(4, 8), 16),
                        ...(point ? { point } : {}),
                    })
                );
            }
        };

        for (const { dir, zone } of outboundDirs) {
            await scanDir(dir, zone);
        }

        return results;
    }

    // ── Inbound file handling ────────────────────────────────────────────────

    // Move |tempPath| (written by the session) into the configured inbound dir.
    // Returns the final path (may differ from destDir/filename if a collision was resolved).
    async receiveFile(tempPath, filename, isSecure) {
        const destDir = isSecure ? this._paths.secInbound : this._paths.inbound;
        await fsp.mkdir(destDir, { recursive: true });
        const destPath = path.join(destDir, filename);
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
        for (const [name] of Object.entries(this._networks)) {
            if (addr.zone === this._defaultZone(name)) return name;
        }
        return this._defaultNetworkName();
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

    async _parseFlowFile(flowPath) {
        const content = await fsp.readFile(flowPath, 'utf8');
        const lines = content.split('\n');
        const results = [];

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const trimmed = raw.trim();
            if (!trimmed || trimmed[0] === '~') continue;

            const firstChar = trimmed[0];
            let disposition, filePath;

            if (firstChar === '^' || firstChar === '-') {
                disposition = 'delete';
                filePath = trimmed.slice(1);
            } else if (firstChar === '#') {
                disposition = 'truncate';
                filePath = trimmed.slice(1);
            } else {
                disposition = 'keep';
                filePath = trimmed;
            }

            const resolved = await resolveFlowRef(flowPath, filePath);
            if (!resolved) continue;

            const lineIdx = i;
            const captured = trimmed; // close over the line as it was when read
            results.push({
                name: path.basename(resolved.path),
                path: resolved.path,
                size: resolved.stat.size,
                timestamp: Math.floor(resolved.stat.mtimeMs / 1000),
                disposition,
                //  Bookkeeping keys off the line as it was written, not off
                //  |resolved.path| — so a reference rescued by the fallback
                //  above is still marked sent correctly.
                disposeFn: () => this._applyFlowDisposition(flowPath, lineIdx, captured),
            });
        }

        return results;
    }

    async _applyFlowDisposition(flowPath, lineIdx, originalTrimmed) {
        //  The file-side action (unlink for 'delete', truncate for 'truncate')
        //  is already performed by BinkpSession._applyDisposition before the
        //  'file-sent' event fires; session.js owns file lifecycle. This
        //  method's job is purely flow-file bookkeeping:
        //    1. Mark the entry as done by prepending '~' to the original line.
        //    2. If no live entries remain, unlink the flow file itself so a
        //       quiet node doesn't accumulate dead-marker files indefinitely.
        //       ftn_bso recreates the flow file on the next outbound queue.
        try {
            const content = await fsp.readFile(flowPath, 'utf8');
            const lines = content.split('\n');

            if (lineIdx >= lines.length || lines[lineIdx].trim() !== originalTrimmed) {
                //  Flow file was modified out from under us (concurrent
                //  ftn_bso append, or another session). Skip both the rewrite
                //  and the GC — neither is safe without our line in place.
                return;
            }

            const prefix = /^[\^#-]/.test(originalTrimmed) ? originalTrimmed[0] : '';
            const body = prefix ? originalTrimmed.slice(1) : originalTrimmed;
            lines[lineIdx] = `~${body}`;

            const hasLive = lines.some(l => {
                const t = l.trim();
                return t.length > 0 && t[0] !== '~';
            });

            if (hasLive) {
                await fsp.writeFile(flowPath, lines.join('\n'), 'utf8');
            } else {
                await fsp.unlink(flowPath);
            }
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
async function flowHasPending(flowPath) {
    const content = await fsp.readFile(flowPath, 'utf8').catch(() => '');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] === '~') continue;

        const ref = /^[\^#-]/.test(trimmed) ? trimmed.slice(1) : trimmed;
        if (await resolveFlowRef(flowPath, ref)) return true;
    }
    return false;
}

//
//  Resolve a flow file reference to a file that exists, as { path, stat }, or
//  null when it resolves nowhere.
//
//  Flow files carry absolute paths (FTS-5005.003 §3.1). A stored path that no
//  longer resolves means the file moved out from under the reference — a
//  relocated outbound tree, or a sysop hand-recovering mail that was filed in
//  the wrong directory. Before giving up we look for the referenced basename
//  in the flow file's own directory, which makes that recovery a matter of
//  moving files rather than also hand-editing flow files.
//
//  A reference that resolves nowhere is logged once per process. Silence here
//  is how misfiled outbound mail hides: the session finds nothing to send and
//  reports success.
//
async function resolveFlowRef(flowPath, ref) {
    const warnOnce = (key, fields, message) => {
        if (warnedFlowRefs.has(key)) return;
        if (warnedFlowRefs.size >= MAX_WARNED_FLOW_REFS) warnedFlowRefs.clear();
        warnedFlowRefs.add(key);
        Log.warn(fields, message);
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
                warnOnce(
                    `stat\0${p}`,
                    { path: p, error: err.message },
                    '[BinkP/BSO] Error stat-ing flow file reference'
                );
            }
            return null;
        }
    };

    let stat = await tryStat(ref);
    if (stat) return { path: ref, stat };

    //  Split on either separator — the reference may have been written by a
    //  mailer running on the other sort of platform.
    const base = ref.split(/[\\/]/).pop();
    const alt = base && path.join(path.dirname(flowPath), base);
    if (alt && alt !== ref) {
        stat = await tryStat(alt);
        if (stat) return { path: alt, stat };
    }

    warnOnce(
        `ref\0${flowPath}\0${ref}`,
        { flowFile: flowPath, ref },
        '[BinkP/BSO] Flow file reference names no usable file; skipping entry'
    );

    return null;
}

//
//  Wire a BsoSpool to a BinkpSession for the standard inbound/outbound case.
//
//  For the originating (outbound) side:
//    Pass the known remote addresses in |remoteAddrs|. Files are queued
//    synchronously before session.start() is called.
//
//  For the answering (inbound) side:
//    Pass remoteAddrs = null. The function listens for the 'addresses' event,
//    uses holdSend()/releaseSend() to gate file sending until the async spool
//    read completes, then queues whatever is pending for the connecting node.
//
//  Returns the disposeMap so callers can add extra entries if needed.
//
async function attachSpoolToSession(session, spool, remoteAddrs) {
    const disposeMap = new Map();

    //  Direct-attach files don't have a flow-file annotation step, so their
    //  disposeFn is null and we skip the disposeMap entry entirely. Only flow
    //  entries register a post-send hook (to mark the line with '~' and GC the
    //  flow file when no live entries remain).
    const registerDispose = f => {
        if (f.disposeFn) {
            disposeMap.set(`${f.name}\0${f.size}\0${f.timestamp}`, f.disposeFn);
        }
    };

    if (remoteAddrs && remoteAddrs.length > 0) {
        // Originating side: addresses are known up-front
        for (const addr of remoteAddrs) {
            const files = await spool.getOutboundFilesForNode(addr);
            for (const f of files) {
                session.queueFile(f.path, f.name, f.size, f.timestamp, f.disposition);
                registerDispose(f);
            }
        }
    } else {
        //
        //  Answering side: learn remote addresses from the session handshake,
        //  then resolve what we have queued for them.
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
        //  needs. The FREQ resolver already uses it for the same reason.
        //
        //  Reported as #747, and it is not TIC-specific: it affects any
        //  answering session with something queued for the caller. It matters
        //  especially for file echoes, because a downlink normally polls its
        //  hub rather than being dialled.
        //
        session.on('addresses', async addrStrings => {
            session.holdEOB();
            try {
                for (const addrStr of addrStrings) {
                    const addr = Address.fromString(addrStr);
                    if (!addr || !addr.isValid()) continue;
                    const files = await spool.getOutboundFilesForNode(addr);
                    for (const f of files) {
                        session.queueFile(
                            f.path,
                            f.name,
                            f.size,
                            f.timestamp,
                            f.disposition
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

module.exports = { BsoSpool, attachSpoolToSession, nodeBaseName };
