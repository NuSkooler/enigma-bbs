/* jslint node: true */
'use strict';

//  ENiGMA½
const NodeType = require('./schema.js').NodeType;

//
//  A schema for a theme's theme.hjson.
//
//  Small: two top level keys, five in "info", four in "customization". The
//  bulk of a theme by line count is under customization.menus and
//  customization.prompts, and that is MCI territory -- left wide open here,
//  scoped separately along with menu.hjson's "form" blocks.
//
//  What this does describe is the frame around it, plus -- through
//  validateThemeReferences() in refs.js -- the one thing that actually bites:
//  a customization naming a menu or prompt that does not exist is never
//  consulted by _finalizeTheme(), so the theming silently does not happen.
//
//  Two key names come from the code rather than from
//  art/themes.md, which lists the *helper method* names where the
//  configuration keys differ: the docs say getStatusAvailIndicators and
//  getStatusVisibleIndicators, while core/theme.js:386,394 read
//  statusAvailableIndicators and statusVisibleIndicators. Following the docs
//  here would have declared two keys nothing reads and rejected the two that
//  work.
//

function defaultsNode() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            passwordChar: {
                type: NodeType.String,
                description: 'Character shown in place of a password.',
            },
            //  each a { short, long } of moment.js format strings
            dateFormat: { type: NodeType.Object, closedKeys: false },
            timeFormat: { type: NodeType.Object, closedKeys: false },
            dateTimeFormat: { type: NodeType.Object, closedKeys: false },
            //  an array[2]; see core/theme.js:382-397
            statusAvailableIndicators: {
                type: NodeType.Array,
                description: 'Two entries: available, then not.',
            },
            statusVisibleIndicators: {
                type: NodeType.Array,
                description: 'Two entries: visible, then not.',
            },
        },
    };
}

function buildThemeSchema() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            info: {
                type: NodeType.Object,
                closedKeys: true,
                children: {
                    //  name and author are required by _themeLoaded(); a theme
                    //  missing either is skipped with a warning
                    name: { type: NodeType.String },
                    author: { type: NodeType.String },
                    group: { type: NodeType.String },
                    //  read at core/user_config.js:218, undocumented
                    desc: { type: NodeType.String },
                    enabled: {
                        type: NodeType.Boolean,
                        description: 'false hides this theme from users.',
                    },
                },
            },

            customization: {
                type: NodeType.Object,
                closedKeys: true,
                children: {
                    defaults: defaultsNode(),

                    //
                    //  Keyed by menu and prompt name. The *keys* are checked
                    //  against menu.hjson by validateThemeReferences(); the
                    //  values are MCI customization and are not described.
                    //
                    menus: {
                        type: NodeType.Object,
                        openMap: true,
                        closedKeys: false,
                        value: { type: NodeType.Object, closedKeys: false },
                    },
                    prompts: {
                        type: NodeType.Object,
                        openMap: true,
                        closedKeys: false,
                        value: { type: NodeType.Object, closedKeys: false },
                    },

                    //  passed through wholesale at core/theme.js:202
                    achievements: { type: NodeType.Object, closedKeys: false },
                },
            },
        },
    };
}

module.exports = {
    buildThemeSchema,
};
