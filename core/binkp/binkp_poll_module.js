'use strict';

const { MenuModule } = require('../menu_module.js');
const { pollNodes } = require('./caller.js');

exports.moduleInfo = {
    name: 'BinkP Poll',
    desc: 'Trigger an immediate BinkP outbound poll',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.binkp_poll',
};

exports.getModule = class BinkpPollModule extends MenuModule {
    initSequence() {
        this.client.term.write('\r\nBinkP: polling outbound nodes...\r\n');
        pollNodes([], err => {
            if (err) {
                this.client.term.write(`BinkP: poll error — ${err.message}\r\n`);
            } else {
                this.client.term.write('BinkP: poll complete.\r\n');
            }
            return this.prevMenu();
        });
    }
};
