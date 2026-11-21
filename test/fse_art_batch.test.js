'use strict';

const { strict: assert } = require('assert');
const events = require('events');
const configModule = require('../core/config.js');

const { ClientTerminal } = require('../core/client_term.js');
const { View } = require('../core/view.js');
const { TickerView } = require('../core/ticker_view.js');

//
//  The full screen editor's footer switch and quote builder batch an erase,
//  the art (read from disk: async) and its form into one socket write. A
//  header ticker that ticked while the art was read was held in that batch
//  and sent between the erase and the art, which then drew from where the
//  tick left the cursor. Background drawing is now suspended for the span
//  of those batches, released on every path (art error, a thrown error,
//  the menu left), and a view that missed a tick is redrawn once after.
//

const BASE_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    messageConferences: {},
};

const quietLog = {};
['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
    quietLog[level] = () => {};
});

function makeClient() {
    const client = new events.EventEmitter();
    client.log = quietLog;
    const writes = [];
    const term = new ClientTerminal({
        writable: true,
        write(data, cb) {
            writes.push(Buffer.from(data).toString('latin1'));
            if (cb) {
                cb(null);
            }
        },
    });
    term.outputEncoding = 'cp437';
    term.termWidth = 80;
    term.termHeight = 25;
    client.term = term;
    client.writes = writes;
    client.sent = () => writes.join('');
    return client;
}

