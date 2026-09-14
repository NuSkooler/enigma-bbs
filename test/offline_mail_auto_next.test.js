'use strict';

const { strict: assert } = require('assert');

const { MenuModule } = require('../core/menu_module.js');
const QWKExport = require('../core/message_base_qwk_export.js').getModule;
const BlueWaveExport = require('../core/message_base_bluewave_export.js').getModule;
const OfflineImport = require('../core/message_base_offline_import.js').getModule;

//
//  MenuModule.initSequence() calls finishedLoading() and then autoNextMenu().
//  A menu with neither a form nor a prompt -- which is how the templates and
//  the docs show all three of these -- has runtime.autoNext set for it by
//  ThemeManager, so the automatic transition fires on top of the one the
//  module makes for itself. menuStack.prev() has no guard against being asked
//  twice, so an export drops the caller two menus back; an import, whose
//  upload starts behind an async mkdir(), loses the race outright and unwinds
//  the stack while gotoMenu() is still in flight.
//
//  Each module therefore refuses the automatic transition.
//
function makeContext() {
    const calls = { prev: 0, next: 0 };
    return {
        calls,
        //  a menu the theme has marked as "display it, then move on"
        menuConfig: { runtime: { autoNext: true }, config: {} },
        haveNext: () => calls.next > 0,
        prevMenu: cb => {
            calls.prev += 1;
            return cb && cb(null);
        },
        displayQueuedInterruptions: cb => cb(null),
        hasNextTimeout: () => false,
    };
}

describe('offline mail menus refuse the automatic next', () => {
    const modules = [
        ['QWK export', QWKExport],
        ['Blue Wave export', BlueWaveExport],
        ['offline mail import', OfflineImport],
    ];

    modules.forEach(([name, Module]) => {
        it(`${name} does not transition on its own`, () => {
            const context = makeContext();
            Module.prototype.autoNextMenu.call(context, () => {});
            assert.equal(
                context.calls.prev,
                0,
                'autoNextMenu() must not leave the menu; the module does that itself'
            );
        });

        it(`${name} overrides MenuModule's implementation`, () => {
            assert.notEqual(
                Module.prototype.autoNextMenu,
                MenuModule.prototype.autoNextMenu,
                'the override is what prevents the double transition'
            );
        });
    });

    //
    //  Guards the test itself: if MenuModule ever stops auto-nexting a menu
    //  marked this way, the assertions above would pass for the wrong reason.
    //
    it('MenuModule would otherwise transition', () => {
        const context = makeContext();
        MenuModule.prototype.autoNextMenu.call(context, () => {});
        assert.equal(context.calls.prev, 1);
    });
});
