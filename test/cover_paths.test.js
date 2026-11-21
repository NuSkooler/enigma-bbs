'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { TickerView } = require('../core/ticker_view.js');

//
//  The screens shown over a menu whose forms stay attached are covers
//  (core/screen_cover.js): while one is up the menu's ticker draws nothing
//  over it, the key that ends it reaches only the cover (no form field, no
//  action key), and the menu is repainted after.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
};
const MENU_TICKER_GOTO = '\x1b[2;10H';

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    const term = { termWidth: 80, termHeight: 25, out: [] };
    term.write = (s, convertLf, cb) => {
        term.out.push(String(s));
        if (typeof convertLf === 'function') {
            convertLf();
        } else if (typeof cb === 'function') {
            cb();
        }
    };
    term.rawWrite = s => term.out.push(String(s));
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    term.since = n => term.out.slice(n).join('');
    client.term = term;
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    return client;
}

//  Interval timers fired by hand
function captureTimers() {
    const timers = [];
    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    global.setInterval = fn => {
        timers.push(fn);
        return timers.length;
    };
    global.clearInterval = id => {
        if (id) {
            timers[id - 1] = null;
        }
    };
    return {
        fireAll() {
            timers.slice().forEach(fn => fn && fn());
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

//  A menu's form: a ticker and a focused field with Escape bound
function attachMenuForm(client) {
    const vc = new ViewController({ client });
    const ticker = new TickerView({
        client,
        id: 9,
        position: { row: 2, col: 10 },
        dimens: { width: 20, height: 1 },
        text: 'Welcome to the board -- news, files and doors',
        motion: 'left',
    });
    const field = new EditTextView({
        client,
        id: 1,
        position: { row: 20, col: 5 },
        dimens: { width: 30 },
        maxLength: 30,
    });
    vc.addView(ticker);
    vc.addView(field);
    vc.setViewOrder();
    vc.redrawAll();
    vc.switchFocus(1);
    vc.mapActionKeys([{ keys: ['escape'], viewId: 1 }], 'form');
    const submits = { n: 0 };
    vc.on('submit', () => ++submits.n);
    return { vc, ticker, field, submits };
}

function makeModule(client, configPatch = {}) {
    const { MenuModule } = require('../core/menu_module.js');
    const mod = new MenuModule({
        menuName: 'testMenu',
        menuConfig: { config: configPatch, art: null },
        client,
    });
    client.currentMenuModule = mod;
    return mod;
}

describe('Screens shown over a menu are covers', () => {
    let previousConfig;
    let timers;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });
    beforeEach(() => {
        timers = captureTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    describe('MenuModule.coverScreen()', () => {
        it('is coverScreen() for the menu client', done => {
            const client = makeClient();
            const mod = makeModule(client);
            const { field } = attachMenuForm(client);
            mod.coverScreen(
                finish => {
                    assert.equal(View.isBackgroundDrawSuspended(client), true);
                    client.emit('key press', 'q');
                    finish(null, 'result');
                },
                (err, result) => {
                    assert.ifError(err);
                    assert.equal(result, 'result');
                    assert.equal(field.getData(), '', 'the key went nowhere');
                    assert.equal(View.isBackgroundDrawSuspended(client), false);
                    return done();
                }
            );
        });
    });

    describe('gotoMenuOrShowMessage(), the error path', () => {
        it('message and pause over the attached menu, then prevMenu() uncovered', done => {
            const client = makeClient();
            const mod = makeModule(client);
            const { field, submits } = attachMenuForm(client);

            mod.gotoMenu = (name, options, cb) => cb(new Error('no such menu'));
            let pauseKey = null;
            mod.pausePrompt = cb => {
                client.waitForKeyPress((ch, key) => {
                    pauseKey = key;
                    cb(null);
                });
            };
            mod.prevMenu = cb => {
                assert.equal(View.isBackgroundDrawSuspended(client), false);
                assert.equal(client.hasInputCapture(), false);
                return cb(null);
            };

            const n = client.term.out.length;
            mod.gotoMenuOrShowMessage('nowhere', 'Not today', err => {
                assert.ifError(err);
                assert.deepEqual(pauseKey, { name: 'escape' });
                assert.equal(submits.n, 0, 'Escape did not run the form action');
                assert.equal(field.getData(), '');
                //  prevMenu() repaints: the ticker is not redrawn first
                assert.ok(!client.term.since(n).includes(MENU_TICKER_GOTO));
                return done();
            });

            assert.ok(client.term.since(n).includes('Not today'));
            timers.fireAll();
            assert.ok(!client.term.since(n).includes(MENU_TICKER_GOTO), 'no ticker');
            client.emit('key press', '\x1b', { name: 'escape' });
        });
    });

    //  A menu-module instance without its constructor: just what the help
    //  path uses
    function bareModule(modulePath, client, extra) {
        const Module = require(modulePath).getModule;
        const mod = Object.create(Module.prototype);
        mod.client = client;
        mod.menuConfig = { config: { art: { help: 'HELP' } } };
        client.currentMenuModule = mod;
        return Object.assign(mod, extra);
    }

    //  The common checks for a help page over an attached form: no ticker
    //  bytes while it is up, the dismissing key (Escape) goes nowhere else,
    //  the restore runs still covered, and nothing is left covered after
    function checkHelpCover({ client, start, restored, finished, menu }) {
        const n = client.term.out.length;
        start();
        timers.fireAll();
        timers.fireAll();
        assert.ok(
            !client.term.since(n).includes(MENU_TICKER_GOTO),
            'no menu ticker bytes'
        );

        client.emit('key press', '\x1b', { name: 'escape' });
        assert.equal(restored.length, 1, 'restored once');
        assert.deepEqual(restored[0], { suspended: true, captured: true });
        assert.equal(finished.length, 1, 'finished');
        assert.ifError(finished[0]);
        assert.equal(menu.submits.n, 0, 'no form action on the dismissing key');
        assert.equal(menu.field.getData(), '', 'nothing typed into the form');
        assert.equal(View.isBackgroundDrawSuspended(client), false);
        assert.equal(client.hasInputCapture(), false);

        client.emit('key press', 'k');
        assert.equal(menu.field.getData(), 'k', 'the form has keys again');
    }

    const coverState = client => ({
        suspended: View.isBackgroundDrawSuspended(client),
        captured: client.hasInputCapture(),
    });

    describe('FSE help (#1137) and the download queue message', () => {
        let theme;
        let savedDisplayThemeArt;
        before(() => {
            theme = require('../core/theme.js');
            savedDisplayThemeArt = theme.displayThemeArt;
            theme.displayThemeArt = (options, cb) => {
                options.client.term.write('<help art>');
                return cb(null);
            };
        });
        after(() => {
            theme.displayThemeArt = savedDisplayThemeArt;
        });

        function fseModule(client, menu, restored) {
            const footer = { focused: 0, setFocus: v => (footer.focused += v ? 1 : 0) };
            const mod = bareModule('../core/fse.js', client, {
                getFooterName: () => 'footerView',
                redrawScreen: cb => {
                    restored.push(coverState(client));
                    menu.vc.redrawAll();
                    return cb(null);
                },
            });
            mod.viewControllers = { footerView: footer };
            return { mod, footer };
        }

        it('Ctrl-O help is a cover; redrawScreen() repaints, still covered', () => {
            const client = makeClient();
            const menu = attachMenuForm(client);
            const restored = [];
            const finished = [];
            const { mod, footer } = fseModule(client, menu, restored);
            checkHelpCover({
                client,
                menu,
                restored,
                finished,
                start: () => mod.displayHelp(err => finished.push(err)),
            });
            assert.equal(footer.focused, 1, 'footer focus back');
        });

        it('the download queue message is a cover; redrawScreen() repaints, still covered', () => {
            const client = makeClient();
            const menu = attachMenuForm(client);
            const restored = [];
            const finished = [];
            const { mod, footer } = fseModule(client, menu, restored);
            let art = null;
            mod.displayAsset = (spec, options, cb) => {
                art = { spec: String(spec), options };
                client.term.write('<queued art>');
                return cb(null);
            };
            checkHelpCover({
                client,
                menu,
                restored,
                finished,
                start: () =>
                    mod.displayExportedToDownloadQueue(err => finished.push(err)),
            });
            assert.equal(
                art.spec,
                'Exported message has been added to your download queue!'
            );
            assert.equal(art.options.clearScreen, true);
            assert.equal(footer.focused, 1, 'footer focus back');
        });

        it('a static ticker in the editor is repainted after help', () => {
            const client = makeClient();
            const menu = attachMenuForm(client);
            menu.ticker.setPropertyValue('motion', 'bounce');
            menu.ticker.setText('short');
            timers.fireAll(); //  drawn, and static from now on
            const { mod } = fseModule(client, menu, []);
            mod.displayHelp(() => {});
            const n = client.term.out.length;
            client.emit('key press', 'q');
            assert.ok(client.term.since(n).includes(MENU_TICKER_GOTO), 'repainted');
        });
    });

    describe('file area list help', () => {
        it('is a cover; displayBrowsePage() repaints, still covered', () => {
            const client = makeClient();
            const menu = attachMenuForm(client);
            const restored = [];
            const finished = [];
            const mod = bareModule('../core/file_area_list.js', client, {
                displayAsset: (spec, options, cb) => {
                    client.term.write('<help art>');
                    return cb(null);
                },
                displayBrowsePage: (clearScreen, cb) => {
                    assert.equal(clearScreen, true);
                    restored.push(coverState(client));
                    return cb(null);
                },
            });
            checkHelpCover({
                client,
                menu,
                restored,
                finished,
                start: () => mod.displayHelpPage(err => finished.push(err)),
            });
        });
    });

    describe('WFC help', () => {
        it('is a cover; _displayMainPage() repaints, still covered', () => {
            const client = makeClient();
            const menu = attachMenuForm(client);
            const restored = [];
            const finished = [];
            const mod = bareModule('../core/wfc.js', client, {
                _stopRefreshing: () => {},
                _releaseMainForm: () => {},
                displayAsset: (spec, options, cb) => {
                    client.term.write('<help art>');
                    return cb(null);
                },
                _displayMainPage: (clearScreen, cb) => {
                    assert.equal(clearScreen, true);
                    restored.push(coverState(client));
                    return cb(null);
                },
            });
            checkHelpCover({
                client,
                menu,
                restored,
                finished,
                start: () => mod._displayHelpPage(err => finished.push(err)),
            });
        });
    });
});
