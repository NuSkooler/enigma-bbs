'use strict';

//
//  Pass 1 of the two-pass toss: the read-only scan that finds FTN area tags
//  with no local area configured.
//
//  These build real .pkt files with the real packet writer and run them
//  through the real scan, because the properties that matter here are exactly
//  the ones a mock would paper over: that the scan reads without consuming,
//  and that it refuses the same packets the import refuses.  A packet whose
//  messages will be rejected must not be able to create areas on the way past.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const { Packet, PacketHeader } = require('../core/ftn_mail_packet.js');
const Message = require('../core/message.js');

const FTN_BSO_PATH = require.resolve('../core/scanner_tossers/ftn_bso.js');

let tempDir;
let restoreConfig;

//  21:1/121 -- what the fixture network is addressed as
const LOCAL_ZONE = 21;
const LOCAL_NET = 1;
const LOCAL_NODE = 121;

function makeConfig({ packetPassword } = {}) {
    const nodes = {};
    if (packetPassword) {
        nodes['21:1/100'] = { packetPassword };
    }

    return {
        debug: { assertsEnabled: false },
        scannerTossers: {
            ftn_bso: {
                paths: {
                    inbound: paths.join(tempDir, 'in'),
                    secInbound: paths.join(tempDir, 'secin'),
                    outbound: paths.join(tempDir, 'out'),
                },
                nodes,
            },
        },
        messageConferences: {
            fsxnet: { name: 'fsxNet', desc: 'fsxNet', areas: {} },
        },
        messageNetworks: {
            ftn: {
                networks: {
                    fsxnet: { localAddress: '21:1/121' },
                },
                //  FSX_GEN is configured; FSX_BBS and FSX_MYS are not
                areas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        tag: 'FSX_GEN',
                        uplinks: ['21:1/100'],
                    },
                },
            },
        },
    };
}

function makeHeader({ password = '' } = {}) {
    const ph = new PacketHeader();
    ph.origZone = 21;
    ph.origNet = 1;
    ph.origNode = 100;
    ph.destZone = LOCAL_ZONE;
    ph.destNet = LOCAL_NET;
    ph.destNode = LOCAL_NODE;
    ph.password = password;
    return ph;
}

function makeEchoMessage(ftnAreaTag, subject) {
    const message = new Message({
        toUserName: 'All',
        fromUserName: 'Someone',
        subject,
        message: 'body text',
        areaTag: 'whatever',
    });
    message.meta.FtnProperty = Object.assign({}, message.meta.FtnProperty, {
        ftn_area: ftnAreaTag,
    });
    message.meta.FtnKludge = message.meta.FtnKludge || {};
    return message;
}

function writePacket(fileName, header, messages) {
    const packetPath = paths.join(tempDir, 'in', fileName);
    return new Promise((resolve, reject) => {
        new Packet().write(packetPath, header, messages, {}, err => {
            if (err) {
                return reject(err);
            }
            //  write() streams; give the stream a tick to flush and close
            setTimeout(() => resolve(packetPath), 50);
        });
    });
}

function makeModule() {
    //  ftn_bso reads its module config from the pushed Config at construction
    delete require.cache[FTN_BSO_PATH];
    const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
    return new getModule();
}

function scan(inst, packetPath) {
    return new Promise(resolve => {
        inst.collectUnknownAreaTagsFromPacket(packetPath, (err, info) => resolve(info));
    });
}

