/* eslint-disable no-control-regex */
'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { View } = require('../core/view.js');
const { TickerView } = require('../core/ticker_view.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { MaskEditTextView } = require('../core/mask_edit_text_view.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const { ViewController } = require('../core/view_controller.js');
const { StatusBarView } = require('../core/status_bar_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');

//
//  A TickerView (%TK) redraws on a timer. Each tick moves the terminal cursor
//  to the ticker and leaves the ticker's SGR set. A focused EditTextView
//  echoes an appended character at the current cursor, in the current SGR,
//  so without putting both back a character typed after a tick lands at the
//  end of the ticker, in the ticker's colour.
//

const TICKER_SGR = '\x1b[0;1;32m';
const FIELD_SGR = '\x1b[0;37;40m';
const FIELD_FOCUS_SGR = '\x1b[0;1;37;44m';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// ─── Test helpers ────────────────────────────────────────────────────────────

//
//  A terminal that does what a real one does with what the views send: CSI H
//  moves the cursor, SGR sets the attribute the next characters are drawn
//  in, ?25l / ?25h hide and show the cursor, and printable characters land in
//  a screen buffer and advance the cursor. beginWrite() / commitWrite() batch
//  as ClientTerminal's do, and every socket write is counted.
//
function makeTerminal() {
    const term = {
        termWidth: 80,
        termHeight: 25,
        cursor: { row: 1, col: 1 },
        sgr: '',
        cursorVisible: true,
        cells: new Map(), //  'row,col' -> { ch, sgr }
        flushes: [], //  what went to the "socket", one entry per write
        _batch: null,
        _depth: 0,
    };

    const consume = s => {
        let i = 0;
        while (i < s.length) {
            if ('\x1b' === s[i] && '[' === s[i + 1]) {
                let j = i + 2;
                while (j < s.length && /[0-9;?]/.test(s[j])) {
                    ++j;
                }
                const args = s.slice(i + 2, j);
                const cmd = s[j];
                if ('H' === cmd || 'f' === cmd) {
                    const [row, col] = args.split(';');
                    term.cursor = {
                        row: parseInt(row, 10) || 1,
                        col: parseInt(col, 10) || 1,
                    };
                } else if ('m' === cmd) {
                    term.sgr = s.slice(i, j + 1);
                } else if ('?25l' === args + cmd) {
                    term.cursorVisible = false;
                } else if ('?25h' === args + cmd) {
                    term.cursorVisible = true;
                }
                i = j + 1;
                continue;
            }
            term.cells.set(`${term.cursor.row},${term.cursor.col}`, {
                ch: s[i],
                sgr: term.sgr,
            });
            ++term.cursor.col;
            ++i;
        }
    };

    const out = s => {
        s = Buffer.isBuffer(s) ? s.toString('latin1') : String(s);
        if (term._batch) {
            term._batch.push(s);
            return;
        }
        term.flushes.push(s);
        consume(s);
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
        if (data.length > 0) {
            term.flushes.push(data);
            consume(data);
        }
    };

    term.pos = () => `${term.cursor.row},${term.cursor.col}`;
    term.cellAt = (row, col) => term.cells.get(`${row},${col}`);
    //  the characters on |row| from |col| for |len| columns
    term.textAt = (row, col, len) => {
        let s = '';
        for (let c = col; c < col + len; ++c) {
            const cell = term.cellAt(row, c);
            s += cell ? cell.ch : ' ';
        }
        return s;
    };

    return term;
}

function makeClient() {
    const log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = () => {};
    });

    const client = new events.EventEmitter();
    client.log = log;
    client.term = makeTerminal();
    client.currentMenuModule = { menuName: 'someMenu', menuConfig: {}, menuMethods: {} };
    return client;
}

//  The ticker's timer callbacks, fired by hand
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
            global.setInterval = saved.setInterval;
            global.clearInterval = saved.clearInterval;
        },
    };
}

//  A ticker on row 2, columns 10-29, scrolling left: every tick draws
function makeTicker(client, id = 9) {
    return new TickerView({
        client,
        id,
        position: { row: 2, col: 10 },
        dimens: { width: 20, height: 1 },
        text: 'Welcome to the board -- news, files and doors',
        motion: 'left',
        styleSGR1: TICKER_SGR,
    });
}

