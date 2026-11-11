'use strict';

//
//  The PETSCII starter (#593): the menu tree in
//  misc/menu_templates/petscii.in.hjson, the starter theme in
//  misc/petscii_starter/, its generated art, and how "oputil.js config new"
//  opts a board in (or, by default, does not).
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const hjson = require('hjson');
const _ = require('lodash');

const ROOT = paths.join(__dirname, '..');
const TEMPLATE_DIR = paths.join(ROOT, 'misc/menu_templates');
const STARTER_DIR = paths.join(ROOT, 'misc/petscii_starter');

const readHjson = path => hjson.parse(fs.readFileSync(path, 'utf8'));
const tree = () => readHjson(paths.join(TEMPLATE_DIR, 'petscii.in.hjson'));
const starterTheme = () => readHjson(paths.join(STARTER_DIR, 'theme.hjson'));

//  system methods the tree may use; each ends the session or stays in place
const ALLOWED_SYSTEM_METHODS = [
    'login',
    'login2FA_OTP',
    'logoff',
    'prevMenu',
    'nextMenu',
];

//  Every menu or prompt a menu entry can lead to: [where, spec]
function targetsOf(name, menu) {
    const out = [];
    const add = (where, spec) => {
        if (_.isString(spec)) {
            out.push([where, spec]);
        } else if (Array.isArray(spec)) {
            spec.forEach((s, i) => {
                if (_.isString(s)) {
                    out.push([`${where}[${i}]`, s]);
                } else if (_.isPlainObject(s)) {
                    add(`${where}[${i}].next`, s.next);
                    add(`${where}[${i}].action`, s.action);
                }
            });
        }
    };

    add(`${name}.next`, menu.next);
    if (menu.prompt) {
        out.push([`${name}.prompt`, `@prompt:${menu.prompt}`]);
    }
    const config = menu.config || {};
    ['tooNodeMenu', 'inactive', 'disabled', 'locked', 'toomany'].forEach(k => {
        if (config[k]) {
            out.push([`${name}.config.${k}`, config[k]]);
        }
    });
    if (_.isString(config.pause) && !['end', 'pageBreak'].includes(config.pause)) {
        out.push([`${name}.config.pause`, `@prompt:${config.pause}`]);
    }

    _.forEach(menu.form || {}, (form, formId) => {
        _.forEach(form.submit || {}, (entries, key) => {
            (entries || []).forEach((e, i) =>
                add(`${name}.form.${formId}.submit.${key}[${i}].action`, e.action)
            );
        });
        (form.actionKeys || []).forEach((ak, i) =>
            add(`${name}.form.${formId}.actionKeys[${i}].action`, ak.action)
        );
    });
    return out;
}

//  { menu: [MCI keys its views need] }, menu forms plus theme layouts
function mciNeeded(menus, theme) {
    const needed = {};
    const push = (name, keys) => {
        needed[name] = _.uniq((needed[name] || []).concat(keys));
    };
    _.forEach(menus, (menu, name) => {
        _.forEach(menu.form || {}, form => push(name, Object.keys(form.mci || {})));
    });
    _.forEach(_.get(theme, 'customization.menus', {}), (custom, name) => {
        push(name, Object.keys(custom.mci || {}));
    });
    return needed;
}

function mciInArt(name) {
    const { PetsciiArtParser } = require('../core/term/petscii/art_parser.js');
    const found = [];
    const parser = new PetsciiArtParser({ mciReplaceChar: ' ' });
    parser.on('mci', m => found.push(`${m.mci}${null === m.id ? '' : m.id}`));
    parser.parse(fs.readFileSync(paths.join(STARTER_DIR, `${name}.seq`)));
    return found;
}

