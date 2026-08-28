'use strict';

//
//  Automatic area creation driven the way a real board drives it.
//
//  Everything else in the suite stubs the leaves: importMailToArea is replaced,
//  the archiver is faked, the message database never appears. That leaves the
//  claim that matters unproven -- that mail which used to be dropped ends up in
//  a real message base -- so this exercises the whole path for real:
//
//      a real config.hjson with a real `includes`
//      real sqlite databases created under a temp directory
//      real .pkt files written by the real packet writer
//      the real performImport() / performExport()
//      a real .zip opened by whatever archiver is configured
//
//  What it cannot cover is the network itself: no BinkP, and no actual uplink.
//  The AreaFix reply below is a NetMail we hand to ourselves, so it proves the
//  plumbing and the correlation, not that a given tosser words its replies the
//  way we expect.
//
//  It runs in its own mocha process (`npm run test:live`, which `npm test`
//  chains) because initializeDatabases() replaces the handles in
//  core/database.js, and fourteen modules capture one of those at load time.
//  Sharing a process with the unit suite would hand some of them a database
//  belonging to a different test.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const hjson = require('hjson');
const { execFileSync } = require('child_process');

const configModule = require('../../core/config.js');
const dbModule = require('../../core/database.js');
const autoAreaCreate = require('../../core/auto_area_create.js');

const FTN_BSO_PATH = require.resolve('../../core/scanner_tossers/ftn_bso.js');
const FIXTURES = paths.join(__dirname, '..', 'fixtures', 'area_lists');

const LOCAL = '21:1/121';
const UPLINK = '21:1/100';

let tempDir;
let inst;
let savedGet;
let savedReload;
let savedDbs;

