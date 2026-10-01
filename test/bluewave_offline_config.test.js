'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const iconv = require('iconv-lite');
const moment = require('moment');

const configModule = require('../core/config.js');
const StatLog = require('../core/stat_log.js');
const { WellKnownConfTags } = require('../core/message_const.js');
const {
    BlueWavePacketReader,
    BlueWavePacketWriter,
    RecordLength,
    ReplyRecordLength,
    parseOlc,
    parsePdq,
} = require('../core/bluewave_mail_packet.js');
//
//  The importer is required in before(), not here. message_db.test.js drops
//  core/message.js from the require cache while mocha loads the files, so a
//  module loaded from this file -- which loads early -- would hold a
//  different Message from the one offline_mail_import.test.js stubs.
//
let importer;
let BlueWave;
let planAreaChanges;

//
//  A reader's offline configuration, as the readers that write one write it.
//  The *.OLC layout is not in the structure kit; this is bluemail's
//  putConfig() byte for byte (bluemail/driver/bwave.cc), which MultiMail
//  matches. The *.PDQ layout is the kit's PDQ_HEADER and PDQ_REC.
//
const olc = ({ areaChanges = 'ON', areas = [], eol = '\r\n' } = {}) => {
    let text = `[Global Mail Host Configuration]${eol}`;
    if (null !== areaChanges) {
        text += `AreaChanges = ${areaChanges}${eol}`;
    }
    text += eol;
    areas.forEach(area => {
        const [echoTag, scan] = Array.isArray(area) ? area : [area, 'ALL'];
        text += `[${echoTag}]${eol}Scan = ${scan}${eol}${eol}`;
    });
    return Buffer.from(text, 'ascii');
};

//  hand-written rather than taken from the module under test
const Pdq = { HeaderLen: 678, Flags: 676, RecLen: 21, AreaChanges: 0x0004 };

const pdq = ({ areaChanges = true, areas = [] } = {}) => {
    const header = Buffer.alloc(Pdq.HeaderLen);
    //  hot keys and expert mode on too, as a reader copies the INF's uflags
    header.writeUInt16LE(0x0003 | (areaChanges ? Pdq.AreaChanges : 0), Pdq.Flags);
    const recs = areas.map(echoTag => {
        const rec = Buffer.alloc(Pdq.RecLen);
        rec.write(echoTag, 0, 'ascii');
        return rec;
    });
    return Buffer.concat([header, ...recs]);
};

//  a *.UPL with no replies in it: what bluemail and MultiMail upload when the
//  caller changed areas and wrote nothing
const uplHeader = loginName => {
    const header = Buffer.alloc(ReplyRecordLength.UplHeader);
    header.writeUInt16LE(ReplyRecordLength.UplHeader, 112);
    header.writeUInt16LE(ReplyRecordLength.UplRec, 114);
    header.write(loginName, 116, 'ascii');
    return header;
};

const makePacketDir = members => {
    const dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-bwolc-test-'));
    Object.keys(members).forEach(name =>
        fs.writeFileSync(paths.join(dir, name), members[name])
    );
    return dir;
};

//
//  The board: four areas the caller can read, one they cannot, and private
//  mail. Read through message_area.js, which reads config lazily, so a
//  pushed config reaches it.
//
const TestConfig = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test Board' },
    messageNetworks: {},
    messageConferences: {
        [WellKnownConfTags.SystemInternal]: {
            name: 'System Internal',
            areas: { private_mail: { name: 'Private Mail' } },
        },
        local: {
            name: 'Local',
            areas: {
                general: { name: 'General Chat' },
                fido_general: { name: 'FidoNet General' },
                fido_tech: { name: 'FidoNet Tech' },
                fido_quiet: { name: 'FidoNet Quiet' },
                secret: { name: 'Sysops Only', secret: true },
            },
        },
    },
};

const Then = '2026-09-01T00:00:00.000Z';
const Now = '2026-10-01T12:00:00.000Z';

