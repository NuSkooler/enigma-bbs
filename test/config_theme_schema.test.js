'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

const { buildThemeSchema } = require('../core/config/theme_schema');
const { validateConfig } = require('../core/config/validate');
const { validateThemeReferences } = require('../core/config/refs');
const { IssueCodes, Severity, describeIssue } = require('../core/config/issue');

const schema = buildThemeSchema();
const validate = theme => validateConfig(theme, theme, schema);
const codesIn = issues => issues.map(i => `${i.path}:${i.code}`);

const THEME_DIR = paths.join(__dirname, '../art/themes');

function shippedThemes() {
    return fs
        .readdirSync(THEME_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => paths.join(THEME_DIR, entry.name, 'theme.hjson'))
        .filter(path => fs.existsSync(path))
        .map(path => ({ path, theme: hjson.parse(fs.readFileSync(path, 'utf8')) }));
}

function stockMenuNames() {
    const dir = paths.join(__dirname, '../misc/menu_templates');
    const menus = {};
    const prompts = {};

    fs.readdirSync(dir)
        .filter(f => f.endsWith('.in.hjson'))
        .forEach(f => {
            const text = fs
                .readFileSync(paths.join(dir, f), 'utf8')
                .replace(/%INCLUDE_FILES%/g, '')
                .replace(/XXXXX/g, 'x');
            const parsed = hjson.parse(text);
            Object.assign(menus, parsed.menus || {});
            Object.assign(prompts, parsed.prompts || {});
        });

    return { menuNames: Object.keys(menus), menuPromptNames: Object.keys(prompts) };
}

describe('theme schema against the shipped themes', () => {
    const themes = shippedThemes();

    it('is reading something', () => {
        assert.ok(themes.length > 0);
    });

    themes.forEach(({ path, theme }) => {
        it(`reports nothing about ${paths.basename(paths.dirname(path))}`, () => {
            assert.deepEqual(validate(theme), []);
        });
    });

    it('finds no customization naming a menu the templates do not define', () => {
        //
        //  The check the whole effort exists for, and the acceptance criterion
        //  for it: a shipped theme against the shipped menus reports nothing.
        //  It started at 7 menu and 1 prompt orphans; #778 corrected the
        //  theme, #779 supplied the one menu that was genuinely missing.
        //
        const names = stockMenuNames();
        const orphans = themes.flatMap(({ path, theme }) =>
            validateThemeReferences(theme, names).map(
                i => `${paths.basename(paths.dirname(path))}: ${i.path}`
            )
        );

        assert.deepEqual(orphans, []);
    });
});

describe('theme schema', () => {
    it('catches a misspelled info key', () => {
        const issues = validate({ info: { name: 'X', auther: 'Y' } });

        assert.deepEqual(codesIn(issues), ['info.auther:unknownKey']);
        assert.equal(issues[0].suggestion, 'author');
    });

    it('accepts "desc", which the code reads and the docs omit', () => {
        //  core/user_config.js:218
        assert.deepEqual(
            validate({ info: { name: 'X', author: 'Y', desc: 'A theme', group: 'G' } }),
            []
        );
    });

    it('uses the key names the code reads, not the helper names in the docs', () => {
        //
        //  docs/_docs/art/themes.md lists getStatusAvailIndicators and
        //  getStatusVisibleIndicators, which are the *helper methods*.
        //  core/theme.js:386,394 read statusAvailableIndicators and
        //  statusVisibleIndicators. Following the docs would declare two keys
        //  nothing reads and reject the two that work.
        //
        assert.deepEqual(
            validate({
                customization: {
                    defaults: {
                        statusAvailableIndicators: ['Y', 'N'],
                        statusVisibleIndicators: ['Y', 'N'],
                    },
                },
            }),
            []
        );

        const issues = validate({
            customization: { defaults: { getStatusAvailIndicators: ['Y', 'N'] } },
        });
        assert.deepEqual(codesIn(issues), [
            'customization.defaults.getStatusAvailIndicators:unknownKey',
        ]);
    });

    it('catches a misspelled customization section', () => {
        const issues = validate({ customization: { menuz: {} } });

        assert.deepEqual(codesIn(issues), ['customization.menuz:unknownKey']);
        assert.equal(issues[0].suggestion, 'menus');
    });

    it('says nothing about MCI customization, which is out of scope', () => {
        assert.deepEqual(
            validate({
                customization: {
                    menus: { anyMenu: { 0: { mci: { XY9: { width: 3 } } } } },
                    prompts: { anyPrompt: { mci: { TL1: { text: 'x' } } } },
                    achievements: { anything: true },
                },
            }),
            []
        );
    });
});

describe('theme references', () => {
    const names = {
        menuNames: ['mainMenu', 'fileBaseSearch'],
        menuPromptNames: ['menuCommand'],
    };
    const themeWith = customization => ({
        info: { name: 'T', author: 'A' },
        customization,
    });

    it('says nothing when every customization names something real', () => {
        assert.deepEqual(
            validateThemeReferences(
                themeWith({ menus: { mainMenu: {} }, prompts: { menuCommand: {} } }),
                names
            ),
            []
        );
    });

    it('reports a customization that names no menu, as a warning', () => {
        //
        //  A warning rather than an error: a board running a menu file older
        //  than the shipped theme gets these legitimately, and failing its
        //  "config validate" over cosmetics would be wrong.
        //
        const issues = validateThemeReferences(
            themeWith({ menus: { mainMenuu: {} } }),
            names
        );

        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.DeadCustomization);
        assert.equal(issues[0].severity, Severity.Warning);
        assert.equal(issues[0].path, 'customization.menus.mainMenuu');
        assert.equal(
            describeIssue(issues[0]).message,
            'no menu named "mainMenuu" -- this customization is never applied; did you mean "mainMenu"?'
        );
    });

    it('reports a customization that names no prompt', () => {
        const issues = validateThemeReferences(
            themeWith({ prompts: { menuComand: {} } }),
            names
        );

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'customization.prompts.menuComand');
        assert.equal(issues[0].suggestion, 'menuCommand');
    });

    it('reports a wholly mismatched theme once, not entry by entry', () => {
        //
        //  A handful of dead entries are typos worth naming. Most of them
        //  being dead is a different fact -- the theme was written against
        //  another menu file -- and listing seventy of them buries every other
        //  finding and gets the whole check switched off.
        //
        const customization = { menus: {} };
        for (let i = 0; i < 20; ++i) {
            customization.menus[`someOtherMenu${i}`] = {};
        }
        customization.menus.mainMenu = {};

        const issues = validateThemeReferences(themeWith(customization), names);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'customization.menus');
        assert.equal(
            describeIssue(issues[0]).message,
            '20 of 21 menu customizations name something this system does not define, ' +
                'so they are never applied -- this theme looks written for a different menu file'
        );
    });

    it('still names them individually when only a few are dead', () => {
        const customization = {
            menus: { mainMenu: {}, fileBaseSearch: {}, mainMenuu: {} },
        };

        const issues = validateThemeReferences(themeWith(customization), names);

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'customization.menus.mainMenuu');
    });

    it('says nothing when the menu names could not be gathered', () => {
        const theme = themeWith({ menus: { nothingLikeThis: {} } });

        assert.deepEqual(validateThemeReferences(theme, {}), []);
        assert.deepEqual(validateThemeReferences(theme, { menuNames: [] }), []);
        assert.deepEqual(validateThemeReferences(theme), []);
    });
});