function haveZip() {
    try {
        execFileSync('zip', ['-h'], { stdio: 'ignore' });
        execFileSync('unzip', ['-h'], { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

function writeConfig() {
    const config = {
        includes: [autoAreaCreate.GeneratedIncludeFileName],
        general: { boardName: 'Integration' },
        users: { usernameMin: 2, usernameMax: 16, requireActivation: false },
        paths: {
            db: paths.join(tempDir, 'db'),
            modsDb: paths.join(tempDir, 'db', 'mods'),
            logs: paths.join(tempDir, 'logs'),
        },
        fileBase: {
            areaStoragePrefix: paths.join(tempDir, 'filebase'),
            storageTags: { fsxnet_info: 'fsxnet_info' },
            areas: {
                fsxnet_info: {
                    name: 'fsxNet Info',
                    desc: 'fsxNet info packs',
                    storageTags: ['fsxnet_info'],
                },
            },
        },
        messageConferences: {
            fsxnet: { name: 'fsxNet', desc: 'fsxNet', areas: {} },
        },
        messageNetworks: {
            ftn: {
                networks: {
                    fsxnet: {
                        localAddress: LOCAL,
                        autoAreas: {
                            confTag: 'fsxnet',
                            maxAutoCreate: 50,
                            infoPack: {
                                enabled: true,
                                areaTag: 'fsxnet_info',
                                match: 'fsxnet*.zip',
                                areaFile: 'fsxnet.na',
                            },
                            onDemand: {
                                enabled: true,
                                rescan: true,
                                rescanUplink: UPLINK,
                                rescanPassword: 'RIGPASS',
                                rescanDays: 30,
                                rescanCommand: '=%TAG% R=%DAYS%',
                            },
                        },
                    },
                },
                //  FSX_GEN is configured; FSX_BBS and FSX_MYS are not
                areas: {
                    fsx_gen: { network: 'fsxnet', tag: 'FSX_GEN', uplinks: [UPLINK] },
                },
            },
        },
        scannerTossers: {
            ftn_bso: {
                defaultNetwork: 'fsxnet',
                nodes: { [UPLINK]: { archiveType: 'ZIP', encoding: 'utf8' } },
                netMail: {
                    routes: { '21:*': { address: UPLINK, network: 'fsxnet' } },
                },
                paths: {
                    inbound: paths.join(tempDir, 'in'),
                    secInbound: paths.join(tempDir, 'secin'),
                    outbound: paths.join(tempDir, 'out'),
                    reject: paths.join(tempDir, 'reject'),
                },
            },
        },
    };

    fs.writeFileSync(
        paths.join(tempDir, 'config', 'config.hjson'),
        hjson.stringify(config, { emitRootBraces: true, space: 4, eol: '\n' }),
        'utf8'
    );
    fs.writeFileSync(
        paths.join(tempDir, 'config', autoAreaCreate.GeneratedIncludeFileName),
        '{}\n',
        'utf8'
    );
}

function makeHeader() {
    const { PacketHeader } = require('../../core/ftn_mail_packet.js');
    const ph = new PacketHeader();
    ph.origZone = 21;
    ph.origNet = 1;
    ph.origNode = 100;
    ph.destZone = 21;
    ph.destNet = 1;
    ph.destNode = 121;
    return ph;
}

let msgIdSeq = 0;
function echoMessage(ftnAreaTag, subject) {
    const Message = require('../../core/message.js');
    const m = new Message({
        toUserName: 'All',
        fromUserName: 'Someone',
        subject,
        message: 'body',
        areaTag: 'placeholder',
    });
    m.meta.FtnProperty = Object.assign({}, m.meta.FtnProperty, {
        ftn_area: ftnAreaTag,
    });
    m.meta.FtnKludge = { MSGID: `${UPLINK} ${(++msgIdSeq).toString(16)}` };
    return m;
}

function writePacket(name, messages) {
    const { Packet } = require('../../core/ftn_mail_packet.js');
    const packetPath = paths.join(tempDir, 'in', name);
    return new Promise((resolve, reject) => {
        new Packet().write(packetPath, makeHeader(), messages, {}, err => {
            if (err) {
                return reject(err);
            }
            setTimeout(() => resolve(packetPath), 60);
        });
    });
}

const runImport = () => new Promise(resolve => inst.performImport(resolve));
const runExport = () => new Promise(resolve => inst.performExport(resolve));

function messageRows() {
    return dbModule.dbs.message
        .prepare(
            'SELECT area_tag, subject, from_user_name FROM message ORDER BY message_id;'
        )
        .all();
}

describe('FTN automatic area creation against real databases', function () {
    this.timeout(30000);

    before(done => {
        savedGet = configModule.get;
        savedReload = configModule.reload;
        //  initializeDatabases() mutates the shared dbs object; other suites
        //  inject their own handles into it, so put back what we found.
        savedDbs = Object.assign({}, dbModule.dbs);

        tempDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-ftn-live-'));
        ['config', 'db', 'logs', 'in', 'secin', 'out', 'reject', 'filebase'].forEach(d =>
            fs.mkdirSync(paths.join(tempDir, d), { recursive: true })
        );
        writeConfig();

        configModule.Config.create(
            paths.join(tempDir, 'config', 'config.hjson'),
            { hotReload: false },
            err => {
                if (err) {
                    return done(err);
                }
                dbModule.initializeDatabases(dbErr => {
                    if (dbErr) {
                        return done(dbErr);
                    }

                    //  a sysop for notifications and NetMail delivery to land on
                    const User = require('../../core/user.js');
                    const user = new User();
                    user.username = 'integop';
                    user.create({ password: 'integration' }, userErr => {
                        if (userErr) {
                            return done(userErr);
                        }

                        delete require.cache[FTN_BSO_PATH];
                        inst =
                            new (require('../../core/scanner_tossers/ftn_bso.js').getModule)();
                        inst.createTempDirectories(done);
                    });
                });
            }
        );
    });

    after(() => {
        configModule.get = savedGet;
        configModule.reload = savedReload;
        Object.keys(dbModule.dbs).forEach(k => delete dbModule.dbs[k]);
        Object.assign(dbModule.dbs, savedDbs);
        delete require.cache[FTN_BSO_PATH];
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // ─────────────────────────────────────────────────────────────────────────

    it('imports mail for unknown areas that would previously have been lost', async () => {
        await writePacket('live0001.pkt', [
            echoMessage('FSX_GEN', 'known area message'),
            echoMessage('FSX_BBS', 'unknown area message'),
            echoMessage('FSX_MYS', 'another unknown'),
        ]);

        assert.ifError(await runImport());

        const subjects = messageRows()
            .filter(r => r.area_tag.startsWith('fsx_'))
            .map(r => `${r.area_tag}|${r.subject}`)
            .sort();

        assert.deepEqual(subjects, [
            'fsx_bbs|unknown area message',
            'fsx_gen|known area message',
            'fsx_mys|another unknown',
        ]);

        //  the packet was consumed, as it always is
        assert.deepEqual(fs.readdirSync(paths.join(tempDir, 'in')), []);
    });

    it('created them read-only', () => {
        const config = configModule.get();
        const area = config.messageConferences.fsxnet.areas.fsx_bbs;

        assert.equal(area.acs.write, autoAreaCreate.DenyAllAcs);
        assert.equal(config.messageNetworks.ftn.areas.fsx_bbs.uplinks, undefined);
        assert.equal(
            inst.isAreaConfigValid(
                Object.assign({}, config.messageNetworks.ftn.areas.fsx_bbs)
            ),
            false
        );
    });

    it('told the operator once, listing what it made', () => {
        const notices = messageRows().filter(
            r => 'private_mail' === r.area_tag && /automatically created/.test(r.subject)
        );
        assert.equal(notices.length, 1);
        assert.match(notices[0].subject, /^2 message area\(s\)/);
    });

    it('spooled a well-formed AreaFix request that reads back correctly', async () => {
        assert.ifError(await runExport());

        const walk = dir =>
            fs
                .readdirSync(dir, { withFileTypes: true })
                .flatMap(d =>
                    d.isDirectory()
                        ? walk(paths.join(dir, d.name))
                        : [paths.join(dir, d.name)]
                );

        const packets = walk(paths.join(tempDir, 'out')).filter(f =>
            /\.(pkt|out|cut|hut|dut|iut)$/i.test(f)
        );
        assert.equal(packets.length, 1, 'expected exactly one outbound packet');

        //  read it back with our own reader rather than trusting the writer
        const { Packet } = require('../../core/ftn_mail_packet.js');
        const seen = [];
        await new Promise((resolve, reject) => {
            new Packet({ keepTearAndOrigin: false }).read(
                packets[0],
                (type, data, next) => {
                    seen.push({ type, data });
                    return next(null);
                },
                err => (err ? reject(err) : resolve())
            );
        });

        const header = seen.find(s => 'header' === s.type).data;
        assert.equal(header.destNode, 100);
        assert.equal(header.origNode, 121);

        const message = seen.find(s => 'message' === s.type).data;
        assert.equal(message.toUserName, 'AreaFix');
        assert.equal(message.subject, 'RIGPASS'); //  AreaFix password
        assert.match(message.message, /=FSX_BBS R=30/);
        assert.match(message.message, /=FSX_MYS R=30/);
    });

    it('recorded the request so a reply can be correlated to it', () => {
        const pending = inst.getPendingAreaFixRequests();
        assert.deepEqual(Object.keys(pending), [UPLINK]);
        assert.deepEqual(Object.keys(pending[UPLINK].tags).sort(), [
            'FSX_BBS',
            'FSX_MYS',
        ]);
    });

    it('parses an uplink AreaFix reply arriving as ordinary inbound NetMail', async () => {
        const { Packet } = require('../../core/ftn_mail_packet.js');
        const Message = require('../../core/message.js');

        const reply = new Message({
            toUserName: 'integop',
            fromUserName: 'AreaFix',
            subject: 'Areafix reply: node change request',
            message: [
                ' FSX_BBS ........................... added',
                ' FSX_MYS ........................... not found',
                '',
                'Your linked areas:',
                //  an area we never asked about, which must be ignored
                ' SOME_OTHER ........................ General chatter',
            ].join('\r\n'),
            areaTag: 'placeholder',
        });
        reply.meta.FtnProperty = Object.assign({}, reply.meta.FtnProperty, {
            ftn_attr_flags: Packet.Attribute.Private,
            ftn_orig_node: 100,
            ftn_orig_network: 1,
            ftn_dest_node: 121,
            ftn_dest_network: 1,
        });
        reply.meta.FtnKludge = {
            INTL: `${LOCAL} ${UPLINK}`,
            MSGID: `${UPLINK} ${(++msgIdSeq).toString(16)}`,
        };

        await writePacket('live0002.pkt', [reply]);
        assert.ifError(await runImport());

        //  answered, so no longer pending
        assert.deepEqual(inst.getPendingAreaFixRequests(), {});

        const notice = messageRows().find(r => /AreaFix reply from/.test(r.subject));
        assert.ok(notice, 'operator should have been told');

        const body = dbModule.dbs.message
            .prepare('SELECT message FROM message WHERE subject = ?;')
            .get(notice.subject).message;

        assert.match(body, /FSX_BBS: added/);
        assert.match(body, /FSX_MYS: not_found/);
        //  the %LIST entry for an area we never mentioned must not appear
        assert.equal(/SOME_OTHER/.test(body), false);
    });

    // ─────────────────────────────────────────────────────────────────────────

    (haveZip() ? it : it.skip)(
        'takes real descriptions from a real .zip info pack',
        async () => {
            const FileEntry = require('../../core/file_entry.js');

            const stage = paths.join(tempDir, 'packstage');
            const store = paths.join(tempDir, 'filebase', 'fsxnet_info');
            fs.mkdirSync(stage, { recursive: true });
            fs.mkdirSync(store, { recursive: true });

            //  the real fsxNet message list, plus the decoys the pack ships:
            //  a FILEBONE file list with the same extension, and binaries
            fs.copyFileSync(
                paths.join(FIXTURES, 'fsxnet-2025.na'),
                paths.join(stage, 'fsxnet.na')
            );
            fs.copyFileSync(
                paths.join(FIXTURES, 'fsxnet-file-2025.na'),
                paths.join(stage, 'fsx_file.na')
            );
            fs.writeFileSync(paths.join(stage, 'nodelist.z21'), 'binary junk');
            fs.writeFileSync(paths.join(stage, 'readme.txt'), 'read me');

            const zipPath = paths.join(store, 'fsxnet.zip');
            execFileSync('zip', [
                '-j',
                '-q',
                zipPath,
                paths.join(stage, 'fsxnet.na'),
                paths.join(stage, 'fsx_file.na'),
                paths.join(stage, 'nodelist.z21'),
                paths.join(stage, 'readme.txt'),
            ]);

            const entry = new FileEntry({
                areaTag: 'fsxnet_info',
                fileName: 'fsxnet.zip',
                storageTag: 'fsxnet_info',
                desc: 'fsxNet info pack',
            });
            await new Promise((resolve, reject) =>
                entry.persist(err => (err ? reject(err) : resolve()))
            );

            assert.ifError(await runImport());

            //  placeholders replaced with what fsxNet actually calls these
            const areas = configModule.get().messageConferences.fsxnet.areas;
            assert.equal(areas.fsx_bbs.name, 'BBS Support/Dev');
            assert.equal(areas.fsx_bbs.desc, 'BBS Support/Dev');
            assert.equal(areas.fsx_mys.desc, 'Mystic BBS Support/Dev');

            //  ...and enrichment did not drop the write deny
            assert.equal(areas.fsx_bbs.acs.write, autoAreaCreate.DenyAllAcs);

            //  we are not linked to the rest of the pack, so nothing else was made
            assert.deepEqual(Object.keys(areas).sort(), ['fsx_bbs', 'fsx_mys']);
        }
    );

    (haveZip() ? it : it.skip)('does not re-ingest an unchanged pack', async () => {
        const before = fs.statSync(
            paths.join(tempDir, 'config', autoAreaCreate.GeneratedIncludeFileName)
        ).mtimeMs;

        assert.ifError(await runImport());

        assert.equal(
            fs.statSync(
                paths.join(tempDir, 'config', autoAreaCreate.GeneratedIncludeFileName)
            ).mtimeMs,
            before,
            'an unchanged pack should not rewrite anything'
        );
    });
});
