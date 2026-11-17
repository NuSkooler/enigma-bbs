/* eslint-disable no-control-regex */
'use strict';

//
//  Views measure, cut and pad the text they draw, which is already rendered:
//  only ANSI escapes are codes there. A pipe that is left after rendering
//  ("||07" shows "|07", an unknown "|ZZ", a code in an editor field shown as
//  typed) is text and takes its columns (#1022).
//

const { strict: assert } = require('assert');

const { strDisplayWidth } = require('../core/display_width.js');

//  What a terminal shows: SGR dropped, ESC[nC as n spaces (bare = 1)
function visible(s) {
    return s
        .replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat('' === n ? 1 : parseInt(n, 10)))
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function makeClient() {
    const writes = [];
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: s => writes.push(String(s)),
            rawWrite: s => writes.push(String(s)),
        },
        log: {
            trace() {},
            debug() {},
            info() {},
            warn() {},
            error() {},
            fatal() {},
        },
        writes,
    };
}

//  The text drawn after the last (or first) cursor move to |row|
function drawnOnRow(client, row, first = false) {
    const all = client.writes.join('');
    const re = new RegExp(`\\x1b\\[${row};\\d+H`, 'g');
    let last = -1;
    while (null !== re.exec(all)) {
        last = re.lastIndex;
        if (first) {
            break;
        }
    }
    assert.ok(last >= 0, `nothing drawn on row ${row}`);
    const rest = all.slice(last);
    const next = rest.search(/\x1b\[\d+;\d+H/);
    return visible(-1 === next ? rest : rest.slice(0, next));
}

describe('Views measure what they draw (ANSI only)', function () {
    let TextView;
    let StatusBarView;
    let VerticalMenuView;

    before(function () {
        ({ TextView } = require('../core/text_view.js'));
        ({ StatusBarView } = require('../core/status_bar_view.js'));
        ({ VerticalMenuView } = require('../core/vertical_menu_view.js'));
    });

    describe('TextView', function () {
        function makeTextView(opts) {
            const client = makeClient();
            const view = new TextView(
                Object.assign(
                    {
                        client,
                        id: 1,
                        position: { row: 3, col: 1 },
                        dimens: { width: 8 },
                    },
                    opts
                )
            );
            return { view, client };
        }

        it('pads text that shows a literal pipe code to the field width', function () {
            const { view, client } = makeTextView();
            view.setText('|15a||07b');
            assert.equal(drawnOnRow(client, 3), 'a|07b   ');
        });

        it('horizScroll shows the last columns of a focused, overflowing value', function () {
            const { view, client } = makeTextView({
                dimens: { width: 5 },
                acceptsFocus: true,
            });
            view.setText('|15ab||07日本x');
            client.writes.length = 0;
            view.setFocus(true); //  draws, then places the cursor
            //  shows "ab|07日本x" (11 columns): the last 5 are "日本x"
            assert.equal(drawnOnRow(client, 3, true), '日本x');
        });

        it('cuts an overflowing value by columns and appends textOverflow', function () {
            const { view, client } = makeTextView({ textOverflow: '..' });
            view.setText('|15a||b日本語xyz');
            const shown = drawnOnRow(client, 3);
            //  "本" would straddle column 6, so it is left out and padded
            assert.equal(shown, 'a|b日.. ');
            assert.equal(strDisplayWidth(shown), 8);
        });

        it('an itemFormat is rendered and measured once', function () {
            const { view, client } = makeTextView({ dimens: { width: 10 } });
            view.itemFormat = '|08[|15{text}|08]';
            view.setText('日本');
            assert.equal(drawnOnRow(client, 3), '[日本]    ');
        });
    });

    describe('StatusBarView panels', function () {
        function makeBar(panels) {
            const client = makeClient();
            const view = new StatusBarView({
                client,
                id: 1,
                position: { row: 2, col: 1 },
                dimens: { width: 12, height: 1 },
                panels,
                refreshInterval: 0,
            });
            return { view, client };
        }

        it('clip-left keeps the last columns of a coloured value', function () {
            const { view, client } = makeBar([
                { name: 'a', width: 6, overflow: 'clip-left' },
                { name: 'b', width: 6 },
            ]);
            view.setPanels({ a: '|15abc||07de', b: '|10日本語x' });
            //  a shows "abc|07de" (8 columns): its last 6 are "c|07de"
            assert.equal(drawnOnRow(client, 2), 'c|07de日本語');
        });

        it('pads a value with a literal pipe to its panel width', function () {
            const { view, client } = makeBar([
                { name: 'a', width: 6, fillChar: '.' },
                { name: 'b', width: 6, fillChar: '.' },
            ]);
            view.setPanels({ a: 'x||y', b: '|ZZ' });
            assert.equal(drawnOnRow(client, 2), 'x|y...|ZZ...');
        });
    });

    describe('VerticalMenuView', function () {
        it('truncates and pads items by the columns they show', function () {
            const client = makeClient();
            const view = new VerticalMenuView({
                client,
                id: 1,
                position: { row: 5, col: 1 },
                dimens: { width: 6, height: 3 },
                items: ['a || b c', '日本語xyz', 'x||07'],
            });
            view.setTextOverflow('..');
            view.redraw();
            assert.equal(drawnOnRow(client, 5), 'a | ..');
            assert.equal(drawnOnRow(client, 6), '日本..');
            assert.equal(drawnOnRow(client, 7), 'x|07  ');
        });
    });
});
