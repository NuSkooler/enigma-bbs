'use strict';

const net = require('net');
const os = require('os');
const _ = require('lodash');
const later = require('@breejs/later');
const async = require('async');

const Log = require('../logger.js').log;
const Events = require('../events.js');
const configModule = require('../config.js');
const Address = require('../ftn_address.js');
const { MessageScanTossModule } = require('../msg_scan_toss_module.js');
const { BinkpSession } = require('../binkp/session.js');
const { BsoSpool, attachSpoolToSession } = require('../binkp/bso_spool.js');
const { pollNodes } = require('../binkp/caller.js');

const Config = () => configModule.get();

//  Crashmail debounce window: when ftn_bso emits NewOutboundBSO, wait briefly
//  before dialing so back-to-back exports of multiple messages to the same
//  node coalesce into a single session. Tunable via
//  scannerTossers.ftn_bso.binkp.crashmailDebounceMs.
const DEFAULT_CRASHMAIL_DEBOUNCE_MS = 500;

exports.moduleInfo = {
    name: 'BinkP',
    desc: 'BinkP FidoNet Mail Exchange',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.binkp',
};

exports.getModule = class BinkpModule extends MessageScanTossModule {
    constructor() {
        super();
        this._server = null;
        this._pullTimer = null;
        this._crashmailTimer = null;
        this._crashmailPending = new Map(); // zone:net/node -> Address
        this._crashmailListener = null;
    }

    startup(cb) {
        const ftnBsoCfg = _.get(Config(), 'scannerTossers.ftn_bso');
        if (!ftnBsoCfg) {
            return cb(null);
        }

        const binkpCfg = _.get(ftnBsoCfg, 'binkp', {});

        async.series(
            [
                callback => this._startInbound(binkpCfg, ftnBsoCfg, callback),
                callback => this._startPullSchedule(binkpCfg, callback),
                callback => this._startCrashmailListener(binkpCfg, callback),
            ],
            cb
        );
    }

    shutdown(cb) {
        if (this._pullTimer) {
            this._pullTimer.clear();
            this._pullTimer = null;
        }
        if (this._crashmailTimer) {
            clearTimeout(this._crashmailTimer);
            this._crashmailTimer = null;
        }
        this._crashmailPending.clear();
        if (this._crashmailListener) {
            Events.removeListener(
                Events.getSystemEvents().NewOutboundBSO,
                this._crashmailListener
            );
            this._crashmailListener = null;
        }
        if (this._server) {
            this._server.close(() => {
                this._server = null;
                return cb(null);
            });
        } else {
            return cb(null);
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _startInbound(binkpCfg, ftnBsoCfg, cb) {
        const inbound = _.get(binkpCfg, 'inbound', {});
        if (!inbound.enabled) return cb(null);

        const spool = new BsoSpool({
            paths: ftnBsoCfg.paths,
            networks: _.get(Config(), 'messageNetworks.ftn.networks', {}),
        });

        const addresses = this._localAddresses();
        const tempDir = _.get(binkpCfg, 'tempDir', os.tmpdir());

        this._server = net.createServer(socket => {
            this._handleConnection(socket, spool, addresses, binkpCfg, tempDir);
        });

        this._server.on('error', err => {
            Log.error({ error: err.message }, '[BinkP] Server error');
        });

        const port = parseInt(inbound.port || 24554);
        const address = inbound.address || '0.0.0.0';

        this._server.listen(port, address, () => {
            Log.info(
                { port: this._server.address().port, address },
                '[BinkP] Inbound server listening'
            );
            return cb(null);
        });
    }

    //
    //  Periodic pull cycle: dial every configured peer regardless of
    //  whether we have outbound mail for them, so quiet nodes' echo mail
    //  flows in. A node opts out by setting `pull: false` in its config
    //  block (rare; use only for write-only peers).
    //
    //  This is intentionally separate from the crashmail listener: that
    //  one fires within hundreds of milliseconds when ftn_bso queues
    //  outbound; this one is the heartbeat that keeps incoming mail
    //  flowing during quiet stretches.
    //
    _startPullSchedule(binkpCfg, cb) {
        const scheduleStr = binkpCfg.pullSchedule;
        if (!scheduleStr) {
            Log.debug('[BinkP] No pullSchedule configured; pull cycle disabled');
            return cb(null);
        }

        const sched = later.parse.text(scheduleStr);
        if (sched.error !== -1) {
            Log.warn(
                { schedule: scheduleStr, errorIdx: sched.error },
                '[BinkP] Invalid pullSchedule expression; pull cycle disabled'
            );
            return cb(null);
        }

        let polling = false;
        this._pullTimer = later.setInterval(() => {
            if (polling) return;
            polling = true;
            const addrs = this._pullAddresses(binkpCfg);
            Log.info({ count: addrs.length }, '[BinkP] Scheduled pull cycle starting');
            pollNodes(addrs, () => {
                polling = false;
            });
        }, sched);

        Log.debug({ schedule: scheduleStr }, '[BinkP] Pull schedule set');
        return cb(null);
    }

    //
    //  Crashmail (event-driven, no schedule): when ftn_bso writes a flow
    //  file via flowFileAppendRefs, it emits NewOutboundBSO with the
    //  destination address. We coalesce events that fire within
    //  |crashmailDebounceMs| (default 500 ms) so a multi-message export to
    //  the same peer turns into one session, not N. After the debounce
    //  window elapses, dial whatever set of addresses accumulated.
    //
    _startCrashmailListener(binkpCfg, cb) {
        const debounceMs = _.get(
            binkpCfg,
            'crashmailDebounceMs',
            DEFAULT_CRASHMAIL_DEBOUNCE_MS
        );

        this._crashmailListener = ({ address }) => {
            if (!address) return;
            const key = `${address.zone || 0}:${address.net}/${address.node}`;
            this._crashmailPending.set(key, address);

            if (this._crashmailTimer) return; // window already open
            this._crashmailTimer = setTimeout(() => {
                this._crashmailTimer = null;
                const addrs = Array.from(this._crashmailPending.values());
                this._crashmailPending.clear();
                if (addrs.length === 0) return;
                Log.info(
                    {
                        count: addrs.length,
                        addrs: addrs.map(a => a.toString()),
                    },
                    '[BinkP] Crashmail dispatch'
                );
                pollNodes(addrs, () => {});
            }, debounceMs);
        };

        Events.addListener(
            Events.getSystemEvents().NewOutboundBSO,
            this._crashmailListener
        );
        return cb(null);
    }

    //  Build the list of addresses for a pull cycle: every entry in
    //  binkp.nodes whose pattern parses as a concrete address (not a
    //  wildcard) and whose config doesn't set `pull: false`.
    _pullAddresses(binkpCfg) {
        const nodes = binkpCfg.nodes || {};
        const out = [];
        for (const [pattern, conf] of Object.entries(nodes)) {
            if (conf && conf.pull === false) continue;
            const addr = Address.fromString(pattern);
            if (!addr || !addr.isValid()) {
                Log.debug(
                    { pattern },
                    '[BinkP] Skipping non-concrete node pattern in pull cycle'
                );
                continue;
            }
            out.push(addr);
        }
        return out;
    }

    async _handleConnection(socket, spool, addresses, binkpCfg, tempDir) {
        const remote = `${socket.remoteAddress}:${socket.remotePort}`;
        Log.info({ remote }, '[BinkP] Inbound connection');

        const session = new BinkpSession(socket, {
            role: 'answering',
            addresses,
            getPassword: remoteAddrs => this._lookupPassword(binkpCfg.nodes, remoteAddrs),
            tempDir,
        });

        let lockAddr = null;
        let filesReceived = 0;

        const releaseLock = async () => {
            if (lockAddr) {
                const addr = lockAddr;
                lockAddr = null;
                await spool.releaseLock(addr).catch(() => {});
            }
        };

        session.on('file-received', () => {
            filesReceived++;
        });

        session.on('addresses', async addrStrings => {
            for (const addrStr of addrStrings) {
                const addr = Address.fromString(addrStr);
                if (!addr || !addr.isValid()) continue;
                const locked = await spool.acquireLock(addr).catch(() => false);
                if (!locked) {
                    Log.info(
                        { addr: addrStr },
                        '[BinkP] Node already in session, sending M_BSY'
                    );
                    session.sendBusy(addrStr);
                    return;
                }
                lockAddr = addr;
                return;
            }
        });

        session.on('session-end', async () => {
            await releaseLock();
            Log.info({ remote }, '[BinkP] Session complete');
            if (filesReceived > 0) {
                Events.emit(Events.getSystemEvents().NewInboundBSO);
            }
        });

        session.on('error', async err => {
            await releaseLock();
            Log.warn({ remote, error: err.message }, '[BinkP] Session error');
        });

        socket.on('error', async err => {
            if (err.code !== 'ECONNRESET') {
                Log.warn({ remote, error: err.message }, '[BinkP] Socket error');
            }
            await releaseLock();
        });

        await attachSpoolToSession(session, spool, null);
        session.start();
    }

    _localAddresses() {
        const networks = _.get(Config(), 'messageNetworks.ftn.networks', {});
        return Object.values(networks)
            .map(n => n.localAddress)
            .filter(Boolean);
    }

    _lookupPassword(nodes, remoteAddrStrings) {
        if (_.isEmpty(nodes)) return null;
        for (const addrStr of remoteAddrStrings || []) {
            const addr = Address.fromString(addrStr);
            if (!addr || !addr.isValid()) continue;
            const nodeConf = _.find(nodes, (conf, pattern) =>
                addr.isPatternMatch(pattern)
            );
            if (nodeConf && nodeConf.sessionPassword) return nodeConf.sessionPassword;
        }
        return null;
    }
};
