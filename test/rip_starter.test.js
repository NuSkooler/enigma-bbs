'use strict';

//
//  The RIP starter (#989): the menus in misc/menu_templates/rip.in.hjson,
//  the generated button screens in misc/rip_starter/, and how "oputil.js
//  config new" opts a board in (or, by default, does not).
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const hjson = require('hjson');
const _ = require('lodash');

const ROOT = paths.join(__dirname, '..');
const TEMPLATE_DIR = paths.join(ROOT, 'misc/menu_templates');
const ART_DIR = paths.join(ROOT, 'misc/rip_starter');
const THEME_DIR = paths.join(ROOT, 'art/themes/luciano_blocktronics');

const readHjson = path => hjson.parse(fs.readFileSync(path, 'utf8'));
const tree = () => readHjson(paths.join(TEMPLATE_DIR, 'rip.in.hjson'));

const { ALLOWED_SYSTEM_METHODS, targetsOf, artNamesOf } = require('./starter_tree.js');

//  every stock menu and prompt, by name (the other starters' files left out)
function stockTree() {
    const out = { menus: {}, prompts: {} };
    fs.readdirSync(TEMPLATE_DIR)
        .filter(
            f =>
                f.endsWith('.in.hjson') &&
                !['rip.in.hjson', 'petscii.in.hjson', 'atascii.in.hjson'].includes(f)
        )
        .forEach(f => {
            const text = fs
                .readFileSync(paths.join(TEMPLATE_DIR, f), 'utf8')
                .replace(/%INCLUDE_FILES%/g, '');
            const parsed = hjson.parse(text);
            Object.assign(out.menus, parsed.menus || {});
            Object.assign(out.prompts, parsed.prompts || {});
        });
    return out;
}

//  the .rip files' art names, with the menu that shows each
function ripScreens() {
    const t = tree();
    return _.pickBy(
        _.mapValues(t.menus, m => m.art),
        art => _.isString(art) && fs.existsSync(paths.join(ART_DIR, `${art}.rip`))
    );
}

//  the keys a menu binds through its form's actionKeys
function boundKeys(menu) {
    const keys = new Set();
    _.forEach(menu.form || {}, form =>
        (form.actionKeys || []).forEach(ak => ak.keys.forEach(k => keys.add(k)))
    );
    return keys;
}

const lines = name => fs.readFileSync(paths.join(ART_DIR, name), 'latin1').split('\r\n');

//  { x0, y0, x1, y1, hotkey, label, command } for each !|1U line
function buttonsIn(name) {
    const mn = s => parseInt(s, 36);
    return lines(name)
        .filter(l => l.startsWith('!|1U'))
        .map(l => {
            const m = /^!\|1U(..)(..)(..)(..)(..)(.)(.)<>(.*)<>(.*)$/.exec(l);
            assert.ok(m, `${name}: button line ${l}`);
            return {
                x0: mn(m[1]),
                y0: mn(m[2]),
                x1: mn(m[3]),
                y1: mn(m[4]),
                hotkey: m[5],
                label: m[8],
                command: m[9],
            };
        });
}

//  the parser's view of a .rip file: MCI codes and where the text ends
function parseRip(name, termHeight) {
    const { ANSIEscapeParser } = require('../core/ansi_escape_parser.js');
    const parser = new ANSIEscapeParser({
        mciReplaceChar: ' ',
        termWidth: 80,
        termHeight,
        ripCommands: true,
    });
    const out = { mci: [], rip: [], maxRow: 1 };
    parser.on('mci', info => out.mci.push({ code: info.mci, position: info.position }));
    parser.on('rip', data => out.rip.push(data));
    parser.on('literal', () => {
        out.maxRow = Math.max(out.maxRow, parser.row);
    });
    parser.on('complete', () => {
        out.end = [parser.row, parser.column];
    });
    parser.reset(fs.readFileSync(paths.join(ART_DIR, name), 'latin1'));
    parser.parse();
    return out;
}

