'use strict';

const { strict: assert } = require('assert');
const _ = require('lodash');

//
//  Config mock — must be in place before requiring theme.js
//
const configModule = require('../core/config.js');
configModule.get = () => ({
    debug: { assertsEnabled: false },
    theme: {
        passwordChar: '*',
        dateFormat: { short: 'MM/DD/YYYY', long: 'dddd, MMMM Do YYYY' },
        timeFormat: { short: 'h:mm a', long: 'h:mm:ss a' },
        dateTimeFormat: {
            short: 'MM/DD/YYYY h:mm a',
            long: 'dddd, MMMM Do YYYY h:mm:ss a',
        },
        statusAvailableIndicators: ['Y', 'N'],
        statusVisibleIndicators: ['Y', 'N'],
        timeWarningText: 'CONFIG: {minutes} minute{plural} left',
    },
    general: {},
    paths: {},
});

const { ThemeManager } = require('../core/theme.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeThemeManager(menuData) {
    const tm = new ThemeManager();
    tm.menuConfig = {
        get: () => menuData,
    };
    return tm;
}

function makeThemeConfig(rawThemeData) {
    return {
        getRaw: () => rawThemeData,
        get: () => rawThemeData,
        current: null,
    };
}

// ─── config block merge ───────────────────────────────────────────────────────

describe('ThemeManager._finalizeTheme() — config block merging', () => {
    it('deep-merges nested config objects so sibling keys are preserved', () => {
        const menuData = {
            menus: {
                mainMenu: {
                    config: {
                        display: { style: 'bold', color: 'blue' },
                        cls: true,
                    },
                },
            },
            prompts: {},
        };

        const themeData = {
            info: { name: 'TestTheme', author: 'Tester', enabled: true },
            customization: {
                menus: {
                    mainMenu: {
                        config: {
                            //  Only override color — style must survive the merge
                            display: { color: 'red' },
                        },
                    },
                },
            },
        };

        const tm = makeThemeManager(menuData);
        const themeConfig = makeThemeConfig(themeData);

        tm._finalizeTheme('testTheme', themeConfig);

        const merged = themeConfig.current;
        assert.equal(
            merged.menus.mainMenu.config.display.color,
            'red',
            'Theme override for color should be applied'
        );
        assert.equal(
            merged.menus.mainMenu.config.display.style,
            'bold',
            'Menu base style should be preserved after deep merge'
        );
        assert.equal(
            merged.menus.mainMenu.config.cls,
            true,
            'Other config keys at same level should be preserved'
        );
    });

    it('shallow Object.assign behaviour (old bug) would have dropped sibling keys', () => {
        //  This test documents the old broken behaviour to ensure we don't regress.
        //  Object.assign({display:{style:'bold',color:'blue'}}, {display:{color:'red'}})
        //  produces {display:{color:'red'}} — style is lost.
        const baseConfig = { display: { style: 'bold', color: 'blue' } };
        const themeOverride = { display: { color: 'red' } };
        const brokenResult = Object.assign({}, baseConfig, themeOverride);
        //  Confirm the bug: style is lost with Object.assign
        assert.equal(brokenResult.display.style, undefined);

        //  Confirm the fix: style is preserved with _.merge
        const fixedResult = _.merge({}, baseConfig, themeOverride);
        assert.equal(fixedResult.display.style, 'bold');
        assert.equal(fixedResult.display.color, 'red');
    });
});

// ─── getRaw() used for theme customization ────────────────────────────────────

describe('ThemeManager._finalizeTheme() — uses getRaw() for theme data', () => {
    it('re-finalization uses raw theme data, not a previously merged overlay', () => {
        const menuData = {
            menus: {
                main: { config: { cls: false } },
            },
            prompts: {},
        };

        const rawThemeData = {
            info: { name: 'T', author: 'A', enabled: true },
            customization: {
                menus: {
                    main: { config: { cls: true } },
                },
            },
        };

        const tm = makeThemeManager(menuData);
        const themeConfig = {
            getRaw: () => rawThemeData,
            //  Simulate a previously merged current that has extra junk in it
            get: () => Object.assign({}, rawThemeData, { menus: { extra: {} } }),
            current: null,
        };

        tm._finalizeTheme('t', themeConfig);

        //  Raw theme data override should be applied
        assert.equal(themeConfig.current.menus.main.config.cls, true);
        //  The "extra" menu from the polluted get() result must NOT appear
        assert.equal(themeConfig.current.menus.extra, undefined);
    });
});

