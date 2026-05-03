'use strict';

const fsp = require('fs/promises');
const path = require('path');

const Address = require('../ftn_address');
const { moveFileWithCollisionHandling } = require('../file_util');
const Log = require('../logger').log;

// In priority order (highest first)
const FLOW_EXTS = ['ilo', 'clo', 'dlo', 'flo', 'hlo'];
const DIRECT_EXTS = ['iut', 'cut', 'dut', 'out', 'hut'];

// Default age beyond which an unreleased .bsy lock is considered orphaned
// (BBS crashed mid-session). 6× the BinkP session timeout (5 min) gives a
// generous safety margin without making post-crash recovery slow. Tunable
// via scannerTossers.ftn_bso.binkp.staleLockMaxAgeMs.
const DEFAULT_STALE_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

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
//
class BsoSpool {
    constructor(config) {
        this._paths = config.paths || {};
        this._networks = config.networks || {};
        this._staleLockMaxAgeMs =
            typeof config.staleLockMaxAgeMs === 'number'
                ? config.staleLockMaxAgeMs
                : DEFAULT_STALE_LOCK_MAX_AGE_MS;
    }

    // ── Lock management ──────────────────────────────────────────────────────

    // Acquire the per-node .bsy lock. Returns false if already locked by another
    // process; throws on unexpected errors.
    async acquireLock(addr) {
        const bsyPath = this._bsyPath(addr);
        await fsp.mkdir(path.dirname(bsyPath), { recursive: true });

        const tryCreate = async () => {
            // 'wx' = exclusive create; fails with EEXIST if file is present
            const fh = await fsp.open(bsyPath, 'wx');
            await fh.writeFile(String(process.pid));
            await fh.close();
        };

        try {
            await tryCreate();
            return true;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }

        //  EEXIST: lock present. Reap if it looks orphaned and retry once.
        if (!(await this._reapIfStale(bsyPath))) return false;

        try {
            await tryCreate();
            return true;
        } catch (err) {
            if (err.code === 'EEXIST') return false;
            throw err;
        }
    }

    async releaseLock(addr) {
        await fsp.unlink(this._bsyPath(addr)).catch(() => {});
    }

    // Sweep every outbound directory for orphaned .bsy lock files. Returns the
    // number of files reaped. Intended for startup so a crashed prior run
    // doesn't leave nodes permanently un-pollable.
    async reapStaleLocks() {
        const dirs = await this._allOutboundDirs();
        let reaped = 0;
        for (const { dir } of dirs) {
            let entries;
            try {
                entries = await fsp.readdir(dir);
            } catch {
                continue;
            }
            for (const file of entries) {
                if (!/\.bsy$/i.test(file)) continue;
                if (await this._reapIfStale(path.join(dir, file))) reaped++;
            }
        }
        return reaped;
    }