describe('RIP starter menus (#989)', () => {
    it('the menu file parses, and every menu is named rip...', () => {
        const t = tree();
        assert.ok(Object.keys(t.menus).length > 0);
        Object.keys(t.menus).forEach(n => assert.match(n, /^rip[A-Z]/));
        assert.equal(t.prompts, undefined);
    });

    it('no name collides with a stock or other starter menu or prompt', () => {
        const others = { menus: new Set(), prompts: new Set() };
        fs.readdirSync(TEMPLATE_DIR)
            .filter(f => f.endsWith('.in.hjson') && 'rip.in.hjson' !== f)
            .forEach(f => {
                const parsed = hjson.parse(
                    fs
                        .readFileSync(paths.join(TEMPLATE_DIR, f), 'utf8')
                        .replace(/%INCLUDE_FILES%/g, '')
                );
                Object.keys(parsed.menus || {}).forEach(n => others.menus.add(n));
                Object.keys(parsed.prompts || {}).forEach(n => others.prompts.add(n));
            });
        Object.keys(tree().menus).forEach(n => assert.ok(!others.menus.has(n), n));
    });

    it('no stock menu leads into the RIP menus', () => {
        fs.readdirSync(TEMPLATE_DIR)
            .filter(f => f.endsWith('.in.hjson') && 'rip.in.hjson' !== f)
            .forEach(f =>
                assert.ok(
                    !/\brip[A-Z]/.test(
                        fs.readFileSync(paths.join(TEMPLATE_DIR, f), 'utf8')
                    ),
                    f
                )
            );
    });

    it('every next, action and config menu exists in the combined tree', () => {
        const t = tree();
        const stock = stockTree();
        const menus = Object.assign({}, stock.menus, t.menus);
        const problems = [];
        let links = 0;
        _.forEach(t.menus, (menu, name) => {
            targetsOf(name, menu).forEach(([where, spec]) => {
                ++links;
                let m;
                if ((m = /^@systemMethod:(.+)$/.exec(spec))) {
                    if (!ALLOWED_SYSTEM_METHODS.includes(m[1])) {
                        problems.push(`${where}: ${spec}`);
                    }
                } else if ((m = /^@menu:(.+)$/.exec(spec))) {
                    if (!menus[m[1]]) problems.push(`${where}: ${spec}`);
                } else if ((m = /^@prompt:(.+)$/.exec(spec))) {
                    if (!stock.prompts[m[1]]) problems.push(`${where}: ${spec}`);
                } else if (spec.startsWith('@')) {
                    problems.push(`${where}: ${spec} (not expected here)`);
                } else if (!menus[spec]) {
                    problems.push(`${where}: ${spec}`);
                }
            });
        });
        assert.deepEqual(problems, []);
        assert.ok(links >= 15, `only ${links} links found`);
    });

    //
    //  The stock menus a RIP caller is sent to must come back by "prev",
    //  never go on by name: otherwise the caller lands in the stock main
    //  menu. These are the ones this tree sends callers to.
    //
    it('the stock menus it uses come back to it', () => {
        const t = tree();
        const stock = stockTree();
        const used = new Set();
        _.forEach(t.menus, (menu, name) =>
            targetsOf(name, menu).forEach(([, spec]) => {
                const m = /^@menu:(.+)$/.exec(spec);
                const target = m ? m[1] : spec;
                if (stock.menus[target]) used.add(target);
            })
        );
        assert.deepEqual([...used].sort(), [
            'fullLogoffSequence',
            'loginAttemptAccountDisabled',
            'loginAttemptAccountInactive',
            'loginAttemptAccountLocked',
            'loginAttemptTooNode',
            'logoff',
            'mainMenuLastCallers',
            'mainMenuWhosOnline',
            'messageBaseChangeCurrentArea',
            'messageBaseMessageList',
            'messageBaseNewPost',
            'newUserApplicationPre',
        ]);
        //  no next of their own: back to the RIP menu when done
        [
            'mainMenuLastCallers',
            'mainMenuWhosOnline',
            'messageBaseChangeCurrentArea',
            'messageBaseMessageList',
            'messageBaseNewPost',
        ].forEach(n => assert.equal(stock.menus[n].next, undefined, n));
        //  these end the call
        ['loginAttemptTooNode', 'logoff'].forEach(n =>
            assert.match(String(stock.menus[n].next), /logoff/, n)
        );
    });

    it('the copies of stock menus differ only in where they go next', () => {
        //  as the board sees them: @reference: resolved (the RIP file spells
        //  out the stock escToPrev binding, which an older main menu file
        //  may not have)
        const ConfigLoader = require('../core/config_loader.js');
        const resolve = menus =>
            new ConfigLoader({ hotReload: false })._resolveAtSpecs({
                common: readHjson(paths.join(TEMPLATE_DIR, 'main.in.hjson')).common,
                menus,
            }).menus;
        const t = { menus: resolve(tree().menus) };
        const stock = resolve(stockTree().menus);
        const without = (menu, ...keys) => _.omit(_.cloneDeep(menu), keys);

        //  the login form, keys and status menus are the stock ones
        assert.deepEqual(without(t.menus.ripLogin, 'next'), without(stock.login, 'next'));
        assert.deepEqual(t.menus.ripLogin.next, [
            { acs: 'AR2', next: 'ripLoginTwoFactorAuthOTPLoop' },
            { next: 'ripMain' },
        ]);
        assert.deepEqual(stock.login.next, [
            { acs: 'AR2', next: 'loginTwoFactorAuthOTPLoop' },
            { next: 'fullLoginSequenceLoginArt' },
        ]);

        assert.deepEqual(
            without(t.menus.ripLoginTwoFactorAuthOTP, 'next'),
            without(stock.loginTwoFactorAuthOTP, 'next')
        );
        assert.equal(t.menus.ripLoginTwoFactorAuthOTP.next, 'ripMain');
        assert.equal(
            t.menus.ripLoginTwoFactorAuthOTPLoop.next,
            'ripLoginTwoFactorAuthOTP'
        );

        //  the stock new scan, message base only
        const scan = t.menus.ripNewScan;
        const stockScan = stock.mainMenuGlobalNewScan;
        assert.equal(scan.module, stockScan.module);
        assert.equal(scan.art, stockScan.art);
        assert.equal(scan.next, undefined);
        assert.deepEqual(scan.config, { ...stockScan.config, skipFileBase: true });
    });

    it('every art name is a shipped file', () => {
        const t = tree();
        const missing = [];
        artNamesOf(t.menus).forEach(([where, name]) => {
            const inStarter = fs.existsSync(paths.join(ART_DIR, `${name}.rip`));
            const inTheme = fs
                .readdirSync(THEME_DIR)
                .some(f => paths.parse(f).name.toUpperCase() === name.toUpperCase());
            if (!inStarter && !inTheme) missing.push(`${where}: ${name}`);
        });
        assert.deepEqual(missing, []);
    });

    it('three button screens, each with a .rip and an .ans', () => {
        assert.deepEqual(ripScreens(), {
            ripMatrix: 'RMATRIX',
            ripMain: 'RMAIN',
            ripMessages: 'RMSGMENU',
        });
        const files = fs.readdirSync(ART_DIR).sort();
        assert.deepEqual(files, [
            'RMAIN.ans',
            'RMAIN.rip',
            'RMATRIX.ans',
            'RMATRIX.rip',
            'RMSGMENU.ans',
            'RMSGMENU.rip',
        ]);
    });

    it('the art names are used by nothing else shipped', () => {
        const ours = new Set(Object.values(ripScreens()));
        const clash = [];
        const walk = dir =>
            fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
                const p = paths.join(dir, e.name);
                if (e.isDirectory()) return walk(p);
                //  NAME, NAME1, NAME2 ... all answer to NAME
                const base = paths.parse(e.name).name.toUpperCase().replace(/\d+$/, '');
                if (ours.has(base) && paths.dirname(p) !== ART_DIR) clash.push(p);
            });
        [paths.join(ROOT, 'art'), paths.join(ROOT, 'misc')].forEach(walk);
        assert.deepEqual(clash, []);
    });

    it('every button sends one key, which its menu binds with and without shift', () => {
        const t = tree();
        _.forEach(ripScreens(), (art, menuName) => {
            const keys = boundKeys(t.menus[menuName]);
            const buttons = buttonsIn(`${art}.rip`);
            assert.ok(buttons.length >= 3, art);
            buttons.forEach(b => {
                assert.match(b.command, /^[A-Z]$/, `${art}: ${b.command}`);
                const lower = b.command.toLowerCase();
                assert.ok(keys.has(lower), `${menuName} binds ${lower}`);
                assert.ok(
                    keys.has(`shift + ${lower}`),
                    `${menuName} binds shift + ${lower}`
                );
                assert.equal(b.hotkey, '00', `${art}: no RIP hotkey`);
                assert.ok(b.label.startsWith(`[${b.command}] `), `${art}: ${b.label}`);
            });
            //  and nothing else is bound but Escape
            const commands = buttons.map(b => b.command.toLowerCase());
            [...keys].forEach(k =>
                assert.ok(
                    'escape' === k || commands.includes(k.replace(/^shift \+ /, '')),
                    `${menuName}: ${k} has no button`
                )
            );
        });
    });

    it('the button screens wait for a key and clear the screen first', () => {
        const t = tree();
        Object.keys(ripScreens()).forEach(n => {
            const menu = t.menus[n];
            assert.equal(menu.next, undefined, n);
            assert.equal(menu.prompt, undefined, n);
            assert.equal(menu.config.cls, true, n);
            //  a form with no views: the generic match needs "mci"
            assert.deepEqual(menu.form[0].mci, {}, n);
        });
    });
});

