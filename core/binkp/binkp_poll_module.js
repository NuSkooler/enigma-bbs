'use strict';

const { MenuModule } = require('../menu_module.js');
const { requestBinkpPull } = require('../misc_scheduled_events.js');

//
//  Runs the native BinkP mailer's pull cycle now and reports the result: the
//  same cycle, and the same set of nodes, as binkp.pullSchedule and the
//  binkpPullNow scheduler task (which the WFC task screen runs). Kept for
//  custom menus that point at it; the stock menus no longer do.
//
exports.moduleInfo = {
    name: 'BinkP Poll',
    desc: 'Run the BinkP pull cycle now',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.binkp_poll',
};

exports.getModule = class BinkpPollModule extends MenuModule {
    initSequence() {
        this.client.term.write('\r\nBinkP: running the pull cycle...\r\n');

        const who = this.client.user.username || 'a menu';
        requestBinkpPull(`BinkP pull cycle requested by ${who}`, (err, outcome) => {
            if (err) {
                this.client.term.write(`BinkP: pull cycle error: ${err.message}\r\n`);
            } else {
                this.client.term.write(`BinkP: ${outcome.message}.\r\n`);
            }
            return this.prevMenu();
        });
    }
};
