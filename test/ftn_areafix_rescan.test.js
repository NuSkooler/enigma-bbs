'use strict';

//
//  AreaFix rescan requests and reply handling.
//
//  The load-bearing behaviour here is what does NOT happen. FSC-0057's
//  "=TAG R=n" is spec correct and works against Mystic and CrashMail II, but
//  husky and SBBSecho have no '=' case: the line falls through to a subscribe
//  of a garbage tag, and a husky hub with forwardRequests may pass that
//  upstream as a request for a new area. There is no portable syntax, so
//  there is deliberately no default command and nothing is sent without one.
//

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const { AreaFixStatus } = require('../core/areafix_reply.js');

const FTN_BSO_PATH = require.resolve('../core/scanner_tossers/ftn_bso.js');

//
//  Resolved per test rather than at file load. Two other suites replace
//  core/message.js and core/stat_log.js in the require cache while loading, so
//  a reference captured here can end up pointing at a singleton the code under
//  test no longer uses -- and stubbing it would have no effect.
//
let Message;
let User;
let StatLog;

let restoreConfig;
let savedPersist;
let savedGetUserName;
let savedGetSystemStat;
let savedSetSystemStat;
let persisted;
let statStore;

function installStubs() {
    Message = require('../core/message.js');
    User = require('../core/user.js');
    StatLog = require('../core/stat_log.js');

    persisted = [];
    statStore = {};

    savedPersist = Message.prototype.persist;
    Message.prototype.persist = function (cb) {
        persisted.push(this);
        return cb(null);
    };

    savedGetUserName = User.getUserName;
    User.getUserName = (userId, cb) => cb(null, 'SysOp');

    savedGetSystemStat = StatLog.getSystemStat;
    savedSetSystemStat = StatLog.setSystemStat;
    StatLog.getSystemStat = name => statStore[name];
    StatLog.setSystemStat = (name, value) => {
        statStore[name] = value;
    };
}

function removeStubs() {
    Message.prototype.persist = savedPersist;
    User.getUserName = savedGetUserName;
    StatLog.getSystemStat = savedGetSystemStat;
    StatLog.setSystemStat = savedSetSystemStat;

    if (restoreConfig) {
        restoreConfig();
        restoreConfig = undefined;
    }
    delete require.cache[FTN_BSO_PATH];
}

function makeConfig(onDemand) {
    return {
        debug: { assertsEnabled: false },
        scannerTossers: {
            ftn_bso: { paths: { inbound: '/tmp', secInbound: '/tmp', outbound: '/tmp' } },
        },
        messageConferences: {
            fsxnet: { name: 'fsxNet', desc: 'fsxNet', areas: {} },
        },
        messageNetworks: {
            ftn: {
                networks: {
                    fsxnet: {
                        localAddress: '21:1/121',
                        autoAreas: {
                            confTag: 'fsxnet',
                            onDemand: Object.assign({ enabled: true }, onDemand),
                        },
                    },
                },
                areas: {},
            },
        },
    };
}

function makeModule(onDemand) {
    const prev = configModule._pushTestConfig(makeConfig(onDemand));
    restoreConfig = () => configModule._popTestConfig(prev);

    delete require.cache[FTN_BSO_PATH];
    const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
    return new getModule();
}

const CREATED = {
    created: [
        { ftnTag: 'FSX_BBS', areaTag: 'fsx_bbs' },
        { ftnTag: 'FSX_MYS', areaTag: 'fsx_mys' },
    ],
    rejected: [],
    pruned: [],
};

