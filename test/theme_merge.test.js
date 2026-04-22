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
