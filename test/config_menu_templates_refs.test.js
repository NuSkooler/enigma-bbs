'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');
const _ = require('lodash');
const eachDeep = require('deepdash/getEachDeep')(_);

const ConfigLoader = require('../core/config_loader.js');

const DIR = paths.join(__dirname, '../misc/menu_templates');

//  The include list oputil.js writes into main.in.hjson; see
//  core/oputil/oputil_config.js.
const INCLUDES = [
    'message_base',
    'private_mail',
    'login',
    'new_user',
    'doors',
    'file_base',
    'activitypub',
];

//
//  What "oputil.js config new" would produce: main.in.hjson with its includes
//  merged in the same way ConfigLoader#_resolveIncludes does, then run through
//  the real resolver rather than a copy of it.
//
function generatedMenuConfig() {
    const read = name =>
        hjson.parse(
            fs
                .readFileSync(paths.join(DIR, `${name}.in.hjson`), 'utf8')
                .replace(/%INCLUDE_FILES%/g, '')
        );

    const config = read('main');
    INCLUDES.forEach(inc => _.defaultsDeep(config, read(inc)));

    return new ConfigLoader({ hotReload: false })._resolveAtSpecs(config);
}

describe('@reference specs in the shipped menu templates', () => {
    const config = generatedMenuConfig();

    it('is reading something', () => {
        assert.ok(
            Object.keys(config.menus || {}).length > 100,
            `expected many menus, found ${Object.keys(config.menus || {}).length}`
        );
    });

    //
    //  An unresolved "@reference:" is left in place as a string rather than
    //  raising anything -- see core/config_loader.js -- so a typo, or a
    //  fragment that was renamed without its users being updated, survives all
    //  the way to a running board. In actionKeys it is silently dropped
    //  (core/view_controller.js skips entries without an array "keys"), which
    //  is to say the key just stops working.
    //
    it('every @reference resolves', () => {
        const unresolved = [];

        eachDeep(config, (value, key, parent, ctx) => {
            if (_.isString(value) && value.startsWith('@reference:')) {
                unresolved.push(`${ctx.path} -> ${value}`);
            }
        });

        assert.deepEqual(unresolved, []);
    });

    //
    //  core/view_controller.js builds its key map with
    //  "if (!Array.isArray(ak.keys)) return;", so an entry that is not an
    //  object with a "keys" array contributes nothing and says nothing.
    //
    it('every actionKeys entry is usable', () => {
        const bad = [];

        eachDeep(config, (value, key, parent, ctx) => {
            if ('actionKeys' !== key) {
                return;
            }

            if (!Array.isArray(value)) {
                bad.push(`${ctx.path} is ${typeof value}, not an array`);
                return;
            }

            value.forEach((entry, i) => {
                if (!_.isObject(entry) || !Array.isArray(entry.keys)) {
                    bad.push(`${ctx.path}[${i}] -> ${JSON.stringify(entry)}`);
                }
            });
        });

        assert.deepEqual(bad, []);
    });

    //
    //  The shared bindings are published in two shapes on purpose: the array
    //  for a menu that has nothing but the shared binding, the entry for one
    //  that lists its own keys beside it. Referencing the array in that second
    //  case would replace the menu's own keys rather than extend them.
    //
    it('publishes each shared prevMenu binding as both an entry and an array', () => {
        ['escToPrev', 'quitToPrev'].forEach(name => {
            const entry = config.common[`${name}Entry`];
            const array = config.common[name];

            assert.ok(_.isPlainObject(entry), `common.${name}Entry is missing`);
            assert.ok(Array.isArray(array), `common.${name} is missing`);
            assert.deepEqual(
                array,
                [entry],
                `common.${name} should be common.${name}Entry on its own`
            );
        });
    });

    //
    //  Guards the conversion in the other direction: if these fall back to
    //  being written out by hand, the fragments stop being worth having. Read
    //  from the templates as written rather than from the resolved config,
    //  where a reference and a copy look alike by construction.
    //
    it('the menus reference the shared bindings rather than copying them', () => {
        const shared = [config.common.escToPrevEntry, config.common.quitToPrevEntry];
        const copies = [];
        let referenced = 0;

        ['main', ...INCLUDES].forEach(name => {
            const raw = hjson.parse(
                fs
                    .readFileSync(paths.join(DIR, `${name}.in.hjson`), 'utf8')
                    .replace(/%INCLUDE_FILES%/g, '')
            );

            eachDeep(raw, (value, key, parent, ctx) => {
                if ('actionKeys' !== key) {
                    return;
                }

                if (_.isString(value) && value.startsWith('@reference:')) {
                    referenced++;
                    return;
                }

                if (!Array.isArray(value)) {
                    return;
                }

                value.forEach((entry, i) => {
                    if (_.isString(entry) && entry.startsWith('@reference:')) {
                        referenced++;
                    } else if (shared.some(s => _.isEqual(s, entry))) {
                        copies.push(`${name}.in.hjson: ${ctx.path}[${i}]`);
                    }
                });
            });
        });

        assert.deepEqual(copies, []);
        assert.ok(referenced > 25, `expected many references, found ${referenced}`);
    });
});

//
//  The full screen editor's footer was two text labels -- %TL1 for the cursor
//  position and %TL2 for INS/OVR, configured through a "TLTL" block on form 2
//  -- until a single %SB1 StatusBarView with named panels replaced them. The
//  shipped art moved; three of these menus did not, and nothing said so.
//
//  core/fse.js drives the bar with setPanel('pos') and setPanel('mode'), and
//  StatusBarView.setPanel() returns early unless the view was built with a
//  panels array, which only a form 2 SB1 block supplies. A menu still carrying
//  TLTL therefore renders an empty footer: no position, no INS/OVR, nothing
//  logged. The config validator cannot catch it either -- MCI blocks belong to
//  the modules that read them and are deliberately left unchecked.
//
describe('editor footers in the shipped menu templates', () => {
    const config = generatedMenuConfig();

    //  an editor menu is one that names footer art to draw
    const editorMenus = Object.entries(config.menus || {}).filter(([, menu]) =>
        _.isString(_.get(menu, 'config.art.footerEditor'))
    );

    it('is reading something', () => {
        assert.ok(
            editorMenus.length > 3,
            `expected several editor menus, found ${editorMenus.length}`
        );
    });

    it('every editor footer configures the status bar', () => {
        const missing = editorMenus
            .filter(([, menu]) => !_.get(menu, 'form.2.mci.SB1'))
            .map(([name]) => name);

        assert.deepEqual(missing, []);
    });

    it('no editor still carries the retired TLTL block', () => {
        const stale = editorMenus
            .filter(([, menu]) => _.has(menu, 'form.2.TLTL'))
            .map(([name]) => name);

        assert.deepEqual(stale, []);
    });
});
