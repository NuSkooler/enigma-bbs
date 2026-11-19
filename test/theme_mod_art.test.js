'use strict';

//
//  Art shipped in a mod's own art/ folder (#447): looked for after the themes
//  and before the general art directory, for menus whose module is a folder
//  mod (mods/<name>/<name>.js), plain names only.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const UserProps = require('../core/user_property.js');

//  Late bound: client_term.js captures the logger at load
let ClientTerminal;
let attachRipLayer;

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    level: () => 100,
    child() {
        return quietLog;
    },
};

const latin1 = b => Buffer.from(b).toString('latin1');

//  A client on a ClientTerminal, with the user's theme set to |themeId|
function session({ themeId = 'user_theme', rip = false, menus = {}, prompts = {} } = {}) {
    const wire = [];
    const term = new ClientTerminal({
        writable: true,
        write(data, cb) {
            wire.push(
                'string' === typeof data ? Buffer.from(data, 'latin1') : Buffer.from(data)
            );
            if (cb) {
                cb(null);
            }
        },
    });
    term.outputEncoding = 'cp437';
    term.termWidth = 80;
    term.termHeight = 25;
    const client = {
        term,
        log: quietLog,
        user: {
            properties: { [UserProps.ThemeId]: themeId },
            isAuthenticated: () => false,
        },
        currentTheme: { info: { themeId }, menus, prompts },
    };
    if (rip) {
        attachRipLayer(client, { source: 'termType' });
    }
    return {
        client,
        sent: () => latin1(Buffer.concat(wire)),
        clear: () => {
            wire.length = 0;
        },
    };
}

