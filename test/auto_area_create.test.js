'use strict';

//
//  Automatic message area creation, end to end.
//
//  These tests drive the real ConfigLoader -- a temp config.hjson with a real
//  `includes` entry -- rather than a mocked config, because the whole design
//  rests on what the include merge actually does:
//
//      _.defaultsDeep(config, includedConfig)      config_loader.js
//
//  If that precedence were the other way around, a rewrite of the generated
//  file would silently overwrite an operator's own description. So it is
//  asserted here, against the repo's own lodash, rather than assumed.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const hjson = require('hjson');

const configModule = require('../core/config.js');
const autoAreaCreate = require('../core/auto_area_create.js');

const NETWORK = 'fsxnet';
const CONF_TAG = 'fsxnet';

let tempDir;
let savedGet;
let savedReload;

function writeBaseConfig(extra = {}) {
    const config = Object.assign(
        {
            includes: [autoAreaCreate.GeneratedIncludeFileName],
            messageConferences: {
                [CONF_TAG]: {
                    name: 'fsxNet',
                    desc: 'fsxNet Echos',
                    areas: {},
                },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        [NETWORK]: {
                            localAddress: '21:1/121',
                            autoAreas: {
                                confTag: CONF_TAG,
                                maxAutoCreate: 5,
                                ignore: [],
                                onDemand: { enabled: true },
                            },
                        },
                    },
                    areas: {},
                },
            },
        },
        extra
    );

    fs.writeFileSync(
        paths.join(tempDir, 'config.hjson'),
        hjson.stringify(config, { emitRootBraces: true, space: 4, eol: '\n' }),
        'utf8'
    );
}

function loadConfig(cb) {
    configModule.Config.create(
        paths.join(tempDir, 'config.hjson'),
        { hotReload: false },
        cb
    );
}

function readGeneratedSync() {
    return hjson.parse(
        fs.readFileSync(
            paths.join(tempDir, autoAreaCreate.GeneratedIncludeFileName),
            'utf8'
        )
    );
}

