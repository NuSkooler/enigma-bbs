'use strict';

//
//  #927: relative names in config.hjson -- general.menuFile, the achievements
//  file, offline mail bulletins -- resolve against paths.config, while
//  "includes" resolve beside config.hjson. paths.config now defaults to the
//  directory config.hjson was loaded from, so the two agree on a board started
//  with --config somewhere other than the install's config/. An explicit
//  paths.config still wins.
//

const { strict: assert } = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const REPO_ROOT = paths.join(__dirname, '..');
const OPUTIL = paths.join(REPO_ROOT, 'oputil.js');

const withSep = dir => paths.join(dir, paths.sep);

describe('paths.config default (#927)', function () {
    //  required lazily: config.js and config_util.js must not be pinned to
    //  whatever another suite left behind at load time
    let configModule;
    let configDefault;
    let getConfigPath;

    let saved;
    let tempDir;

    before(() => {
        configModule = require('../core/config.js');
        configDefault = require('../core/config_default.js');
        ({ getConfigPath } = require('../core/config_util.js'));

        //  Config.create() rebinds these module-level exports
        saved = {
            get: configModule.get,
            reload: configModule.reload,
            getUserConfig: configModule.getUserConfig,
        };
    });

    after(() => {
        Object.assign(configModule, saved);
    });

    beforeEach(() => {
        tempDir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-927-')));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function create(configPath, cb) {
        configModule.Config.create(
            configPath,
            { hotReload: false, reportValidation: false },
            err => cb(err, configModule.get())
        );
    }

    function writeConfig(dir, hjsonText) {
        const configPath = paths.join(dir, 'config.hjson');
        fs.writeFileSync(configPath, hjsonText);
        return configPath;
    }

    it('resolves a relative menuFile beside a config.hjson loaded from elsewhere', done => {
        const configPath = writeConfig(
            tempDir,
            '{\n    general: {\n        menuFile: my-menu.hjson\n    }\n}\n'
        );

        create(configPath, (err, config) => {
            assert.ifError(err);
            assert.equal(config.paths.config, withSep(tempDir));
            assert.equal(
                getConfigPath(config.general.menuFile),
                paths.join(tempDir, 'my-menu.hjson')
            );
            //  and the stock default menuFile likewise
            assert.equal(getConfigPath('menu.hjson'), paths.join(tempDir, 'menu.hjson'));
            return done();
        });
    });

    it('agrees with where includes are read from', done => {
        //  the include's own key only exists if the include was found here
        fs.writeFileSync(
            paths.join(tempDir, 'extra.hjson'),
            '{\n    test927: {\n        fromInclude: true\n    }\n}\n'
        );
        const configPath = writeConfig(
            tempDir,
            '{\n    includes: [ "extra.hjson" ]\n}\n'
        );

        create(configPath, (err, config) => {
            assert.ifError(err);
            assert.equal(config.test927.fromInclude, true);
            assert.equal(
                getConfigPath('extra.hjson'),
                paths.join(tempDir, 'extra.hjson')
            );
            return done();
        });
    });

    it('lets an explicit paths.config win', done => {
        const elsewhere = paths.join(tempDir, 'elsewhere');
        fs.mkdirSync(elsewhere);
        const configPath = writeConfig(
            tempDir,
            `{\n    paths: {\n        config: "${elsewhere}"\n    }\n}\n`
        );

        create(configPath, (err, config) => {
            assert.ifError(err);
            assert.equal(config.paths.config, elsewhere);
            assert.equal(
                getConfigPath('menu.hjson'),
                paths.join(elsewhere, 'menu.hjson')
            );
            return done();
        });
    });

    it('lets an explicit paths.config equal to the old default win', done => {
        //  the value a --config board writes to keep the old behaviour
        const installConfig = configDefault().paths.config;
        const configPath = writeConfig(
            tempDir,
            `{\n    paths: {\n        config: "${installConfig}"\n    }\n}\n`
        );

        create(configPath, (err, config) => {
            assert.ifError(err);
            assert.equal(config.paths.config, installConfig);
            return done();
        });
    });

    it('keeps the derived default across a reload', done => {
        const elsewhere = paths.join(tempDir, 'elsewhere');
        const configPath = writeConfig(
            tempDir,
            `{\n    paths: {\n        config: "${elsewhere}"\n    }\n}\n`
        );

        create(configPath, (err, config) => {
            assert.ifError(err);
            assert.equal(config.paths.config, elsewhere);

            //  the operator removes the explicit setting: the next load must
            //  fall back to the derived default, not the install's config/
            writeConfig(
                tempDir,
                '{\n    general: {\n        boardName: Reloaded\n    }\n}\n'
            );
            configModule.reload(err => {
                assert.ifError(err);
                const reloaded = configModule.get();
                assert.equal(reloaded.general.boardName, 'Reloaded');
                assert.equal(reloaded.paths.config, withSep(tempDir));
                return done();
            });
        });
    });

    it('leaves the stock layout unchanged', () => {
        const { effectiveDefaults } = configModule;
        const stock = configDefault().paths.config;

        //  as main.js passes it: resolved against the install directory
        assert.equal(
            effectiveDefaults({
                baseConfigPath: paths.join(REPO_ROOT, 'config', 'config.hjson'),
            }).paths.config,
            stock
        );

        //  and with no config path at all, as docker/check_tools.js asks
        assert.equal(effectiveDefaults().paths.config, stock);
    });

    it('leaves the stock layout unchanged for a relative path, as oputil gives it', () => {
        //  oputil without --config loads "./config/config.hjson" from the
        //  directory it is run in, the install directory
        const cwd = process.cwd();
        process.chdir(REPO_ROOT);
        try {
            assert.equal(
                configModule.effectiveDefaults({
                    baseConfigPath: './config/config.hjson',
                }).paths.config,
                configDefault().paths.config
            );
        } finally {
            process.chdir(cwd);
        }
    });

    describe('oputil config new', function () {
        it('writes absolute menu and achievements paths into the install config/', done => {
            const { setInstallFilePaths } = require('../core/oputil/oputil_config.js');

            const newConfig = { general: {} };
            setInstallFilePaths(newConfig, 'myboard-main.hjson');

            const installConfig = paths.join(REPO_ROOT, 'config');
            assert.equal(
                newConfig.general.menuFile,
                paths.join(installConfig, 'menus', 'myboard-main.hjson')
            );
            assert.equal(
                newConfig.general.achievementFile,
                paths.join(installConfig, 'achievements.hjson')
            );
            //  the install ships this one
            assert.ok(fs.existsSync(newConfig.general.achievementFile));

            //  and a config.hjson written outside config/ still finds both
            const configPath = writeConfig(tempDir, JSON.stringify(newConfig, null, 4));
            create(configPath, (err, config) => {
                assert.ifError(err);
                assert.equal(config.paths.config, withSep(tempDir));
                assert.equal(
                    getConfigPath(config.general.achievementFile),
                    paths.join(installConfig, 'achievements.hjson')
                );
                assert.equal(
                    getConfigPath(config.general.menuFile),
                    paths.join(installConfig, 'menus', 'myboard-main.hjson')
                );
                return done();
            });
        });
    });

    describe('a missing achievements file', function () {
        let loggerModule;
        let savedLog;
        let warnings;
        let prevGet;

        beforeEach(() => {
            loggerModule = require('../core/logger.js');
            savedLog = loggerModule.log;
            warnings = [];
            const quiet = () => {};
            loggerModule.log = {
                trace: quiet,
                debug: quiet,
                info: quiet,
                error: quiet,
                fatal: quiet,
                warn: (obj, msg) => warnings.push({ obj, msg }),
                child() {
                    return this;
                },
            };
        });

        afterEach(() => {
            loggerModule.log = savedLog;
            if (prevGet) {
                configModule._popTestConfig(prevGet);
                prevGet = undefined;
            }
        });

        it('leaves achievements off and says where it looked, and why', done => {
            prevGet = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                general: { achievementFile: 'achievements.hjson' },
                paths: { config: withSep(tempDir) },
            });

            const { Achievements } = require('../core/achievement.js');
            const achievements = new Achievements({});

            achievements.init(err => {
                //  not a startup failure: achievements are just disabled
                assert.ifError(err);
                assert.equal(achievements.isEnabled(), false);

                const expectedPath = paths.join(tempDir, 'achievements.hjson');
                assert.equal(warnings.length, 1, JSON.stringify(warnings));
                assert.equal(warnings[0].obj.path, expectedPath);
                assert.equal(warnings[0].obj.configDir, withSep(tempDir));
                assert.match(warnings[0].msg, /not found/);
                assert.match(warnings[0].msg, /paths\.config/);
                return done();
            });
        });
    });

    describe('oputil --config', function () {
        //  a real oputil process: --config is parsed there, not here
        this.timeout(20000);

        it('validates the menu.hjson beside the config.hjson it was given', () => {
            writeConfig(
                tempDir,
                '{\n    general: {\n        boardName: Test\n        menuFile: my-menu.hjson\n    }\n}\n'
            );
            fs.writeFileSync(
                paths.join(tempDir, 'my-menu.hjson'),
                '{\n    menus: {\n        hello: {\n            art: hello\n        }\n    }\n}\n'
            );

            let output;
            try {
                output = execFileSync(
                    process.execPath,
                    [OPUTIL, 'config', 'validate', '--config', withSep(tempDir)],
                    {
                        encoding: 'utf8',
                        cwd: REPO_ROOT,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    }
                );
            } catch (e) {
                output = `${e.stdout || ''}${e.stderr || ''}`;
            }

            //  the menu report is headed by the path it read
            assert.ok(
                output.includes(paths.join(tempDir, 'my-menu.hjson')),
                `expected a report on ${paths.join(tempDir, 'my-menu.hjson')}:\n${output}`
            );
        });
    });
});