const makeClient = ({ stored, loginName = 'anne' } = {}) => {
    const persisted = [];
    const properties = {};
    if (stored) {
        properties.bluewave_export_msg_areas = JSON.stringify(stored);
    }

    const log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(
        level => (log[level] = () => {})
    );

    return {
        persisted,
        log,
        acs: {
            hasMessageConfRead: () => true,
            hasMessageAreaRead: area => !area.secret,
        },
        user: {
            username: loginName,
            realName: () => 'Anne Onymous',
            getProperty: name => properties[name],
            persistProperty: (name, value, cb) => {
                persisted.push({ name, value: JSON.parse(value) });
                properties[name] = value;
                return cb(null);
            },
        },
    };
};

//  the importer's own read-and-apply path, over a real unpacked packet
const importPacket = (client, members, cb) => {
    const context = Object.create(importer);
    Object.assign(context, {
        client,
        limits: { maxMessages: 500, maxMessageLength: 64 * 1024 },
        summary: { imported: 0, rejected: 0, byArea: {}, areaChanges: null },
        _updateStatus: () => {},
    });

    const packetDir = makePacketDir(members);
    context._readAndPersist(BlueWave, { packetDir, limits: context.limits }, err => {
        fs.rmSync(packetDir, { recursive: true, force: true });
        return cb(err, context);
    });
};

const tagsOf = exportAreas => exportAreas.map(a => a.areaTag);