describe('auto_area_create', () => {
    before(() => {
        savedGet = configModule.get;
        savedReload = configModule.reload;
    });

    after(() => {
        //  Config.create() rebinds these module-level exports; put back what
        //  test/setup.js installed so later suites are unaffected.
        configModule.get = savedGet;
        configModule.reload = savedReload;
    });

    beforeEach(done => {
        tempDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-autoarea-'));
        //  the include must exist before it is referenced or the whole load fails
        fs.writeFileSync(
            paths.join(tempDir, autoAreaCreate.GeneratedIncludeFileName),
            '{}\n',
            'utf8'
        );
        writeBaseConfig();
        loadConfig(done);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // ─── Happy path ──────────────────────────────────────────────────────────

    it('creates areas and makes them resolvable after reload', done => {
        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN', 'FSX_BBS'], (err, result) => {
            assert.ifError(err);
            assert.deepEqual(result.created.map(c => c.areaTag).sort(), [
                'fsx_bbs',
                'fsx_gen',
            ]);
            assert.equal(result.rejected.length, 0);

            //  createAreas() reloads, so these must resolve through the merge
            const { getMessageAreaByTag } = require('../core/message_area.js');
            assert.ok(getMessageAreaByTag('fsx_gen'));
            assert.equal(getMessageAreaByTag('fsx_gen').confTag, CONF_TAG);

            const ftnArea = configModule.get().messageNetworks.ftn.areas.fsx_gen;
            assert.equal(ftnArea.network, NETWORK);
            assert.equal(ftnArea.tag, 'FSX_GEN');
            done();
        });
    });

    it('creates areas that do not export and cannot be posted into', done => {
        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
            assert.ifError(err);

            const config = configModule.get();
            const ftnArea = config.messageNetworks.ftn.areas.fsx_gen;

            //
            //  No uplinks: isAreaConfigValid() requires an array, and both
            //  export sites skip silently without one. Nothing goes out.
            //
            assert.equal(ftnArea.uplinks, undefined);

            const FtnBso = require('../core/scanner_tossers/ftn_bso.js');
            const inst = new FtnBso.getModule();
            assert.equal(inst.isAreaConfigValid(Object.assign({}, ftnArea)), false);

            //
            //  ...but "does not export" is not "read-only": a local user could
            //  still post into a black hole. The write-deny ACS is what closes
            //  that, so check it the way ACS itself would.
            //
            const area = config.messageConferences[CONF_TAG].areas.fsx_gen;
            assert.equal(area.acs.write, autoAreaCreate.DenyAllAcs);

            const ACS = require('../core/acs.js');
            const acs = new ACS({
                client: { user: { userId: 1, groups: ['users', 'sysops'] } },
                user: {
                    userId: 1,
                    groups: ['users', 'sysops'],
                    properties: {},
                    isRoot: () => true,
                },
            });
            assert.equal(acs.hasMessageAreaWrite(area), false);
            done();
        });
    });

    // ─── Precedence: config.hjson wins over the generated include ────────────

    it("an operator's own desc survives a regeneration", done => {
        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
            assert.ifError(err);
            assert.equal(
                configModule.get().messageConferences[CONF_TAG].areas.fsx_gen.desc,
                'FSX_GEN'
            );

            //  operator edits config.hjson to give it a real description
            writeBaseConfig({
                messageConferences: {
                    [CONF_TAG]: {
                        name: 'fsxNet',
                        desc: 'fsxNet Echos',
                        areas: {
                            fsx_gen: { desc: 'General Chat, my words' },
                        },
                    },
                },
            });

            configModule.reload(reloadErr => {
                assert.ifError(reloadErr);

                //  ...and a later pass rewrites the generated file wholesale
                autoAreaCreate.createAreas(NETWORK, ['FSX_BBS'], err2 => {
                    assert.ifError(err2);
                    const areas = configModule.get().messageConferences[CONF_TAG].areas;
                    assert.equal(areas.fsx_gen.desc, 'General Chat, my words');
                    assert.ok(areas.fsx_bbs);
                    done();
                });
            });
        });
    });

    // ─── Collision guard ─────────────────────────────────────────────────────

    it('refuses a tag that would alias the private mail area', done => {
        autoAreaCreate.createAreas(NETWORK, ['PRIVATE_MAIL'], (err, result) => {
            assert.ifError(err);
            assert.equal(result.created.length, 0);
            assert.equal(result.rejected.length, 1);
            assert.equal(result.rejected[0].areaTag, 'private_mail');
            assert.equal(
                result.rejected[0].reason,
                autoAreaCreate.RejectReasons.WellKnown
            );

            //  and nothing was written
            assert.deepEqual(readGeneratedSync().messageNetworks?.ftn?.areas ?? {}, {});
            done();
        });
    });

    it('refuses a tag that would alias the local bulletin area', done => {
        autoAreaCreate.createAreas(NETWORK, ['LOCAL_BULLETIN'], (err, result) => {
            assert.ifError(err);
            assert.equal(result.created.length, 0);
            assert.equal(
                result.rejected[0].reason,
                autoAreaCreate.RejectReasons.WellKnown
            );
            done();
        });
    });

    it('refuses a tag that collides with an existing area in another conference', done => {
        writeBaseConfig({
            messageConferences: {
                [CONF_TAG]: { name: 'fsxNet', desc: 'fsxNet Echos', areas: {} },
                local: {
                    name: 'Local',
                    desc: 'Local',
                    areas: { fsx_gen: { name: 'Mine', desc: 'Mine' } },
                },
            },
        });

        configModule.reload(reloadErr => {
            assert.ifError(reloadErr);
            autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], (err, result) => {
                assert.ifError(err);
                assert.equal(result.created.length, 0);
                assert.equal(
                    result.rejected[0].reason,
                    autoAreaCreate.RejectReasons.ExistingArea
                );
                done();
            });
        });
    });

    it('refuses a tag that is not a usable area tag', done => {
        autoAreaCreate.createAreas(NETWORK, [';', 'has space'], (err, result) => {
            assert.ifError(err);
            assert.equal(result.created.length, 0);
            assert.equal(result.rejected.length, 2);
            result.rejected.forEach(r =>
                assert.equal(r.reason, autoAreaCreate.RejectReasons.InvalidTag)
            );
            done();
        });
    });

    // ─── Guardrails ──────────────────────────────────────────────────────────

    it('caps the total number created, not the number per run', done => {
        //  maxAutoCreate is 5 in the fixture config
        autoAreaCreate.createAreas(
            NETWORK,
            ['A_ONE', 'A_TWO', 'A_THREE'],
            (err, first) => {
                assert.ifError(err);
                assert.equal(first.created.length, 3);

                autoAreaCreate.createAreas(
                    NETWORK,
                    ['B_ONE', 'B_TWO', 'B_THREE', 'B_FOUR'],
                    (err2, second) => {
                        assert.ifError(err2);
                        //  2 remaining under the cap of 5, the rest refused
                        assert.equal(second.created.length, 2);
                        assert.equal(second.rejected.length, 2);
                        second.rejected.forEach(r =>
                            assert.equal(
                                r.reason,
                                autoAreaCreate.RejectReasons.MaxReached
                            )
                        );
                        done();
                    }
                );
            }
        );
    });

    it('honours the ignore list for new tags and prunes ones already created', done => {
        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN', 'FSX_BBS'], err => {
            assert.ifError(err);

            writeBaseConfig({
                messageNetworks: {
                    ftn: {
                        networks: {
                            [NETWORK]: {
                                localAddress: '21:1/121',
                                autoAreas: {
                                    confTag: CONF_TAG,
                                    maxAutoCreate: 5,
                                    ignore: ['FSX_GEN', 'FSX_TST'],
                                    onDemand: { enabled: true },
                                },
                            },
                        },
                        areas: {},
                    },
                },
            });

            configModule.reload(reloadErr => {
                assert.ifError(reloadErr);
                autoAreaCreate.createAreas(
                    NETWORK,
                    ['FSX_TST', 'FSX_MYS'],
                    (err2, result) => {
                        assert.ifError(err2);
                        assert.deepEqual(
                            result.created.map(c => c.areaTag),
                            ['fsx_mys']
                        );
                        assert.deepEqual(result.pruned, ['fsx_gen']);
                        assert.equal(
                            result.rejected[0].reason,
                            autoAreaCreate.RejectReasons.Ignored
                        );

                        const generated = readGeneratedSync();
                        assert.equal(
                            generated.messageNetworks.ftn.areas.fsx_gen,
                            undefined
                        );
                        assert.equal(
                            generated.messageConferences[CONF_TAG].areas.fsx_gen,
                            undefined
                        );
                        assert.ok(generated.messageNetworks.ftn.areas.fsx_bbs);
                        done();
                    }
                );
            });
        });
    });

    it('is idempotent: re-running with the same tags creates nothing new', done => {
        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
            assert.ifError(err);
            autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], (err2, result) => {
                assert.ifError(err2);
                assert.equal(result.created.length, 0);
                assert.equal(result.rejected.length, 0);
                done();
            });
        });
    });

    // ─── Refusals that protect the boot ──────────────────────────────────────

    it('refuses when the generated file is not included from config.hjson', done => {
        writeBaseConfig({ includes: [] });
        configModule.reload(reloadErr => {
            assert.ifError(reloadErr);
            autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
                assert.ok(err);
                assert.match(err.message, /includes/);
                done();
            });
        });
    });

    it('refuses when the configured confTag is not a real conference', done => {
        writeBaseConfig({
            messageNetworks: {
                ftn: {
                    networks: {
                        [NETWORK]: {
                            localAddress: '21:1/121',
                            autoAreas: {
                                confTag: 'nope',
                                onDemand: { enabled: true },
                            },
                        },
                    },
                    areas: {},
                },
            },
        });

        configModule.reload(reloadErr => {
            assert.ifError(reloadErr);
            autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
                assert.ok(err);
                assert.match(err.message, /not a configured message conference/);
                done();
            });
        });
    });

    it('leaves an unparsable generated file alone rather than clobbering it', done => {
        const generatedPath = paths.join(
            tempDir,
            autoAreaCreate.GeneratedIncludeFileName
        );
        fs.writeFileSync(generatedPath, '{ this is not: valid hjson ][', 'utf8');

        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
            assert.ok(err);
            assert.match(err.message, /Cannot parse/);
            assert.equal(
                fs.readFileSync(generatedPath, 'utf8'),
                '{ this is not: valid hjson ]['
            );
            done();
        });
    });

    it('writes a file that parses, and leaves no temp file behind', done => {
        autoAreaCreate.createAreas(NETWORK, ['FSX_GEN'], err => {
            assert.ifError(err);
            //  hjson.parse would throw on a truncated write
            const generated = readGeneratedSync();
            assert.ok(generated.messageConferences[CONF_TAG].areas.fsx_gen);
            assert.deepEqual(
                fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp')),
                []
            );
            done();
        });
    });

    // ─── Feature gating ──────────────────────────────────────────────────────

    it('is off for a network with no autoAreas block', done => {
        writeBaseConfig({
            messageNetworks: {
                ftn: {
                    networks: { [NETWORK]: { localAddress: '21:1/121' } },
                    areas: {},
                },
            },
        });
        configModule.reload(err => {
            assert.ifError(err);
            assert.deepEqual(autoAreaCreate.onDemandNetworkNames(), []);
            assert.equal(autoAreaCreate.anyAutoAreasEnabled(), false);
            assert.equal(autoAreaCreate.getAutoAreasConfig(NETWORK), null);
            done();
        });
    });

    it('is off when neither source is enabled', done => {
        writeBaseConfig({
            messageNetworks: {
                ftn: {
                    networks: {
                        [NETWORK]: {
                            localAddress: '21:1/121',
                            autoAreas: {
                                confTag: CONF_TAG,
                                onDemand: { enabled: false },
                                infoPack: { enabled: false },
                            },
                        },
                    },
                    areas: {},
                },
            },
        });
        configModule.reload(err => {
            assert.ifError(err);
            assert.deepEqual(autoAreaCreate.onDemandNetworkNames(), []);
            done();
        });
    });
});
