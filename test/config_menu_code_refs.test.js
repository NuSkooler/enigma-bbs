'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');
const _ = require('lodash');

const ConfigLoader = require('../core/config_loader.js');

const MENU_DIR = paths.join(__dirname, '../misc/menu_templates');
const CORE_DIR = paths.join(__dirname, '../core');
const THEME = paths.join(__dirname, '../art/themes/luciano_blocktronics/theme.hjson');

const INCLUDES = [
    'message_base',
    'private_mail',
    'login',
    'new_user',
    'doors',
    'file_base',
    'activitypub',
];

function generatedMenuConfig() {
    const read = name =>
        hjson.parse(
            fs
                .readFileSync(paths.join(MENU_DIR, `${name}.in.hjson`), 'utf8')
                .replace(/%INCLUDE_FILES%/g, '')
        );

    const config = read('main');
    INCLUDES.forEach(inc => _.defaultsDeep(config, read(inc)));

    return new ConfigLoader({ hotReload: false })._resolveAtSpecs(config);
}

function coreJsFiles(dir = CORE_DIR, out = []) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const full = paths.join(dir, e.name);
        if (e.isDirectory()) {
            coreJsFiles(full, out);
        } else if (e.name.endsWith('.js')) {
            out.push(full);
        }
    });
    return out;
}

//
//  Menu names a module falls back to when its *MenuName config key is unset:
//
//      this.config.chatMenuName || 'sysopChat'
//      _.get(this.config, 'chatMenuName', 'sysopChat')
//
//  These never appear as an @menu: reference, so the existing @reference test
//  cannot see them -- rename the menu and the goto fails at runtime, only for
//  whoever presses that key.
//
const CODE_DEFAULT_RE = /[Mm]enuName['"]?\s*(?:\|\||,)\s*'([A-Za-z0-9_]+)'/g;

function codeDefaultMenuNames() {
    const found = new Map();
    coreJsFiles().forEach(file => {
        const src = fs.readFileSync(file, 'utf8');
        let m;
        CODE_DEFAULT_RE.lastIndex = 0;
        while ((m = CODE_DEFAULT_RE.exec(src)) !== null) {
            const rel = paths.relative(paths.join(__dirname, '..'), file);
            if (!found.has(m[1])) {
                found.set(m[1], rel);
            }
        }
    });
    return found;
}

//
//  Sysop-side copies of a user-facing menu. They exist so the +op path can be
//  themed and configured separately -- which means theme customization, keyed
//  by menu name, has to exist for both or the copy silently loses its
//  formatting. That is not a crash; the node list just renders as bare
//  "{text}" and nobody notices until they look at it.
//
const VARIANT_MENUS = {
    wfcNodeMessage: 'nodeMessage',
};

describe('menu names referenced from code', () => {
    let menus;

    before(() => {
        menus = generatedMenuConfig().menus;
    });

    it('finds the fallbacks it is meant to be checking', () => {
        //  Guards the regex itself: if the idiom changes and this silently
        //  matches nothing, the test below would pass forever.
        const names = codeDefaultMenuNames();
        assert.ok(
            names.size >= 3,
            `expected several code menu defaults, found ${names.size}`
        );
        assert.ok(names.has('sysopChat'));
    });

    it('every one resolves in the shipped menu templates', () => {
        const missing = [];
        codeDefaultMenuNames().forEach((file, name) => {
            if (!menus[name]) {
                missing.push(`${name} (default in ${file})`);
            }
        });

        assert.deepEqual(
            missing,
            [],
            `code falls back to menus that do not exist:\n  ${missing.join('\n  ')}`
        );
    });
});

describe('sysop-side menu variants', () => {
    let menus;
    let themeMenus;

    before(() => {
        menus = generatedMenuConfig().menus;
        themeMenus = _.get(
            hjson.parse(fs.readFileSync(THEME, 'utf8')),
            'customization.menus',
            {}
        );
    });

    Object.entries(VARIANT_MENUS).forEach(([variant, original]) => {
        it(`${variant} exists alongside ${original}`, () => {
            assert.ok(menus[original], `${original} missing from templates`);
            assert.ok(menus[variant], `${variant} missing from templates`);
            assert.equal(
                menus[variant].module,
                menus[original].module,
                `${variant} should drive the same module as ${original}`
            );
        });

        it(`${variant} is themed, not just defined`, () => {
            //  The regression this guards: adding the variant menu without a
            //  matching theme block. Customization is keyed by menu name, so
            //  the copy inherits nothing and its node list renders bare.
            assert.ok(
                themeMenus[original],
                `${original} has no theme customization to compare against`
            );
            assert.ok(
                themeMenus[variant],
                `${variant} has no theme customization; it will lose ${original}'s formatting`
            );
        });

        it(`${variant} customizes the same MCI codes as ${original}`, () => {
            const mciCodes = entry =>
                Object.keys(entry)
                    .filter(k => /^\d+$/.test(k))
                    .flatMap(form => Object.keys(_.get(entry, [form, 'mci'], {})))
                    .sort();

            assert.deepEqual(
                mciCodes(themeMenus[variant]),
                mciCodes(themeMenus[original]),
                `${variant} and ${original} have drifted apart in the theme`
            );
        });
    });
});