describe('RIP starter screens (#989)', () => {
    const Allowed = /^!\|(Y|c|S|B|R|@|1B|1U)/;

    const ripFiles = () => fs.readdirSync(ART_DIR).filter(f => f.endsWith('.rip'));

    it('the generator reproduces the committed files', () => {
        const { buildAll } = require('../dev_util/rip_art/build.js');
        const built = buildAll();
        assert.deepEqual(Object.keys(built).sort(), fs.readdirSync(ART_DIR).sort());
        Object.entries(built).forEach(([file, bytes]) => {
            assert.ok(bytes.equals(fs.readFileSync(paths.join(ART_DIR, file))), file);
        });
    });

    it('start with the font style and use only the commands seen working', () => {
        ripFiles().forEach(f => {
            const all = lines(f);
            assert.equal(all[0], '!|Y00000100', f);
            all.filter(l => l.includes('!|')).forEach(l => {
                //  one command per line, at its start
                assert.ok(l.startsWith('!|'), `${f}: ${l}`);
                assert.equal(l.split('!|').length, 2, `${f}: ${l}`);
                assert.match(l, Allowed, `${f}: ${l}`);
                assert.ok(!l.includes('%'), `${f}: an MCI code in ${l}`);
            });
            //  never reset windows or a text window, anywhere
            const text = fs.readFileSync(paths.join(ART_DIR, f), 'latin1');
            assert.ok(!/!\|\*|!\|w|\|\*|\|w/.test(text), f);
            //  no RIP on/off or query
            assert.ok(!/\x1b\[\d*!/.test(text), f);
        });
    });

    it('end their lines in CR LF', () => {
        fs.readdirSync(ART_DIR).forEach(f => {
            const text = fs.readFileSync(paths.join(ART_DIR, f), 'latin1');
            assert.ok(!/[^\r]\n|\r(?!\n)/.test(text), f);
            assert.ok(!text.endsWith('\r\n'), `${f}: the last line has no line end`);
            assert.ok(!text.includes('\x1a'), f);
        });
    });

    it('fit 640x350 and a 42 row screen, with the buttons above the status line', () => {
        ripFiles().forEach(f => {
            [42, 43, 44].forEach(rows => {
                const parsed = parseRip(f, rows);
                assert.ok(parsed.rip.length >= 10, f);
                //  the status line is last; nothing reaches row 42
                assert.ok(parsed.maxRow <= 41, `${f}: text on row ${parsed.maxRow}`);
                assert.equal(parsed.end[0], parsed.maxRow, f);
                const statusTop = (parsed.end[0] - 1) * 8;
                buttonsIn(f).forEach(b => {
                    assert.ok(b.x0 >= 0 && b.x1 < 640 && b.x0 < b.x1, f);
                    assert.ok(b.y0 >= 0 && b.y1 < 350 && b.y0 < b.y1, f);
                    //  and clear of the help text on rows 6 and 7
                    assert.ok(b.y0 > 7 * 8, `${f}: button over the help text`);
                    assert.ok(
                        b.y1 + 2 < statusTop,
                        `${f}: button reaches the status line`
                    );
                });
            });
            //  bars and rectangles too
            lines(f)
                .filter(l => /^!\|[BR@]/.test(l))
                .forEach(l => {
                    const [x0, y0] = [l.slice(3, 5), l.slice(5, 7)].map(s =>
                        parseInt(s, 36)
                    );
                    assert.ok(x0 < 640 && y0 < 350, `${f}: ${l}`);
                    if (!l.startsWith('!|@')) {
                        const [x1, y1] = [l.slice(7, 9), l.slice(9, 11)].map(s =>
                            parseInt(s, 36)
                        );
                        assert.ok(x1 < 640 && y1 < 350, `${f}: ${l}`);
                    }
                });
        });
    });

    it('have their MCI code in the ANSI text, the .ans the same one', () => {
        ripFiles().forEach(f => {
            const codes = parseRip(f, 42).mci.map(m => m.code);
            assert.equal(codes.length, 1, f);
            const ans = fs.readFileSync(
                paths.join(ART_DIR, f.replace(/\.rip$/, '.ans')),
                'latin1'
            );
            assert.ok(ans.includes(`%${codes[0]}`), f);
            assert.ok(!ans.includes('!|'), f);
        });
    });

    it('label every button in the .ans as well', () => {
        ripFiles().forEach(f => {
            const ans = fs
                .readFileSync(paths.join(ART_DIR, f.replace(/\.rip$/, '.ans')), 'latin1')
                .replace(/\x1b\[[0-9;]*m/g, '');
            buttonsIn(f).forEach(b => {
                const label = b.label.replace(/^\[.\] /, '');
                assert.ok(ans.includes(`[${b.command}] ${label}`), `${f}: ${label}`);
            });
        });
    });
});

describe('RIP branch on the stock connect menu (#989)', () => {
    let addConnectBranches;
    let RipStarter;

    before(() => {
        ({ addConnectBranches, RipStarter } = require('../core/oputil/oputil_config.js'));
    });

    const loginText = () =>
        fs.readFileSync(paths.join(TEMPLATE_DIR, 'login.in.hjson'), 'utf8');

    //  telnetConnected's next for a session of |emulation| with |layers|
    function nextFor(menus, emulation, layers = []) {
        const ACS = require('../core/acs.js');
        const client = {
            term: {
                emulation: {
                    name: emulation,
                    layers: new Map(layers.map(l => [l, {}])),
                },
            },
        };
        const acs = new ACS({ client, user: { groups: [], isGroupMember: () => false } });
        return acs.getConditionalValue(menus.telnetConnected.next, 'next');
    }

    it('sends RIP sessions to the RIP matrix and everyone else to the stock one', () => {
        const menus = hjson.parse(addConnectBranches(loginText(), ['rip'])).menus;
        assert.deepEqual(menus.telnetConnected.next, [
            { acs: 'TE[rip]', next: 'ripMatrix' },
            { next: 'matrix' },
        ]);
        assert.equal(nextFor(menus, 'ansi', ['rip']), RipStarter.afterConnectMenu);
        assert.equal(nextFor(menus, 'ansi'), 'matrix');
        assert.equal(nextFor(menus, 'petscii'), 'matrix');
        assert.ok(tree().menus[RipStarter.afterConnectMenu]);
    });

    it('composes with the other two: PETSCII, ATASCII, RIP, then the default', () => {
        [
            ['petscii', 'atascii', 'rip'],
            ['rip', 'atascii', 'petscii'],
        ].forEach(asked => {
            const menus = hjson.parse(addConnectBranches(loginText(), asked)).menus;
            assert.deepEqual(menus.telnetConnected.next, [
                { acs: 'TE[petscii]', next: 'petsciiMatrix' },
                { acs: 'TE[atascii]', next: 'atasciiMatrix' },
                { acs: 'TE[rip]', next: 'ripMatrix' },
                { next: 'matrix' },
            ]);
            assert.equal(nextFor(menus, 'ansi', ['rip']), 'ripMatrix');
            assert.equal(nextFor(menus, 'petscii'), 'petsciiMatrix');
            assert.equal(nextFor(menus, 'ansi'), 'matrix');
        });
    });

    it('changes nothing but telnetConnected.next', () => {
        const before = hjson.parse(loginText());
        const after = hjson.parse(addConnectBranches(loginText(), ['rip']));
        after.menus.telnetConnected.next = before.menus.telnetConnected.next;
        assert.deepEqual(after, before);
    });
});

describe('oputil config new and the RIP starter (#989)', function () {
    this.timeout(20000);

    let tmp;
    let restore = [];
    const asked = [];

    const answersFor = (includePetscii, includeAtascii, includeRip) => ({
        createNewConfig: true,
        configPath: paths.join(tmp, 'out', 'config.hjson'),
        overwriteConfig: true,
        boardName: 'Test Board',
        msgConfName: 'Local',
        msgConfDesc: 'Local Areas',
        msgAreaName: 'General',
        msgAreaDesc: 'General chit-chat',
        loggingLevel: 'info',
        includePetscii,
        includeAtascii,
        includeRip,
    });

    function stubInquirer(answers) {
        const inq = require('inquirer');
        const prompt = inq.prompt;
        const BottomBar = inq.ui.BottomBar;
        inq.prompt = questions => {
            questions.forEach(q => asked.push(q));
            return Promise.resolve(
                _.pick(
                    answers,
                    questions.map(q => q.name)
                )
            );
        };
        inq.ui.BottomBar = class {
            constructor() {
                this.log = { write() {} };
            }
        };
        restore.push(() => {
            inq.prompt = prompt;
            inq.ui.BottomBar = BottomBar;
        });
    }

    function runConfigNew(includePetscii, includeAtascii, includeRip) {
        stubInquirer(answersFor(includePetscii, includeAtascii, includeRip));
        const { buildNewConfig } = require('../core/oputil/oputil_config.js');
        const dirs = {
            installConfigDir: paths.join(tmp, 'config'),
            themesDir: paths.join(tmp, 'themes'),
            artDir: paths.join(tmp, 'art'),
        };
        fs.mkdirSync(dirs.themesDir, { recursive: true });
        fs.mkdirSync(dirs.artDir, { recursive: true });
        const log = console.info;
        console.info = () => {};
        return new Promise((resolve, reject) => {
            buildNewConfig(dirs, (err, configPath, result) => {
                console.info = log;
                if (err) return reject(new Error(String(err)));
                const menuDir = paths.join(dirs.installConfigDir, 'menus');
                resolve({
                    result: result || {},
                    config: readHjson(configPath),
                    menus: fs.readdirSync(menuDir).sort(),
                    menuDir,
                    file: n =>
                        fs.readFileSync(paths.join(menuDir, `test_board-${n}.hjson`)),
                    themes: fs.readdirSync(dirs.themesDir).sort(),
                    art: fs.readdirSync(dirs.artDir).sort(),
                    artDir: dirs.artDir,
                });
            });
        });
    }

    const template = n => fs.readFileSync(paths.join(TEMPLATE_DIR, `${n}.in.hjson`));
    const STOCK = [
        'message_base',
        'private_mail',
        'login',
        'new_user',
        'doors',
        'file_base',
        'activitypub',
    ];

    function validateReferences(out, themeIds) {
        const ConfigLoader = require('../core/config_loader.js');
        const merged = readHjson(paths.join(out.menuDir, 'test_board-main.hjson'));
        merged.includes.forEach(inc =>
            _.defaultsDeep(merged, readHjson(paths.join(out.menuDir, inc)))
        );
        const menus = new ConfigLoader({ hotReload: false })._resolveAtSpecs(
            merged
        ).menus;
        const { validateDeferredReferences } = require('../core/config/refs.js');
        const issues = validateDeferredReferences(out.config, {
            themeIds: ['luciano_blocktronics', ...themeIds],
            menuNames: Object.keys(menus),
        });
        assert.deepEqual(issues, []);
        return menus;
    }

    beforeEach(() => {
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-rip-starter-'));
        asked.length = 0;
    });

    afterEach(() => {
        restore.forEach(r => r());
        restore = [];
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('asks the RIP question after the ATASCII one, default No', async () => {
        await runConfigNew(false, false, false);
        const names = asked.map(q => q.name);
        const a = names.indexOf('includeAtascii');
        const r = names.indexOf('includeRip');
        assert.ok(a >= 0 && r === a + 1, names.join(','));
        assert.equal(r, names.length - 1);
        const q = asked[r];
        assert.equal(q.type, 'confirm');
        assert.equal(q.default, false);
        assert.equal(
            q.message,
            'Include starter menus and art for RIP (RIPscrip) callers?'
        );
    });

    it('No to all three writes exactly the stock menus, and no art', async () => {
        const out = await runConfigNew(false, false, false);
        assert.deepEqual(
            out.menus,
            STOCK.concat('main')
                .map(n => `test_board-${n}.hjson`)
                .sort()
        );
        STOCK.forEach(n => assert.ok(out.file(n).equals(template(n)), n));
        assert.equal(
            out.file('main').toString('utf8'),
            template('main')
                .toString('utf8')
                .replace(
                    /%INCLUDE_FILES%/g,
                    STOCK.map(n => `test_board-${n}.hjson`).join('\n\t\t')
                )
        );
        assert.deepEqual(out.art, []);
        assert.deepEqual(out.themes, []);
        assert.equal(_.get(out.config, 'theme.emulations'), undefined);
        assert.deepEqual(out.result.ripNotes, []);
    });

    it('a PETSCII and ATASCII board without RIP is written as before', async () => {
        const out = await runConfigNew(true, true, false);
        assert.ok(!/rip/i.test(out.file('main').toString('utf8')));
        assert.ok(!/TE\[rip\]/.test(out.file('login').toString('utf8')));
        assert.deepEqual(out.art, []);
    });

    it('RIP adds the menus, the branch and the art, and no theme', async () => {
        const out = await runConfigNew(false, false, true);
        assert.ok(out.menus.includes('test_board-rip.hjson'));
        assert.ok(out.file('rip').equals(template('rip')));
        assert.match(out.file('main').toString('utf8'), /test_board-rip\.hjson/);
        STOCK.filter(n => 'login' !== n).forEach(n =>
            assert.ok(out.file(n).equals(template(n)), n)
        );
        const login = readHjson(paths.join(out.menuDir, 'test_board-login.hjson'));
        assert.deepEqual(login.menus.telnetConnected.next, [
            { acs: 'TE[rip]', next: 'ripMatrix' },
            { next: 'matrix' },
        ]);
        assert.deepEqual(out.art, fs.readdirSync(ART_DIR).sort());
        out.art.forEach(f =>
            assert.ok(
                fs
                    .readFileSync(paths.join(out.artDir, f))
                    .equals(fs.readFileSync(paths.join(ART_DIR, f))),
                f
            )
        );
        assert.deepEqual(out.themes, []);
        assert.equal(_.get(out.config, 'theme.emulations'), undefined);
        const menus = validateReferences(out, []);
        assert.ok(menus.ripMatrix && menus.ripMain && menus.ripMessages);
        assert.deepEqual(out.result.ripNotes, []);
    });

    it('all three: three trees, two themes, the art and a three-way branch', async () => {
        const out = await runConfigNew(true, true, true);
        const main = out.file('main').toString('utf8');
        assert.ok(
            main.indexOf('test_board-atascii.hjson') <
                main.indexOf('test_board-rip.hjson')
        );
        const login = readHjson(paths.join(out.menuDir, 'test_board-login.hjson'));
        assert.equal(login.menus.telnetConnected.next.length, 4);
        assert.deepEqual(out.themes, ['atascii_starter', 'petscii_starter']);
        assert.deepEqual(Object.keys(out.config.theme.emulations), [
            'petscii',
            'atascii',
        ]);
        assert.deepEqual(out.art, fs.readdirSync(ART_DIR).sort());
        validateReferences(out, ['petscii_starter', 'atascii_starter']);
    });

    it('never overwrites an art file that is already there', async () => {
        const mine = paths.join(tmp, 'art', 'RMAIN.rip');
        fs.mkdirSync(paths.dirname(mine), { recursive: true });
        fs.writeFileSync(mine, 'mine');
        const out = await runConfigNew(false, false, true);
        assert.equal(fs.readFileSync(mine, 'utf8'), 'mine');
        assert.deepEqual(out.art, fs.readdirSync(ART_DIR).sort());
        assert.deepEqual(out.result.ripNotes, []);
    });

    describe('when the starter cannot be completed', () => {
        let errors;
        let consoleError;

        beforeEach(() => {
            errors = [];
            consoleError = console.error;
            console.error = (...args) => errors.push(args.join(' '));
        });

        afterEach(() => {
            console.error = consoleError;
        });

        it('a login menu in the way is kept, and the operator is told', async () => {
            const menuDir = paths.join(tmp, 'config', 'menus');
            fs.mkdirSync(menuDir, { recursive: true });
            const mine = paths.join(menuDir, 'test_board-login.hjson');
            fs.writeFileSync(mine, '{ mine: true }');
            const out = await runConfigNew(false, false, true);
            assert.equal(fs.readFileSync(mine, 'utf8'), '{ mine: true }');
            assert.equal(out.result.ripNotes.length, 1);
            assert.match(
                out.result.ripNotes[0],
                /already exists.*TE\[rip\].*RIP documentation/
            );
            assert.ok(errors.some(e => /RIP starter is not complete/.test(e)));
        });

        it('art that cannot be copied is reported, and the menus still written', async () => {
            const { RipStarter } = require('../core/oputil/oputil_config.js');
            const source = RipStarter.artSourceDir;
            const moved = `${source}.moved-by-test`;
            fs.renameSync(source, moved);
            try {
                const out = await runConfigNew(false, false, true);
                assert.equal(out.result.ripNotes.length, 1);
                assert.match(out.result.ripNotes[0], /art could not be copied/);
                assert.ok(out.menus.includes('test_board-rip.hjson'));
                assert.ok(errors.some(e => /RIP starter is not complete/.test(e)));
            } finally {
                fs.renameSync(moved, source);
            }
        });

        it('a complete run has nothing to report', async () => {
            const out = await runConfigNew(true, true, true);
            assert.deepEqual(out.result.ripNotes, []);
            assert.equal(errors.length, 0);
        });
    });
});
