'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

const { buildMenuSchema } = require('../core/config/menu_schema');
const { validateConfig } = require('../core/config/validate');
const { validateMenuReferences } = require('../core/config/refs');
const { IssueCodes, describeIssue } = require('../core/config/issue');

const schema = buildMenuSchema();

//  menu.hjson has no defaults object, so what the sysop wrote and the
//  effective configuration are the same thing
const validate = config => validateConfig(config, config, schema);
const codesIn = issues => issues.map(i => `${i.path}:${i.code}`);

//
//  The menus a stock install gets. oputil assembles main.in.hjson plus the
//  include files; unioning them here is the same set without the placeholder
//  substitution, which does not affect menu or prompt names.
//
function stockMenus() {
    const dir = paths.join(__dirname, '../misc/menu_templates');
    const out = { menus: {}, prompts: {} };

    fs.readdirSync(dir)
        .filter(f => f.endsWith('.in.hjson'))
        .forEach(f => {
            const text = fs
                .readFileSync(paths.join(dir, f), 'utf8')
                .replace(/%INCLUDE_FILES%/g, '')
                .replace(/XXXXX/g, 'x');
            const parsed = hjson.parse(text);
            Object.assign(out.menus, parsed.menus || {});
            Object.assign(out.prompts, parsed.prompts || {});
        });

    return out;
}

describe('menu schema against the shipped templates', () => {
    const stock = stockMenus();

    it('is reading something', () => {
        assert.ok(Object.keys(stock.menus).length > 100);
        assert.ok(Object.keys(stock.prompts).length > 5);
    });

    it('reports nothing about their structure', () => {
        //
        //  Inherited from #281: whatever "oputil.js config new" produces must
        //  be clean, or the check is unusable on a brand new installation.
        //
        assert.deepEqual(validate(stock), []);
    });

    it('reports no dangling menu or prompt references', () => {
        const issues = validateMenuReferences(stock);
        assert.deepEqual(
            issues.map(i => `${i.path} -> ${i.value}`),
            []
        );
    });
});

describe('menu schema', () => {
    const withMenu = menu => ({ menus: { testMenu: menu } });

    it('catches a misspelled menu entry key', () => {
        const issues = validate(withMenu({ desc: 'Test', modul: 'show_art' }));

        assert.deepEqual(codesIn(issues), ['menus.testMenu.modul:unknownKey']);
        assert.equal(issues[0].suggestion, 'module');
    });

    it('accepts the keys the code reads but no documentation lists', () => {
        //
        //  font, runtime and youSubmittedFormat are read at
        //  menu_module.js:906, menu_module.js:644 and bbs_list.js:213. Closing
        //  the key set on menu-hjson.md alone would report three working
        //  menus as containing typos.
        //
        assert.deepEqual(
            validate(
                withMenu({
                    desc: 'Test',
                    font: 'cp437',
                    runtime: { autoNext: true },
                    youSubmittedFormat: '{submitter} (You!)',
                })
            ),
            []
        );
    });

    it('rejects a menu level "acs", which nothing consults', () => {
        //  only config.acs is read, at core/acs.js:84
        const issues = validate(withMenu({ desc: 'Test', acs: 'ID1' }));

        assert.deepEqual(codesIn(issues), ['menus.testMenu.acs:unknownKey']);
    });

    it('accepts an acs inside config, which is the one that works', () => {
        assert.deepEqual(
            validate(withMenu({ desc: 'Test', config: { acs: 'ID1' } })),
            []
        );
    });

    it('rejects "fallback", which has done nothing since the menu stack', () => {
        const issues = validate(withMenu({ desc: 'Test', fallback: 'logoff' }));

        assert.deepEqual(codesIn(issues), ['menus.testMenu.fallback:unknownKey']);
    });

    it('says nothing about the contents of config, form or mci', () => {
        //
        //  config carries 69 module-specific keys on a real board and form is
        //  MCI territory; both are scoped out, and claiming to know them would
        //  report most menus on most boards.
        //
        assert.deepEqual(
            validate({
                menus: {
                    testMenu: {
                        config: { anythingAtAll: true, nested: { more: 1 } },
                        form: { 0: { mci: { XY9: { whatever: 'yes' } } } },
                    },
                },
                prompts: { testPrompt: { art: 'X', mci: { ZZ1: { any: 1 } } } },
            }),
            []
        );
    });

    it('catches a misspelled prompt entry key', () => {
        const issues = validate({ prompts: { p: { art: 'X', mcii: {} } } });

        assert.deepEqual(codesIn(issues), ['prompts.p.mcii:unknownKey']);
        assert.equal(issues[0].suggestion, 'mci');
    });

    it('catches a misspelled top-level section', () => {
        const issues = validate({ menus: {}, promtps: {} });

        assert.deepEqual(codesIn(issues), ['promtps:unknownKey']);
        assert.equal(issues[0].suggestion, 'prompts');
    });

    it('says nothing about the names a sysop gives their menus', () => {
        assert.deepEqual(
            validate({ menus: { whatever_they_called_it: { desc: 'x' } } }),
            []
        );
    });
});