    // Returns true if the .bsy at |bsyPath| was older than staleLockMaxAgeMs
    // and has been removed (or was already gone). Returns false when the file
    // is still fresh, or when stat/unlink errors prevent a confident reap.
    async _reapIfStale(bsyPath) {
        let stat;
        try {
            stat = await fsp.stat(bsyPath);
        } catch (err) {
            //  Already gone — caller should treat that as a successful reap
            //  (the slot is now free).
            return err.code === 'ENOENT';
        }
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs <= this._staleLockMaxAgeMs) return false;
        try {
            await fsp.unlink(bsyPath);
            Log.info(
                { path: bsyPath, ageMs },
                '[BinkP/BSO] Reaped stale .bsy lock'
            );
            return true;
        } catch (err) {
            if (err.code === 'ENOENT') return true;
            Log.warn(
                { path: bsyPath, error: err.message },
                '[BinkP/BSO] Could not reap stale .bsy lock'
            );
            return false;
        }
    }

    // ── Outbound file enumeration ────────────────────────────────────────────

    // Returns all pending outbound files for |addr|.
    // Each entry: { name, path, size, timestamp, disposition, disposeFn }
    // Call disposeFn() after the remote acknowledges receipt (file-sent event).
    async getOutboundFilesForNode(addr) {
        const dir = this._outboundDir(addr);
        const base = nodeBaseName(addr);
        const results = [];

        for (const ext of DIRECT_EXTS) {
            const filePath = path.join(dir, `${base}.${ext}`);
            try {
                const stat = await fsp.stat(filePath);
                // Zero-byte .ilo = poll trigger, not actual mail
                if (stat.size === 0) continue;
                results.push({
                    name: path.basename(filePath),
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
            const flowPath = path.join(dir, `${base}.${ext}`);
            try {
                const entries = await this._parseFlowFile(flowPath);
                results.push(...entries);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    Log.warn(
                        { path: flowPath, error: err.message },
                        '[BinkP/BSO] Error reading flow file'
                    );
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

        for (const { dir, zone } of outboundDirs) {
            let entries;
            try {
                entries = await fsp.readdir(dir);
            } catch {
                continue;
            }

            for (const file of entries) {
                const m =
                    /^([0-9a-f]{8})\.(flo|clo|ilo|hlo|dlo|out|cut|iut|hut|dut)$/i.exec(
                        file
                    );
                if (!m) continue;

                const base = m[1].toLowerCase();
                const ext = m[2].toLowerCase();
                const key = `${zone}:${base}`;
                if (seen.has(key)) continue;

                const filePath = path.join(dir, file);

                if (FLOW_EXTS.includes(ext)) {
                    if (!(await flowHasPending(filePath))) continue;
                } else {
                    // Direct-attach: zero-byte = poll flag, not mail
                    const stat = await fsp.stat(filePath).catch(() => null);
                    if (!stat || stat.size === 0) continue;
                }

                seen.add(key);
                results.push(
                    new Address({
                        zone,
                        net: parseInt(base.slice(0, 4), 16),
                        node: parseInt(base.slice(4, 8), 16),
                    })
                );
            }
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

    _defaultNetworkName() {
        const names = Object.keys(this._networks);
        return names.length > 0 ? names[0] : null;
    }

    _defaultZone(networkName) {
        const net = this._networks[networkName];
        if (!net) return 1;
        if (typeof net.defaultZone === 'number') return net.defaultZone;
        const addr = Address.fromString(net.localAddress || '');
        return addr && addr.zone ? addr.zone : 1;
    }

    _networkNameForAddr(addr) {
        for (const [name] of Object.entries(this._networks)) {
            if (addr.zone === this._defaultZone(name)) return name;
        }
        return this._defaultNetworkName();
    }

    _outboundDir(addr) {
        const netName = this._networkNameForAddr(addr);
        const defaultNet = this._defaultNetworkName();
        const defaultZone = this._defaultZone(netName);

        const zoneExt =
            addr.zone !== undefined && addr.zone !== defaultZone
                ? '.' + `000${addr.zone.toString(16)}`.slice(-3)
                : '';

        const dirName =
            netName === defaultNet ? `outbound${zoneExt}` : `${netName}${zoneExt}`;

        return path.join(this._paths.outbound, dirName);
    }

    _bsyPath(addr) {
        return path.join(this._outboundDir(addr), `${nodeBaseName(addr)}.bsy`);
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

            let stat;
            try {
                stat = await fsp.stat(filePath);
            } catch {
                // File referenced in flow but missing on disk — skip silently
                continue;
            }

            const lineIdx = i;
            const captured = trimmed; // close over the line as it was when read
            results.push({
                name: path.basename(filePath),
                path: filePath,
                size: stat.size,
                timestamp: Math.floor(stat.mtimeMs / 1000),
                disposition,
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
        const defaultNet = this._defaultNetworkName();

        for (const [netName] of Object.entries(this._networks)) {
            const defaultZone = this._defaultZone(netName);
            const isDefault = netName === defaultNet;
            const baseName = isDefault ? 'outbound' : netName;

            dirs.push({
                dir: path.join(this._paths.outbound, baseName),
                zone: defaultZone,
            });

            // Also pick up zone-specific subdirs (outbound.001, outbound.002, …)
            try {
                const re = new RegExp(`^${baseName}\\.([0-9a-f]{3})$`, 'i');
                const entries = await fsp.readdir(this._paths.outbound);
                for (const entry of entries) {
                    const m = re.exec(entry);
                    if (m) {
                        dirs.push({
                            dir: path.join(this._paths.outbound, entry),
                            zone: parseInt(m[1], 16),
                        });
                    }
                }
            } catch {
                // outbound root does not exist yet — fine
            }
        }

        // Fallback when no networks are configured
        if (dirs.length === 0) {
            dirs.push({ dir: path.join(this._paths.outbound, 'outbound'), zone: 1 });
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

async function flowHasPending(flowPath) {
    const content = await fsp.readFile(flowPath, 'utf8').catch(() => '');
    return content.split('\n').some(line => {
        const t = line.trim();
        return t.length > 0 && t[0] !== '~';
    });
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
        // Answering side: learn remote addresses from the session handshake
        session.on('addresses', async addrStrings => {
            session.holdSend();
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
                session.releaseSend();
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
        if (fn) {
            disposeMap.delete(key);
            await fn().catch(err =>
                Log.warn(
                    { name, error: err.message },
                    '[BinkP/BSO] Error applying file disposition'
                )
            );
        }
    });

    return disposeMap;
}

module.exports = { BsoSpool, attachSpoolToSession, nodeBaseName };
