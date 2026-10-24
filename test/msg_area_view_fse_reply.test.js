'use strict';

const { strict: assert } = require('assert');

//  A theme with no extraArgs.menu for replyMessage must not wedge the view
//  controller: the handler has to log and still call back (see #832).

const configModule = require('../core/config.js');

describe('AreaViewFSEModule replyMessage', () => {
    it('logs and calls back when extraArgs.menu is missing', done => {
        const previous = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            menus: { cls: false },
        });

        let mod;
        const warnings = [];
        try {
            const { getModule } = require('../core/msg_area_view_fse.js');
            const log = () => {
                throw new Error('client.log is a logger, not a function');
            };
            Object.assign(log, {
                warn: (...a) => warnings.push(a),
                error: () => {},
                info: () => {},
                debug: () => {},
                trace: () => {},
            });
            const client = {
                log,
                user: {},
                currentTheme: { prompts: {} },
                term: { termWidth: 80, termHeight: 25 },
                on: () => {},
                removeListener: () => {},
            };
            mod = new getModule({
                menuName: 'msgView',
                menuConfig: { config: {} },
                client,
            });
        } finally {
            configModule._popTestConfig(previous);
        }

        mod.message = {
            isPrivate: () => false,
        };
        mod.menuMethods.replyMessage({}, {}, err => {
            assert.equal(err, null);
            assert.equal(warnings.length, 1);
            done();
        });
    });
});
