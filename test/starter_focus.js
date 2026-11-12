'use strict';

//
//  Is focus visible in a starter theme (#593)? Shared by
//  test/petscii_starter.test.js and test/atascii_starter.test.js.
//
//  Every menu, list, toggle and footer menu a caller moves focus in is built
//  as the real view (vertical, horizontal or toggle menu), with the styles a
//  live session would give it: the SGR at its MCI code in the starter's own
//  art, then the menu's view config, then the theme's layout. Its output
//  goes through the emulation's real output translator onto a screen model,
//  and each item's cells are read back: the item in focus must be reversed
//  (PETSCII) or inverse (ATASCII), and every other item must not be.
//
//  Views draw their items one after the other, so a style that sets only a
//  foreground colour keeps the background of the item before it; drawing
//  the whole view is what catches that.
//
//  Everything that loads configuration is required inside the functions:
//  call them from a test or a before() hook only.
//

const fs = require('fs');
const paths = require('path');
const _ = require('lodash');

//  modules whose VM1 is a display list, never focused
const DISPLAY_ONLY = ['last_callers', 'whos_online'];

//  core/fse.js: the art each form of an editor menu is drawn from
const FSE_FORM_ART = {
    0: 'header',
    1: 'body',
    2: 'footerEditor',
    3: 'footerEditorMenu',
    4: 'footerView',
    5: 'quote',
    6: 'footerFind',
};

//  sample items for lists the modules fill at run time
const SAMPLE_ITEMS = [
    {
        text: 'first',
        index: 1,
        name: 'Alpha',
        msgNum: 1,
        subject: 'One',
        fromUserName: 'ann',
        newIndicator: '*',
    },
    {
        text: 'second',
        index: 2,
        name: 'Beta',
        msgNum: 2,
        subject: 'Two',
        fromUserName: 'bob',
        newIndicator: '*',
    },
    {
        text: 'third',
        index: 3,
        name: 'Gamma',
        msgNum: 3,
        subject: 'Three',
        fromUserName: 'cat',
        newIndicator: ' ',
    },
];

//  config keys that are not view styles or layout
const NOT_VIEW_PROPS = ['argName', 'submit', 'hotKeys', 'hotKeySubmit', 'focus'];

//  [{ menu, formId, key, art }] for every view a caller moves focus in
function focusableViews(tree) {
    const out = [];
    _.forEach(tree.menus, (menu, name) => {
        if (DISPLAY_ONLY.includes(menu.module)) {
            return;
        }
        _.forEach(menu.form || {}, (form, formId) => {
            const art = _.has(menu, 'config.art')
                ? menu.config.art[FSE_FORM_ART[formId]]
                : menu.art;
            Object.keys(form.mci || {})
                .filter(k => /^(VM|HM|TM)\d+$/.test(k))
                .forEach(key => out.push({ menu: name, formId, key, art }));
        });
    });
    return out;
}

//
//  |emu|: {
//      artDir, ext, termWidth, termHeight,
//      parseArt(bytes) -> [{ key, SGR, position }]   (MCI codes in order)
//      render(ansi) -> screen                        (translator + model)
//      flagged(screen, row, col) -> bool             (reversed / inverse)
//      cellText(screen, row, col) -> string
//  }
//  Returns a list of problems (empty when focus shows everywhere).
//
function focusProblems(tree, theme, emu) {
    const VerticalMenuView = require('../core/vertical_menu_view.js').VerticalMenuView;
    const HorizontalMenuView =
        require('../core/horizontal_menu_view.js').HorizontalMenuView;
    const ToggleMenuView = require('../core/toggle_menu_view.js').ToggleMenuView;
    const Classes = { VM: VerticalMenuView, HM: HorizontalMenuView, TM: ToggleMenuView };

    const problems = [];
    const custom = theme.customization.menus;

    focusableViews(tree).forEach(({ menu, formId, key, art }) => {
        const where = `${menu}.form.${formId}.${key}`;
        const bytes = fs.readFileSync(paths.join(emu.artDir, `${art}${emu.ext}`));
        const codes = emu.parseArt(bytes).filter(m => m.key === key);
        if (0 === codes.length) {
            problems.push(`${where}: no ${key} in ${art}`);
            return;
        }

        const out = [];
        const client = {
            term: {
                termWidth: emu.termWidth,
                termHeight: emu.termHeight,
                write: s => out.push(String(s)),
                rawWrite: s => out.push(String(s)),
            },
            log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
        };

        const view = new Classes[key.slice(0, 2)]({
            client,
            id: parseInt(key.slice(2), 10),
            styleSGR1: codes[0].SGR,
            //  art.js: a code drawn a second time gives the focus style
            styleSGR2: codes[1] ? codes[1].SGR : undefined,
            position: { row: codes[0].position[0], col: codes[0].position[1] },
        });

        const layout = Object.assign(
            {},
            _.get(tree.menus[menu], ['form', formId, 'mci', key], {}),
            _.get(custom, [menu, formId, 'mci', key]) ||
                _.get(custom, [menu, 'mci', key], {})
        );
        Object.entries(_.omit(layout, NOT_VIEW_PROPS)).forEach(([k, v]) =>
            view.setPropertyValue(k, v)
        );
        if (!layout.items) {
            //  filled by the module at run time: plain strings for the
            //  quote builder, records for the lists
            view.setItems(
                'VM3' === key ? SAMPLE_ITEMS.map(i => i.text) : _.cloneDeep(SAMPLE_ITEMS)
            );
        }

        view.setFocus(true);
        out.length = 0;
        view.redraw();
        const screen = emu.render(out.join(''));

        //  each item, found on its row by a word only it has, in drawing order
        const format = String(layout.itemFormat || '');
        const field = /\{name/.test(format)
            ? 'name'
            : /\{subject/.test(format)
              ? 'subject'
              : 'text';
        const focused = view.focusedItemIndex;
        const vertical = 'VM' === key.slice(0, 2);
        let from = 0;
        view.items.forEach((item, index) => {
            const label = _.isString(item) ? item : String(item[field] || item.text);
            const word = label.trim().split(/\s+/)[0];
            const row = vertical ? view.position.row + index : view.position.row;
            let line = '';
            for (let c = 1; c <= emu.termWidth; ++c) {
                line += emu.cellText(screen, row, c);
            }
            const at = line.indexOf(word, vertical ? 0 : from);
            if (!word || at < 0) {
                problems.push(
                    `${where}: item ${index} ("${word}") not found on row ${row}`
                );
                return;
            }
            const flags = _.range(at + 1, at + 1 + word.length).map(c =>
                emu.flagged(screen, row, c)
            );
            if (index === focused && !flags.every(Boolean)) {
                problems.push(`${where}: the focused item is not shown as focus`);
            }
            if (index !== focused && flags.some(Boolean)) {
                problems.push(`${where}: unfocused item ${index} looks focused`);
            }
            from = at + word.length;
        });
    });
    return problems;
}

module.exports = { focusableViews, focusProblems, DISPLAY_ONLY };