describe('Blue Wave offline configuration', () => {
    let previousConfig;
    before(() => {
        previousConfig = configModule._pushTestConfig(TestConfig);

        const ImportModule = require('../core/message_base_offline_import.js');
        importer = ImportModule.getModule.prototype;
        BlueWave = ImportModule.PacketFormats.find(f => 'Blue Wave' === f.name);
        planAreaChanges = ImportModule.planAreaChanges;
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    describe('reading a *.OLC', () => {
        it('reads what bluemail writes', () => {
            const config = parseOlc(olc({ areas: ['FIDO_GENERAL', 'GENERAL'] }));
            assert.equal(config.areaChanges, true);
            assert.deepEqual(config.areas, [
                { echoTag: 'FIDO_GENERAL', scan: 'ALL' },
                { echoTag: 'GENERAL', scan: 'ALL' },
            ]);
        });

        it('does not take the global section for an area', () => {
            const config = parseOlc(olc({ areas: [] }));
            assert.equal(config.areaChanges, true);
            assert.deepEqual(config.areas, []);
        });

        it('reads LF line endings the same as CRLF', () => {
            const crlf = parseOlc(olc({ areas: ['GENERAL', 'FIDO_TECH'] }));
            const lf = parseOlc(olc({ areas: ['GENERAL', 'FIDO_TECH'], eol: '\n' }));
            assert.deepEqual(lf, crlf);
        });

        it('takes YES, ON and TRUE in any case, and nothing else', () => {
            ['YES', 'on', 'True'].forEach(value =>
                assert.equal(parseOlc(olc({ areaChanges: value })).areaChanges, true)
            );
            ['OFF', 'NO', 'FALSE', '1'].forEach(value =>
                assert.equal(parseOlc(olc({ areaChanges: value })).areaChanges, false)
            );
        });

        it('treats a missing AreaChanges as off', () => {
            assert.equal(parseOlc(olc({ areaChanges: null })).areaChanges, false);
        });

        //  Wolverine writes its settings with no spaces around the '='
        it('does not need spaces around the equals sign', () => {
            const config = parseOlc(
                Buffer.from(
                    '[Global Mail Host Configuration]\r\nAreaChanges=ON\r\n\r\n[GENERAL]\r\nScan=ALL\r\n'
                )
            );
            assert.equal(config.areaChanges, true);
            assert.deepEqual(config.areas, [{ echoTag: 'GENERAL', scan: 'ALL' }]);
        });

        //  MultiMail and Wolverine both write the other modes
        it('keeps the Scan value an area was given', () => {
            const config = parseOlc(
                olc({
                    areas: [
                        ['FIDO_TECH', 'PERSONLY'],
                        ['GENERAL', 'PERS+ALL'],
                    ],
                })
            );
            assert.deepEqual(
                config.areas.map(a => a.scan),
                ['PERSONLY', 'PERS+ALL']
            );
        });

        //  only the global section turns the list on
        it('ignores an AreaChanges inside an area section', () => {
            const config = parseOlc(
                Buffer.from(
                    '[Global Mail Host Configuration]\r\nAreaChanges = OFF\r\n\r\n[GENERAL]\r\nAreaChanges = ON\r\n'
                )
            );
            assert.equal(config.areaChanges, false);
        });

        it('lists an area named twice once', () => {
            const config = parseOlc(olc({ areas: ['GENERAL', 'general'] }));
            assert.equal(config.areas.length, 1);
        });
    });

    describe('reading a *.PDQ', () => {
        it('reads the area change flag and the echotags', () => {
            const config = parsePdq(pdq({ areas: ['FIDO_TECH', 'GENERAL'] }));
            assert.equal(config.areaChanges, true);
            assert.deepEqual(
                config.areas.map(a => a.echoTag),
                ['FIDO_TECH', 'GENERAL']
            );
        });

        it('reads the flag as off when it is not set', () => {
            const config = parsePdq(pdq({ areaChanges: false, areas: ['GENERAL'] }));
            assert.equal(config.areaChanges, false);
        });

        it('reports a header too short to hold the flags', () => {
            const config = parsePdq(Buffer.alloc(Pdq.HeaderLen - 1));
            assert.equal(config.areaChanges, false);
            assert.match(config.error, /truncated/i);
        });
    });

    describe('picking which file to read', () => {
        const readConfig = (members, cb) => {
            const dir = makePacketDir(
                Object.assign({ 'ENIGMA.UPL': uplHeader('anne') }, members)
            );
            let config = null;
            const reader = new BlueWavePacketReader(null, {
                areaTagForEchoTag: () => 'general',
            });
            reader.on('offline config', c => (config = c));
            reader.readExtracted(dir, err => {
                fs.rmSync(dir, { recursive: true, force: true });
                assert.equal(err, null);
                cb(config);
            });
        };

        //  bluemail writes both; the kit says the *.PDQ is read only
        //  without a *.OLC
        it('reads the *.OLC when a reader wrote both', done => {
            readConfig(
                {
                    'ENIGMA.OLC': olc({ areas: ['FIDO_TECH'] }),
                    'ENIGMA.PDQ': pdq({ areas: ['FIDO_GENERAL'] }),
                },
                config => {
                    assert.equal(config.format, 'OLC');
                    assert.deepEqual(
                        config.areas.map(a => a.echoTag),
                        ['FIDO_TECH']
                    );
                    done();
                }
            );
        });

        it('reads the *.PDQ when there is no *.OLC', done => {
            readConfig({ 'ENIGMA.PDQ': pdq({ areas: ['FIDO_GENERAL'] }) }, config => {
                assert.equal(config.format, 'PDQ');
                assert.deepEqual(
                    config.areas.map(a => a.echoTag),
                    ['FIDO_GENERAL']
                );
                done();
            });
        });

        //  DOS names: what a reader wrote may reach us in either case
        it('finds a lower case member', done => {
            readConfig({ 'enigma.olc': olc({ areas: ['GENERAL'] }) }, config => {
                assert.equal(config.format, 'OLC');
                done();
            });
        });

        it('reports nothing when there is neither', done => {
            readConfig({}, config => {
                assert.equal(config, null);
                done();
            });
        });
    });

    //
    //  The list replaces the caller's selection. A diff would pass every test
    //  in which the caller only adds areas, so most of these drop one.
    //
    describe('applying it', () => {
        const stored = [
            { areaTag: 'general', newerThanTimestamp: Then },
            { areaTag: 'fido_general', newerThanTimestamp: Then },
            { areaTag: 'private_mail', newerThanTimestamp: Then },
        ];

        it('turns off what the list leaves out and on what it adds', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({
                        areas: ['GENERAL', 'FIDO_TECH', 'PRIVATE_MAIL'],
                    }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.equal(client.persisted.length, 1);
                    assert.equal(client.persisted[0].name, 'bluewave_export_msg_areas');
                    assert.deepEqual(tagsOf(client.persisted[0].value).sort(), [
                        'fido_tech',
                        'general',
                        'private_mail',
                    ]);

                    const changes = context.summary.areaChanges;
                    assert.deepEqual(changes.removed, ['FIDO_GENERAL']);
                    assert.deepEqual(changes.added, ['FIDO_TECH']);
                    assert.deepEqual(changes.refused, []);
                    done();
                }
            );
        });

        //
        //  An area that stays on must not have its starting point reset, or
        //  every area the caller kept would re-send what they already have
        //  -- or skip what they have not yet had.
        //
        it('keeps where a kept area starts and starts an added one from now', done => {
            const client = makeClient({ stored });
            //  whole seconds: the stored timestamp may not carry milliseconds
            const startedAt = moment().startOf('second');
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areas: ['GENERAL', 'FIDO_TECH'] }),
                },
                err => {
                    assert.ifError(err);
                    const byTag = {};
                    client.persisted[0].value.forEach(a => (byTag[a.areaTag] = a));

                    assert.ok(moment(byTag.general.newerThanTimestamp).isSame(Then));

                    //  checked as stored: moment(undefined) is also "now", and
                    //  no timestamp at all means the whole history
                    const stamp = byTag.fido_tech.newerThanTimestamp;
                    assert.ok(
                        stamp,
                        'an added area starts from the upload, not the beginning'
                    );
                    const added = moment(stamp);
                    assert.ok(added.isValid());
                    assert.ok(!added.isBefore(startedAt) && !added.isAfter(moment()));
                    done();
                }
            );
        });

        it('changes nothing when AreaChanges is off', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areaChanges: 'OFF', areas: ['FIDO_TECH'] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.equal(client.persisted.length, 0);
                    assert.equal(context.summary.areaChanges, null);
                    done();
                }
            );
        });

        it('changes nothing when AreaChanges is absent', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areaChanges: null, areas: ['FIDO_TECH'] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.equal(client.persisted.length, 0);
                    assert.equal(context.summary.areaChanges, null);
                    done();
                }
            );
        });

        it('refuses and reports an area the caller cannot see', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areas: ['GENERAL', 'SECRET', 'NO_SUCH_AREA'] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.deepEqual(tagsOf(client.persisted[0].value), ['general']);
                    assert.deepEqual(context.summary.areaChanges.refused, [
                        'SECRET',
                        'NO_SUCH_AREA',
                    ]);
                    done();
                }
            );
        });

        //
        //  The kit's reading of an empty list is "turn everything off". Here
        //  that would end the caller's packets for good: an export with no
        //  messages delivers nothing, and nothing online edits the list.
        //
        it('does not apply a list that would leave no areas', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areas: [] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.equal(client.persisted.length, 0);
                    assert.equal(context.summary.areaChanges.emptied, true);
                    done();
                }
            );
        });

        //  Wolverine names areas by number, which nothing here resolves
        it('does not apply a list in which nothing resolves', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areas: ['1', '2', 'SECRET'] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.equal(client.persisted.length, 0);
                    assert.equal(context.summary.areaChanges.emptied, true);
                    assert.deepEqual(context.summary.areaChanges.refused, [
                        '1',
                        '2',
                        'SECRET',
                    ]);
                    done();
                }
            );
        });

        it('applies the *.OLC, not the *.PDQ, when both are present', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areas: ['FIDO_TECH'] }),
                    'ENIGMA.PDQ': pdq({ areas: ['FIDO_GENERAL'] }),
                },
                err => {
                    assert.ifError(err);
                    assert.deepEqual(tagsOf(client.persisted[0].value), ['fido_tech']);
                    done();
                }
            );
        });

        it('applies a *.PDQ on its own', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.PDQ': pdq({ areas: ['GENERAL', 'FIDO_QUIET'] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.deepEqual(tagsOf(client.persisted[0].value).sort(), [
                        'fido_quiet',
                        'general',
                    ]);
                    assert.deepEqual(context.summary.areaChanges.removed, [
                        'FIDO_GENERAL',
                        'PRIVATE_MAIL',
                    ]);
                    done();
                }
            );
        });

        //  somebody else's packet changes nobody's areas
        it('changes nothing from a packet built for somebody else', done => {
            const client = makeClient({ stored });
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('mallory'),
                    'ENIGMA.OLC': olc({ areas: ['FIDO_TECH'] }),
                },
                err => {
                    assert.ok(err);
                    assert.equal(client.persisted.length, 0);
                    done();
                }
            );
        });

        //
        //  A caller who has never chosen has every area they can see. Their
        //  first list is still a replacement of that, not an addition to
        //  nothing.
        //
        it('replaces the default selection of a caller who never chose', done => {
            const client = makeClient();
            importPacket(
                client,
                {
                    'ENIGMA.UPL': uplHeader('anne'),
                    'ENIGMA.OLC': olc({ areas: ['GENERAL'] }),
                },
                (err, context) => {
                    assert.ifError(err);
                    assert.deepEqual(tagsOf(client.persisted[0].value), ['general']);
                    assert.deepEqual(context.summary.areaChanges.removed, [
                        'FIDO_GENERAL',
                        'FIDO_TECH',
                        'FIDO_QUIET',
                        'PRIVATE_MAIL',
                    ]);
                    done();
                }
            );
        });
    });

    describe('planning the change', () => {
        const echoTagMap = new Map([
            ['GENERAL', 'general'],
            ['FIDO_TECH', 'fido_tech'],
        ]);

        //  it was not in their packet, so it could not have been named
        it('drops an area the caller can no longer see without reporting it', () => {
            const plan = planAreaChanges({
                current: [{ areaTag: 'general' }, { areaTag: 'gone_now' }],
                requested: [{ echoTag: 'GENERAL', scan: 'ALL' }],
                echoTagMap,
                now: Now,
            });
            assert.deepEqual(tagsOf(plan.exportAreas), ['general']);
            assert.deepEqual(plan.removed, []);
        });

        it('matches an echotag in any case', () => {
            const plan = planAreaChanges({
                current: [],
                requested: [{ echoTag: 'fido_tech', scan: 'ALL' }],
                echoTagMap,
                now: Now,
            });
            assert.deepEqual(tagsOf(plan.exportAreas), ['fido_tech']);
            assert.deepEqual(plan.refused, []);
        });

        it('says that personal-only is not honoured', () => {
            const plan = planAreaChanges({
                current: [],
                requested: [{ echoTag: 'FIDO_TECH', scan: 'PERSONLY' }],
                echoTagMap,
                now: Now,
            });
            assert.deepEqual(tagsOf(plan.exportAreas), ['fido_tech']);
            assert.equal(plan.notes.length, 1);
            assert.match(plan.notes[0], /FIDO_TECH.*personal-only/);
        });
    });

    //
    //  #882: the caller could see a count and nothing else, so could not tell
    //  a reply landed where they meant it to.
    //
    describe('the summary', () => {
        const summaryFor = (summary, packetError) => {
            const context = Object.create(importer);
            context.summary = Object.assign(
                { imported: 0, rejected: 0, byArea: {}, areaChanges: null },
                summary
            );
            context.packetError = packetError;
            return context._summaryLines();
        };

        it('says where each message went', () => {
            assert.deepEqual(
                summaryFor({
                    imported: 3,
                    byArea: { fido_general: 2, private_mail: 1 },
                }),
                ['Imported 3 message(s)', '  FidoNet General: 2', '  Private Mail: 1']
            );
        });

        it('follows the areas with what was not imported', () => {
            assert.deepEqual(
                summaryFor({ imported: 1, rejected: 2, byArea: { general: 1 } }),
                [
                    'Imported 1 message(s)',
                    '  General Chat: 1',
                    '2 not imported -- see the log',
                ]
            );
        });

        it('names an area the sysop has since removed by its tag', () => {
            assert.deepEqual(summaryFor({ imported: 1, byArea: { retired: 1 } }), [
                'Imported 1 message(s)',
                '  retired: 1',
            ]);
        });

        it('then says what the offline configuration changed', () => {
            const lines = summaryFor({
                imported: 1,
                byArea: { general: 1 },
                areaChanges: {
                    added: ['FIDO_TECH'],
                    removed: ['FIDO_GENERAL', 'PRIVATE_MAIL'],
                    refused: ['SECRET'],
                    notes: [],
                    emptied: false,
                },
            });
            assert.deepEqual(lines.slice(2), [
                'Added to packet: FIDO_TECH',
                'Removed from packet: FIDO_GENERAL, PRIVATE_MAIL',
                'Not available here: SECRET',
            ]);
        });

        it('says when a list was not applied', () => {
            const lines = summaryFor({
                areaChanges: {
                    added: [],
                    removed: [],
                    refused: ['1'],
                    notes: [],
                    emptied: true,
                },
            });
            assert.match(lines[1], /no areas would be left.*not applied/i);
            assert.equal(lines[2], 'Not available here: 1');
        });

        it('counts each message against its area as it is stored', done => {
            const context = Object.create(importer);
            Object.assign(context, {
                summary: { imported: 0, rejected: 0, byArea: {}, areaChanges: null },
                client: makeClient(),
                _updateStatus: () => {},
                _persistMessage: (message, cb) =>
                    cb('secret' === message.areaTag ? new Error('no') : null),
            });

            context._persistMessages(
                [
                    { areaTag: 'general' },
                    { areaTag: 'fido_tech' },
                    { areaTag: 'general' },
                    { areaTag: 'secret' },
                ],
                () => {
                    assert.deepEqual(context.summary.byArea, {
                        general: 2,
                        fido_tech: 1,
                    });
                    assert.equal(context.summary.rejected, 1);
                    done();
                }
            );
        });
    });

    //
    //  A reader can only turn on an area its packet listed. Listing just the
    //  selected areas would let a caller drop an area and never get it back.
    //
    describe('listing areas in the packet', () => {
        const AreaNum = 0;
        const EchoTag = 6;
        const Flags = 77;
        const Scanning = 0x0001;

        const str = (buf, offset, length) => {
            const slice = buf.slice(offset, offset + length);
            const end = slice.indexOf(0);
            return iconv.decode(slice.slice(0, -1 === end ? length : end), 'cp437');
        };

        const buildInf = (build, cb) => {
            const realInit = StatLog.init;
            StatLog.init = callback => callback(null);

            const writer = new BlueWavePacketWriter({
                bbsID: 'ENIGMA',
                systemName: 'Test Board',
                sysOpName: 'SysOp',
            });
            writer.once('ready', () => {
                build(writer);
                writer.writePacketFiles(err => {
                    StatLog.init = realInit;
                    assert.ifError(err);
                    const inf = fs.readFileSync(paths.join(writer.workDir, 'ENIGMA.INF'));
                    writer.temptmp.cleanup();

                    const areas = {};
                    const count =
                        (inf.length - RecordLength.InfHeader) / RecordLength.InfArea;
                    for (let i = 0; i < count; ++i) {
                        const rec = inf.slice(
                            RecordLength.InfHeader + i * RecordLength.InfArea
                        );
                        areas[str(rec, EchoTag, 21)] = {
                            number: str(rec, AreaNum, 6),
                            scanning: 0 !== (rec.readUInt16LE(Flags) & Scanning),
                        };
                    }
                    cb(areas);
                });
            });
            writer.init();
        };

        it('lists an area the caller has not selected, without INF_SCANNING', done => {
            buildInf(
                writer => {
                    writer.addArea('general', { scanning: true });
                    writer.addArea('fido_tech', { scanning: false });
                },
                areas => {
                    assert.equal(areas.GENERAL.scanning, true);
                    assert.equal(areas.FIDO_TECH.scanning, false);
                    done();
                }
            );
        });

        it('marks an area scanning once it is selected or carries mail', done => {
            buildInf(
                writer => {
                    writer.addArea('general', { scanning: false });
                    writer.addArea('general', { scanning: true });
                    writer.addArea('fido_tech', { scanning: false });
                    writer.appendMessage({
                        areaTag: 'fido_tech',
                        messageId: 7,
                        fromUserName: 'A',
                        toUserName: 'B',
                        subject: 'Listed late',
                        message: 'Body',
                        modTimestamp: new Date(2026, 8, 9),
                        isPrivate: () => false,
                    });
                },
                areas => {
                    assert.equal(areas.GENERAL.scanning, true);
                    assert.equal(areas.FIDO_TECH.scanning, true);
                    done();
                }
            );
        });
    });
});