describe('FTN automatic area creation: read-only inbound scan', () => {
    beforeEach(() => {
        tempDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-areascan-'));
        fs.mkdirSync(paths.join(tempDir, 'in'));
        fs.mkdirSync(paths.join(tempDir, 'secin'));
        fs.mkdirSync(paths.join(tempDir, 'out'));
    });

    afterEach(() => {
        if (restoreConfig) {
            restoreConfig();
            restoreConfig = undefined;
        }
        delete require.cache[FTN_BSO_PATH];
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function pushConfig(opts) {
        const prev = configModule._pushTestConfig(makeConfig(opts));
        restoreConfig = () => configModule._popTestConfig(prev);
    }

    it('finds area tags with no local area and ignores ones we already carry', async () => {
        pushConfig();
        const packetPath = await writePacket('test0001.pkt', makeHeader(), [
            makeEchoMessage('FSX_GEN', 'configured'),
            makeEchoMessage('FSX_BBS', 'not configured'),
            makeEchoMessage('FSX_MYS', 'also not configured'),
            makeEchoMessage('FSX_BBS', 'duplicate tag'),
        ]);

        const info = await scan(makeModule(), packetPath);

        assert.ok(info);
        assert.equal(info.networkName, 'fsxnet');
        assert.deepEqual(info.ftnTags.sort(), ['FSX_BBS', 'FSX_MYS']);
    });

    it('does not consume or modify the packet it scanned', async () => {
        pushConfig();
        const packetPath = await writePacket('test0002.pkt', makeHeader(), [
            makeEchoMessage('FSX_BBS', 'hello'),
        ]);
        const before = fs.readFileSync(packetPath);

        await scan(makeModule(), packetPath);

        assert.ok(fs.existsSync(packetPath), 'packet must survive the scan');
        assert.ok(before.equals(fs.readFileSync(packetPath)));
    });

    it('refuses a packet whose password does not match', async () => {
        pushConfig({ packetPassword: 'SECRET' });
        const packetPath = await writePacket(
            'test0003.pkt',
            makeHeader({ password: 'WRONG' }),
            [makeEchoMessage('FSX_BBS', 'hostile')]
        );

        //  The import rejects this packet, so nothing in it may create areas
        assert.equal(await scan(makeModule(), packetPath), null);
    });

    it('accepts a packet whose password does match', async () => {
        pushConfig({ packetPassword: 'SECRET' });
        const packetPath = await writePacket(
            'test0004.pkt',
            makeHeader({ password: 'SECRET' }),
            [makeEchoMessage('FSX_BBS', 'legit')]
        );

        const info = await scan(makeModule(), packetPath);
        assert.deepEqual(info.ftnTags, ['FSX_BBS']);
    });

    it('refuses a packet that is not addressed to us', async () => {
        pushConfig();
        const header = makeHeader();
        header.destNode = 999;

        const packetPath = await writePacket('test0005.pkt', header, [
            makeEchoMessage('FSX_BBS', 'misaddressed'),
        ]);

        assert.equal(await scan(makeModule(), packetPath), null);
    });

    it('survives a malformed packet without throwing', async () => {
        pushConfig();
        const packetPath = paths.join(tempDir, 'in', 'bad00001.pkt');
        fs.writeFileSync(packetPath, Buffer.alloc(0));

        assert.equal(await scan(makeModule(), packetPath), null);
        assert.ok(fs.existsSync(packetPath));
    });

    it('collects across every packet in a directory', async () => {
        pushConfig();
        await writePacket('test0006.pkt', makeHeader(), [
            makeEchoMessage('FSX_BBS', 'one'),
        ]);
        await writePacket('test0007.pkt', makeHeader(), [
            makeEchoMessage('FSX_MYS', 'two'),
        ]);

        const inst = makeModule();
        const collected = {};
        await new Promise(resolve =>
            inst.collectUnknownAreaTagsFromPacketDir(
                paths.join(tempDir, 'in'),
                collected,
                resolve
            )
        );

        assert.deepEqual(Array.from(collected.fsxnet).sort(), ['FSX_BBS', 'FSX_MYS']);
        assert.equal(fs.readdirSync(paths.join(tempDir, 'in')).length, 2);
    });

    it('does nothing at all when no network has it enabled', async () => {
        pushConfig();
        await writePacket('test0008.pkt', makeHeader(), [
            makeEchoMessage('FSX_BBS', 'one'),
        ]);

        const inst = makeModule();
        let scanned = false;
        inst.collectUnknownAreaTagsFromDirectory = (dir, collected, cb) => {
            scanned = true;
            return cb(null);
        };

        await new Promise(resolve => inst.maybeAutoCreateAreas(resolve));
        assert.equal(scanned, false, 'no scan should run with the feature off');
    });
});

//
//  The whole path, end to end: real packets in a real inbound directory, a
//  real config.hjson with a real include, through maybeAutoCreateAreas().
//  Each half is covered above and in auto_area_create.test.js; this is the
//  join between them.
//
describe('FTN automatic area creation: end to end', () => {
    const hjson = require('hjson');
    const autoAreaCreate = require('../core/auto_area_create.js');

    let savedGet;
    let savedReload;

    before(() => {
        savedGet = configModule.get;
        savedReload = configModule.reload;
    });

    after(() => {
        configModule.get = savedGet;
        configModule.reload = savedReload;
        delete require.cache[FTN_BSO_PATH];
    });

    function writeConfigHjson(autoAreas) {
        const config = {
            includes: [autoAreaCreate.GeneratedIncludeFileName],
            debug: { assertsEnabled: false },
            scannerTossers: {
                ftn_bso: {
                    paths: {
                        inbound: paths.join(tempDir, 'in'),
                        secInbound: paths.join(tempDir, 'secin'),
                        outbound: paths.join(tempDir, 'out'),
                    },
                    nodes: {},
                },
            },
            messageConferences: {
                fsxnet: { name: 'fsxNet', desc: 'fsxNet', areas: {} },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        fsxnet: Object.assign({ localAddress: '21:1/121' }, autoAreas),
                    },
                    areas: {
                        fsx_gen: {
                            network: 'fsxnet',
                            tag: 'FSX_GEN',
                            uplinks: ['21:1/100'],
                        },
                    },
                },
            },
        };

        fs.writeFileSync(
            paths.join(tempDir, 'config.hjson'),
            hjson.stringify(config, { emitRootBraces: true, space: 4, eol: '\n' }),
            'utf8'
        );
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-autoarea-e2e-'));
        ['in', 'secin', 'out'].forEach(d => fs.mkdirSync(paths.join(tempDir, d)));
        fs.writeFileSync(
            paths.join(tempDir, autoAreaCreate.GeneratedIncludeFileName),
            '{}\n',
            'utf8'
        );
    });

    afterEach(() => {
        delete require.cache[FTN_BSO_PATH];
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function loadConfig() {
        return new Promise((resolve, reject) =>
            configModule.Config.create(
                paths.join(tempDir, 'config.hjson'),
                { hotReload: false },
                err => (err ? reject(err) : resolve())
            )
        );
    }

    it('creates areas for unknown tags found in inbound mail, and they resolve', async () => {
        writeConfigHjson({
            autoAreas: {
                confTag: 'fsxnet',
                maxAutoCreate: 10,
                onDemand: { enabled: true },
            },
        });
        await loadConfig();

        await writePacket('e2e00001.pkt', makeHeader(), [
            makeEchoMessage('FSX_GEN', 'already configured'),
            makeEchoMessage('FSX_BBS', 'unknown'),
            makeEchoMessage('FSX_MYS', 'unknown too'),
        ]);

        const inst = makeModule();
        await new Promise(resolve => inst.maybeAutoCreateAreas(resolve));

        //  ...the areas now resolve, which is what lets pass 2 import the mail
        const { getMessageAreaByTag } = require('../core/message_area.js');
        assert.ok(getMessageAreaByTag('fsx_bbs'), 'fsx_bbs should now exist');
        assert.ok(getMessageAreaByTag('fsx_mys'), 'fsx_mys should now exist');

        //  ...and the tosser can map the FTN tag to them
        assert.equal(inst.getLocalAreaTagByFtnAreaTag('FSX_BBS'), 'fsx_bbs');

        //  read-only, both halves
        const ftnArea = configModule.get().messageNetworks.ftn.areas.fsx_bbs;
        assert.equal(ftnArea.uplinks, undefined);
        assert.equal(getMessageAreaByTag('fsx_bbs').acs.write, autoAreaCreate.DenyAllAcs);

        //  the packet is still there for pass 2
        assert.ok(fs.existsSync(paths.join(tempDir, 'in', 'e2e00001.pkt')));
    });

    it('does nothing when the generated include is not wired into config.hjson', async () => {
        writeConfigHjson({
            autoAreas: {
                confTag: 'fsxnet',
                onDemand: { enabled: true },
            },
        });
        //  drop the include entry, keeping the file
        const configPath = paths.join(tempDir, 'config.hjson');
        const parsed = hjson.parse(fs.readFileSync(configPath, 'utf8'));
        parsed.includes = [];
        fs.writeFileSync(
            configPath,
            hjson.stringify(parsed, { emitRootBraces: true, space: 4, eol: '\n' }),
            'utf8'
        );
        await loadConfig();

        await writePacket('e2e00002.pkt', makeHeader(), [
            makeEchoMessage('FSX_BBS', 'unknown'),
        ]);

        const inst = makeModule();
        await new Promise(resolve => inst.maybeAutoCreateAreas(resolve));

        const { getMessageAreaByTag } = require('../core/message_area.js');
        assert.equal(getMessageAreaByTag('fsx_bbs'), undefined);
    });

    it('honours the ignore list against real inbound mail', async () => {
        writeConfigHjson({
            autoAreas: {
                confTag: 'fsxnet',
                ignore: ['FSX_BOT'],
                onDemand: { enabled: true },
            },
        });
        await loadConfig();

        await writePacket('e2e00003.pkt', makeHeader(), [
            makeEchoMessage('FSX_BOT', 'noisy robot echo'),
            makeEchoMessage('FSX_BBS', 'wanted'),
        ]);

        const inst = makeModule();
        await new Promise(resolve => inst.maybeAutoCreateAreas(resolve));

        const { getMessageAreaByTag } = require('../core/message_area.js');
        assert.ok(getMessageAreaByTag('fsx_bbs'));
        assert.equal(getMessageAreaByTag('fsx_bot'), undefined);
    });

    it('mail that would have been skipped is routed to the new area on pass 2', async () => {
        //
        //  The whole point of the feature. Before pass 1, a message for an
        //  unconfigured tag hits the unknown-area branch of the import, is
        //  counted as skipped, and -- because the packet is unlinked straight
        //  afterwards -- is gone. After pass 1 the same packet routes.
        //
        writeConfigHjson({
            autoAreas: {
                confTag: 'fsxnet',
                maxAutoCreate: 10,
                onDemand: { enabled: true },
            },
        });
        await loadConfig();

        const packetPath = await writePacket('e2e00004.pkt', makeHeader(), [
            makeEchoMessage('FSX_GEN', 'known area'),
            makeEchoMessage('FSX_BBS', 'unknown area'),
        ]);

        const inst = makeModule();

        //  Stub only the DB-backed leaf so the real toss path runs
        const routed = [];
        inst.importMailToArea = (importConfig, header, message, cb) => {
            routed.push({ areaTag: importConfig.localAreaTag, subject: message.subject });
            return cb(null);
        };

        const toss = () =>
            new Promise(resolve =>
                inst.importMessagesFromPacketFile(packetPath, '', resolve)
            );

        await toss();
        assert.deepEqual(
            routed.map(r => r.subject),
            ['known area'],
            'the unknown-area message should be skipped before the areas exist'
        );

        routed.length = 0;
        await new Promise(resolve => inst.maybeAutoCreateAreas(resolve));
        await toss();

        assert.deepEqual(routed.map(r => `${r.subject} -> ${r.areaTag}`).sort(), [
            'known area -> fsx_gen',
            'unknown area -> fsx_bbs',
        ]);
    });
});
