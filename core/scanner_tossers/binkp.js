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

// Same pattern as ftn_bso's SCHEDULE_REGEXP
const SCHEDULE_REGEXP = /(?:^|or )?(@immediate|@watch:)([^\0]+)?$/;

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
        this._pollTimer = null;
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
                callback => this._startOutboundSchedule(binkpCfg, callback),
            ],
            cb
        );
    }

    shutdown(cb) {
        if (this._pollTimer) {
            this._pollTimer.clear();
            this._pollTimer = null;
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

    _startOutboundSchedule(binkpCfg, cb) {
        const scheduleStr = binkpCfg.schedule;
        if (!scheduleStr) return cb(null);

        const parsed = this._parseSchedule(scheduleStr);
        if (!parsed || !parsed.sched) return cb(null);

        let polling = false;
        this._pollTimer = later.setInterval(() => {
            if (polling) return;
            polling = true;
            Log.info('[BinkP] Scheduled outbound poll starting');
            pollNodes([], () => {
                polling = false;
            });
        }, parsed.sched);

        Log.debug({ schedule: scheduleStr }, '[BinkP] Outbound poll schedule set');
        return cb(null);
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

    _parseSchedule(schedStr) {
        if (!schedStr) return;
        let schedule = {};
        const m = SCHEDULE_REGEXP.exec(schedStr);
        if (m) {
            schedStr = schedStr.substr(0, m.index).trim();
            if ('@immediate' === m[1]) schedule.immediate = true;
        }
        if (schedStr.length > 0) {
            const sched = later.parse.text(schedStr);
            if (-1 === sched.error) schedule.sched = sched;
        }
        return _.isEmpty(schedule) ? undefined : schedule;
    }
};
