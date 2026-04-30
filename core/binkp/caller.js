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

        await attachSpoolToSession(session, spool, [addr]);

        await new Promise((resolve, reject) => {
            session.on('session-end', resolve);
            session.on('error', reject);
            session.on('busy', reason => reject(new Error(`Remote busy: ${reason}`)));
            session.start();
        });

        if (filesReceived > 0) {
            Events.emit(Events.getSystemEvents().NewInboundBSO);
        }

        Log.info({ addr: addrStr, host, port }, '[BinkP/Caller] Session complete');
    } finally {
        await spool.releaseLock(addr).catch(() => {});
    }
}

// ── pollNodes ─────────────────────────────────────────────────────────────────

// Find all nodes with pending outbound mail and call each in sequence.
// Called directly by core/scanner_tossers/binkp.js on its own schedule.
async function pollNodes(args, cb) {
    const config = Config();

    if (
        !_.isString(_.get(config, 'scannerTossers.ftn_bso.paths.outbound')) ||
        _.isEmpty(_.get(config, 'messageNetworks.ftn.networks'))
    ) {
        Log.debug('[BinkP/Caller] Not configured, skipping poll');
        return cb(null);
    }

    const spool = buildSpool();

    let addrs;
    try {
        addrs = await spool.getNodesWithPendingMail();
    } catch (err) {
        Log.warn({ error: err.message }, '[BinkP/Caller] Error scanning outbound spool');
        return cb(err);
    }

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