// ─── info block ───────────────────────────────────────────────────────────────

describe('ThemeManager._finalizeTheme() — info block', () => {
    it('sets info from raw theme data and injects themeId', () => {
        const menuData = { menus: { m: {} }, prompts: {} };
        const themeData = {
            info: { name: 'My Theme', author: 'NuSkooler', enabled: true },
            customization: {},
        };

        const tm = makeThemeManager(menuData);
        const themeConfig = makeThemeConfig(themeData);

        tm._finalizeTheme('myTheme', themeConfig);

        assert.equal(themeConfig.current.info.name, 'My Theme');
        assert.equal(themeConfig.current.info.author, 'NuSkooler');
        assert.equal(themeConfig.current.info.themeId, 'myTheme');
    });
});

// ─── MCI immutable properties ─────────────────────────────────────────────────

describe('ThemeManager._finalizeTheme() — MCI immutable properties', () => {
    it('theme cannot override maxLength on a form MCI entry', () => {
        const menuData = {
            menus: {
                loginForm: {
                    form: {
                        0: {
                            mci: {
                                ET1: { maxLength: 20, textStyle: 'normal' },
                            },
                        },
                    },
                },
            },
            prompts: {},
        };

        const themeData = {
            info: { name: 'T', author: 'A', enabled: true },
            customization: {
                menus: {
                    loginForm: {
                        mci: {
                            ET1: { maxLength: 999, textStyle: 'upper' },
                        },
                    },
                },
            },
        };

        const tm = makeThemeManager(menuData);
        const themeConfig = makeThemeConfig(themeData);

        tm._finalizeTheme('t', themeConfig);

        const mci = themeConfig.current.menus.loginForm.form[0].mci.ET1;
        assert.equal(mci.maxLength, 20, 'maxLength must not be overridden by theme');
        assert.equal(
            mci.textStyle,
            'upper',
            'non-immutable property should be overridden'
        );
    });
});

// ─── TableView (%TV) deep merge ───────────────────────────────────────────────

describe('ThemeManager._finalizeTheme() — TableView MCI merge', () => {
    const finalize = (menuMci, themeMci) => {
        const menuData = {
            menus: { idx: { form: { 0: { mci: menuMci } } } },
            prompts: {},
        };
        const themeData = {
            info: { name: 'T', author: 'A', enabled: true },
            customization: { menus: { idx: { mci: themeMci } } },
        };
        const tm = makeThemeManager(menuData);
        const themeConfig = makeThemeConfig(themeData);
        tm._finalizeTheme('t', themeConfig);
        return themeConfig.current.menus.idx.form[0].mci;
    };

    it('deep-merges columns, so a theme can set one column property alone', () => {
        const mci = finalize(
            {
                TV1: {
                    columns: {
                        area: { field: 'areaName', width: 'fill' },
                        new: { field: 'newCount', width: 5, sgr: '|08' },
                    },
                },
            },
            { TV1: { columns: { new: { sgr: '|10' } } } }
        );
        assert.deepEqual(mci.TV1.columns, {
            area: { field: 'areaName', width: 'fill' },
            new: { field: 'newCount', width: 5, sgr: '|10' },
        });
    });

    it('deep-merges stateSGR, sort and group', () => {
        const mci = finalize(
            {
                TV1: {
                    stateSGR: { new: '|15', personal: '|13' },
                    sort: { column: 'new', order: 'desc', then: 'area' },
                    group: { format: '{text}', fillChar: '-' },
                },
            },
            {
                TV1: {
                    stateSGR: { personal: '|12' },
                    sort: { order: 'asc' },
                    group: { sgr: '|08' },
                },
            }
        );
        assert.deepEqual(mci.TV1.stateSGR, { new: '|15', personal: '|12' });
        assert.deepEqual(mci.TV1.sort, { column: 'new', order: 'asc', then: 'area' });
        assert.deepEqual(mci.TV1.group, { format: '{text}', fillChar: '-', sgr: '|08' });
    });

    it('replaces arrays inside merged objects and other TV keys', () => {
        const mci = finalize(
            {
                TV1: {
                    columnOrder: ['a', 'b', 'c'],
                    sortable: ['a', 'b'],
                    sort: { column: 'a', then: ['b', 'c'] },
                    height: 10,
                },
            },
            {
                TV1: {
                    columnOrder: ['c'],
                    sortable: ['c'],
                    sort: { then: ['c'] },
                },
            }
        );
        assert.deepEqual(mci.TV1.columnOrder, ['c']);
        assert.deepEqual(mci.TV1.sortable, ['c']);
        assert.deepEqual(mci.TV1.sort, { column: 'a', then: ['c'] });
        assert.equal(mci.TV1.height, 10);
    });

    it('keeps immutable properties on TV entries', () => {
        const mci = finalize({ TV1: { submit: true } }, { TV1: { submit: false } });
        assert.equal(mci.TV1.submit, true);
    });

    it('still replaces nested values on other views (VM, SB)', () => {
        const mci = finalize(
            {
                VM1: { columns: { a: { x: 1, y: 2 } }, focusTextStyle: 'upper' },
                SB1: {
                    panels: [
                        { name: 'a', width: 5 },
                        { name: 'b', width: 6 },
                    ],
                    sort: { column: 'a', order: 'desc' },
                },
            },
            {
                VM1: { columns: { a: { x: 9 } } },
                SB1: { panels: [{ name: 'z' }], sort: { order: 'asc' } },
            }
        );
        assert.deepEqual(mci.VM1.columns, { a: { x: 9 } });
        assert.equal(mci.VM1.focusTextStyle, 'upper');
        assert.deepEqual(mci.SB1.panels, [{ name: 'z' }]);
        assert.deepEqual(mci.SB1.sort, { order: 'asc' });
    });

    it('a VM key on TV art keeps replace behaviour (the key names the type)', () => {
        const mci = finalize(
            { VM1: { stateSGR: { new: '|15', personal: '|13' } } },
            { VM1: { stateSGR: { personal: '|12' } } }
        );
        assert.deepEqual(mci.VM1.stateSGR, { personal: '|12' });
    });
});