//  setInterval() run by hand
function fakeIntervals() {
    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    const intervals = new Map();
    let nextId = 1;
    global.setInterval = fn => {
        const id = nextId++;
        intervals.set(id, fn);
        return id;
    };
    global.clearInterval = id => intervals.delete(id);
    return {
        fire(id) {
            intervals.get(id)();
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

describe('FSE batches that wait on art suspend background drawing', () => {
    let FullScreenEditorModule;
    let theme;
    let timers;

    before(() => {
        const prev = configModule._pushTestConfig(BASE_CONFIG);
        ({ FullScreenEditorModule } = require('../core/fse.js'));
        theme = require('../core/theme.js');
        configModule._popTestConfig(prev);
    });
    beforeEach(() => {
        timers = fakeIntervals();
    });
    afterEach(() => {
        timers.restore();
    });

    //  an editor whose header holds a ticker, already drawn
    function makeEditor() {
        const client = makeClient();
        const inst = Object.create(FullScreenEditorModule.prototype);
        inst.client = client;
        inst.menuConfig = { config: { art: { quote: 'QUOTE' } } };
        inst.header = { height: 4 };
        inst.body = { height: 15 };
        inst.footerMode = 'editor';
        inst.viewControllers = {};
        inst.ticker = new TickerView({
            client,
            id: 9,
            position: { row: 2, col: 60 },
            dimens: { width: 6, height: 1 },
            text: 'NEWS!',
            motion: 'bounce',
        });
        return inst;
    }

    describe('switchFooter()', () => {
        function pendingArt(inst) {
            const state = {};
            inst.prepViewControllerWithArt = (name, formId, options, cb) => {
                state.name = name;
                state.finish = err => {
                    if (err) {
                        //  as prepViewControllerWithArt() does: no vc
                        return cb(err);
                    }
                    inst.client.term.rawWrite('<FOOTER ART>');
                    return cb(null, { redrawAll() {} }, true);
                };
            };
            return state;
        }

        it('a tick while the art is read is not sent inside the batch; the ticker is redrawn after', done => {
            const inst = makeEditor();
            const art = pendingArt(inst);
            inst.switchFooter(err => {
                assert.ifError(err);
                const sent = inst.client.sent();
                //  the erase and the art in one write, nothing between
                assert.equal(inst.client.writes[0], '\x1b[19;1H\x1b[2K<FOOTER ART>');
                //  then the ticker's one redraw
                assert.ok(inst.client.writes[1].includes('\x1b[2;60H'), sent);
                assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
                inst.ticker.destroy();
                return done();
            });
            assert.equal(art.name, 'footerEditor');
            assert.equal(View.isBackgroundDrawSuspended(inst.client), true);
            timers.fire(inst.ticker._timer); //  the header ticks meanwhile
            assert.equal(inst.client.sent(), '', 'held');
            art.finish(null);
        });

        it('an art error ends the batch and the suspend (it threw before)', done => {
            const inst = makeEditor();
            const art = pendingArt(inst);
            inst.switchFooter(err => {
                assert.ok(err);
                assert.equal(inst.client.term._writeBuf, null, 'batch closed');
                assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
                assert.ok(inst.client.sent().startsWith('\x1b[19;1H\x1b[2K'));
                inst.ticker.destroy();
                return done();
            });
            art.finish(new Error('no art'));
        });

        it('a refocused footer is redrawn inside the batch', done => {
            const inst = makeEditor();
            const art = pendingArt(inst);
            let redrawn = 0;
            inst.prepViewControllerWithArt = (name, formId, options, cb) => {
                art.finish = () => cb(null, { redrawAll: () => ++redrawn }, false);
            };
            inst.switchFooter(err => {
                assert.ifError(err);
                assert.equal(redrawn, 1);
                assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
                inst.ticker.destroy();
                return done();
            });
            art.finish();
        });

        it('a synchronous throw ends the batch and the suspend', () => {
            const inst = makeEditor();
            inst.prepViewControllerWithArt = () => {
                throw new Error('boom');
            };
            assert.throws(() => inst.switchFooter(() => {}), /boom/);
            assert.equal(inst.client.term._writeBuf, null);
            assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
            inst.ticker.destroy();
        });

        it('the art finishing after leave(): called back, a refocused footer not redrawn', () => {
            const inst = makeEditor();
            const art = pendingArt(inst);
            let redrawn = 0;
            inst.prepViewControllerWithArt = (name, formId, options, cb) => {
                art.finish = () => cb(null, { redrawAll: () => ++redrawn }, false);
            };
            inst.tempMessageConfAndAreaRestore = () => {};
            let called = 0;
            inst.switchFooter(err => {
                assert.ifError(err);
                ++called;
            });
            inst.leave();
            art.finish();
            assert.equal(called, 1, 'called back, as the prep helper is');
            assert.equal(redrawn, 0, "a left menu's form is not drawn");
            assert.equal(inst.client.sent(), '\x1b[19;1H\x1b[2K', 'only the erase');
            inst.ticker.destroy();
        });

        it('leave() with the art still pending ends both; nothing is redrawn', () => {
            const inst = makeEditor();
            pendingArt(inst);
            inst.tempMessageConfAndAreaRestore = () => {};
            inst.switchFooter(() => assert.fail('the art never finishes here'));
            timers.fire(inst.ticker._timer);
            inst.leave();
            assert.equal(inst.client.term._writeBuf, null);
            assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
            assert.equal(inst.client.sent(), '\x1b[19;1H\x1b[2K', 'only the erase');
            inst.ticker.destroy();
        });
    });

    describe('the quote builder', () => {
        it('a tick while its art is read is not sent between the erase and the art', done => {
            const inst = makeEditor();
            const savedDisplay = theme.displayThemeArt;
            let finish;
            theme.displayThemeArt = (options, cb) => {
                finish = err => {
                    if (!err) {
                        inst.client.term.rawWrite('<QUOTE ART>');
                    }
                    cb(err, err ? undefined : { mciMap: {} });
                };
            };
            try {
                inst.displayQuoteBuilder();
            } finally {
                theme.displayThemeArt = savedDisplay;
            }
            assert.equal(View.isBackgroundDrawSuspended(inst.client), true);
            timers.fire(inst.ticker._timer);
            //  the form exists already; the quote lines never arrive
            const fakeView = {
                dimens: { width: 70 },
                position: { col: 1 },
                styleSGR1: '',
                styleSGR2: '',
            };
            inst.viewControllers.quoteBuilder = {
                redrawAll() {},
                getView: () => fakeView,
            };
            inst.viewControllers.body = { getView: () => fakeView };
            inst._getQuoteLineOptions = () => ({});
            inst.replyToMessage = { getQuoteLines: () => {} };
            finish(null);
            assert.equal(inst.client.writes[0], '\x1b[5;1H\x1b[0J<QUOTE ART>');
            assert.ok(inst.client.writes[1].includes('\x1b[2;60H'));
            assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
            inst.ticker.destroy();
            return done();
        });

        it('an art error ends the batch and the suspend', () => {
            const inst = makeEditor();
            const savedDisplay = theme.displayThemeArt;
            let finish;
            theme.displayThemeArt = (options, cb) => {
                finish = () => cb(new Error('no art'));
            };
            try {
                inst.displayQuoteBuilder();
            } finally {
                theme.displayThemeArt = savedDisplay;
            }
            finish();
            assert.equal(inst.client.term._writeBuf, null);
            assert.equal(View.isBackgroundDrawSuspended(inst.client), false);
            inst.ticker.destroy();
        });
    });
});
