'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { View } = require('../core/view.js');
const { TickerView } = require('../core/ticker_view.js');
const { StatusBarView } = require('../core/status_bar_view.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { ViewController } = require('../core/view_controller.js');

//
//  View.suspendBackgroundDraw() / resumeBackgroundDraw(): while something
//  covers the screen a background draw (a ticker tick) draws nothing, and
//  once the screen is given back each view that missed a draw gets one full
//  redraw, through drawInBackground() so the cursor goes back to the field.
//

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const TICKER_GOTO = '\x1b[2;10H';

//  Records socket writes; beginWrite() / commitWrite() batch as
//  ClientTerminal's do, so one entry is one write
function makeTerm() {
    const term = { termWidth: 80, termHeight: 25, flushes: [], _batch: null, _depth: 0 };
    const out = s => {
        s = Buffer.isBuffer(s) ? s.toString('latin1') : String(s);
        if (term._batch) {
            term._batch.push(s);
        } else {
            term.flushes.push(s);
        }
    };
    term.write = out;
    term.rawWrite = out;
    term.beginWrite = () => {
        if (!term._batch) {
            term._batch = [];
            term._depth = 0;
        }
        ++term._depth;
    };
    term.commitWrite = () => {
        if (!term._batch || --term._depth > 0) {
            return;
        }
        const data = term._batch.join('');
        term._batch = null;
        if (data) {
            term.flushes.push(data);
        }
    };
    term.since = n => term.flushes.slice(n).join('');
    return term;
}

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.term = makeTerm();
    client.currentMenuModule = { menuName: 'someMenu', menuConfig: {}, menuMethods: {} };
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
            timers.forEach(fn => fn && fn());
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

function makeTicker(client, options = {}) {
    return new TickerView(
        Object.assign(
            {
                client,
                id: 9,
                position: { row: 2, col: 10 },
                dimens: { width: 20, height: 1 },
                text: 'Welcome to the board -- news, files and doors',
                motion: 'left',
            },
            options
        )
    );
}

//  A ticker and a focused command field, as on a menu with a prompt
function makeScreen() {
    const client = makeClient();
    const vc = new ViewController({ client });
    const ticker = makeTicker(client);
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
    return { client, vc, ticker, field, term: client.term };
}

//  A bare view counting its redraws
function makeCountingView(client, id = 5) {
    const view = new View({ client, id, position: { row: 3, col: 1 } });
    view.redraws = 0;
    view.redraw = () => {
        ++view.redraws;
        client.term.write(`<view ${id}>`);
    };
    return view;
}

describe('Background draw suspend / resume', () => {
    let timers;
    beforeEach(() => {
        timers = captureTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    it('skips drawFn while suspended', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        const token = View.suspendBackgroundDraw(client);
        assert.equal(View.isBackgroundDrawSuspended(client), true);

        let ran = 0;
        view.drawInBackground(() => ++ran);
        assert.equal(ran, 0);
        assert.equal(client.term.flushes.length, 0, 'nothing written');

        View.resumeBackgroundDraw(client, token);
        assert.equal(View.isBackgroundDrawSuspended(client), false);
    });

    it('redraws a view that missed draws once, on the last resume', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        const outer = View.suspendBackgroundDraw(client);
        const inner = View.suspendBackgroundDraw(client);

        view.drawInBackground(() => {});
        view.drawInBackground(() => {});

        View.resumeBackgroundDraw(client, inner);
        assert.equal(view.redraws, 0, 'still suspended by the outer token');
        assert.equal(View.isBackgroundDrawSuspended(client), true);

        View.resumeBackgroundDraw(client, outer);
        assert.equal(view.redraws, 1, 'one redraw for any number of missed draws');

        View.resumeBackgroundDraw(client, outer);
        assert.equal(view.redraws, 1, 'a token given back twice does nothing');
    });

    it('counts tokens, not calls: resuming in either order works', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        const first = View.suspendBackgroundDraw(client);
        const second = View.suspendBackgroundDraw(client);
        view.drawInBackground(() => {});

        View.resumeBackgroundDraw(client, first);
        assert.equal(view.redraws, 0);
        View.resumeBackgroundDraw(client, second);
        assert.equal(view.redraws, 1);
    });

    it('ignores a token it did not give out', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        const token = View.suspendBackgroundDraw(client);
        view.drawInBackground(() => {});

        View.resumeBackgroundDraw(client, {});
        View.resumeBackgroundDraw(client, null);
        View.resumeBackgroundDraw(makeClient(), token);
        assert.equal(View.isBackgroundDrawSuspended(client), true);
        assert.equal(view.redraws, 0);
    });

    it('does not redraw a view that missed nothing', () => {
        const client = makeClient();
        const quiet = makeCountingView(client, 5);
        const busy = makeCountingView(client, 6);
        const token = View.suspendBackgroundDraw(client);
        busy.drawInBackground(() => {});
        View.resumeBackgroundDraw(client, token);
        assert.equal(quiet.redraws, 0);
        assert.equal(busy.redraws, 1);
    });

    it('does not redraw a view destroyed while suspended', () => {
        const client = makeClient();
        const ticker = makeTicker(client);
        const token = View.suspendBackgroundDraw(client);
        timers.fireAll();

        ticker.destroy();
        const before = client.term.flushes.length;
        View.resumeBackgroundDraw(client, token);
        assert.equal(client.term.flushes.length, before, 'nothing drawn');
    });

    //  A mod's View subclass may already use these names for its own state
    it('takes no property names from a view: a subclass’s destroyed / backgroundSeq are its own', () => {
        const client = makeClient();
        class ModView extends View {
            constructor(options) {
                super(options);
                this.destroyed = true; //  the mod's own meaning
                this.backgroundSeq = 1e9;
            }
        }
        const view = new ModView({ client, id: 8, position: { row: 3, col: 1 } });
        view.redraws = 0;
        view.redraw = () => ++view.redraws;

        const token = View.suspendBackgroundDraw(client);
        assert.equal(view.isBackgroundDrawSuspended(), true, 'covered as usual');
        view.drawInBackground(() => {});
        View.resumeBackgroundDraw(client, token);
        assert.equal(view.redraws, 1, 'the draw it missed is owed and given');
        assert.equal(view.destroyed, true);
        assert.equal(view.backgroundSeq, 1e9);
    });

    it('does not note a view that is already destroyed', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        view.destroy();
        const token = View.suspendBackgroundDraw(client);
        view.drawInBackground(() => {});
        View.resumeBackgroundDraw(client, token);
        assert.equal(view.redraws, 0);
    });

    it('treats a view torn down with its form as destroyed, even if its destroy() skips super', () => {
        const client = makeClient();
        const vc = new ViewController({ client });
        const view = makeCountingView(client);
        view.destroy = () => {}; //  a mod view that does not call super
        vc.addView(view);

        const token = View.suspendBackgroundDraw(client);
        view.drawInBackground(() => {});
        vc.detachClientEvents();
        View.resumeBackgroundDraw(client, token);
        assert.equal(view.redraws, 0);
    });

    it('draws nothing on resume once the client has ended', () => {
        const client = makeClient();
        const view = makeCountingView(client);
        const token = View.suspendBackgroundDraw(client);
        view.drawInBackground(() => {});
        client.clientEnded = true;
        View.resumeBackgroundDraw(client, token);
        assert.equal(view.redraws, 0);
        assert.equal(View.isBackgroundDrawSuspended(client), false);
    });

    it('still redraws the others when one view’s redraw throws', () => {
        const client = makeClient();
        const bad = makeCountingView(client, 5);
        const good = makeCountingView(client, 6);
        bad.redraw = () => {
            throw new Error('boom');
        };
        const token = View.suspendBackgroundDraw(client);
        bad.drawInBackground(() => {});
        good.drawInBackground(() => {});
        View.resumeBackgroundDraw(client, token);
        assert.equal(good.redraws, 1);
    });

    it('keeps each client separate', () => {
        const a = makeClient();
        const b = makeClient();
        View.suspendBackgroundDraw(a);
        let ran = 0;
        makeCountingView(b).drawInBackground(() => ++ran);
        assert.equal(ran, 1);
    });

    describe('TickerView', () => {
        it('draws no tick while suspended, and one frame on resume', () => {
            const { client, term } = makeScreen();
            const token = View.suspendBackgroundDraw(client);
            const before = term.flushes.length;

            timers.fireAll();
            timers.fireAll();
            assert.equal(term.flushes.length, before, 'no tick written');

            View.resumeBackgroundDraw(client, token);
            assert.equal(term.flushes.length, before + 1, 'one write for the redraw');
            const redraw = term.flushes[term.flushes.length - 1];
            assert.ok(redraw.startsWith(HIDE_CURSOR), 'cursor hidden first');
            assert.ok(redraw.includes(TICKER_GOTO), 'the ticker is drawn');
            assert.ok(redraw.endsWith(SHOW_CURSOR), 'cursor shown again');
            assert.ok(
                redraw.includes('\x1b[20;5H'),
                'the cursor goes back to the focused field'
            );
        });

        it('draws the missed frame on resume, though it equals the last one computed', () => {
            //  bounce with text that fits never moves, so the redraw computes
            //  the frame the missed tick computed, and the ticker skips frames
            //  it believes are on screen
            const { client, ticker, term } = makeScreen();
            ticker.setPropertyValue('motion', 'bounce');
            ticker.setText('short');
            timers.fireAll(); //  drawn
            const token = View.suspendBackgroundDraw(client);
            ticker.setText('other');
            timers.fireAll(); //  computed and noted, not drawn

            const before = term.flushes.length;
            View.resumeBackgroundDraw(client, token);
            assert.equal(term.flushes.length, before + 1);
            assert.ok(term.since(before).includes('other'));
        });

        it('a static ticker (nothing new to draw) under a cover is redrawn on resume', () => {
            //  the screen under it has been drawn over: a frame equal to the
            //  last is not "already on screen" after a cover
            const { client, ticker, term } = makeScreen();
            ticker.setPropertyValue('motion', 'bounce');
            ticker.setText('short');
            timers.fireAll();
            const token = View.suspendBackgroundDraw(client);
            timers.fireAll(); //  noted, not drawn

            const before = term.flushes.length;
            View.resumeBackgroundDraw(client, token);
            assert.equal(term.flushes.length, before + 1);
            assert.ok(term.since(before).includes('short'));

            //  and then static again: no more writes
            const after = term.flushes.length;
            timers.fireAll();
            assert.equal(term.flushes.length, after);
        });

        it('a static ticker that did not tick while covered draws on the next tick', () => {
            const { client, ticker, term } = makeScreen();
            ticker.setPropertyValue('motion', 'bounce');
            ticker.setText('short');
            timers.fireAll();
            View.resumeBackgroundDraw(client, View.suspendBackgroundDraw(client));

            const before = term.flushes.length;
            timers.fireAll();
            assert.equal(term.flushes.length, before + 1, 'repainted once');
            assert.ok(term.since(before).includes('short'));
            timers.fireAll();
            assert.equal(term.flushes.length, before + 1, 'then skips as before');
        });

        it("a cover's restore that calls redrawAll() repaints a static ticker", () => {
            const { client, vc, ticker, term } = makeScreen();
            ticker.setPropertyValue('motion', 'bounce');
            ticker.setText('short');
            timers.fireAll();
            const token = View.suspendBackgroundDraw(client);
            const before = term.flushes.length;
            vc.redrawAll(); //  the restore, still covered
            assert.ok(term.since(before).includes('short'));
            View.resumeBackgroundDraw(client, token);
        });

        it('without a cover, a static ticker still skips unchanged frames', () => {
            const { ticker, term } = makeScreen();
            ticker.setPropertyValue('motion', 'bounce');
            ticker.setText('short');
            timers.fireAll();
            const before = term.flushes.length;
            timers.fireAll();
            ticker.redraw();
            assert.equal(term.flushes.length, before);
        });

        it('ticks as it did before, one write with the cursor hidden, after a resume', () => {
            const { client, term } = makeScreen();
            View.resumeBackgroundDraw(client, View.suspendBackgroundDraw(client));

            const before = term.flushes.length;
            timers.fireAll();
            assert.equal(term.flushes.length, before + 1, 'one socket write per tick');
            const tick = term.flushes[term.flushes.length - 1];
            assert.ok(tick.startsWith(HIDE_CURSOR));
            assert.ok(tick.indexOf(TICKER_GOTO) > 0);
            assert.ok(tick.endsWith(SHOW_CURSOR));
        });
    });

    describe('only views that existed when the cover began', () => {
        it('a ticker created inside the cover animates; one under it does not', () => {
            const { client, ticker: under, term } = makeScreen();
            const token = View.suspendBackgroundDraw(client);

            //  the cover's own pause prompt, with a ticker of its own
            const inside = makeTicker(client, {
                id: 1,
                position: { row: 24, col: 30 },
                text: 'Press any key to continue',
            });
            assert.equal(under.isBackgroundDrawSuspended(), true);
            assert.equal(inside.isBackgroundDrawSuspended(), false);

            const before = term.flushes.length;
            timers.fireAll();
            const out = term.since(before);
            assert.ok(out.includes('\x1b[24;30H'), 'the pause ticker draws');
            assert.ok(!out.includes(TICKER_GOTO), 'the covered ticker does not');

            inside.destroy();
            View.resumeBackgroundDraw(client, token);
            assert.ok(term.since(before).includes(TICKER_GOTO), 'redrawn on resume');
        });

        it('nested: a view created under cover A but before B is suspended while B is held', () => {
            const client = makeClient();
            const a = View.suspendBackgroundDraw(client);
            const view = makeCountingView(client);
            const b = View.suspendBackgroundDraw(client);
            const late = makeCountingView(client, 6);

            let ran = 0;
            view.drawInBackground(() => ++ran);
            assert.equal(ran, 0, 'covered by B');
            late.drawInBackground(() => ++ran);
            assert.equal(ran, 1, 'created after B: draws');

            View.resumeBackgroundDraw(client, b);
            assert.equal(view.redraws, 1, 'only A is held now, which it is not under');
            view.drawInBackground(() => ++ran);
            assert.equal(ran, 2, 'draws again while A is still held');
            assert.equal(View.isBackgroundDrawSuspended(client), true);
            View.resumeBackgroundDraw(client, a);
            assert.equal(view.redraws, 1, 'nothing more owed');
        });

        it('nested: a view under both covers is redrawn only when both are given back', () => {
            const client = makeClient();
            const view = makeCountingView(client);
            const a = View.suspendBackgroundDraw(client);
            const b = View.suspendBackgroundDraw(client);
            view.drawInBackground(() => {});
            View.resumeBackgroundDraw(client, b);
            assert.equal(view.redraws, 0);
            View.resumeBackgroundDraw(client, a);
            assert.equal(view.redraws, 1);
        });

        it('redrawMissed: false gives the screen back without the redraws', () => {
            const client = makeClient();
            const view = makeCountingView(client);
            const token = View.suspendBackgroundDraw(client);
            view.drawInBackground(() => {});
            View.resumeBackgroundDraw(client, token, { redrawMissed: false });
            assert.equal(view.redraws, 0);
            assert.equal(View.isBackgroundDrawSuspended(client), false);
            //  and nothing is owed later either
            View.resumeBackgroundDraw(client, View.suspendBackgroundDraw(client));
            assert.equal(view.redraws, 0);
        });

        it('dropBackgroundDrawSuspends() lets go of everything, redrawing nothing', () => {
            const client = makeClient();
            const view = makeCountingView(client);
            const a = View.suspendBackgroundDraw(client);
            View.suspendBackgroundDraw(client);
            view.drawInBackground(() => {});
            assert.equal(View.dropBackgroundDrawSuspends(client), 2);
            assert.equal(View.dropBackgroundDrawSuspends(client), 0);
            assert.equal(View.isBackgroundDrawSuspended(client), false);
            View.resumeBackgroundDraw(client, a); //  stale: ignored
            assert.equal(view.redraws, 0);
            let ran = 0;
            view.drawInBackground(() => ++ran);
            assert.equal(ran, 1);
        });
    });

    describe('drawFn while covered, on a real ClientTerminal', () => {
        function makeRealTermClient() {
            const ClientTerminal = require('../core/client_term.js').ClientTerminal;
            const sent = [];
            const term = new ClientTerminal({
                writable: true,
                write(data, cb) {
                    sent.push(Buffer.from(data).toString('latin1'));
                    if (cb) {
                        cb(null);
                    }
                },
            });
            term.outputEncoding = 'cp437';
            term.termWidth = 80;
            term.termHeight = 25;
            const client = makeClient();
            client.term = term;
            return { client, term, sent };
        }

        it('still runs drawFn, for its state changes, and sends none of its output', () => {
            const { client, term, sent } = makeRealTermClient();
            const view = new View({ client, id: 5, position: { row: 3, col: 1 } });
            let redraws = 0;
            view.redraw = () => {
                ++redraws;
                term.write('<redraw>');
            };
            const lines = [];
            const token = View.suspendBackgroundDraw(client);
            view.drawInBackground(() => {
                lines.push('a line'); //  a mod adding state in drawFn
                term.write('drawn while covered');
                term.rawWrite('raw too');
            });
            assert.deepEqual(lines, ['a line'], 'drawFn ran');
            assert.equal(sent.join(''), '', 'nothing sent');

            View.resumeBackgroundDraw(client, token);
            assert.equal(redraws, 1, 'the full redraw on resume');
            assert.ok(sent.join('').includes('<redraw>'));
            assert.ok(!sent.join('').includes('covered'));
        });

        it('keeps what an enclosing batch already held', () => {
            const { client, term, sent } = makeRealTermClient();
            const view = new View({ client, id: 5, position: { row: 3, col: 1 } });
            view.redraw = () => {};
            const token = View.suspendBackgroundDraw(client);
            term.beginWrite();
            term.write('before');
            view.drawInBackground(() => term.write('dropped'));
            term.write('after');
            term.commitWrite();
            assert.equal(sent.join(''), 'beforeafter');
            View.resumeBackgroundDraw(client, token);
        });

        describe('ClientTerminal.discardOutput()', () => {
            it('sends nothing of what fn writes, and returns what fn returns', () => {
                const { term, sent } = makeRealTermClient();
                const r = term.discardOutput(() => {
                    term.write('A');
                    term.rawWrite('B');
                    return 42;
                });
                assert.equal(r, 42);
                assert.equal(sent.join(''), '');
                assert.equal(term._writeBuf, null, 'no batch left open');
                term.write('next');
                assert.equal(sent.join(''), 'next', 'later output goes out');
            });

            it('inside an outer batch: earlier chunks (pass-through too) kept, its own trimmed', () => {
                const { term, sent } = makeRealTermClient();
                term.beginWrite();
                term.write('keep1');
                term.write('PT', false);
                term.rawWrite('x');
                term.discardOutput(() => {
                    term.write('drop1');
                    term.rawWrite('drop2');
                });
                term.write('keep2');
                term.commitWrite();
                assert.equal(sent.join(''), 'keep1PTxkeep2');
                assert.equal(sent.length, 1, 'still one write for the batch');
            });

            it('a balanced batch inside fn is discarded with the rest', () => {
                const { term, sent } = makeRealTermClient();
                term.discardOutput(() => {
                    term.beginWrite();
                    term.write('d');
                    term.commitWrite();
                    term.write('e');
                });
                assert.equal(sent.join(''), '');
                assert.equal(term._writeBuf, null);
                assert.equal(term._writeBufDepth, 0);
            });

            it('fn throwing inside a batch it began: the error goes on, the batch is closed', () => {
                const { term, sent } = makeRealTermClient();
                assert.throws(
                    () =>
                        term.discardOutput(() => {
                            term.beginWrite();
                            term.write('d');
                            throw new Error('draw failed');
                        }),
                    /draw failed/
                );
                assert.equal(term._writeBuf, null, 'not left batching');
                term.write('after');
                assert.equal(sent.join(''), 'after');
            });

            it('write callbacks inside fn still fire', () => {
                const { term } = makeRealTermClient();
                let called = 0;
                term.discardOutput(() => {
                    term.write('z', true, () => ++called);
                    term.rawWrite('y', () => ++called);
                });
                assert.equal(called, 2);
            });
        });

        it('a covered ticker sends no tick bytes', () => {
            const { client, sent } = makeRealTermClient();
            const ticker = makeTicker(client);
            ticker.redraw();
            const before = sent.length;
            const token = View.suspendBackgroundDraw(client);
            timers.fireAll();
            timers.fireAll();
            assert.equal(sent.length, before);
            View.resumeBackgroundDraw(client, token);
            assert.equal(sent.length, before + 1, 'one write for the redraw');
            ticker.destroy();
        });
    });

    describe('StatusBarView', () => {
        it('redraws a panel refresh it missed', () => {
            const client = makeClient();
            let n = 0;
            const bar = new StatusBarView({
                client,
                id: 3,
                position: { row: 24, col: 1 },
                dimens: { width: 40, height: 1 },
            });
            bar._evalPanelText = () => `n=${++n}`;
            bar.setPropertyValue('panels', [
                { name: 'count', width: 10, text: 'x', refreshInterval: 1000 },
            ]);
            bar.redraw();

            const token = View.suspendBackgroundDraw(client);
            const before = client.term.flushes.length;
            timers.fireAll();
            assert.equal(client.term.flushes.length, before);

            View.resumeBackgroundDraw(client, token);
            assert.ok(client.term.since(before).includes(`n=${n}`), 'latest value drawn');

            //  destroy() reaches View.destroy(): a draw it would miss now is
            //  not noted, so no redraw is owed to it
            bar.destroy();
            const again = View.suspendBackgroundDraw(client);
            bar.drawInBackground(() => {});
            const afterDestroy = client.term.flushes.length;
            View.resumeBackgroundDraw(client, again);
            assert.equal(client.term.flushes.length, afterDestroy, 'nothing redrawn');
        });
    });
});
