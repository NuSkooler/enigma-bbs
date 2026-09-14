/* eslint-disable no-control-regex */
'use strict';

const { strict: assert } = require('assert');

const { MenuModule } = require('../core/menu_module.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { TextView } = require('../core/text_view.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');

// ─── Test helpers ────────────────────────────────────────────────────────────

//  A client whose terminal tracks the hardware cursor the way a real one does:
//  CSI <row>;<col>H moves it, printable characters advance it.  Everything the
//  views emit goes through here, so the recorded position is what a user would
//  actually see in SyncTERM.
function makeTrackingClient() {
    const term = {
        termWidth: 80,
        termHeight: 25,
        cursor: { row: 1, col: 1 },
        writes: [],
    };

    const consume = s => {
        if (typeof s !== 'string') {
            return;
        }
        term.writes.push(s);

        let i = 0;
        while (i < s.length) {
            const ch = s[i];
            if ('\x1b' === ch && '[' === s[i + 1]) {
                let j = i + 2;
                while (j < s.length && /[0-9;?]/.test(s[j])) {
                    ++j;
                }
                if ('H' === s[j] || 'f' === s[j]) {
                    const [row, col] = s.slice(i + 2, j).split(';');
                    term.cursor.row = parseInt(row, 10) || 1;
                    term.cursor.col = parseInt(col, 10) || 1;
                }
                i = j + 1;
                continue;
            }
            if ('\r' === ch) {
                term.cursor.col = 1;
            } else if ('\n' === ch) {
                ++term.cursor.row;
            } else {
                ++term.cursor.col;
            }
            ++i;
        }
    };

    term.write = consume;
    term.rawWrite = consume;

    return { term, pos: () => `${term.cursor.row},${term.cursor.col}` };
}

//  Build a MenuModule without running its constructor: updateCustomViewTextsWithFilter
//  needs only |client|, |menuConfig| and |viewControllers|, and skipping the
//  constructor keeps the test clear of the Config() capture that MenuModule
//  performs at require time.
function makeModule(client, views, focusedView, config) {
    const form = {
        getView: id => views[id],
        getFocusedView: () => focusedView,
    };

    const mod = Object.create(MenuModule.prototype);
    mod.client = client;
    mod.menuConfig = { config };
    mod.viewControllers = { main: form };
    return mod;
}

//  The activityPubSearch main form: ET2 is the search input the user types
//  into, TL10 the status line that gets rewritten on every search (#831).
function makeSearchInput(client) {
    return new EditTextView({
        client,
        id: 2,
        position: { row: 13, col: 21 },
        dimens: { width: 50 },
        maxLength: 70,
        acceptsFocus: true,
        acceptsInput: true,
    });
}

function makeStatusLine(client) {
    return new TextView({
        client,
        id: 10,
        position: { row: 22, col: 6 },
        dimens: { width: 60 },
        acceptsFocus: false,
    });
}

const STATUS_FORMAT = { mainInfoFormat10: 'Status: {statusText}' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MenuModule custom view cursor restore', () => {
    it('leaves the cursor in the focused input after redrawing a status line', () => {
        const client = makeTrackingClient();
        const input = makeSearchInput(client);
        const status = makeStatusLine(client);
        const mod = makeModule(client, { 2: input, 10: status }, input, STATUS_FORMAT);

        input.setFocus(true);
        assert.equal(client.pos(), '13,21', 'precondition: focus put the cursor in ET2');

        mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'Searching...' });

        assert.equal(
            client.pos(),
            '13,21',
            'cursor must return to the focused input, not stay on the status line'
        );
    });

    it('restores the cursor on the redraw path as well as the setText path', () => {
        const client = makeTrackingClient();
        const input = makeSearchInput(client);
        const status = makeStatusLine(client);
        const mod = makeModule(client, { 2: input, 10: status }, input, STATUS_FORMAT);

        input.setFocus(true);
        //  First call sets the text; the second finds it unchanged and takes
        //  the plain redraw() branch, which draws just the same.
        mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'Ready' });
        mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'Ready' });

        assert.equal(client.pos(), '13,21');
    });

    it('echoes a typed character in the input rather than over the status line', () => {
        const client = makeTrackingClient();
        const input = makeSearchInput(client);
        const status = makeStatusLine(client);
        const mod = makeModule(client, { 2: input, 10: status }, input, STATUS_FORMAT);

        input.setFocus(true);
        mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'Searching...' });

        //  EditTextView's append fast path writes at the current cursor with no
        //  goto of its own, so a displaced cursor echoes in the wrong place.
        input.onKeyPress('a', undefined);

        assert.equal(client.pos(), '13,22', 'the "a" must land in the input field');
        assert.equal(input.getData(), 'a');
    });

    it('restores the cursor after appending to a multi-line custom view', () => {
        const client = makeTrackingClient();
        const input = makeSearchInput(client);
        const log = new MultiLineEditTextView({
            client,
            id: 10,
            position: { row: 18, col: 2 },
            dimens: { width: 40, height: 4 },
            acceptsFocus: false,
        });
        const mod = makeModule(client, { 2: input, 10: log }, input, {
            mainInfoFormat10: 'log line {n}',
        });

        input.setFocus(true);
        mod.updateCustomViewTextsWithFilter(
            'main',
            10,
            { n: '1' },
            { appendMultiLine: true }
        );

        assert.equal(client.pos(), '13,21');
    });

    it('honours a _repositionCursor patched onto a view', () => {
        //  sysop_chat.js replaces _repositionCursor on its input view to account
        //  for a prefix and its own scroll offset; the restore must go through
        //  whatever the view provides rather than assuming the stock one.
        const client = makeTrackingClient();
        const input = makeSearchInput(client);
        const status = makeStatusLine(client);
        const mod = makeModule(client, { 2: input, 10: status }, input, STATUS_FORMAT);

        let called = 0;
        input._repositionCursor = () => {
            ++called;
            client.term.write('\x1b[7;7H');
        };

        input.setFocus(true);
        called = 0; //  setFocus positions the cursor too; count only the restore

        mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'hi' });

        assert.equal(called, 1, 'the patched _repositionCursor should be used');
        assert.equal(client.pos(), '7,7');
    });

    describe('no-op cases', () => {
        //  Run one update and return every byte the terminal received, so a
        //  "no-op" can be asserted exactly rather than by cursor position alone.
        function writesFor(makeFocused) {
            const client = makeTrackingClient();
            const status = makeStatusLine(client);
            const focused = makeFocused ? makeFocused(client) : null;
            const views = { 10: status };
            if (focused) {
                views[2] = focused;
                focused.setFocus(true);
            }
            const mod = makeModule(client, views, focused, STATUS_FORMAT);

            client.term.writes.length = 0;
            mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'hi' });
            return { writes: client.term.writes.join(''), pos: client.pos() };
        }

        it('does not move the cursor when a menu view holds focus', () => {
            //  VerticalMenuView has no cursor of its own to restore; the module
            //  that owns it decides where the cursor belongs.
            const menu = writesFor(
                client =>
                    new VerticalMenuView({
                        client,
                        id: 2,
                        position: { row: 13, col: 21 },
                        dimens: { width: 30, height: 5 },
                        items: ['one', 'two'],
                        acceptsFocus: true,
                        acceptsInput: true,
                    })
            );
            const none = writesFor(null);
            assert.equal(
                menu.writes,
                none.writes,
                'a focused menu view must not change what is written'
            );
        });

        it('does not move the cursor when nothing holds focus', () => {
            const { pos } = writesFor(null);
            //  Left where the status line finished drawing: col 6 + width 60.
            assert.equal(pos, '22,66');
        });

        it('does not move the cursor to a view that has since been blurred', () => {
            //  ViewController keeps |focusedView| pointing at the last focused
            //  view even after it is blurred, so hasFocus is what must be trusted.
            const client = makeTrackingClient();
            const input = makeSearchInput(client);
            const status = makeStatusLine(client);
            const mod = makeModule(
                client,
                { 2: input, 10: status },
                input,
                STATUS_FORMAT
            );

            input.setFocus(true);
            input.setFocus(false);
            assert.equal(input.hasFocus, false, 'precondition: the input is blurred');

            mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'hi' });

            assert.equal(
                client.pos(),
                '22,66',
                'cursor must stay where the caller left it'
            );
        });

        it('writes nothing at all when no custom views are configured', () => {
            const client = makeTrackingClient();
            const input = makeSearchInput(client);
            const status = makeStatusLine(client);
            //  No mainInfoFormat10 -> getCustomViewsWithFilter matches nothing.
            const mod = makeModule(client, { 2: input, 10: status }, input, {});

            input.setFocus(true);
            client.term.writes.length = 0;
            mod.updateCustomViewTextsWithFilter('main', 10, { statusText: 'hi' });

            assert.deepEqual(client.term.writes, []);
        });
    });
});
