'use strict';

const net = require('net');
const os = require('os');
const _ = require('lodash');

const Log = require('../logger.js').log;
const Events = require('../events.js');
const configModule = require('../config.js');
const Address = require('../ftn_address.js');
const { BinkpSession } = require('./session.js');
const { BsoSpool, attachSpoolToSession } = require('./bso_spool.js');

const Config = () => configModule.get();

const CONNECT_TIMEOUT_MS = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSpool() {
    const config = Config();
    return new BsoSpool({
        paths: _.get(config, 'scannerTossers.ftn_bso.paths'),
        networks: _.get(config, 'messageNetworks.ftn.networks', {}),
    });
}

function localAddresses() {
    const networks = _.get(Config(), 'messageNetworks.ftn.networks', {});
    return Object.values(networks)
        .map(n => n.localAddress)
        .filter(Boolean);
}

// Returns the first node config entry whose address pattern matches |addr|,
// or undefined if none matches.
function nodeConfigFor(addr) {
    const nodes = _.get(Config(), 'scannerTossers.ftn_bso.binkp.nodes', {});
    return _.find(nodes, (conf, pattern) => addr.isPatternMatch(pattern));
}

// ── callNode ──────────────────────────────────────────────────────────────────

// Dial a single remote node and run a BinkP session as the originating side.
// Returns a Promise that resolves when the session completes cleanly or
// rejects on connection/protocol error.
async function callNode(addr, nodeConf, spool) {
    const addrStr = addr.toString();
    const host = nodeConf.host;
    const port = nodeConf.port || 24554;

    const locked = await spool.acquireLock(addr).catch(() => false);
    if (!locked) {
        Log.info({ addr: addrStr }, '[BinkP/Caller] Node already in session, skipping');
        return;
    }

    try {
        const socket = await _connect(host, port);

        const session = new BinkpSession(socket, {
            role: 'originating',
            addresses: localAddresses(),
            getPassword: () => nodeConf.sessionPassword || null,
            tempDir: _.get(Config(), 'scannerTossers.ftn_bso.binkp.tempDir', os.tmpdir()),
        });

        let filesReceived = 0;
        session.on('file-received', () => {
            filesReceived++;
        });

        //  Attach the terminal-state listeners BEFORE any awaits that follow
        //  session construction. The session's socket events ('error',
        //  'close') can fire promptly on a remote drop — even before
        //  start() is called — and BinkpSession turns them into 'error' /
        //  'disconnect' emits. A listener attached after the await would
        //  miss them and the promise would hang until SESSION_TIMEOUT_MS.
        const sessionResult = new Promise((resolve, reject) => {
            session.on('session-end', resolve);
            session.on('error', reject);
            session.on('busy', reason => reject(new Error(`Remote busy: ${reason}`)));
            //  Remote dropped mid-flight: BinkpSession emits 'disconnect'
            //  (not 'error') from _onSocketClose. Treat as a session error
            //  so the caller advances rather than waiting on the 5-min
            //  session timeout.
            session.on('disconnect', () => reject(new Error('Remote disconnected')));
        });
        //  Acknowledge the rejection up-front: if the remote drops between
        //  here and `await sessionResult` below (e.g. during the awaited
        //  attachSpoolToSession), the rejection still settles cleanly into
        //  our await. Without this, Node logs a noisy "unhandled-rejection
        //  → handled asynchronously" pair for every aborted-on-connect peer.
        sessionResult.catch(() => {});

        await attachSpoolToSession(session, spool, [addr]);
        session.start();

        await sessionResult;

        if (filesReceived > 0) {
            Events.emit(Events.getSystemEvents().NewInboundBSO);
        }

        Log.info({ addr: addrStr, host, port }, '[BinkP/Caller] Session complete');
    } finally {
        await spool.releaseLock(addr).catch(() => {});
    }
}

// ── pollNodes ─────────────────────────────────────────────────────────────────

// Dial each node in |forceAddrs| plus every node the spool reports as having
// pending outbound mail. The two sets are unioned and de-duplicated by
// zone:net/node before dialing — so the same hub never gets called twice in a
// single pass even if it appears in both.
//
// |forceAddrs| accepts either Address instances or address strings ("21:1/100",
// "700:100/0"); strings are parsed via Address.fromString().
//
// Callers:
//   - scanner_tossers/binkp.js periodic pull schedule: passes every configured
//     node to keep quiet peers' echo mail flowing in.
//   - scanner_tossers/binkp.js NewOutboundBSO listener (crashmail): passes the
//     single just-queued destination so we ship within hundreds of milliseconds.
//   - binkp/binkp_poll_module.js (sysop "poll now" menu): passes [].
async function pollNodes(forceAddrs, cb) {
    const config = Config();

    if (
        !_.isString(_.get(config, 'scannerTossers.ftn_bso.paths.outbound')) ||
        _.isEmpty(_.get(config, 'messageNetworks.ftn.networks'))
    ) {
        Log.debug('[BinkP/Caller] Not configured, skipping poll');
        return cb(null);
    }

    const spool = buildSpool();

    let pendingAddrs;
    try {
        pendingAddrs = await spool.getNodesWithPendingMail();
    } catch (err) {
        Log.warn({ error: err.message }, '[BinkP/Caller] Error scanning outbound spool');
        return cb(err);
    }

    //  Union pending + caller-supplied force addrs, deduped by zone:net/node.
    //  Address instances pass through untouched; strings are parsed (and
    //  dropped if invalid).
    const addrsByKey = new Map();
    const seen = addr => {
        const key = `${addr.zone || 0}:${addr.net}/${addr.node}`;
        if (!addrsByKey.has(key)) {
            addrsByKey.set(key, addr);
        }
    };
    for (const a of pendingAddrs) seen(a);
    for (const a of forceAddrs || []) {
        const addr = a instanceof Address ? a : Address.fromString(String(a));
        if (addr && addr.isValid()) seen(addr);
    }
    const addrs = Array.from(addrsByKey.values());

    for (const addr of addrs) {
        const nodeConf = nodeConfigFor(addr);
        if (!nodeConf || !nodeConf.host) {
            Log.debug(
                { addr: addr.toString() },
                '[BinkP/Caller] No host configured, skipping'
            );
            continue;
        }

        try {
            await callNode(addr, nodeConf, spool);
        } catch (err) {
            Log.warn(
                { addr: addr.toString(), error: err.message },
                '[BinkP/Caller] Call failed'
            );
        }
    }

    return cb(null);
}

// ── Private ───────────────────────────────────────────────────────────────────

function _connect(host, port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });

        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Connection to ${host}:${port} timed out`));
        }, CONNECT_TIMEOUT_MS);

        socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });

        socket.once('error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

module.exports = { callNode, pollNodes };