describe('PETSCII starter menus (#593)', () => {
    it('every menu and prompt is named petscii...', () => {
        const t = tree();
        Object.keys(t.menus).forEach(n => assert.match(n, /^petscii[A-Z]/));
        Object.keys(t.prompts).forEach(n => assert.match(n, /^petscii[A-Z]/));
    });

    it('no name collides with a stock menu or prompt', () => {
        const stock = { menus: new Set(), prompts: new Set() };
        fs.readdirSync(TEMPLATE_DIR)
            .filter(f => f.endsWith('.in.hjson') && 'petscii.in.hjson' !== f)
            .forEach(f => {
                const text = fs
                    .readFileSync(paths.join(TEMPLATE_DIR, f), 'utf8')
                    .replace(/%INCLUDE_FILES%/g, '');
                const parsed = hjson.parse(text);
                Object.keys(parsed.menus || {}).forEach(n => stock.menus.add(n));
                Object.keys(parsed.prompts || {}).forEach(n => stock.prompts.add(n));
            });
        const t = tree();
        Object.keys(t.menus).forEach(n => assert.ok(!stock.menus.has(n), n));
        Object.keys(t.prompts).forEach(n => assert.ok(!stock.prompts.has(n), n));
    });

    it('every next, action, prompt and config menu stays inside the tree', () => {
        const t = tree();
        const problems = [];
        _.forEach(t.menus, (menu, name) => {
            targetsOf(name, menu).forEach(([where, spec]) => {
                let m;
                if ((m = /^@systemMethod:(.+)$/.exec(spec))) {
                    if (!ALLOWED_SYSTEM_METHODS.includes(m[1])) {
                        problems.push(`${where}: ${spec}`);
                    }
                } else if ((m = /^@menu:(.+)$/.exec(spec))) {
                    if (!t.menus[m[1]]) problems.push(`${where}: ${spec}`);
                } else if ((m = /^@prompt:(.+)$/.exec(spec))) {
                    if (!t.prompts[m[1]]) problems.push(`${where}: ${spec}`);
                } else if (spec.startsWith('@')) {
                    problems.push(`${where}: ${spec} (not expected here)`);
                } else if (!t.menus[spec]) {
                    problems.push(`${where}: ${spec}`);
                }
            });
        });
        assert.deepEqual(problems, []);
    });

    it('found the links it checks', () => {
        const t = tree();
        const all = _.flatMap(t.menus, (menu, name) => targetsOf(name, menu));
        assert.ok(all.length >= 20, `only ${all.length} links found`);
    });

    it('every art name has a .seq file in the starter theme', () => {
        const t = tree();
        const arts = _.uniq(
            Object.values(t.menus)
                .map(m => m.art)
                .concat(Object.values(t.prompts).map(p => p.art))
                .filter(Boolean)
        );
        assert.ok(arts.length > 10);
        arts.forEach(art =>
            assert.ok(fs.existsSync(paths.join(STARTER_DIR, `${art}.seq`)), art)
        );
    });

    it("every view a menu needs has its MCI code in that menu's art", () => {
        const t = tree();
        const needed = mciNeeded(t.menus, starterTheme());
        let checked = 0;
        _.forEach(needed, (keys, name) => {
            const art = mciInArt(t.menus[name].art);
            keys.forEach(key => {
                assert.ok(
                    art.includes(key),
                    `${name}: ${key} not in ${t.menus[name].art}`
                );
                ++checked;
            });
        });
        assert.ok(checked >= 8, `only ${checked} views checked`);
    });

    it('the theme is a PETSCII theme customising only menus of the tree', () => {
        const theme = starterTheme();
        assert.equal(theme.info.emulation, 'petscii');
        const t = tree();
        Object.keys(theme.customization.menus).forEach(n => assert.ok(t.menus[n], n));
    });

    it('the generator reproduces the committed .seq files', () => {
        const { buildAll } = require('../dev_util/petscii_art/build.js');
        const built = buildAll();
        const committed = fs.readdirSync(STARTER_DIR).filter(f => f.endsWith('.seq'));
        assert.deepEqual(Object.keys(built).sort(), committed.sort());
        Object.entries(built).forEach(([file, bytes]) => {
            assert.ok(bytes.equals(fs.readFileSync(paths.join(STARTER_DIR, file))), file);
        });
    });

    it('the art is safe for a Commodore screen', () => {
        const { PetsciiScreen } = require('./term_petscii_screens.js');
        const { Controls } = require('../core/term/petscii/charset.js');
        fs.readdirSync(STARTER_DIR)
            .filter(f => f.endsWith('.seq'))
            .forEach(file => {
                const bytes = fs.readFileSync(paths.join(STARTER_DIR, file));
                assert.ok(!bytes.includes(Controls.delete), `${file}: DELETE`);
                assert.ok(!bytes.includes(Controls.insert), `${file}: INSERT`);
                assert.ok(bytes.length < 1024, `${file}: ${bytes.length} bytes`);
                //  throws on anything a terminal must not be sent
                const screen = new PetsciiScreen(40, 25, { row: 0, col: 0 });
                screen.write(bytes);
                assert.equal(screen.scrolls, 0, `${file} scrolled the screen`);
            });
    });
});