describe('menu references', () => {
    const base = () => ({
        menus: {
            mainMenu: { desc: 'Main', prompt: 'menuCommand' },
            otherMenu: { desc: 'Other' },
        },
        prompts: { menuCommand: { art: 'PROMPT' } },
    });

    it('says nothing about a menu file that lines up', () => {
        assert.deepEqual(validateMenuReferences(base()), []);
    });

    it('catches a "next" naming a menu that does not exist', () => {
        const config = base();
        config.menus.mainMenu.next = 'otherMenuu';

        const issues = validateMenuReferences(config);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.UnresolvedRef);
        assert.equal(issues[0].path, 'menus.mainMenu.next');
        assert.equal(issues[0].suggestion, 'otherMenu');
    });

    it('leaves an "@" spec for something that is not a menu alone', () => {
        //
        //  handleNext() runs the value through
        //  asset.getAssetWithShorthand(spec, 'menu'), so a leading "@" makes it
        //  an asset spec. A first cut of this check reported four dangling
        //  menus on a production board, all of them "@systemMethod:logoff" and
        //  all of them correct.
        //
        const config = base();
        config.menus.mainMenu.next = '@systemMethod:logoff';
        config.menus.otherMenu.next = '@method:someLocalMethod';

        assert.deepEqual(validateMenuReferences(config), []);
    });

    it('does check an explicit "@menu:" spec', () => {
        const config = base();
        config.menus.mainMenu.next = '@menu:nowhere';

        const issues = validateMenuReferences(config);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].value, 'nowhere');
    });

    it('checks each branch of an ACS-guarded "next"', () => {
        const config = base();
        config.menus.mainMenu.next = [
            { acs: 'ID1', next: 'otherMenu' },
            { next: 'nowhere' },
        ];

        const issues = validateMenuReferences(config);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'menus.mainMenu.next[1]');
    });

    it('finds an "@menu:" buried in a submit handler', () => {
        //
        //  Walked rather than modelled: this is how the broken ActivityPub
        //  search command was found, three levels down inside an ACS-guarded
        //  action array.
        //
        const config = base();
        config.menus.mainMenu.submit = [
            {
                value: { command: 'S' },
                action: [
                    { acs: 'AE1', action: '@menu:nowhere' },
                    { action: '@menu:otherMenu' },
                ],
            },
        ];

        const issues = validateMenuReferences(config);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'menus.mainMenu.submit[0].action[0].action');
        assert.equal(issues[0].value, 'nowhere');
    });

    it('catches a prompt that does not exist', () => {
        const config = base();
        config.menus.mainMenu.prompt = 'menuComand';

        const issues = validateMenuReferences(config);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'menus.mainMenu.prompt');
        assert.equal(issues[0].suggestion, 'menuCommand');
        assert.match(
            describeIssue(issues[0]).message,
            /^prompt "menuComand" is not defined/
        );
    });

    it('says nothing when there are no menus to check against', () => {
        //  fail open, as everywhere else
        assert.deepEqual(validateMenuReferences({ menus: {} }), []);
        assert.deepEqual(validateMenuReferences({}), []);
        assert.deepEqual(validateMenuReferences(undefined), []);
    });
});
