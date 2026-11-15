'use strict';

//
//  core/bso_flow_paths.js: which files a BSO flow file line may act on.
//  The spool-level behaviour is in binkp_bso_spool.test.js; this covers the
//  rules themselves.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const {
    isControlFileName,
    isOutboundLikeDirName,
    basenameFallbackAllowed,
    flowRefLineProblem,
    flowPathSettings,
    FlowPathPolicy,
} = require('../core/bso_flow_paths.js');

describe('bso_flow_paths', function () {
    describe('isControlFileName', () => {
        it('knows the FTS-5005 and binkd control and flow names, in either case', () => {
            for (const name of [
                '00680025.flo',
                '00680025.ILO',
                '00680025.clo',
                '00680025.dlo',
                '00680025.hlo',
                '00680025.out',
                '00680025.CUT',
                '00680025.dut',
                '00680025.hut',
                '00680025.iut',
                '00680025.req',
                '00680025.bsy',
                '00680025.csy',
                '00680025.hld',
                '00680025.try',
                '00680025.stc',
                '00680025.pnt',
                '00680025.sep',
                'enigma.bsy',
            ]) {
                assert.ok(isControlFileName(name), name);
            }
        });

        it('leaves packets, bundles and TICs alone', () => {
            for (const name of [
                'a1b2c3d4.pkt',
                '0000fc9c.mo0',
                '0000fc9c.sut', //  Sunday, sequence t
                '0000fc9c.tut', //  Tuesday, sequence t
                '0000fc9c.fr9',
                'deadbeef.tic',
                'NODELIST.Z21',
                'noext',
                '.bsy',
            ]) {
                assert.ok(!isControlFileName(name), name);
            }
        });
    });

    describe('isOutboundLikeDirName', () => {
        const names = new Set(['fsxnet', 'ftn_out']);

        it('accepts outbound, configured names, zone suffixes and point directories', () => {
            for (const name of [
                'outbound',
                'OUTBOUND',
                'outbound.002',
                'outbound.1000',
                'fsxnet',
                'fsxnet.015',
                'ftn_out',
                '00680024.pnt',
            ]) {
                assert.ok(isOutboundLikeDirName(name, names), name);
            }
        });

        it('rejects anything else', () => {
            for (const name of [
                'inbound',
                'out',
                'outbound.sep',
                'outbounds',
                'filebase',
                '',
            ]) {
                assert.ok(!isOutboundLikeDirName(name, names), name);
            }
        });
    });

    describe('basenameFallbackAllowed', () => {
        const names = new Set(['fsxnet']);

        it('allows the #734 shape for ^, - and #', () => {
            for (const directive of ['^', '-', '#']) {
                assert.ok(
                    basenameFallbackAllowed(
                        '/bbs/ftn_out/outbound.002/a.pkt',
                        directive,
                        names
                    )
                );
            }
        });

        it('never for a send-and-keep line', () => {
            assert.ok(
                !basenameFallbackAllowed('/bbs/ftn_out/outbound.002/a.pkt', '', names)
            );
        });

        it('splits DOS paths too', () => {
            assert.ok(
                basenameFallbackAllowed('C:\\fido\\outbound\\0000fc9c.mo1', '^', names)
            );
            assert.ok(
                !basenameFallbackAllowed('C:\\fido\\inbound\\0000fc9c.mo1', '^', names)
            );
        });

        it('not from a directory that is not an outbound', () => {
            assert.ok(
                !basenameFallbackAllowed('/var/spool/husky/inbound/x.zip', '^', names)
            );
            assert.ok(!basenameFallbackAllowed('/x.pkt', '^', names));
        });

        it('not onto a control or flow file name', () => {
            assert.ok(
                !basenameFallbackAllowed('/bbs/outbound.002/00680025.flo', '^', names)
            );
            assert.ok(!basenameFallbackAllowed('/bbs/outbound/00680025.bsy', '#', names));
        });

        it('keeps a bare name in the flow file directory, but not a drive-relative one', () => {
            assert.ok(basenameFallbackAllowed('a1b2c3d4.pkt', '^', names));
            assert.ok(!basenameFallbackAllowed('C:a1b2c3d4.pkt', '^', names));
        });

        it('never for "." or ".."', () => {
            assert.ok(!basenameFallbackAllowed('/bbs/outbound/..', '^', names));
            assert.ok(!basenameFallbackAllowed('/bbs/outbound/.', '^', names));
        });
    });

    describe('flowRefLineProblem', () => {
        it('accepts what ENiGMA writes', () => {
            assert.equal(flowRefLineProblem('^', '/bbs/outbound/a1b2c3d4.pkt'), null);
            assert.equal(flowRefLineProblem('', '/bbs/files/NODELIST.Z21'), null);
            assert.equal(flowRefLineProblem('#', '/bbs/outbound/list.txt'), null);
        });

        it('refuses everything readers disagree about', () => {
            const cases = [
                ['^', 'relative/a.pkt'],
                ['^', '/a\nb'],
                ['^', '/a\rb'],
                ['^', `/a${String.fromCharCode(0)}b`],
                ['^', `/a${String.fromCharCode(9)}b`],
                ['^', `/a${String.fromCharCode(0x7f)}b`],
                ['', ' /a'],
                ['^', '/a '],
                ['^', `/a${String.fromCharCode(9)}`],
                ['^', '^/a'],
                ['', '!/a'],
                ['', '@/a'],
                ['^', ''],
                ['^', undefined],
                ['~', '/a'],
                ['-', '/a'],
                ['^', `/${'z'.repeat(2046)}`],
            ];
            for (const [directive, ref] of cases) {
                assert.ok(
                    flowRefLineProblem(directive, ref),
                    `${JSON.stringify(directive)} + ${JSON.stringify(ref)}`
                );
            }
        });

        it('counts bytes, not characters', () => {
            //  'é' is two bytes in UTF-8
            const ref = `/${'é'.repeat(1023)}`; //  1 + 2046 bytes
            assert.equal(flowRefLineProblem('', ref), null);
            assert.ok(flowRefLineProblem('^', ref));
        });
    });

    describe('flowPathSettings', () => {
        it('collects protected directories, file base storage and the operator list', () => {
            const settings = flowPathSettings(
                {
                    paths: {
                        config: '/bbs/config/',
                        security: '/bbs/config/security',
                        db: '/bbs/db/',
                        modsDb: '/bbs/db/mods/',
                        logs: '/bbs/logs/',
                    },
                    fileBase: {
                        areaStoragePrefix: '/bbs/file_base/',
                        storageTags: { a: 'area_a', b: '/srv/files/*', c: 42 },
                    },
                    scannerTossers: {
                        ftn_bso: {
                            binkp: { flowDispositionRoots: ['/srv/husky/in', 7, ''] },
                        },
                    },
                },
                { configFilePath: '/etc/enigma/config.hjson' }
            );

            assert.deepEqual(settings.protectedDirs, [
                '/bbs/config/',
                '/bbs/config/security',
                '/bbs/db/',
                '/bbs/db/mods/',
                '/bbs/logs/',
                '/etc/enigma',
            ]);
            assert.deepEqual(settings.storeDirs, [
                '/bbs/file_base/',
                '/bbs/file_base/area_a',
                '/srv/files',
            ]);
            assert.deepEqual(settings.dispositionRoots, ['/srv/husky/in']);
        });

        it('copes with an empty configuration', () => {
            assert.deepEqual(flowPathSettings({}, { configFilePath: null }), {
                protectedDirs: [],
                storeDirs: [],
                dispositionRoots: [],
            });
        });
    });

    describe('FlowPathPolicy', () => {
        let root;
        let real;

        before(async () => {
            root = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_flowpaths_'));
            for (const d of [
                'install/config',
                'install/mail/out/outbound',
                'install/mail/in',
                'install/file_base',
                'install/core',
                'other',
            ]) {
                await fsp.mkdir(paths.join(root, d), { recursive: true });
            }
            //  macOS and some CI temp dirs are themselves behind a symlink
            real = await fsp.realpath(root);
        });

        after(async () => {
            await fsp.rm(root, { recursive: true, force: true });
        });

        const at = p => paths.join(real, p);

        it('lets the most specific directory decide, with protected winning a tie', async () => {
            const policy = await FlowPathPolicy.build({
                settings: {
                    protectedDirs: [at('install')],
                    storeDirs: [at('install/file_base')],
                    dispositionRoots: [at('install/core'), at('other')],
                },
                spoolDirs: [at('install/mail/out/outbound'), at('install/mail/in')],
            });

            const check = (p, refused, allowed) => {
                const c = policy.classifyRealPath(at(p));
                assert.equal(c.refused, refused, `${p} refused`);
                assert.equal(c.allowed, allowed, `${p} allowed`);
            };

            check('install/config/config.hjson', true, false);
            check('install/mail/out/outbound/a.pkt', false, true);
            check('install/mail/in/x.zip', false, true);
            check('install/file_base/NODELIST.Z21', false, false); //  sendable, kept
            check('install/core/x', true, false); //  operator roots exempt nothing
            check('other/x', false, true);
            check('elsewhere/x', false, false);
        });

        it('refuses a mail directory that is itself a protected one', async () => {
            const policy = await FlowPathPolicy.build({
                settings: { protectedDirs: [at('install/mail/in')] },
                spoolDirs: [at('install/mail/in')],
            });
            assert.equal(policy.classifyRealPath(at('install/mail/in/x')).refused, true);
        });

        it('does not treat a sibling with a common prefix as inside', async () => {
            const policy = await FlowPathPolicy.build({
                settings: { protectedDirs: [at('install/mail/in')] },
            });
            assert.equal(
                policy.classifyRealPath(at('install/mail/inbound2/x')).refused,
                false
            );
        });

        it('classifies by real path, through symlinks', async () => {
            const secret = at('install/config/secret');
            await fsp.writeFile(secret, 'S');
            const link = at('install/mail/out/outbound/link.pkt');
            await fsp.symlink(secret, link);

            const policy = await FlowPathPolicy.build({
                settings: { protectedDirs: [at('install/config')] },
                spoolDirs: [at('install/mail/out/outbound')],
            });
            const c = await policy.classify(link);
            assert.equal(c.realPath, secret);
            assert.equal(c.refused, true);
            assert.equal(await policy.classify(at('install/nope')), null);
        });

        it('says once which way an overlap went', async () => {
            const lines = [];
            const log = {
                info: (fields, msg) => lines.push(['info', msg]),
                warn: (fields, msg) => lines.push(['warn', msg]),
            };
            const build = () =>
                FlowPathPolicy.build({
                    settings: {
                        protectedDirs: [at('install')],
                        dispositionRoots: [at('install/core')],
                    },
                    spoolDirs: [at('install/mail/in')],
                    log,
                });
            await build();
            await build();

            assert.deepEqual(
                lines.map(l => l[0]).sort(),
                ['info', 'warn'],
                'one line each, the second build silent'
            );
        });
    });
});