describe('FTN AreaFix rescan requests', () => {
    beforeEach(() => {
        installStubs();
    });

    afterEach(() => {
        removeStubs();
    });

    const request = inst =>
        new Promise(resolve =>
            inst.maybeRequestAreaFixRescan('fsxnet', CREATED, resolve)
        );

    it('sends nothing when rescan is not enabled', async () => {
        await request(makeModule({}));
        assert.equal(persisted.length, 0);
    });

    it('sends nothing when no rescanCommand is configured', async () => {
        //  There is no safe default: the same line means different things to
        //  different tossers, and to two of them it means "add this area".
        await request(makeModule({ rescan: true, rescanUplink: '21:1/100' }));
        assert.equal(persisted.length, 0);
    });

    it('sends nothing when the uplink address is missing or invalid', async () => {
        await request(makeModule({ rescan: true, rescanCommand: '=%TAG% R=%DAYS%' }));
        assert.equal(persisted.length, 0);

        await request(
            makeModule({
                rescan: true,
                rescanUplink: 'not-an-address',
                rescanCommand: '=%TAG% R=%DAYS%',
            })
        );
        assert.equal(persisted.length, 0);
    });

    it('sends one NetMail with a command per created area', async () => {
        await request(
            makeModule({
                rescan: true,
                rescanUplink: '21:1/100',
                rescanPassword: 'SECRET',
                rescanDays: 30,
                rescanCommand: '=%TAG% R=%DAYS%',
            })
        );

        assert.equal(persisted.length, 1);
        const msg = persisted[0];

        assert.equal(msg.areaTag, Message.WellKnownAreaTags.Private);
        assert.equal(msg.toUserName, 'AreaFix');
        assert.equal(msg.subject, 'SECRET'); //  AreaFix password goes in the subject
        assert.equal(msg.meta.System[Message.SystemMetaNames.RemoteToUser], '21:1/100');
        assert.equal(
            msg.meta.System[Message.SystemMetaNames.ExternalFlavor],
            Message.AddressFlavor.FTN
        );

        assert.equal(msg.message, '=FSX_BBS R=30\r\n=FSX_MYS R=30\r\n');
    });

    it('uses whatever syntax the uplink actually speaks', async () => {
        //  the husky / SBBSecho form
        await request(
            makeModule({
                rescan: true,
                rescanUplink: '21:1/100',
                rescanDays: 14,
                rescanCommand: '%RESCAN %TAG% R=%DAYS%',
            })
        );

        assert.equal(
            persisted[0].message,
            '%RESCAN FSX_BBS R=14\r\n%RESCAN FSX_MYS R=14\r\n'
        );
    });

    it('records what it asked for so the reply can be correlated', async () => {
        const inst = makeModule({
            rescan: true,
            rescanUplink: '21:1/100',
            rescanCommand: '=%TAG% R=%DAYS%',
        });
        await request(inst);

        const pending = inst.getPendingAreaFixRequests();
        assert.deepEqual(Object.keys(pending), ['21:1/100']);
        assert.deepEqual(Object.keys(pending['21:1/100'].tags).sort(), [
            'FSX_BBS',
            'FSX_MYS',
        ]);
        assert.equal(pending['21:1/100'].network, 'fsxnet');
    });
});