describe('Mod art fallback (mods/<name>/art, #447)', function () {
    let tmp;
    let themesDir;
    let artDir;
    let modsDir;
    let modArt;
    let config;
    let prevConfig;
    let prevLog;
    let theme;
    let moduleUtil;
    let menuUtil;
    let cacheBefore;

    const write = (file, text) => {
        fs.mkdirSync(paths.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    };

    //  a menu module mod, subclassing the MenuModule the BBS has loaded
    const modSource = name => `'use strict';
const { MenuModule } = require(${JSON.stringify(
        paths.join(__dirname, '..', 'core', 'menu_module.js')
    )});
exports.moduleInfo = { name: '${name}', desc: 'test', author: 'test' };
exports.getModule = class extends MenuModule {};
`;

    before(function () {
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-mod-art-'));
        themesDir = paths.join(tmp, 'themes');
        artDir = paths.join(tmp, 'general');
        modsDir = paths.join(tmp, 'mods');
        modArt = paths.join(modsDir, 'lampmod', 'art');

        write(paths.join(themesDir, 'user_theme', 'BOTH.ans'), 'user theme\r\n');
        write(paths.join(themesDir, 'default_theme', 'DEF.ans'), 'default theme\r\n');
        write(paths.join(themesDir, 'default_theme', 'BOTH.ans'), 'default theme\r\n');

        write(paths.join(artDir, 'GEN.ans'), 'general\r\n');
        write(paths.join(artDir, 'ONLYGEN.ans'), 'general\r\n');

        write(paths.join(modsDir, 'lampmod', 'lampmod.js'), modSource('lampmod'));
        for (const name of ['BOTH', 'DEF', 'GEN', 'LAMP']) {
            write(paths.join(modArt, `${name}.ans`), `mod ${name}\r\n`);
        }
        write(paths.join(modArt, 'RAND1.ans'), 'mod RAND1\r\n');
        write(paths.join(modArt, 'RAND2.ans'), 'mod RAND2\r\n');
        write(paths.join(modArt, 'RIPART.ans'), 'mod RIPART ansi\r\n');
        write(paths.join(modArt, 'RIPART.rip'), '!|1K\r\nmod RIPART rip\r\n');
        write(paths.join(modArt, 'sub', 'SUBART.ans'), 'mod sub\r\n');

        //  a single file mod; the folder of the same name is not its own
        write(paths.join(modsDir, 'single.js'), modSource('single'));
        write(paths.join(modsDir, 'single', 'art', 'SINGLE.ans'), 'single\r\n');

        //  a folder mod with no art folder
        write(paths.join(modsDir, 'noart', 'noart.js'), modSource('noart'));

        config = {
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'Test' },
            paths: { themes: themesDir, art: artDir, mods: modsDir },
            theme: { default: 'default_theme', preLogin: 'default_theme' },
        };
        prevConfig = configModule._pushTestConfig(config);
        prevLog = loggerModule.log;
        loggerModule.log = quietLog;

        //  menu_util captures config.js's |get| and the logger at load:
        //  require it fresh, and put the cache back afterwards
        cacheBefore = new Map(
            ['menu_util.js'].map(f => {
                const id = require.resolve(`../core/${f}`);
                return [id, require.cache[id]];
            })
        );
        cacheBefore.forEach((_, id) => delete require.cache[id]);

        ({ ClientTerminal } = require('../core/client_term.js'));
        ({ attachRipLayer } = require('../core/term/select.js'));
        theme = require('../core/theme.js');
        moduleUtil = require('../core/module_util.js');
        menuUtil = require('../core/menu_util.js');
    });

    after(function () {
        cacheBefore.forEach((mod, id) => {
            if (mod) {
                require.cache[id] = mod;
            } else {
                delete require.cache[id];
            }
        });
        Object.keys(require.cache)
            .filter(id => id.startsWith(tmp))
            .forEach(id => delete require.cache[id]);
        loggerModule.log = prevLog;
        configModule._popTestConfig(prevConfig);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function themeArt(client, name, extra) {
        return new Promise(resolve =>
            theme.getThemeArt(Object.assign({ client, name }, extra), (err, info) =>
                resolve(err ? null : info)
            )
        );
    }

    const from = info => (info ? paths.relative(tmp, info.fromPath) : 'none');

    describe('finding the folder', function () {
        it('a folder mod: <mods>/<name>/art', function () {
            const opts = { name: 'lampmod', path: modsDir };
            assert.equal(
                moduleUtil.getModArtPath(
                    opts,
                    paths.join(modsDir, 'lampmod', 'lampmod.js')
                ),
                modArt
            );
        });

        it('a single file mod: none, even with a folder of its name beside it', function () {
            const opts = { name: 'single', path: modsDir };
            assert.equal(
                moduleUtil.getModArtPath(opts, paths.join(modsDir, 'single.js')),
                undefined
            );
            assert.equal(moduleUtil.getModArtPath(opts, undefined), undefined);
        });

        it('loadModuleEx() says which file it loaded', function (done) {
            moduleUtil.loadModuleEx(
                { name: 'single', path: modsDir, category: 'mods' },
                (err, mod, modPath) => {
                    assert.ifError(err);
                    assert.equal(modPath, paths.join(modsDir, 'single.js'));
                    moduleUtil.loadModuleEx(
                        { name: 'lampmod', path: modsDir, category: 'mods' },
                        (err, mod, modPath) => {
                            assert.ifError(err);
                            assert.equal(
                                modPath,
                                paths.join(modsDir, 'lampmod', 'lampmod.js')
                            );
                            return done();
                        }
                    );
                }
            );
        });

        function loadMenu(menu) {
            const s = session({ menus: { testMenu: menu } });
            return new Promise((resolve, reject) =>
                menuUtil.loadMenu({ name: 'testMenu', client: s.client }, (err, inst) =>
                    err ? reject(err) : resolve({ inst, s })
                )
            );
        }

        it("a folder mod's menu module gets it", async function () {
            const { inst } = await loadMenu({ module: '@userModule:lampmod' });
            assert.equal(inst.modArtPath, modArt);
        });

        it("a single file mod's does not", async function () {
            const { inst } = await loadMenu({ module: '@userModule:single' });
            assert.equal(inst.modArtPath, undefined);
        });

        it('a folder mod with no art folder gets the path: the lookup moves on', async function () {
            const { inst, s } = await loadMenu({ module: '@userModule:noart' });
            assert.equal(inst.modArtPath, paths.join(modsDir, 'noart', 'art'));
            const artData = await new Promise(resolve =>
                inst.displayAsset('GEN', {}, (err, data) => resolve({ err, data }))
            );
            assert.ifError(artData.err);
            assert.ok(s.sent().includes('general'));
        });

        it('a system module menu never does', async function () {
            const { inst } = await loadMenu({ art: 'LAMP' });
            assert.equal(inst.modArtPath, undefined);
            const { inst: inst2 } = await loadMenu({
                module: '@systemModule:standard_menu',
            });
            assert.equal(inst2.modArtPath, undefined);
        });
    });

    describe('lookup order', function () {
        it('the theme beats the mod', async function () {
            const { client } = session();
            assert.equal(
                from(await themeArt(client, 'BOTH', { modArtPath: modArt })),
                'themes/user_theme/BOTH.ans'
            );
        });

        it('the default theme beats the mod', async function () {
            const { client } = session();
            assert.equal(
                from(await themeArt(client, 'DEF', { modArtPath: modArt })),
                'themes/default_theme/DEF.ans'
            );
        });

        it('the mod beats the general art directory', async function () {
            const { client } = session();
            assert.equal(
                from(await themeArt(client, 'GEN', { modArtPath: modArt })),
                'mods/lampmod/art/GEN.ans'
            );
            assert.equal(
                from(await themeArt(client, 'GEN')),
                'general/GEN.ans',
                'and without a mod, the general art as before'
            );
        });

        it('a plain name, with or without an extension, from the mod', async function () {
            const { client } = session();
            assert.equal(
                from(await themeArt(client, 'LAMP', { modArtPath: modArt })),
                'mods/lampmod/art/LAMP.ans'
            );
            assert.equal(
                from(await themeArt(client, 'LAMP.ans', { modArtPath: modArt })),
                'mods/lampmod/art/LAMP.ans'
            );
            assert.equal(from(await themeArt(client, 'LAMP')), 'none');
        });

        it('random NAME<n> selection, as in a theme', async function () {
            const { client } = session();
            const realRandom = Math.random;
            try {
                Math.random = () => 0;
                const first = from(
                    await themeArt(client, 'RAND', { modArtPath: modArt })
                );
                Math.random = () => 0.99;
                const second = from(
                    await themeArt(client, 'RAND', { modArtPath: modArt })
                );
                assert.deepEqual([first, second].sort(), [
                    'mods/lampmod/art/RAND1.ans',
                    'mods/lampmod/art/RAND2.ans',
                ]);
            } finally {
                Math.random = realRandom;
            }
        });

        it('a name holding a path is never looked for in the mod folder', async function () {
            const { client } = session();
            assert.equal(
                from(await themeArt(client, 'sub/SUBART', { modArtPath: modArt })),
                'none'
            );
            //  and works as it always has
            const abs = paths.join(modArt, 'sub', 'SUBART.ans');
            assert.equal(
                from(await themeArt(client, abs, { modArtPath: modArt })),
                'mods/lampmod/art/sub/SUBART.ans'
            );
        });

        it('a missing folder falls through silently', async function () {
            const { client } = session();
            const missing = paths.join(modsDir, 'noart', 'art');
            assert.equal(
                from(await themeArt(client, 'GEN', { modArtPath: missing })),
                'general/GEN.ans'
            );
            assert.equal(
                from(await themeArt(client, 'BOTH', { modArtPath: missing })),
                'themes/user_theme/BOTH.ans'
            );
            assert.equal(
                from(await themeArt(client, 'NOWHERE', { modArtPath: missing })),
                'none'
            );
        });
    });

    describe('RIP art in a mod folder: trusted, as in a theme', function () {
        it('displayThemeArt() shows a .rip as RIP', function (done) {
            const s = session({ rip: true });
            theme.displayThemeArt(
                { client: s.client, name: 'RIPART', modArtPath: modArt },
                (err, artData) => {
                    assert.ifError(err);
                    assert.equal(paths.basename(artData.artInfo.fromPath), 'RIPART.rip');
                    assert.ok(artData.artInfo.rip);
                    assert.ok(s.sent().includes('!|1K'));
                    return done();
                }
            );
        });

        it('acceptRip false: the .ans', async function () {
            const s = session({ rip: true });
            const info = await themeArt(s.client, 'RIPART', {
                modArtPath: modArt,
                acceptRip: false,
            });
            assert.equal(from(info), 'mods/lampmod/art/RIPART.ans');
        });

        it('without the RIP layer: the .ans', async function () {
            const s = session();
            const info = await themeArt(s.client, 'RIPART', {
                modArtPath: modArt,
                acceptRip: true,
            });
            assert.equal(from(info), 'mods/lampmod/art/RIPART.ans');
        });
    });

    describe("a mod menu's art helpers", function () {
        function modMenu(menu = {}) {
            const s = session({
                menus: {
                    testMenu: Object.assign({ module: '@userModule:lampmod' }, menu),
                },
            });
            return new Promise((resolve, reject) =>
                menuUtil.loadMenu({ name: 'testMenu', client: s.client }, (err, inst) =>
                    err ? reject(err) : resolve({ inst, s })
                )
            );
        }

        it('displayAsset() finds art in the mod folder', async function () {
            const { inst, s } = await modMenu();
            await new Promise((resolve, reject) =>
                inst.displayAsset('LAMP', {}, err => (err ? reject(err) : resolve()))
            );
            assert.ok(s.sent().includes('mod LAMP'));
        });

        it('no config key can point displayAsset() at another folder', async function () {
            const { inst } = await modMenu();
            inst.modArtPath = undefined;
            const err = await new Promise(resolve =>
                inst.displayAsset('LAMP', { modArtPath: modArt }, resolve)
            );
            assert.ok(err, 'not found');
        });

        it('the helpers that bypass displayAsset() pass it on', async function () {
            const { inst } = await modMenu({
                config: { art: { list: 'LAMP' } },
            });
            const seen = {};
            const real = {
                displayThemedAsset: theme.displayThemedAsset,
                displayThemedPrompt: theme.displayThemedPrompt,
                getThemeArt: theme.getThemeArt,
            };
            theme.displayThemedAsset = (spec, client, options, cb) => {
                seen.displayArtAndPrepViewController = options.modArtPath;
                return cb(new Error('stop'));
            };
            theme.displayThemedPrompt = (name, client, options, cb) => {
                seen.promptForInput = options.modArtPath;
                return cb(null, {});
            };
            theme.getThemeArt = (options, cb) => {
                seen.paginated = options.modArtPath;
                return cb(new Error('stop'));
            };
            try {
                await new Promise(resolve =>
                    inst.displayArtAndPrepViewController('list', 0, {}, () => resolve())
                );
                await new Promise(resolve =>
                    inst._displayArtPaginated('LAMP', {}, () => resolve())
                );
                inst.addViewController = (name, vc) => vc;
                inst.client.on = () => {};
                inst.client.removeListener = () => {};
                await new Promise(resolve =>
                    inst.promptForInput(
                        { formName: 'p', formId: 0, promptName: 'x' },
                        {},
                        () => resolve()
                    )
                );
            } finally {
                Object.assign(theme, real);
            }
            assert.deepEqual(seen, {
                displayArtAndPrepViewController: modArt,
                paginated: modArt,
                promptForInput: modArt,
            });
        });

        it("a prompt's config cannot set it; the caller's is used", function (done) {
            const s = session({
                prompts: {
                    lampPrompt: { art: 'LAMP', config: { modArtPath: '/nowhere' } },
                },
            });
            const viewController = { loadFromPromptConfig: (opts, cb) => cb(null) };
            theme.displayThemedPrompt(
                'lampPrompt',
                s.client,
                { modArtPath: modArt, viewController },
                (err, artInfo) => {
                    assert.ifError(err);
                    assert.ok(artInfo, 'found in the mod folder');
                    assert.ok(s.sent().includes('mod LAMP'));
                    return done();
                }
            );
        });

        it("a system module's displayAsset() never looks in a mod", async function () {
            const s = session({ menus: { sys: {} } });
            const inst = await new Promise((resolve, reject) =>
                menuUtil.loadMenu({ name: 'sys', client: s.client }, (err, i) =>
                    err ? reject(err) : resolve(i)
                )
            );
            const err = await new Promise(resolve =>
                inst.displayAsset('LAMP', { modArtPath: modArt }, resolve)
            );
            assert.ok(err, 'not found');
        });
    });
});
