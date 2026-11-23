'use strict';

//
//  #1145: the user config screen filled its terminal height field with
//  user.properties.term_height.toString(), which threw for a user created
//  without one (oputil, an import, a mod). It now shows this session's
//  height, as signup stores.
//
//  The real mciReady() runs; the art, form loading and theme list are
//  stubbed, and what each field is given is recorded.
//

const { strict: assert } = require('assert');

const { MenuModule } = require('../core/menu_module.js');
const { ViewController } = require('../core/view_controller.js');
const theme = require('../core/theme.js');
const UserProps = require('../core/user_property.js');

const TermHeightMci = 8;

describe('user config: the terminal height field (#1145)', () => {
    const saved = {};

    before(() => {
        saved.mciReady = MenuModule.prototype.mciReady;
        saved.load = ViewController.prototype.loadFromMenuConfig;
        saved.getSelectableThemes = theme.getSelectableThemes;
        saved.getSessionThemeId = theme.getSessionThemeId;

        MenuModule.prototype.mciReady = function (mciData, cb) {
            return cb(null);
        };
        ViewController.prototype.loadFromMenuConfig = function (options, cb) {
            return cb(null);
        };
        theme.getSelectableThemes = () => [];
        theme.getSessionThemeId = () => 'luciano_blocktronics';
    });

    after(() => {
        MenuModule.prototype.mciReady = saved.mciReady;
        ViewController.prototype.loadFromMenuConfig = saved.load;
        theme.getSelectableThemes = saved.getSelectableThemes;
        theme.getSessionThemeId = saved.getSessionThemeId;
    });

    function makeLog() {
        const log = { child: () => log };
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
            log[level] = () => {};
        });
        return log;
    }

    //  the text given to the term height field, for a user with |properties|
    function termHeightShown(properties) {
        const UserConfig = require('../core/user_config.js').getModule;
        const client = {
            log: makeLog(),
            term: { termHeight: 31, termWidth: 80 },
            on: () => {},
            once: () => {},
            removeListener: () => {},
            user: {
                properties,
                realName: () => 'Some Body',
            },
        };
        const mod = new UserConfig({
            menuName: 'userConfig',
            menuConfig: { config: {} },
            client,
        });
        mod.validateMCIByViewIds = (form, ids, cb) => cb(null);
        mod.prevMenu = () => assert.fail('init failed');

        const given = {};
        mod.setViewText = (form, mciId, text) => {
            given[mciId] = text;
        };

        let done = false;
        mod.mciReady({ menu: {} }, err => {
            assert.ifError(err);
            done = true;
        });
        assert.ok(done, 'mciReady() finished');
        return given[TermHeightMci];
    }

    it('a user with no term_height: this session height, no throw', () => {
        assert.equal(termHeightShown({}), '31');
    });

    it('a user with a term_height: that value, as before', () => {
        assert.equal(termHeightShown({ [UserProps.TermHeight]: 50 }), '50');
        assert.equal(termHeightShown({ [UserProps.TermHeight]: '24' }), '24');
    });
});