describe('PETSCII branch on the stock connect menu (#593)', () => {
    let addPetsciiConnectBranch;
    let PetsciiStarter;

    before(() => {
        ({
            addPetsciiConnectBranch,
            PetsciiStarter,
        } = require('../core/oputil/oputil_config.js'));
    });

    const loginText = () =>
        fs.readFileSync(paths.join(TEMPLATE_DIR, 'login.in.hjson'), 'utf8');

    //  telnetConnected's next, resolved for a session of |emulation|
    function nextFor(menus, emulation) {
        const ACS = require('../core/acs.js');
        const client = { term: { emulation: { name: emulation, layers: new Map() } } };
        const acs = new ACS({ client, user: { groups: [], isGroupMember: () => false } });
        return acs.getConditionalValue(menus.telnetConnected.next, 'next');
    }

    it('the stock login template is unchanged by it', () => {
        assert.equal(hjson.parse(loginText()).menus.telnetConnected.next, 'matrix');
    });

    it('sends PETSCII sessions to the starter matrix and ANSI ones to the stock one', () => {
        const menus = hjson.parse(addPetsciiConnectBranch(loginText())).menus;
        assert.equal(nextFor(menus, 'petscii'), PetsciiStarter.afterConnectMenu);
        assert.equal(nextFor(menus, 'ansi'), 'matrix');
        assert.ok(tree().menus[PetsciiStarter.afterConnectMenu]);
    });

    it('changes nothing but telnetConnected.next', () => {
        const before = hjson.parse(loginText());
        const after = hjson.parse(addPetsciiConnectBranch(loginText()));
        assert.notDeepEqual(
            after.menus.telnetConnected.next,
            before.menus.telnetConnected.next
        );
        after.menus.telnetConnected.next = before.menus.telnetConnected.next;
        assert.deepEqual(after, before);
    });

    it('works on a checkout with CRLF line endings', () => {
        const crlf = loginText().replace(/\r?\n/g, '\r\n');
        const out = addPetsciiConnectBranch(crlf);
        assert.ok(!/[^\r]\n/.test(out), 'a bare LF crept in');
        assert.equal(nextFor(hjson.parse(out).menus, 'petscii'), 'petsciiMatrix');
    });

    it('refuses text without the stock telnetConnected entry', () => {
        assert.throws(() => addPetsciiConnectBranch('{ menus: {} }'));
    });
});

