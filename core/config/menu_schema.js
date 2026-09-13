/* jslint node: true */
'use strict';

//  ENiGMA½
const NodeType = require('./schema.js').NodeType;

//
//  A schema for menu.hjson.
//
//  Hand written, like core/config/achievement_schema.js: there is no defaults
//  object to derive one from, since core/theme.js hands its ConfigLoader no
//  defaultConfig at all.
//
//  Only the *structure* is described. "config", "form" and a prompt's "mci"
//  are left wide open on purpose:
//
//    * "config" carries 69 distinct keys across 56 modules on a real board,
//      and they belong to the module that reads them, not to menu.hjson. That
//      is a per-module corpus and a separate piece of work.
//
//    * "form" and "mci" need a real grammar -- explicit versus implicit form
//      shapes, MCI code keys, the immutable-property merge rules -- which is
//      the genuinely hard part of the file and is scoped separately.
//
//  What is closed is the small vocabulary around them, which is where a typo
//  is both likely and silent.
//
//  The key sets below come from the code that reads them rather than from the
//  files that ship. Four keys no documentation lists are legal -- |font|,
//  |runtime|, |youSubmittedFormat| and |action| -- and two keys that appear in
//  real menu files are not: a menu level |acs| is never consulted (only
//  config.acs is, at core/acs.js:84) and |fallback| has done nothing since the
//  menu stack replaced it.
//

//  A value that may be a string, an array of ACS-guarded alternatives, or an
//  object; saying nothing beats guessing wrong.
const ANY = {};

function menuEntryNode() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            desc: {
                type: NodeType.String,
                description: 'Shown in Who\'s Online and wherever %MD is used.',
            },
            //  a string, or an array of { acs, art } alternatives
            art: ANY,
            //  a menu name, an "@" asset spec, or an array of ACS alternatives
            next: ANY,
            prompt: {
                type: NodeType.String,
                description: 'Name of an entry in the "prompts" section.',
            },
            submit: ANY,
            //
            //  A menu driven by a "prompt" may carry an action directly
            //  instead of a by-form-id submit block; core/view_controller.js
            //  :653 reads it off the menu entry and says as much in the else
            //  branch right below.
            //
            action: ANY,
            form: {
                type: NodeType.Object,
                //  form and MCI validation is deliberately out of scope
                closedKeys: false,
            },
            module: {
                type: NodeType.String,
                description:
                    'Module driving this menu; a bare name is a system module, or use @userModule:.',
            },
            config: {
                type: NodeType.Object,
                //  module specific; see the note at the top of this file
                closedKeys: false,
            },

            //
            //  Read by the code, documented nowhere in menu-hjson.md. Leaving
            //  them out would report a working menu as containing a typo.
            //
            font: {
                type: NodeType.String,
                description:
                    'SyncTERM style font for this menu\'s art; also accepted under config.',
            },
            runtime: {
                type: NodeType.Object,
                closedKeys: true,
                children: {
                    autoNext: { type: NodeType.Boolean },
                },
                description: 'Read at core/menu_module.js:644.',
            },
            youSubmittedFormat: {
                type: NodeType.String,
                description: 'bbs_list only; see modules/bbs-list.md.',
            },
        },
    };
}

function promptEntryNode() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            art: {
                type: NodeType.String,
                description: 'Art file to display; required.',
            },
            //  note: no "form" wrapper on a prompt -- mci sits directly here
            mci: { type: NodeType.Object, closedKeys: false },
            config: { type: NodeType.Object, closedKeys: false },
            actionKeys: ANY,
        },
    };
}

function buildMenuSchema() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            includes: {
                type: NodeType.Array,
                items: { type: NodeType.String },
                description: 'Additional menu files merged into this one.',
            },
            //
            //  Not read by anything: it exists to hold fragments for
            //  "@reference:" to point at, the same role a "_"-prefixed block
            //  plays in config.hjson.
            //
            common: { type: NodeType.Object, closedKeys: false },

            menus: {
                type: NodeType.Object,
                openMap: true, //  keyed by menu name, which the sysop chooses
                closedKeys: false,
                value: menuEntryNode(),
            },
            prompts: {
                type: NodeType.Object,
                openMap: true,
                closedKeys: false,
                value: promptEntryNode(),
            },
        },
    };
}

module.exports = {
    buildMenuSchema,
};