//  A command field on row 20, columns 5-34, like a main menu's ET1
function makeField(client, id = 1) {
    return new EditTextView({
        client,
        id,
        position: { row: 20, col: 5 },
        dimens: { width: 30 },
        maxLength: 30,
        styleSGR1: FIELD_SGR,
        styleSGR2: FIELD_FOCUS_SGR,
    });
}

function type(client, chars) {
    for (const ch of chars) {
        client.emit('key press', ch);
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TickerView tick with a focused input', () => {
    let timers;
    beforeEach(() => {
        timers = captureTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    describe('same form (ticker and field in one ViewController)', () => {
        function setup() {
            const client = makeClient();
            const vc = new ViewController({ client });
            const ticker = makeTicker(client);
            const field = makeField(client);
            vc.addView(ticker);
            vc.addView(field);
            vc.setViewOrder();
            vc.redrawAll();
            vc.switchFocus(1);
            return { client, vc, ticker, field, term: client.term };
        }

        it('puts the cursor back in the field, in the field focus SGR', () => {
            const { client, term } = setup();

            type(client, 'ab');
            assert.equal(term.pos(), '20,7', 'precondition: typing advanced the cursor');

            timers.fireAll();

            assert.equal(term.pos(), '20,7', 'cursor back after the two typed chars');
            assert.equal(
                term.sgr,
                FIELD_FOCUS_SGR,
                'field focus SGR, not the ticker SGR'
            );
            assert.equal(term.cursorVisible, true, 'the field shows its cursor');
        });

        it('a character typed after a tick lands in the field, in its colour', () => {
            const { client, term } = setup();

            type(client, 'ab');
            timers.fireAll();
            const tickerRow = term.textAt(2, 10, 20);

            type(client, 'c');

            assert.equal(term.textAt(20, 5, 3), 'abc');
            assert.equal(term.cellAt(20, 7).sgr, FIELD_FOCUS_SGR);
            assert.equal(term.cellAt(2, 30), undefined, 'nothing drawn past the ticker');
            assert.equal(
                term.textAt(2, 10, 20),
                tickerRow,
                'ticker untouched by the key'
            );
            assert.equal(term.pos(), '20,8');
        });

        it('sends the tick as one write, with the cursor hidden while it draws', () => {
            const { client, term } = setup();
            type(client, 'ab');

            const before = term.flushes.length;
            timers.fireAll();

            assert.equal(term.flushes.length, before + 1, 'one socket write per tick');
            const tick = term.flushes[term.flushes.length - 1];
            assert.ok(tick.startsWith(HIDE_CURSOR), 'hidden before the ticker is drawn');
            assert.ok(
                tick.indexOf('\x1b[2;10H') > 0,
                'the ticker is drawn after the cursor is hidden'
            );
            assert.ok(tick.endsWith(SHOW_CURSOR), 'shown again once it is back');
        });

        it('keeps the cursor in a field that is scrolled, at its edit position', () => {
            const { client, field, term } = setup();

            type(client, 'abcdefghijklmnopqrstuvwxyz');
            //  move the edit cursor back three columns
            for (let i = 0; i < 3; ++i) {
                client.emit('key press', null, { name: 'left arrow' });
            }
            const expected = term.pos();
            assert.equal(expected, `20,${5 + field.cursorPos.col}`);

            timers.fireAll();
            assert.equal(term.pos(), expected);
        });

        it('writes nothing for a tick that draws what the last one drew', () => {
            const { client, ticker, term } = setup();
            ticker.setPropertyValue('motion', 'bounce');
            ticker.setText('short'); //  fits the window: bounce never moves
            timers.fireAll(); //  draws once
            type(client, 'x');

            const before = term.flushes.length;
            timers.fireAll();
            timers.fireAll();
            assert.equal(term.flushes.length, before, 'no write, so no cursor churn');
        });
    });

    describe('menu art and prompt in two ViewControllers', () => {
        //  The art (with the %TK) loads into the menu form and the prompt (with
        //  the focused ET1) into a second one, as standardMCIReadyHandler does
        function setup() {
            const client = makeClient();
            const menuVc = new ViewController({ client });
            const promptVc = new ViewController({ client });

            const ticker = makeTicker(client);
            menuVc.addView(ticker);
            menuVc.redrawAll();

            const field = makeField(client);
            promptVc.addView(field);
            promptVc.setViewOrder();
            promptVc.redrawAll();
            promptVc.switchFocus(1);

            return { client, menuVc, promptVc, ticker, field, term: client.term };
        }

        it("puts the cursor back in the prompt's field", () => {
            const { client, term } = setup();

            type(client, 'g');
            timers.fireAll();

            assert.equal(term.pos(), '20,6');
            assert.equal(term.sgr, FIELD_FOCUS_SGR);

            type(client, 'o');
            assert.equal(term.textAt(20, 5, 2), 'go');
            assert.equal(term.cellAt(20, 6).sgr, FIELD_FOCUS_SGR);
            assert.equal(term.cellAt(2, 30), undefined);
        });

        it('leaves the cursor alone once the prompt is torn down', () => {
            const { client, promptVc, term } = setup();

            type(client, 'g');
            promptVc.detachClientEvents(); //  e.g. removeViewController()

            const before = term.flushes.length;
            timers.fireAll();
            const tick = term.flushes.slice(before).join('');

            assert.equal(term.pos(), '2,30', 'cursor where the ticker left it');
            assert.ok(!tick.includes('\x1b[20;'), 'not moved into the old field');
            assert.ok(!tick.includes(HIDE_CURSOR) && !tick.includes(SHOW_CURSOR));
        });

        it('follows focus handed from one form to another and back', () => {
            //  promptForInput(): the previous form gives up focus, a new prompt
            //  takes it, and on submit focus goes back before the prompt is
            //  removed
            const { client, promptVc, term } = setup();

            const otherVc = new ViewController({ client });
            const other = new EditTextView({
                client,
                id: 1,
                position: { row: 22, col: 40 },
                dimens: { width: 10 },
                maxLength: 10,
                styleSGR2: '\x1b[0;33m',
            });
            otherVc.addView(other);
            otherVc.setViewOrder();

            promptVc.setFocus(false);
            otherVc.switchFocus(1);

            timers.fireAll();
            assert.equal(term.pos(), '22,40', 'the new prompt holds focus');
            assert.equal(term.sgr, '\x1b[0;33m');

            promptVc.setFocus(true);
            otherVc.detachClientEvents();

            timers.fireAll();
            assert.equal(term.pos(), '20,5', 'back in the first field');
            assert.equal(term.sgr, FIELD_FOCUS_SGR);
        });
    });

    describe('no focused input (pause prompt)', () => {
        //  displayThemedPrompt() loads the pause art into a temporary form
        //  that focuses nothing; the key is read with waitForKeyPress()
        it('draws as before: no cursor hide/show, cursor left after the ticker', () => {
            const client = makeClient();
            const vc = new ViewController({ client });

            //  as displayThemedPrompt() hands it over: the pause art's MCI
            //  map and the prompt's config
            const mciMap = {
                TK1: {
                    code: 'TK',
                    id: 1,
                    position: [24, 10],
                    args: [],
                    SGR: TICKER_SGR,
                    focusSGR: TICKER_SGR,
                },
            };
            const config = {
                mci: {
                    TK1: {
                        text: 'Press any key to continue... ',
                        width: 20,
                        motion: 'left',
                    },
                },
            };
            vc.loadFromPromptConfig({ mciMap, config }, err => assert.ifError(err));
            assert.equal(View.getInputFocusView(client), null, 'nothing focused');

            const term = client.term;
            const before = term.flushes.length;
            timers.fireAll();
            const tick = term.flushes.slice(before).join('');

            assert.ok(tick.startsWith('\x1b[24;10H'), 'goes straight to the ticker');
            assert.ok(!tick.includes(HIDE_CURSOR) && !tick.includes(SHOW_CURSOR));
            assert.equal(term.pos(), '24,30', 'cursor where the ticker leaves it');
            assert.equal(term.textAt(24, 10, 20), 'ress any key to cont');
            assert.equal(term.cellAt(24, 10).sgr, TICKER_SGR);
        });

        it('works on a terminal without write batching', () => {
            const client = makeClient();
            delete client.term.beginWrite;
            delete client.term.commitWrite;
            makeTicker(client);
            const field = makeField(client);
            field.setFocus(true);

            timers.fireAll();
            assert.notEqual(client.term.textAt(2, 10, 20).trim(), '', 'ticker drawn');
            assert.equal(client.term.pos(), '20,5');
            assert.equal(client.term.sgr, FIELD_FOCUS_SGR);
        });
    });

    describe('other focused views', () => {
        it('a focused list view (WFC) keeps its cursor hidden', () => {
            const client = makeClient();
            const vc = new ViewController({ client });
            const ticker = makeTicker(client);
            const list = new VerticalMenuView({
                client,
                id: 1,
                position: { row: 5, col: 1 },
                dimens: { width: 20, height: 5 },
                items: ['one', 'two', 'three'],
            });
            vc.addView(ticker);
            vc.addView(list);
            vc.setViewOrder();
            vc.redrawAll();
            vc.switchFocus(1);
            assert.equal(client.term.cursorVisible, false, 'precondition');

            timers.fireAll();
            assert.equal(client.term.cursorVisible, false);
        });

        it('a focused MaskEditTextView gets its cursor and focus SGR back', () => {
            const client = makeClient();
            makeTicker(client);
            const mask = new MaskEditTextView({
                client,
                id: 1,
                position: { row: 12, col: 8 },
                maskPattern: '##/##/####',
                styleSGR2: FIELD_FOCUS_SGR,
            });
            mask.setFocus(true);
            for (const ch of '123') {
                mask.onKeyPress(ch);
            }
            const expected = client.term.pos();
            assert.notEqual(expected, '12,8', 'precondition: typing moved the cursor');

            timers.fireAll();
            assert.equal(client.term.pos(), expected);
            assert.equal(client.term.sgr, FIELD_FOCUS_SGR);
        });

        it('a focused MultiLineEditTextView (FSE) gets its edit position back', () => {
            const client = makeClient();
            makeTicker(client);
            const mle = new MultiLineEditTextView({
                client,
                id: 1,
                position: { row: 5, col: 3 },
                dimens: { width: 40, height: 10 },
                styleSGR2: FIELD_FOCUS_SGR,
            });
            mle.setText('first line\nsecond');
            mle.setFocus(true);
            for (const ch of 'abc') {
                mle.onKeyPress(ch);
            }
            const expected = client.term.pos();
            assert.equal(expected, '6,12', 'precondition: after "secondabc"');

            timers.fireAll();
            assert.equal(client.term.pos(), expected);
            assert.equal(client.term.sgr, FIELD_FOCUS_SGR);
            assert.equal(client.term.cursorVisible, true);

            mle.onKeyPress('d');
            assert.equal(client.term.textAt(6, 3, 10), 'secondabcd');
            assert.equal(client.term.cellAt(6, 12).sgr, FIELD_FOCUS_SGR);
        });

        it('a MultiLineEditTextView scrolled down keeps its row in the window', () => {
            const client = makeClient();
            makeTicker(client);
            const mle = new MultiLineEditTextView({
                client,
                id: 1,
                position: { row: 5, col: 3 },
                dimens: { width: 40, height: 3 },
                styleSGR2: FIELD_FOCUS_SGR,
            });
            mle.setText(['1', '2', '3', '4', '5', '6'].join('\n'));
            mle.setFocus(true);
            const expected = client.term.pos();
            const row = parseInt(expected, 10);
            assert.ok(row >= 5 && row <= 7, `precondition: in the window (${expected})`);

            timers.fireAll();
            assert.equal(client.term.pos(), expected);
        });
    });
});

describe('StatusBarView refresh with a focused input', () => {
    let timers;
    beforeEach(() => {
        timers = captureTimers();
    });
    afterEach(() => {
        timers.restore();
    });

    const BAR_SGR = '\x1b[0;30;46m';

    function setup(barOptions) {
        const client = makeClient();
        const bar = new StatusBarView(
            Object.assign(
                {
                    client,
                    id: 5,
                    position: { row: 24, col: 1 },
                    dimens: { width: 40, height: 1 },
                    styleSGR1: BAR_SGR,
                },
                barOptions
            )
        );
        const field = makeField(client);
        field.setFocus(true);
        for (const ch of 'hi') {
            field.onKeyPress(ch);
        }
        return { client, bar, field, term: client.term };
    }

    it('single mode: a refresh that draws puts the cursor back in the field', () => {
        const { bar, field, term } = setup({ text: 'one', refreshInterval: 1000 });

        timers.fireAll(); //  first refresh draws
        assert.equal(term.textAt(24, 1, 3), 'one');
        assert.equal(term.pos(), '20,7');
        assert.equal(term.sgr, FIELD_FOCUS_SGR);

        bar._format = 'two';
        timers.fireAll();
        assert.equal(term.textAt(24, 1, 3), 'two');
        assert.equal(term.pos(), '20,7');

        field.onKeyPress('!');
        assert.equal(term.textAt(20, 5, 3), 'hi!');
        assert.equal(term.cellAt(20, 7).sgr, FIELD_FOCUS_SGR);
    });

    it('panel mode: a panel refresh puts the cursor back in the field', () => {
        const { bar, term } = setup({
            panels: [{ name: 'clock', width: 10, text: 'tick', refreshInterval: 1000 }],
        });

        bar._panels[0].text = 'tock';
        timers.fireAll();
        assert.equal(term.textAt(24, 1, 4), 'tock');
        assert.equal(term.pos(), '20,7');
        assert.equal(term.sgr, FIELD_FOCUS_SGR);
    });

    it('with nothing focused, a refresh leaves the cursor after the bar', () => {
        const client = makeClient();
        new StatusBarView({
            client,
            id: 5,
            position: { row: 24, col: 1 },
            dimens: { width: 40, height: 1 },
            text: 'one',
            refreshInterval: 1000,
        });
        const before = client.term.flushes.length;
        timers.fireAll();
        const out = client.term.flushes.slice(before).join('');
        assert.equal(client.term.textAt(24, 1, 3), 'one');
        assert.ok(!out.includes(HIDE_CURSOR) && !out.includes(SHOW_CURSOR));
        assert.equal(client.term.pos(), '24,41');
    });
});

describe('View input focus tracking', () => {
    function makeEtv(client, row) {
        return new EditTextView({
            client,
            id: row,
            position: { row, col: 1 },
            dimens: { width: 10 },
            maxLength: 10,
        });
    }

    it('is the view last given focus while it holds it', () => {
        const client = makeClient();
        const a = makeEtv(client, 1);
        const b = makeEtv(client, 2);

        assert.equal(View.getInputFocusView(client), null);
        a.setFocus(true);
        assert.equal(View.getInputFocusView(client), a);
        b.setFocus(true);
        assert.equal(View.getInputFocusView(client), b);

        a.setFocus(false); //  not the holder: changes nothing
        assert.equal(View.getInputFocusView(client), b);

        b.setFocus(false);
        assert.equal(View.getInputFocusView(client), null);
    });

    it('is kept per client', () => {
        const one = makeClient();
        const two = makeClient();
        const a = makeEtv(one, 1);
        a.setFocus(true);
        assert.equal(View.getInputFocusView(two), null);
    });

    it('is released when its form is torn down', () => {
        const client = makeClient();
        const vc = new ViewController({ client });
        const a = makeEtv(client, 1);
        vc.addView(a);
        vc.setViewOrder();
        vc.switchFocus(1);
        assert.equal(View.getInputFocusView(client), a);

        vc.detachClientEvents();
        assert.equal(a.hasFocus, true, 'the view itself keeps hasFocus');
        assert.equal(View.getInputFocusView(client), null);
    });

    it('suspend/resume: set aside, given back, and nested', () => {
        const client = makeClient();
        const a = makeEtv(client, 1);
        a.setFocus(true);

        const outer = View.suspendInputFocus(client);
        assert.equal(View.getInputFocusView(client), null);
        const inner = View.suspendInputFocus(client); //  a pause within a pause
        View.resumeInputFocus(client, inner); //  nothing was tracked: nothing back
        assert.equal(View.getInputFocusView(client), null);
        View.resumeInputFocus(client, outer);
        assert.equal(View.getInputFocusView(client), a);

        //  a view blurred while set aside is not given back
        const t = View.suspendInputFocus(client);
        a.setFocus(false);
        a.hasFocus = true; //  even if something marks it again by hand
        View.resumeInputFocus(client, t);
        assert.equal(View.getInputFocusView(client), null);

        View.resumeInputFocus(client, null); //  no token: no-op
    });

    describe('the MCI config `focus` property', () => {
        //  a form loaded as displayThemedPrompt() / a menu's prompt loads it
        function loadForm(client, mciMap, mci) {
            const vc = new ViewController({ client });
            vc.loadFromPromptConfig({ mciMap, config: { mci } }, err =>
                assert.ifError(err)
            );
            return vc;
        }

        function mciEntry(code, id, row, col) {
            return { code, id, position: [row, col], args: [], SGR: '', focusSGR: '' };
        }

        it('marks the view but does not track it until the form focuses it', () => {
            const client = makeClient();
            const vc = new ViewController({ client });
            const a = makeEtv(client, 1);
            vc.addView(a);
            vc.applyViewConfig({ mci: { ET1: { focus: true } } }, err =>
                assert.ifError(err)
            );
            assert.equal(a.hasFocus, true, 'marked');
            assert.equal(View.getInputFocusView(client), null, 'not tracked yet');

            vc.switchFocus(1);
            assert.equal(View.getInputFocusView(client), a);
        });

        it('two forms both declaring focus: the one focused last is tracked', () => {
            const client = makeClient();
            const formA = loadForm(
                client,
                { ET1: mciEntry('ET', 1, 10, 5) },
                {
                    ET1: { focus: true },
                }
            );
            const formB = loadForm(
                client,
                { ET1: mciEntry('ET', 1, 20, 5) },
                {
                    ET1: { focus: true },
                }
            );
            assert.equal(View.getInputFocusView(client), formB.getView(1));

            //  and nothing brings form A's field back on its own
            formB.detachClientEvents();
            assert.equal(View.getInputFocusView(client), null);
            assert.ok(formA.getView(1).hasFocus);
        });

        it('a form whose `focus` names a view it cannot focus does not take tracking', () => {
            const client = makeClient();
            const formA = loadForm(
                client,
                { ET1: mciEntry('ET', 1, 10, 5) },
                {
                    ET1: { focus: true },
                }
            );
            //  a mistake in a theme: focus on a text label (logs an assert)
            loadForm(client, { TL2: mciEntry('TL', 2, 3, 3) }, { TL2: { focus: true } });

            assert.equal(View.getInputFocusView(client), formA.getView(1));
        });
    });
});

describe('View.drawInBackground()', () => {
    it('restores the view focused when drawFn() is done, if drawFn() moved focus', () => {
        const client = makeClient();
        const a = makeField(client, 1);
        const b = new EditTextView({
            client,
            id: 2,
            position: { row: 10, col: 40 },
            dimens: { width: 10 },
            maxLength: 10,
            styleSGR2: '\x1b[0;35m',
        });
        a.setFocus(true);

        a.drawInBackground(() => {
            a.setFocus(false);
            b.setFocus(true);
        });
        assert.equal(client.term.pos(), '10,40');
        assert.equal(client.term.sgr, '\x1b[0;35m');
        assert.equal(client.term.cursorVisible, true);
    });

    it('puts the cursor back and rethrows when drawFn() throws', () => {
        const client = makeClient();
        const field = makeField(client, 1);
        field.setFocus(true);
        field.onKeyPress('x');

        const before = client.term.flushes.length;
        assert.throws(
            () =>
                field.drawInBackground(() => {
                    client.term.write('\x1b[2;10Hpartial');
                    throw new Error('draw failed');
                }),
            /draw failed/
        );

        assert.equal(client.term._batch, null, 'the batch was committed');
        assert.equal(client.term.flushes.length, before + 1);
        assert.equal(client.term.cursorVisible, true, 'not left hidden');
        assert.equal(client.term.pos(), '20,6', 'back in the field');
        assert.equal(client.term.sgr, FIELD_FOCUS_SGR);
    });

    it('shows the cursor again if drawFn() left nothing focused', () => {
        const client = makeClient();
        const a = makeField(client, 1);
        a.setFocus(true);

        a.drawInBackground(() => a.setFocus(false));
        assert.equal(client.term.cursorVisible, true, 'not left hidden');
    });
});
