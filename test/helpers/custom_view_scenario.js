'use strict';

//
//  A form of custom views refreshed by MenuModule#updateCustomViewTextsWithFilter()
//  without any option, for pinning its bytes against origin/master. The view
//  classes are passed in so the very same scenario can be run against another
//  checkout's core/ (that is how the pinned values were taken).
//
//  Every kind of view the refresh treats differently is here: a TextView whose
//  text changes, one whose text does not (the redraw() branch), one with a
//  predefined MCI code, an EditTextView, a StatusBarView, an MLE, and a hole
//  in the range.
//

function makeCaptureClient() {
    const writes = [];
    const term = {
        termWidth: 80,
        termHeight: 25,
        write: s => {
            writes.push(String(s));
        },
        rawWrite: s => {
            writes.push(String(s));
        },
    };
    const client = {
        term,
        log: {
            trace() {},
            debug() {},
            info() {},
            warn() {},
            error() {},
            fatal() {},
        },
        currentTheme: {
            helpers: {
                getTimeFormat: () => client.timeFormat,
                getDateFormat: () => 'YYYY',
            },
        },
        timeFormat: '[12:00]',
    };
    return { client, writes };
}

const SCENARIO_CONFIG = {
    mainInfoFormat10: '|00|15{calls:>5} |07calls',
    mainInfoFormat11: '|00|07static label',
    mainInfoFormat12: 'Time {CT}',
    mainInfoFormat13: '|04{name}',
    mainInfoFormat14: '|02Avl|08:|10{avail}',
    //  15 left out: the walk must carry on past it
    mainInfoFormat16: 'log {calls}',
};

function buildScenario(classes) {
    const { MenuModule, TextView, EditTextView, StatusBarView, MultiLineEditTextView } =
        classes;
    const { client, writes } = makeCaptureClient();

    const views = {
        10: new TextView({
            client,
            id: 10,
            position: { row: 4, col: 70 },
            dimens: { width: 10 },
        }),
        11: new TextView({
            client,
            id: 11,
            position: { row: 5, col: 2 },
            dimens: { width: 20 },
        }),
        12: new TextView({
            client,
            id: 12,
            position: { row: 6, col: 2 },
            dimens: { width: 20 },
        }),
        13: new EditTextView({
            client,
            id: 13,
            position: { row: 7, col: 2 },
            dimens: { width: 20 },
            maxLength: 20,
        }),
        14: new StatusBarView({
            client,
            id: 14,
            position: { row: 1, col: 2 },
            dimens: { width: 20 },
        }),
        16: new MultiLineEditTextView({
            client,
            id: 16,
            position: { row: 10, col: 2 },
            dimens: { width: 30, height: 3 },
            mode: 'preview',
            acceptsFocus: false,
        }),
    };

    const form = {
        getView: id => views[id],
        getFocusedView: () => null,
    };

    const mod = Object.create(MenuModule.prototype);
    mod.client = client;
    mod.menuConfig = { config: Object.assign({}, SCENARIO_CONFIG) };
    mod.viewControllers = { main: form };

    return { mod, views, client, writes };
}

//  Three refreshes: first values, a change, then nothing changed
function runNoOptionScenario(classes) {
    const { mod, client, writes } = buildScenario(classes);
    const ticks = [
        { calls: 1, name: 'Bob', avail: 'Y', time: '[12:00]' },
        { calls: 2, name: 'Bob', avail: 'Y', time: '[12:01]' },
        { calls: 2, name: 'Bob', avail: 'Y', time: '[12:01]' },
    ];
    ticks.forEach(t => {
        client.timeFormat = t.time;
        mod.updateCustomViewTextsWithFilter('main', 10, t);
    });
    return writes.join('');
}

module.exports = {
    makeCaptureClient,
    buildScenario,
    runNoOptionScenario,
    SCENARIO_CONFIG,
};