// ─── theme helpers ────────────────────────────────────────────────────────────

describe('ThemeManager._setThemeHelpers() — getTimeWarningText', () => {
    const helpersFor = theme => {
        makeThemeManager({})._setThemeHelpers(theme);
        return theme.helpers;
    };

    //
    //  theme.js late binds config.js's |get|, so pushing a config in a hook
    //  reaches it whatever order the suite loaded in.
    //
    let previousConfig;
    const withConfiguredText = timeWarningText => {
        configModule._popTestConfig(previousConfig);
        previousConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            theme: { timeWarningText },
            general: {},
            paths: {},
        });
    };

    beforeEach(() => {
        previousConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            theme: { timeWarningText: 'CONFIG: {minutes} minute{plural} left' },
            general: {},
            paths: {},
        });
    });

    afterEach(() => {
        configModule._popTestConfig(previousConfig);
    });

    it('uses the configured text when the theme says nothing', () => {
        assert.equal(
            helpersFor({}).getTimeWarningText(),
            'CONFIG: {minutes} minute{plural} left'
        );
    });

    it('lets a theme override it', () => {
        const helpers = helpersFor({
            customization: { defaults: { timeWarningText: 'THEME: {minutes}' } },
        });
        assert.equal(helpers.getTimeWarningText(), 'THEME: {minutes}');
    });

    //
    //  An empty string means "no warning" and must survive both layers. The
    //  "||" the sibling helpers use would swallow it and substitute a
    //  default, which is the inconsistency this helper avoids.
    //
    it('honours an empty string from the configuration', () => {
        withConfiguredText('');
        assert.equal(helpersFor({}).getTimeWarningText(), '');
    });

    it('honours an empty string from the theme', () => {
        const helpers = helpersFor({
            customization: { defaults: { timeWarningText: '' } },
        });
        assert.equal(helpers.getTimeWarningText(), '');
    });

    //  the same shape as getPasswordChar and the date formats beside it
    it('is defined alongside the other customization helpers', () => {
        const helpers = helpersFor({});
        ['getPasswordChar', 'getDateFormat', 'getTimeWarningText'].forEach(name =>
            assert.equal(typeof helpers[name], 'function', name)
        );
    });
});