describe('FTN AreaFix reply handling', () => {
    let inst;

    beforeEach(() => {
        installStubs();

        inst = makeModule({});
        inst.recordPendingAreaFixRequests('21:1/100', 'fsxnet', 'AreaFix', [
            'FSX_BBS',
            'FSX_MYS',
        ]);
        persisted = [];
    });

    afterEach(() => {
        removeStubs();
    });

    function reply({ from = '21:1/100', fromUserName = 'AreaFix', body }) {
        const message = new Message({
            toUserName: 'SysOp',
            fromUserName,
            subject: 'Areafix reply: node change request',
            message: body,
            areaTag: Message.WellKnownAreaTags.Private,
        });
        message.meta.System[Message.SystemMetaNames.RemoteFromUser] = from;
        return new Promise(resolve => inst.handleAreaFixReply(message, resolve));
    }

    it('notifies the operator and clears what was answered', async () => {
        await reply({
            body: [
                ' FSX_BBS ........................... added',
                ' FSX_MYS ........................... not found',
            ].join('\r\n'),
        });

        assert.equal(persisted.length, 1);
        assert.match(persisted[0].subject, /AreaFix reply from 21:1\/100/);
        assert.match(persisted[0].message, /FSX_BBS: added/);
        assert.match(persisted[0].message, /FSX_MYS: not_found/);

        //  both answered, so nothing is still pending for that uplink
        assert.deepEqual(Object.keys(inst.getPendingAreaFixRequests()), []);
    });

    it('leaves unanswered areas pending', async () => {
        await reply({ body: ' FSX_BBS ........................... added' });

        const pending = inst.getPendingAreaFixRequests();
        assert.deepEqual(Object.keys(pending['21:1/100'].tags), ['FSX_MYS']);
    });

    it('ignores a NetMail from a system we sent nothing to', async () => {
        await reply({ from: '21:1/999', body: ' FSX_BBS ....... added' });
        assert.equal(persisted.length, 0);
        assert.deepEqual(Object.keys(inst.getPendingAreaFixRequests()), ['21:1/100']);
    });

    it('ignores a NetMail from a human at the uplink', async () => {
        await reply({
            fromUserName: 'Some Sysop',
            body: 'I linked FSX_BBS added it for you',
        });
        assert.equal(persisted.length, 0);
    });

    it('reports wording it does not recognize rather than acting on it', async () => {
        await reply({ body: 'FSX_BBS wibbled sideways' });

        assert.equal(persisted.length, 1);
        assert.match(persisted[0].message, new RegExp(AreaFixStatus.Unknown));
        assert.match(persisted[0].message, /wibbled sideways/);
    });

    it('does nothing for a NetMail with no remote from address', async () => {
        const message = new Message({
            toUserName: 'SysOp',
            fromUserName: 'AreaFix',
            subject: 'hi',
            message: 'FSX_BBS added',
            areaTag: Message.WellKnownAreaTags.Private,
        });
        await new Promise(resolve => inst.handleAreaFixReply(message, resolve));
        assert.equal(persisted.length, 0);
    });

    it('drops pending requests older than the correlation window', async () => {
        const stale = JSON.parse(statStore.ftn_areafix_pending);
        stale['21:1/100'].tags.FSX_BBS.timestamp = '2020-01-01T00:00:00.000Z';
        stale['21:1/100'].tags.FSX_MYS.timestamp = '2020-01-01T00:00:00.000Z';
        statStore.ftn_areafix_pending = JSON.stringify(stale);

        assert.deepEqual(Object.keys(inst.getPendingAreaFixRequests()), []);

        await reply({ body: ' FSX_BBS ....... added' });
        assert.equal(persisted.length, 0);
    });
});

describe('FTN automatic area creation: operator notification', () => {
    let inst;

    beforeEach(() => {
        installStubs();

        inst = makeModule({});
    });

    afterEach(() => {
        removeStubs();
    });

    const report = result =>
        new Promise(resolve => inst.reportAutoCreatedAreas('fsxnet', result, resolve));

    it('sends one message per batch, not one per area', async () => {
        await report({
            created: Array.from({ length: 300 }, (_, i) => ({
                ftnTag: `FSX_${i}`,
                areaTag: `fsx_${i}`,
            })),
            rejected: [],
            pruned: [],
        });

        assert.equal(persisted.length, 1);
        assert.match(persisted[0].subject, /300 message area\(s\) automatically created/);
        assert.match(persisted[0].message, /FSX_0\s+->\s+fsx_0/);
        assert.match(persisted[0].message, /FSX_299\s+->\s+fsx_299/);
    });

    it('says what was refused and why', async () => {
        await report({
            created: [{ ftnTag: 'FSX_BBS', areaTag: 'fsx_bbs' }],
            rejected: [
                {
                    ftnTag: 'PRIVATE_MAIL',
                    areaTag: 'private_mail',
                    reason: 'would collide with a built-in system area',
                },
            ],
            pruned: [],
        });

        assert.equal(persisted.length, 1);
        assert.match(
            persisted[0].message,
            /PRIVATE_MAIL: would collide with a built-in system area/
        );
    });

    it('tells the operator these areas are read-only and how to adopt one', async () => {
        await report({
            created: [{ ftnTag: 'FSX_BBS', areaTag: 'fsx_bbs' }],
            rejected: [],
            pruned: [],
        });

        assert.match(persisted[0].message, /read-only/);
        assert.match(persisted[0].message, /config\.hjson/);
        assert.match(persisted[0].message, /autoAreas\.ignore/);
    });

    it('sends nothing when nothing was created', async () => {
        await report({
            created: [],
            rejected: [{ ftnTag: 'X', areaTag: 'x', reason: 'nope' }],
            pruned: ['old_area'],
        });
        assert.equal(persisted.length, 0);
    });
});
