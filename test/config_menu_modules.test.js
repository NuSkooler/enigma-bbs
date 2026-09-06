'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

const { validateMenuModules } = require('../core/config/refs');
const {
    makeModuleResolver,
    defaultModuleResolver,
} = require('../core/config/module_resolver');
const { describeIssue } = require('../core/config/issue');

const CORE = paths.join(__dirname, '..', 'core');
const MODS = paths.join(__dirname, '..', 'mods');

const resolver = () => makeModuleResolver({ systemPath: CORE, userPath: MODS });

function stockMenus() {
    const dir = paths.join(__dirname, '../misc/menu_templates');
    const menus = {};

    fs.readdirSync(dir)
        .filter(f => f.endsWith('.in.hjson'))
        .forEach(f => {
            const text = fs
                .readFileSync(paths.join(dir, f), 'utf8')
                .replace(/%INCLUDE_FILES%/g, '')
                .replace(/XXXXX/g, 'x');
            Object.assign(menus, hjson.parse(text).menus || {});
        });

    return { menus };
}

describe('menu modules against the shipped templates', () => {
    const stock = stockMenus();

    it('is reading something', () => {
        const modules = new Set(
            Object.values(stock.menus)
                .map(m => m.module)
                .filter(Boolean)
        );
        assert.ok(modules.size > 40, `expected many modules, found ${modules.size}`);
    });

    it('every module they name can actually be loaded', () => {
        //
        //  This found sysopBinkpPollNow naming "binkp_poll", which has never
        //  existed -- the module is core/binkp/binkp_poll_module.js -- on a
        //  menu reachable from the sysop "!BINKP" command.
        //
        const issues = validateMenuModules(stock, resolver());

        assert.deepEqual(
            issues.map(i => `${i.path} -> ${i.value}`),
            []
        );
    });
});

describe('menu module resolution', () => {
    it('finds a module at <name>.js', () => {
        assert.equal(resolver()({ type: 'systemModule', asset: 'show_art' }), true);
    });

    it('finds one down a relative path, as the templates use', () => {
        //  activitypub/ap_search and ./activitypub/... both appear in real files
        assert.equal(
            resolver()({ type: 'systemModule', asset: 'binkp/binkp_poll_module' }),
            true
        );
        assert.equal(
            resolver()({ type: 'systemModule', asset: './activitypub/ap_search' }),
            true
        );
    });

    it('does not find one that is not there', () => {
        assert.equal(
            resolver()({ type: 'systemModule', asset: 'no_such_module_at_all' }),
            false
        );
    });

    it('refuses a name that climbs out of its directory', () => {
        //  a module name may contain separators, so this has to be said
        assert.equal(resolver()({ type: 'systemModule', asset: '../package' }), false);
    });

    it('refuses one where only the nested candidate escapes', () => {
        //
        //  Found by review: the containment check looked at "<name>.js" and
        //  not at "<name>/<basename>.js". Given "..", appending ".js" makes a
        //  filename inside the root -- so that candidate looks contained --
        //  while the nested form climbs out of it. The test above never
        //  covered this, because "../package" escapes on the first candidate.
        //
        const escaping = paths.resolve(CORE, '..', '...js');
        fs.writeFileSync(escaping, 'module.exports = {};');

        try {
            ['..', './..', 'foo/../..'].forEach(asset => {
                assert.equal(
                    resolver()({ type: 'systemModule', asset }),
                    false,
                    `accepted "${asset}", which resolves outside core/`
                );
            });
        } finally {
            fs.unlinkSync(escaping);
        }
    });

    it('does not choke on a boxed String', () => {
        //
        //  _.isString() -- the gate in refs.js -- is true for one, and
        //  path.basename() then refuses it outright. Unreachable through
        //  hjson, which yields primitives, but it is the mechanism that made
        //  the unguarded oputil path a crash rather than a report.
        //
        assert.equal(
            resolver()({ type: 'systemModule', asset: new String('show_art') }),
            true
        );
    });

    it('checks nothing when it has nowhere to look', () => {
        assert.equal(makeModuleResolver({}), undefined);
        assert.equal(makeModuleResolver(), undefined);
    });

    it('does not object to a user module when no mods path is configured', () => {
        const r = makeModuleResolver({ systemPath: CORE });
        assert.equal(r({ type: 'userModule', asset: 'anything_at_all' }), true);
    });

    it('takes its system path from where menu_util looks', () => {
        //  core/menu_util.js:83 uses its own __dirname, which is core/
        const r = defaultModuleResolver({ paths: { mods: MODS } });
        assert.equal(r({ type: 'systemModule', asset: 'show_art' }), true);
    });
});

