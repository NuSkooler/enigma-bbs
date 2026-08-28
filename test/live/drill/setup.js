'use strict';

//
//  Build an isolated configuration tree for a real ENiGMA½ instance.
//
//  Everything lives under the drill directory: its own databases, log, mail
//  spool and ports. Nothing touches the operator's own config or data.
//

const fs = require('fs');
const paths = require('path');
const hjson = require('hjson');

const ROOT = paths.join(__dirname, '..', '..', '..');
const DRILL = process.argv[2];
const MENU = process.argv[3];

if (!DRILL || !MENU) {
    console.error('usage: setup.js <drillDir> <pathToMenuHjson>');
    process.exit(2);
}

const LOCAL = '21:1/121';
const UPLINK = '21:1/100';

[
    'config',
    'db',
    'db/mods',
    'logs',
    'in',
    'secin',
    'out',
    'reject',
    'trigger',
    'drop',
    'filebase',
].forEach(d => fs.mkdirSync(paths.join(DRILL, d), { recursive: true }));

const config = {
    includes: ['auto-areas.hjson'],

    general: {
        boardName: 'FTN Drill',
        prettyBoardName: 'Drill',
        menuFile: MENU,
    },

    paths: {
        db: paths.join(DRILL, 'db'),
        modsDb: paths.join(DRILL, 'db', 'mods'),
        logs: paths.join(DRILL, 'logs'),
        dropFiles: paths.join(DRILL, 'drop'),
    },

    //  off every port a real instance on this box would want
    loginServers: {
        telnet: { enabled: true, port: 9888 },
        ssh: { enabled: false },
        webSocket: { ws: { enabled: false }, wss: { enabled: false } },
    },
    contentServers: {
        web: { http: { enabled: false }, https: { enabled: false } },
        gopher: { enabled: false },
        nntp: { nntp: { enabled: false }, nntps: { enabled: false } },
    },
    chatServers: { mrc: { enabled: false } },

    messageConferences: {
        testnet: { name: 'TestNet', desc: 'Drill conference', areas: {} },
    },

    messageNetworks: {
        ftn: {
            networks: {
                testnet: {
                    localAddress: LOCAL,
                    autoAreas: {
                        confTag: 'testnet',
                        maxAutoCreate: 25,
                        ignore: ['TST_NOISY'],
                        onDemand: {
                            enabled: true,
                            rescan: true,
                            rescanUplink: UPLINK,
                            rescanPassword: 'DRILLPASS',
                            rescanDays: 30,
                            //  the Mystic / CrashMail II form
                            rescanCommand: '=%TAG% R=%DAYS%',
                        },
                    },
                },
            },
            //  TST_GEN is configured; everything else the drill sends is not
            areas: {
                tst_gen: { network: 'testnet', tag: 'TST_GEN', uplinks: [UPLINK] },
            },
        },
    },

    scannerTossers: {
        ftn_bso: {
            defaultNetwork: 'testnet',
            nodes: { [UPLINK]: { archiveType: 'ZIP', encoding: 'utf8' } },
            //  without a route the rescan netmail cannot be exported
            netMail: { routes: { '21:*': { address: UPLINK, network: 'testnet' } } },
            paths: {
                inbound: paths.join(DRILL, 'in'),
                secInbound: paths.join(DRILL, 'secin'),
                outbound: paths.join(DRILL, 'out'),
                reject: paths.join(DRILL, 'reject'),
            },
            schedule: {
                //  touching the watch file tosses immediately
                import: `@watch:${paths.join(DRILL, 'trigger', 'import.now')}`,
                //  proves the rescan request leaves without a timed schedule
                export: '@immediate',
            },
        },
    },
};

fs.writeFileSync(
    paths.join(DRILL, 'config', 'config.hjson'),
    hjson.stringify(config, { emitRootBraces: true, space: 4, eol: '\n' }),
    'utf8'
);

console.log(`drill config: ${paths.join(DRILL, 'config', 'config.hjson')}`);
console.log(`enigma root:  ${ROOT}`);
