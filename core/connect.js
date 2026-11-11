/* jslint node: true */
'use strict';

//  ENiGMA½
const ansi = require('./ansi_term.js');
const Events = require('./events.js');

const { emulationOf } = require('./term');
const {
    ansiQuerySyncTermFontSupport,
    ansiQueryCtermCapabilities,
} = require('./term/ansi/probes.js');

//  deps
const async = require('async');

exports.connectEntry = connectEntry;
exports.ansiQuerySyncTermFontSupport = ansiQuerySyncTermFontSupport;
exports.ansiQueryCtermCapabilities = ansiQueryCtermCapabilities;

function prepareTerminal(term) {
    term.rawWrite(`${ansi.normal()}${ansi.clearScreen()}`);
}

function displayBanner(term) {
    //  note: intentional formatting:
    term.pipeWrite(`
|06Connected to |02EN|10i|02GMA|10½ |06BBS version |12|VN
|06Copyright (c) 2014-2026 Bryan Ashby |14- |12http://l33t.codes/
|06Updates & source |14- |12https://github.com/NuSkooler/enigma-bbs/
|00`);
}

function connectEntry(client, nextMenu) {
    const term = client.term;

    //
    //  What is asked of the terminal before the first menu is up to its
    //  emulation: see core/term/ansi/probes.js for ANSI's sequence.
    //
    async.series(
        emulationOf(term).probes.map(probe => callback => probe.run(client, callback)),
        () => {
            prepareTerminal(term);

            //
            //  Always show an ENiGMA½ banner
            //
            displayBanner(term);

            // fire event
            Events.emit(Events.getSystemEvents().TermDetected, { client: client });

            setTimeout(() => {
                return client.menuStack.goto(nextMenu);
            }, 500);
        }
    );
}