describe('menu module validation', () => {
    const withModule = module => ({ menus: { testMenu: { desc: 'T', module } } });

    it('says nothing about a module that is there', () => {
        assert.deepEqual(validateMenuModules(withModule('show_art'), resolver()), []);
    });

    it('catches a module that is not', () => {
        const issues = validateMenuModules(withModule('no_such_module'), resolver());

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'menus.testMenu.module');
        assert.match(
            describeIssue(issues[0]).message,
            /no "no_such_module\.js" there, nor "no_such_module\/no_such_module\.js"/
        );
    });

    it('catches a spec that is not a module spec at all', () => {
        //
        //  getModuleAsset() asserts the type is systemModule or userModule, and
        //  an assert throws straight out of the waterfall that loads the menu.
        //  Worse than a module that is merely missing.
        //
        const issues = validateMenuModules(withModule('@method:notAModule'), resolver());

        assert.equal(issues.length, 1);
        assert.match(
            describeIssue(issues[0]).message,
            /"@method:" does not name a module/
        );
    });

    it('looks for a user module under the mods path', () => {
        const r = makeModuleResolver({ systemPath: CORE, userPath: '/nonexistent' });
        const issues = validateMenuModules(withModule('@userModule:whatever'), r);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].refPath, 'paths.mods');
    });

    it('reports rather than crashes on a module value that is not a spec', () => {
        //
        //  Found by review: the caller checks _.isString but not emptiness, so
        //  "module: ''" returned undefined from the parser and the next line
        //  read .type off it. That escaped oputil's nested callbacks entirely
        //  and killed the process with a raw stack trace.
        //
        ['', '   ', '@', '@@@', '@:', '@menu'].forEach(module => {
            const issues = validateMenuModules(withModule(module), resolver());
            assert.ok(
                issues.length >= 0,
                `threw or misbehaved on ${JSON.stringify(module)}`
            );
        });

        const empty = validateMenuModules(withModule(''), resolver());
        assert.equal(empty.length, 1);
        assert.match(
            describeIssue(empty[0]).message,
            /a menu module must be a bare name or "@userModule:"/
        );
    });

    it('says nothing when there is no resolver', () => {
        //  fail open, as everywhere else
        assert.deepEqual(validateMenuModules(withModule('no_such_module')), []);
        assert.deepEqual(
            validateMenuModules(withModule('no_such_module'), undefined),
            []
        );
    });

    it('says nothing about a menu with no module', () => {
        assert.deepEqual(
            validateMenuModules({ menus: { m: { desc: 'x' } } }, resolver()),
            []
        );
    });
});

describe('module asset parsing', () => {
    it('recognises the same asset types core/asset.js does', () => {
        //
        //  refs.js parses the spec itself rather than requiring core/asset.js,
        //  which pulls in stat_log.js and its load-time database handle. That
        //  copy needs watching.
        //
        const asset = require('../core/asset');

        //  bare name, and each accepted "@" form, must agree with getAssetWithShorthand
        [
            'show_art',
            '@systemModule:show_art',
            '@userModule:some_mod',
            '@method:notAModule',
        ].forEach(spec => {
            const theirs = asset.getAssetWithShorthand(spec, 'systemModule');
            const issues = validateMenuModules(
                { menus: { m: { module: spec } } },
                () => true //  resolve everything; only the type matters here
            );

            const weAccept = 0 === issues.length;
            const theyAccept = ['systemModule', 'userModule'].includes(theirs.type);

            assert.equal(
                weAccept,
                theyAccept,
                `disagreement on "${spec}": core/asset.js says ${theirs.type}`
            );
        });
    });
});
