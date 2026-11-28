'use strict';

//
//  core/version.js (#1194): the one place the ENiGMA½ version comes from.
//  Most of this feeds resolveVersion() a fake git and file system; the last
//  block runs real git in a scratch repository, never in this checkout, so
//  nothing here depends on the state of the tree the tests run from.
//

const { strict: assert } = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const version = require('../core/version.js');

const Root = '/opt/enigma-bbs';
const Pkg = '0.6.3-beta';

//  A fake world: |describe| is what `git describe` prints (or an Error to
//  throw), |topLevel| what `git rev-parse --show-toplevel` prints.
function fakeDeps({
    hasGit = true,
    topLevel = Root,
    describe,
    env = {},
    calls = [],
} = {}) {
    return {
        root: Root,
        releaseVersion: Pkg,
        env,
        exists: p => hasGit && p === paths.join(Root, '.git'),
        realpath: p => p.replace(/\/+$/, ''),
        exec: (file, args, opts) => {
            calls.push({ file, args, opts });
            const out = 'rev-parse' === args[0] ? topLevel : describe;
            if (out instanceof Error) {
                throw out;
            }
            return `${out}\n`;
        },
    };
}

describe('version (core/version.js)', function () {
    describe('formatDescribe', () => {
        const cases = [
            //  exactly on a release tag
            ['v0.7.0', '0.7.0'],
            ['v0.7.0-dirty', '0.7.0-dirty'],
            ['v0.7.0-rc.1', '0.7.0-rc.1'],
            ['v0.7.0-rc.1-dirty', '0.7.0-rc.1-dirty'],
            ['v1.12.3', '1.12.3'],
            //  commits after one
            ['v0.7.0-14-gabc1234', '0.7.0-14-gabc1234'],
            ['v0.7.0-14-gabc1234-dirty', '0.7.0-14-gabc1234-dirty'],
            ['v0.7.0-rc.1-3-g0123456789', '0.7.0-rc.1-3-g0123456789'],
            ['v0.7.0-rc.2-3-gdeadbee-dirty', '0.7.0-rc.2-3-gdeadbee-dirty'],
            //  no tag reachable: --always prints just the commit
            ['abc1234', `${Pkg}-gabc1234`],
            ['abc1234-dirty', `${Pkg}-gabc1234-dirty`],
            ['62f9dbecd', `${Pkg}-g62f9dbecd`],
            ['1234567', `${Pkg}-g1234567`],
        ];

        cases.forEach(([input, expected]) => {
            it(`${input} -> ${expected}`, () => {
                assert.equal(version.formatDescribe(input, Pkg), expected);
                assert.equal(version.formatDescribe(`${input}\n`, Pkg), expected);
            });
        });

        it('returns undefined for anything else', () => {
            [
                undefined,
                null,
                '',
                'fatal: not a git repository',
                'release-0.7.0',
                '0.7.0',
                'v',
                'vNext',
                'xyz',
            ].forEach(input =>
                assert.equal(version.formatDescribe(input, Pkg), undefined, input)
            );
        });
    });

    describe('resolveVersion', () => {
        it('uses git describe in a checkout of the install root', () => {
            assert.equal(
                version.resolveVersion(fakeDeps({ describe: 'v0.7.0-14-gabc1234' })),
                '0.7.0-14-gabc1234'
            );
            assert.equal(
                version.resolveVersion(fakeDeps({ describe: 'v0.7.0' })),
                '0.7.0'
            );
            assert.equal(
                version.resolveVersion(fakeDeps({ describe: 'abc1234-dirty' })),
                `${Pkg}-gabc1234-dirty`
            );
        });

        it('prefers git over the environment variable', () => {
            const env = { [version.EnvVarName]: '9.9.9-from-docker' };
            assert.equal(
                version.resolveVersion(fakeDeps({ describe: 'v0.7.0', env })),
                '0.7.0'
            );
        });

        it('runs git in the install root, with the release-tag pattern, and without GIT_DIR and friends', () => {
            const calls = [];
            const env = {
                PATH: '/usr/bin',
                GIT_DIR: '/elsewhere/.git',
                GIT_WORK_TREE: '/elsewhere',
                GIT_INDEX_FILE: '/elsewhere/.git/index',
            };
            version.resolveVersion(fakeDeps({ describe: 'v0.7.0', env, calls }));

            assert.equal(calls.length, 2);
            calls.forEach(({ file, opts }) => {
                assert.equal(file, 'git');
                assert.equal(opts.cwd, Root);
                assert.ok(opts.timeout > 0);
                assert.equal(opts.env.PATH, '/usr/bin');
                assert.equal(opts.env.GIT_DIR, undefined);
                assert.equal(opts.env.GIT_WORK_TREE, undefined);
                assert.equal(opts.env.GIT_INDEX_FILE, undefined);
            });
            assert.deepEqual(calls[0].args, ['rev-parse', '--show-toplevel']);
            assert.equal(calls[1].args[0], 'describe');
            ['--tags', '--dirty', '--always'].forEach(a =>
                assert.ok(calls[1].args.includes(a), a)
            );
            const m = calls[1].args.indexOf('--match');
            assert.equal(calls[1].args[m + 1], 'v[0-9]*');

            //  the caller's environment is left alone
            assert.equal(env.GIT_DIR, '/elsewhere/.git');
        });

        describe('without a usable checkout', () => {
            const envSet = { [version.EnvVarName]: '0.7.0-14-gabc1234' };

            const situations = {
                'no .git in the install root (and git is never run)': {
                    hasGit: false,
                    describe: new Error('must not be called'),
                },
                'the .git found belongs to a parent directory': {
                    topLevel: '/home/someone/projects',
                    describe: 'v5.0.0-1-gfeedbee',
                },
                'git is missing or fails': {
                    topLevel: Object.assign(new Error('spawnSync git ENOENT'), {
                        code: 'ENOENT',
                    }),
                },
                'git describe fails': {
                    describe: new Error('Command failed: git describe'),
                },
                'git describe prints something unrecognised': {
                    describe: 'warning: something odd',
                },
                'git prints nothing': {
                    topLevel: '',
                },
            };

            Object.entries(situations).forEach(([name, world]) => {
                it(`${name}: the environment variable, else package.json`, () => {
                    const calls = [];
                    assert.equal(
                        version.resolveVersion(fakeDeps({ ...world, calls })),
                        Pkg
                    );
                    assert.equal(
                        version.resolveVersion(fakeDeps({ ...world, env: envSet })),
                        envSet[version.EnvVarName]
                    );
                    if (false === world.hasGit) {
                        assert.equal(calls.length, 0);
                    }
                });
            });

            it('ignores an empty or blank environment variable', () => {
                [' ', ''].forEach(v =>
                    assert.equal(
                        version.resolveVersion(
                            fakeDeps({
                                hasGit: false,
                                env: { [version.EnvVarName]: v },
                            })
                        ),
                        Pkg
                    )
                );
            });

            it('trims the environment variable', () => {
                assert.equal(
                    version.resolveVersion(
                        fakeDeps({
                            hasGit: false,
                            env: { [version.EnvVarName]: ' 0.7.0\n' },
                        })
                    ),
                    '0.7.0'
                );
            });

            it('never throws, even if realpath does', () => {
                const deps = fakeDeps({ describe: 'v0.7.0' });
                deps.realpath = () => {
                    throw new Error('ENOENT');
                };
                assert.equal(version.resolveVersion(deps), Pkg);
            });
        });
    });

    describe('getVersion / getReleaseVersion', () => {
        it('getReleaseVersion is the package.json version', () => {
            assert.equal(version.getReleaseVersion(), require('../package.json').version);
        });

        it('getVersion is a non-empty string, worked out once', () => {
            const v = version.getVersion();
            assert.equal(typeof v, 'string');
            assert.ok(v.length > 0);
            assert.equal(version.getVersion(), v);
        });

        it('the install root is the ENiGMA tree, not the process cwd', () => {
            assert.equal(version.InstallRoot, paths.resolve(__dirname, '..'));
        });
    });

    //
    //  Real git, in a scratch repository, to pin down that describe's actual
    //  output parses as above. Skipped where git is not installed.
    //
    describe('with real git', function () {
        this.timeout(20000);

        let tmpDir;
        let repo;
        const cleanEnv = Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
        );

        const git = (cwd, ...args) =>
            execFileSync(
                'git',
                [
                    '-c',
                    'user.name=Test',
                    '-c',
                    'user.email=test@example.com',
                    '-c',
                    'commit.gpgsign=false',
                    '-c',
                    'tag.gpgsign=false',
                    ...args,
                ],
                { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'ignore'] }
            )
                .toString()
                .trim();

        const resolve = root =>
            version.resolveVersion({ root, releaseVersion: Pkg, env: {} });

        before(function () {
            try {
                execFileSync('git', ['--version'], { stdio: 'ignore' });
            } catch (e) {
                return this.skip();
            }
            tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-version-'));
            repo = paths.join(tmpDir, 'repo');
            fs.mkdirSync(repo);
            git(repo, 'init', '-q');
            fs.writeFileSync(paths.join(repo, 'file.txt'), 'one\n');
            git(repo, 'add', 'file.txt');
            git(repo, 'commit', '-q', '-m', 'one');
        });

        after(() => {
            if (tmpDir) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('walks through no tag, a tag, commits after it, and a modified tree', () => {
            const short = () => git(repo, 'rev-parse', '--short', 'HEAD');

            //  no release tag yet (a non-release tag does not count)
            git(repo, 'tag', 'not-a-release');
            assert.equal(resolve(repo), `${Pkg}-g${short()}`);

            git(repo, 'tag', '-a', 'v0.7.0', '-m', 'v0.7.0');
            assert.equal(resolve(repo), '0.7.0');

            fs.writeFileSync(paths.join(repo, 'file.txt'), 'two\n');
            assert.equal(resolve(repo), '0.7.0-dirty');

            git(repo, 'commit', '-q', '-am', 'two');
            assert.equal(resolve(repo), `0.7.0-1-g${short()}`);

            fs.writeFileSync(paths.join(repo, 'file.txt'), 'three\n');
            assert.equal(resolve(repo), `0.7.0-1-g${short()}-dirty`);

            //  an untracked file is not a modification
            git(repo, 'checkout', '-q', '--', 'file.txt');
            fs.writeFileSync(paths.join(repo, 'untracked.txt'), 'x\n');
            assert.equal(resolve(repo), `0.7.0-1-g${short()}`);
        });

        it('ignores a repository ENiGMA was unpacked inside', () => {
            const nested = paths.join(repo, 'unpacked', 'enigma-bbs');
            fs.mkdirSync(nested, { recursive: true });
            assert.equal(resolve(nested), Pkg);

            //  ...even if something left a .git directory in the install root
            //  that git does not take for a repository
            fs.mkdirSync(paths.join(nested, '.git'));
            assert.equal(resolve(nested), Pkg);
        });
    });
});
