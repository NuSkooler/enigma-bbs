'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

//  A module loadModuleEx() accepts: a moduleInfo block and a getModule()
const FakeModuleSource = name => `'use strict';
exports.moduleInfo = { name: '${name}', packageName: 'test.module_util.${name}' };
exports.getModule = class {};
`;

describe('module_util: module-level "enabled"', () => {
    let moduleUtil;
    let ErrorReasons;
    let tmpDir;
    let previousConfig;

    //  config is read at call time, so each test pushes its own
    const withConfig = cfg => {
        configModule._popTestConfig(previousConfig);
        previousConfig = configModule._pushTestConfig(cfg);
    };

    const load = (name, category) =>
        new Promise(resolve => {
            moduleUtil.loadModuleEx({ name, path: tmpDir, category }, (err, mod) =>
                resolve({ err, mod })
            );
        });

    before(() => {
        //  lazily: other test files evict core modules from require.cache
        moduleUtil = require('../core/module_util.js');
        ErrorReasons = require('../core/enig_error.js').ErrorReasons;

        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-modutil-'));
        for (const name of ['alpha', 'beta', 'gamma']) {
            fs.writeFileSync(paths.join(tmpDir, `${name}.js`), FakeModuleSource(name));
        }

        previousConfig = configModule._pushTestConfig({});
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('loadModuleEx()', () => {
        it('refuses a module whose block says enabled: false, with the Disabled reason', async () => {
            withConfig({ testServers: { alpha: { enabled: false } } });

            const { err, mod } = await load('alpha', 'testServers');
            assert.ok(err, 'expected an error');
            assert.equal(err.reasonCode, ErrorReasons.Disabled);
            assert.match(err.message, /"alpha" is disabled/);
            assert.equal(mod, undefined);
        });

        it('loads a module whose block says enabled: true', async () => {
            withConfig({ testServers: { alpha: { enabled: true } } });

            const { err, mod } = await load('alpha', 'testServers');
            assert.ifError(err);
            assert.equal(mod.moduleInfo.name, 'alpha');
        });

        it('loads a module whose block does not mention enabled', async () => {
            withConfig({ testServers: { alpha: { port: 1234 } } });

            const { err, mod } = await load('alpha', 'testServers');
            assert.ifError(err);
            assert.equal(mod.moduleInfo.name, 'alpha');
        });

        it('loads a module with no config block, section or category', async () => {
            withConfig({ testServers: {} });
            assert.ifError((await load('alpha', 'testServers')).err);

            withConfig({});
            assert.ifError((await load('alpha', 'testServers')).err);
            assert.ifError((await load('alpha', undefined)).err);
            assert.ifError((await load('alpha', null)).err);
        });

        it('looks the module up under its own category only', async () => {
            withConfig({
                otherServers: { alpha: { enabled: false } },
                testServers: { beta: { enabled: false } },
            });

            assert.ifError((await load('alpha', 'testServers')).err);
            assert.equal(
                (await load('alpha', 'otherServers')).err.reasonCode,
                ErrorReasons.Disabled
            );
            assert.equal(
                (await load('beta', 'testServers')).err.reasonCode,
                ErrorReasons.Disabled
            );
        });

        it('reads the config current at call time, not at require time', async () => {
            withConfig({ testServers: { alpha: { enabled: false } } });
            assert.equal(
                (await load('alpha', 'testServers')).err.reasonCode,
                ErrorReasons.Disabled
            );

            withConfig({ testServers: { alpha: { enabled: true } } });
            assert.ifError((await load('alpha', 'testServers')).err);
        });
    });

    describe('loadModulesForCategory()', () => {
        let previousLog;
        let logged;

        beforeEach(() => {
            previousLog = loggerModule.log;
            logged = [];
            const record =
                level =>
                (...args) =>
                    logged.push({ level, args });
            const stub = {
                fatal: record('fatal'),
                error: record('error'),
                warn: record('warn'),
                info: record('info'),
                debug: record('debug'),
                trace: record('trace'),
                child: () => stub,
            };
            loggerModule.log = stub;
        });

        afterEach(() => {
            loggerModule.log = previousLog;
        });

        it('skips a disabled module quietly and still loads the rest', done => {
            withConfig({
                paths: { testServers: tmpDir },
                testServers: {
                    alpha: { enabled: true },
                    beta: { enabled: false },
                },
            });

            const loaded = [];
            moduleUtil.loadModulesForCategory(
                'testServers',
                (mod, next) => {
                    loaded.push(mod.moduleInfo.name);
                    return next(null);
                },
                err => {
                    try {
                        assert.ifError(err);
                        assert.deepEqual(loaded.sort(), ['alpha', 'gamma']);

                        const levels = logged.map(l => l.level);
                        assert.ok(!levels.includes('error'), 'nothing at error');
                        assert.ok(!levels.includes('warn'), 'nothing at warn');

                        const disabled = logged.find(
                            l => l.args[0] && 'beta' === l.args[0].module
                        );
                        assert.ok(disabled, 'the disabled module is logged');
                        assert.equal(disabled.level, 'info');
                        assert.equal(disabled.args[0].category, 'testServers');
                        return done();
                    } catch (e) {
                        return done(e);
                    }
                }
            );
        });
    });
});