describe('oputil config new and the PETSCII starter (#593)', function () {
    this.timeout(20000);

    let tmp;
    let restore = [];

    //  Answers for every question config new asks
    const answersFor = includePetscii => ({
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
    });

    function stubInquirer(answers) {
        const inq = require('inquirer');
        const prompt = inq.prompt;
        const BottomBar = inq.ui.BottomBar;
        inq.prompt = questions =>
            Promise.resolve(
                _.pick(
                    answers,
                    questions.map(q => q.name)
                )
            );
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

    function runConfigNew(includePetscii) {
        stubInquirer(answersFor(includePetscii));
        const { buildNewConfig } = require('../core/oputil/oputil_config.js');
        const dirs = {
            installConfigDir: paths.join(tmp, 'config'),
            themesDir: paths.join(tmp, 'themes'),
        };
        fs.mkdirSync(dirs.themesDir, { recursive: true });
        const log = console.info;
        console.info = () => {};
        return new Promise((resolve, reject) => {
            buildNewConfig(dirs, (err, configPath) => {
                console.info = log;
                if (err) return reject(new Error(String(err)));
                resolve({
                    config: readHjson(configPath),
                    menus: fs
                        .readdirSync(paths.join(dirs.installConfigDir, 'menus'))
                        .sort(),
                    menuDir: paths.join(dirs.installConfigDir, 'menus'),
                    themes: fs.readdirSync(dirs.themesDir),
                    themesDir: dirs.themesDir,
                });
            });
        });
    }

    beforeEach(() => {
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-petscii-starter-'));
    });

    afterEach(() => {
        restore.forEach(r => r());
        restore = [];
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('on No writes exactly the stock menus and no PETSCII settings', async () => {
        const out = await runConfigNew(false);
        assert.deepEqual(out.menus, [
            'test_board-activitypub.hjson',
            'test_board-doors.hjson',
            'test_board-file_base.hjson',
            'test_board-login.hjson',
            'test_board-main.hjson',
            'test_board-message_base.hjson',
            'test_board-new_user.hjson',
            'test_board-private_mail.hjson',
        ]);
        assert.deepEqual(out.themes, []);
        assert.equal(_.get(out.config, 'theme.emulations'), undefined);
        assert.equal(_.get(out.config, 'loginServers.telnet.emulations'), undefined);

        //  the copies are the templates, byte for byte
        ['login', 'new_user', 'doors'].forEach(n =>
            assert.ok(
                fs
                    .readFileSync(paths.join(out.menuDir, `test_board-${n}.hjson`))
                    .equals(fs.readFileSync(paths.join(TEMPLATE_DIR, `${n}.in.hjson`))),
                n
            )
        );
        const main = fs.readFileSync(
            paths.join(out.menuDir, 'test_board-main.hjson'),
            'utf8'
        );
        assert.ok(!/petscii/i.test(main));
    });

    it('on Yes adds the menus, the branch, the theme and the theme setting', async () => {
        const { PetsciiStarter } = require('../core/oputil/oputil_config.js');
        const out = await runConfigNew(true);

        assert.ok(out.menus.includes('test_board-petscii.hjson'));
        assert.ok(
            fs
                .readFileSync(paths.join(out.menuDir, 'test_board-petscii.hjson'))
                .equals(fs.readFileSync(paths.join(TEMPLATE_DIR, 'petscii.in.hjson')))
        );
        const main = fs.readFileSync(
            paths.join(out.menuDir, 'test_board-main.hjson'),
            'utf8'
        );
        assert.match(main, /test_board-petscii\.hjson/);

        const login = readHjson(paths.join(out.menuDir, 'test_board-login.hjson'));
        assert.ok(Array.isArray(login.menus.telnetConnected.next));

        assert.deepEqual(out.themes, [PetsciiStarter.themeId]);
        const copied = fs
            .readdirSync(paths.join(out.themesDir, PetsciiStarter.themeId))
            .sort();
        assert.deepEqual(copied, fs.readdirSync(STARTER_DIR).sort());

        assert.deepEqual(out.config.theme.emulations, {
            petscii: { default: 'petscii_starter', preLogin: 'petscii_starter' },
        });
        assert.equal(_.get(out.config, 'loginServers.telnet.emulations'), undefined);

        //  every menu the generated menus name exists, and so does the theme
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
            themeIds: ['luciano_blocktronics', PetsciiStarter.themeId],
            menuNames: Object.keys(menus),
        });
        assert.deepEqual(issues, []);
        assert.ok(menus[PetsciiStarter.afterConnectMenu]);
        assert.ok(menus[PetsciiStarter.firstMenu]);
    });

    it('never overwrites a theme directory that is already there', async () => {
        const { PetsciiStarter } = require('../core/oputil/oputil_config.js');
        const mine = paths.join(tmp, 'themes', PetsciiStarter.themeId);
        fs.mkdirSync(mine, { recursive: true });
        fs.writeFileSync(paths.join(mine, 'theme.hjson'), '{ mine: true }');
        await runConfigNew(true);
        assert.equal(
            fs.readFileSync(paths.join(mine, 'theme.hjson'), 'utf8'),
            '{ mine: true }'
        );
        assert.deepEqual(fs.readdirSync(mine), ['theme.hjson']);
    });
});
