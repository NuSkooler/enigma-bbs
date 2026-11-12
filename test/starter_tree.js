'use strict';

//
//  Shared by test/petscii_starter.test.js and test/atascii_starter.test.js
//  (#593): what a starter menu tree may lead to, and which art and MCI codes
//  its menus need. Pure functions over a parsed menu file and theme.
//

const { strict: assert } = require('assert');
const _ = require('lodash');

//  system methods the tree may use; each ends the session or stays in place
const ALLOWED_SYSTEM_METHODS = [
    'login',
    'login2FA_OTP',
    'logoff',
    'prevMenu',
    'nextMenu',
];

//
//  Module methods the tree may use. Each stays in its module, goes back, or
//  goes to a menu named in the menu's config or extraArgs, which targetsOf()
//  collects and the tree check follows (menuViewPost, menuNewPost, the
//  pre-art menus, messageBasePostMessageNoAccess, extraArgs.menu).
//
const ALLOWED_METHODS = [
    //  msg_conf_list, msg_area_list
    'changeConference',
    'changeArea',
    //  msg_list
    'selectMessage',
    'postNewMessage',
    'fullExit',
    'markAllRead',
    //  fse.js and its view / post modules
    'headerSubmit',
    'headerEscapePressed',
    'editModeEscPressed',
    'editModeQuickHelp',
    'editModeChangeSubject',
    'editModeMenuSave',
    'editModeMenuHelp',
    'editModeMenuQuote',
    'appendQuoteEntry',
    'quoteBuilderEscPressed',
    'prevMessage',
    'nextMessage',
    'replyMessage',
    'viewModeMenuHelp',
    'movementKeyPressed',
    'editModeFind',
    'viewModeFind',
    'viewModeFindNext',
    'viewModeFindPrev',
    'footerFindSubmit',
    'footerFindCancel',
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
    [
        'tooNodeMenu',
        'inactive',
        'disabled',
        'locked',
        'toomany',
        //  message modules
        'menuViewPost',
        'menuNewPost',
        'changeConfPreArtMenu',
        'changeAreaPreArtMenu',
        'messageBasePostMessageNoAccess',
        //  new_scan
        'newScanMessageList',
        'newScanActivityPubList',
        'newScanFileBaseList',
        'noReplyGhostSenderMenu',
    ].forEach(k => {
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
        (form.actionKeys || []).forEach((ak, i) => {
            add(`${name}.form.${formId}.actionKeys[${i}].action`, ak.action);
            if (_.has(ak, 'extraArgs.menu')) {
                out.push([
                    `${name}.form.${formId}.actionKeys[${i}].extraArgs.menu`,
                    ak.extraArgs.menu,
                ]);
            }
        });
        _.forEach(form.submit || {}, (entries, key) => {
            (entries || []).forEach((e, i) => {
                if (_.has(e, 'extraArgs.menu')) {
                    out.push([
                        `${name}.form.${formId}.submit.${key}[${i}].extraArgs.menu`,
                        e.extraArgs.menu,
                    ]);
                }
            });
        });
    });
    return out;
}

//
//  The full-screen editor (core/fse.js) draws its screen from several pieces
//  of art, each with a form of its own: form id -> config.art name.
//
const FSE_MODULES = ['msg_area_view_fse', 'msg_area_post_fse'];
const FSE_FORM_ART = {
    0: 'header',
    1: 'body',
    2: 'footerEditor',
    3: 'footerEditorMenu',
    4: 'footerView',
    5: 'quote',
    6: 'footerFind',
};

const isFse = menu => FSE_MODULES.includes(menu.module);

//  every art name a menu shows: [art, ...]
function artNamesOf(menu) {
    if (isFse(menu)) {
        return Object.values(_.get(menu, 'config.art', {}));
    }
    return menu.art ? [menu.art] : [];
}

//  [[art name, form id], ...] for each form of a menu
function formArts(menu) {
    if (isFse(menu)) {
        return Object.keys(menu.form || {}).map(id => [
            _.get(menu, ['config', 'art', FSE_FORM_ART[id]]),
            id,
        ]);
    }
    return [[menu.art, '0']];
}

//
//  { art name: [MCI keys its views need] }, from the menu forms plus the theme
//  layouts (a theme gives a layout per form id for a menu with several forms,
//  and one 'mci' block for a menu with one)
//
function mciNeeded(menus, theme) {
    const needed = {};
    const push = (art, keys) => {
        needed[art] = _.uniq((needed[art] || []).concat(keys));
    };
    _.forEach(menus, (menu, name) => {
        const arts = _.fromPairs(formArts(menu).map(([art, id]) => [id, art]));
        _.forEach(menu.form || {}, (form, id) => {
            assert.ok(arts[id], `${name}: form ${id} has no art`);
            push(arts[id], Object.keys(form.mci || {}));
        });
        const custom = _.get(theme, ['customization', 'menus', name], {});
        if (custom.mci) {
            push(arts['0'] || menu.art, Object.keys(custom.mci));
        }
        Object.keys(custom)
            .filter(k => /^\d+$/.test(k))
            .forEach(id => {
                assert.ok(arts[id], `${name}: theme layout for form ${id} has no art`);
                push(arts[id], Object.keys(custom[id].mci || {}));
            });
    });
    return needed;
}

module.exports = {
    ALLOWED_SYSTEM_METHODS,
    ALLOWED_METHODS,
    FSE_MODULES,
    FSE_FORM_ART,
    targetsOf,
    isFse,
    artNamesOf,
    formArts,
    mciNeeded,
};
