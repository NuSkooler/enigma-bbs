/* eslint-disable no-control-regex */
'use strict';

//  TableView (%TV): rows, groups, columns, header, sorting, pipe codes (#447)

const { strict: assert } = require('assert');

const { TableView } = require('../core/table_view.js');
const { MCIViewFactory } = require('../core/mci_view_factory.js');
const { pipeToAnsi } = require('../core/color_codes.js');

//  What a terminal shows: SGR dropped, ESC[nC as n spaces (bare = 1)
function visible(s) {
    return s
        .replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat('' === n ? 1 : parseInt(n, 10)))
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function makeClient(termWidth = 80) {
    const writes = [];
    return {
        term: {
            termWidth,
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

//  The raw text drawn after the last (or first) cursor move to |row|
function rawOnRow(client, row, first = false) {
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
    return -1 === next ? rest : rest.slice(0, next);
}

function drawnOnRow(client, row, first = false) {
    return visible(rawOnRow(client, row, first));
}

//  Rows (screen row numbers) written since the writes were last cleared
function rowsWritten(client) {
    const rows = new Set();
    const re = /\x1b\[(\d+);\d+H/g;
    const all = client.writes.join('');
    let m;
    while (null !== (m = re.exec(all))) {
        rows.add(parseInt(m[1], 10));
    }
    return [...rows].sort((a, b) => a - b);
}

//  Mirror the real lifecycle: drawn before any key press
function makeView(opts = {}, items, { termWidth = 80, draw = true } = {}) {
    const client = makeClient(termWidth);
    const view = new TableView(
        Object.assign(
            {
                client,
                id: 1,
                position: { row: 1, col: 1 },
                dimens: { width: 30, height: 5 },
            },
            opts
        )
    );
    if (items) {
        view.setItems(items);
    }
    if (draw) {
        view.redraw();
    }
    return { view, client };
}

const key = name => ({ name });

const g = (text, extra) => Object.assign({ kind: 'group', text }, extra);
const it_ = (text, extra) => Object.assign({ text }, extra);

describe('TableView', function () {
    describe('registration', function () {
        it('is a user view code and the factory creates it', function () {
            assert.ok(MCIViewFactory.UserViewCodes.includes('TV'));
            const factory = new MCIViewFactory(makeClient());
            const view = factory.createFromMCI({
                code: 'TV',
                id: 1,
                position: [2, 3],
                args: [],
            });
            assert.ok(view instanceof TableView);
            assert.equal(view.mciCode, 'TV');
            assert.deepEqual(view.position, { row: 2, col: 3 });
        });
    });

    describe('navigation', function () {
        const list = () => [
            g('A'),
            it_('a1'),
            it_('a2'),
            g('B'),
            it_('b1', { selectable: false }),
            it_('b2'),
            g('C'),
            it_('c1'),
        ];

        it('starts on the first selectable row', function () {
            const { view } = makeView({}, list());
            assert.equal(view.getFocusItemIndex(), 1);
        });

        it('down and up skip group and unselectable rows', function () {
            const { view } = makeView({ dimens: { width: 20, height: 8 } }, list());
            view.setFocus(true);
            const seen = [];
            for (let i = 0; i < 3; ++i) {
                view.onKeyPress(null, key('down arrow'));
                seen.push(view.getFocusItemIndex());
            }
            assert.deepEqual(seen, [2, 5, 7]);
            view.onKeyPress(null, key('up arrow'));
            assert.equal(view.getFocusItemIndex(), 5);
            view.onKeyPress(null, key('up arrow'));
            assert.equal(view.getFocusItemIndex(), 2);
        });

        it('wraps around at the ends of the list (VM parity)', function () {
            const { view } = makeView({}, list());
            view.focusPrevious();
            assert.equal(view.getFocusItemIndex(), 7);
            view.focusNext();
            assert.equal(view.getFocusItemIndex(), 1);
        });

        it('home and end go to the first and last selectable rows', function () {
            const { view } = makeView({}, list());
            view.focusLast();
            assert.equal(view.getFocusItemIndex(), 7);
            view.focusFirst();
            assert.equal(view.getFocusItemIndex(), 1);
        });

        it('page down/up land on selectable rows and wrap at the ends', function () {
            const items = [];
            for (let i = 0; i < 20; ++i) {
                items.push(0 === i % 5 ? g(`G${i}`) : it_(`r${i}`));
            }
            const { view } = makeView({ dimens: { width: 20, height: 4 } }, items);
            assert.equal(view.getFocusItemIndex(), 1);
            view.focusNextPageItem(); //  1 + 4 = 5 is a group: next selectable
            assert.equal(view.getFocusItemIndex(), 6);
            view.focusNextPageItem();
            assert.equal(view.getFocusItemIndex(), 11); //  10 is a group
            view.focusPreviousPageItem(); //  11 - 4 = 7
            assert.equal(view.getFocusItemIndex(), 7);
            view.focusPreviousPageItem(); //  3
            assert.equal(view.getFocusItemIndex(), 3);
            view.focusPreviousPageItem(); //  0 is a group: first selectable
            assert.equal(view.getFocusItemIndex(), 1);
            view.focusPreviousPageItem(); //  at the top: wraps to the last
            assert.equal(view.getFocusItemIndex(), 19);
            view.focusNextPageItem(); //  at the bottom: wraps to the first
            assert.equal(view.getFocusItemIndex(), 1);
        });

        it('emits index update with the row', function () {
            const { view } = makeView({}, list());
            const events = [];
            view.on('index update', (idx, item) => events.push([idx, item.text]));
            view.focusNext();
            view.focusNext();
            assert.deepEqual(events, [
                [2, 'a2'],
                [5, 'b2'],
            ]);
        });

        it('scrolls as little as possible', function () {
            const items = [];
            for (let i = 0; i < 10; ++i) {
                items.push(it_(`r${i}`));
            }
            const { view, client } = makeView(
                { dimens: { width: 10, height: 3 } },
                items
            );
            view.focusNext();
            view.focusNext();
            assert.equal(view.viewWindow.top, 0);
            view.focusNext(); //  r3: one row down
            assert.deepEqual(view.viewWindow, { top: 1, bottom: 3 });
            assert.equal(drawnOnRow(client, 3).trim(), 'r3');
            view.focusPrevious();
            view.focusPrevious();
            assert.equal(view.viewWindow.top, 1);
            view.focusPrevious(); //  r0: one row up
            assert.equal(view.viewWindow.top, 0);
        });

        it("pulls a row's group header into view when scrolling up to it", function () {
            const items = [g('A'), it_('a1'), it_('a2'), it_('a3'), g('B'), it_('b1')];
            const { view, client } = makeView(
                { dimens: { width: 10, height: 2 } },
                items
            );
            //  first selectable row: its group header is shown above it
            assert.deepEqual(view.viewWindow, { top: 0, bottom: 1 });
            view.focusLast();
            assert.equal(view.getFocusItemIndex(), 5);
            assert.deepEqual(view.viewWindow, { top: 4, bottom: 5 });
            view.focusFirst();
            assert.deepEqual(view.viewWindow, { top: 0, bottom: 1 });
            assert.equal(drawnOnRow(client, 1).trim(), 'A');
        });

        it('focusItemAtTop puts the focused row at the top', function () {
            const items = [];
            for (let i = 0; i < 10; ++i) {
                items.push(it_(`r${i}`));
            }
            const { view } = makeView(
                { dimens: { width: 10, height: 3 }, focusItemAtTop: true },
                items
            );
            view.focusNext();
            assert.equal(view.viewWindow.top, 1);
            view.focusLast(); //  near the end the window fills from the bottom
            assert.deepEqual(view.viewWindow, { top: 7, bottom: 9 });
        });

        it('focus moves within the window redraw only the two rows', function () {
            const { view, client } = makeView(
                { dimens: { width: 20, height: 8 } },
                list()
            );
            client.writes.length = 0;
            view.focusNext(); //  1 -> 2
            assert.deepEqual(rowsWritten(client), [2, 3]);
            client.writes.length = 0;
            view.focusNext(); //  2 -> 5, skipping two rows
            assert.deepEqual(rowsWritten(client), [3, 6]);
        });

        it('hot keys to unselectable rows are ignored', function () {
            const { view } = makeView({ hotKeys: { g: 0, b: 4, c: 7 } }, list());
            view.setFocus(true);
            view.onKeyPress('g', null);
            assert.equal(view.getFocusItemIndex(), 1);
            view.onKeyPress('b', null);
            assert.equal(view.getFocusItemIndex(), 1);
            view.onKeyPress('c', null);
            assert.equal(view.getFocusItemIndex(), 7);
        });
    });

    describe('empty lists', function () {
        [
            ['no rows', []],
            ['only group rows', [g('A'), g('B')]],
        ].forEach(([what, items]) => {
            it(`${what}: navigation is quiet and emptyText is drawn`, function () {
                const { view, client } = makeView(
                    { emptyText: '|15Nothing new', dimens: { width: 20, height: 3 } },
                    items
                );
                let updates = 0;
                view.on('index update', () => updates++);
                [
                    'focusNext',
                    'focusPrevious',
                    'focusNextPageItem',
                    'focusPreviousPageItem',
                    'focusFirst',
                    'focusLast',
                ].forEach(m => assert.doesNotThrow(() => view[m]()));
                assert.equal(updates, 0);
                assert.equal(drawnOnRow(client, 1), 'Nothing new         ');
                assert.equal(drawnOnRow(client, 2).trim(), '');
                assert.equal(view.getData(), null);
                assert.equal(view.getFocusedItem(), null);
                assert.ok(rawOnRow(client, 1).includes(pipeToAnsi('|15')));
            });
        });
    });

    describe('columns', function () {
        const cols = {
            name: { field: 'name', width: 'fill' },
            count: { field: 'count', width: 5 },
        };

        it('lays out fixed, fill and percentage widths with a separator', function () {
            const { client } = makeView(
                {
                    dimens: { width: 30, height: 2 },
                    separator: '|',
                    columns: {
                        a: { width: 4 },
                        b: { width: '50%' },
                        c: { width: 'fill' },
                    },
                    columnOrder: ['a', 'b', 'c'],
                },
                [{ a: 'A', b: 'B', c: 'C' }]
            );
            //  30 - 2 separators = 28; b = 14; c = 28 - 4 - 14 = 10
            assert.equal(drawnOnRow(client, 1), 'A   |B             |C         ');
        });

        it('uses the column id as the field and keeps columnOrder', function () {
            const { client } = makeView(
                {
                    dimens: { width: 10, height: 1 },
                    columns: { x: { width: 3 }, y: { width: 3 } },
                    columnOrder: ['y', 'x'],
                },
                [{ x: 'X', y: 'Y' }]
            );
            assert.equal(drawnOnRow(client, 1), 'Y  X      ');
        });

        it('splits fill space between several fill columns', function () {
            const { client } = makeView(
                {
                    dimens: { width: 11, height: 1 },
                    columns: { a: {}, b: { width: 'fill' }, c: { width: 1 } },
                    columnOrder: ['a', 'b', 'c'],
                },
                [{ a: 'a', b: 'b', c: 'c' }]
            );
            assert.equal(drawnOnRow(client, 1), 'a    b    c');
        });

        it('justifies numbers right and text left by default', function () {
            const { client } = makeView(
                { dimens: { width: 15, height: 2 }, columns: cols },
                [
                    { name: 'abc', count: 12 },
                    { name: 'de', count: 3 },
                ]
            );
            assert.equal(drawnOnRow(client, 1), 'abc          12');
            assert.equal(drawnOnRow(client, 2), 'de            3');
        });

        it('explicit justify and type override the defaults', function () {
            const { client } = makeView(
                {
                    dimens: { width: 15, height: 1 },
                    columns: {
                        name: { width: 'fill', justify: 'right' },
                        count: { width: 5, justify: 'center' },
                        code: { width: 3, type: 'number' },
                    },
                    columnOrder: ['name', 'count', 'code'],
                },
                [{ name: 'ab', count: 1, code: '7' }]
            );
            assert.equal(drawnOnRow(client, 1), '     ab  1    7');
        });

        it('textOverflow cuts with an omission; unset is a plain cut', function () {
            const { client } = makeView(
                {
                    dimens: { width: 12, height: 1 },
                    columns: {
                        a: { width: 6, textOverflow: '…' },
                        b: { width: 6 },
                    },
                    columnOrder: ['a', 'b'],
                },
                [{ a: 'abcdefghij', b: 'klmnopqrst' }]
            );
            assert.equal(drawnOnRow(client, 1), 'abcde…klmnop');
        });

        it('nullText stands in for empty values; format applies to the rest', function () {
            const { client } = makeView(
                {
                    dimens: { width: 16, height: 3 },
                    columns: {
                        n: { width: 8, nullText: '-', format: '{value:,}' },
                        t: { width: 8, nullText: 'n/a' },
                    },
                    columnOrder: ['n', 't'],
                },
                [{ n: 12345, t: '' }, { t: null }, { n: 0, t: 'x' }]
            );
            assert.equal(drawnOnRow(client, 1), '  12,345n/a     ');
            assert.equal(drawnOnRow(client, 2), '       -n/a     ');
            assert.equal(drawnOnRow(client, 3), '       0x       ');
        });

        it('format sees {value} and every row field, with transformers', function () {
            const { client } = makeView(
                {
                    dimens: { width: 20, height: 1 },
                    columns: {
                        a: { field: 'name', format: '{value!styleUpper} ({count})' },
                    },
                },
                [{ name: 'bob', count: 3 }]
            );
            assert.equal(drawnOnRow(client, 1), 'BOB (3)             ');
        });

        it('formats dates with dateFormat and bools with boolText', function () {
            const { client } = makeView(
                {
                    dimens: { width: 12, height: 1 },
                    columns: {
                        d: { width: 6, type: 'date', dateFormat: 'MMM DD' },
                        b: { width: 3 },
                        c: { width: 3, boolText: ['+', '-'] },
                    },
                    columnOrder: ['d', 'b', 'c'],
                },
                [{ d: new Date(2026, 10, 17, 21, 4), b: true, c: false }]
            );
            assert.equal(drawnOnRow(client, 1), 'Nov 17Yes-  ');
        });

        it('padding narrows the content inside the column', function () {
            const { client } = makeView(
                {
                    dimens: { width: 12, height: 1 },
                    columns: {
                        a: { width: 6, padding: 1 },
                        b: { width: 6, padding: [2, 0] },
                    },
                    columnOrder: ['a', 'b'],
                },
                [{ a: 'abcdefgh', b: 'xyz' }]
            );
            assert.equal(drawnOnRow(client, 1), ' abcd   xyz ');
        });

        it('fillChar fills a column with its own character', function () {
            const { client } = makeView(
                {
                    dimens: { width: 8, height: 1 },
                    columns: { a: { width: 8, fillChar: '.' } },
                },
                [{ a: 'ab' }]
            );
            assert.equal(drawnOnRow(client, 1), 'ab......');
        });

        it('minTermWidth hides a column on narrower terminals; fill takes the space', function () {
            const options = {
                dimens: { width: 20, height: 1 },
                separator: ' ',
                columns: {
                    name: { width: 'fill' },
                    last: { width: 6, minTermWidth: 80 },
                },
                columnOrder: ['name', 'last'],
            };
            const row = [{ name: 'General', last: 'Nov 17' }];
            const wide = makeView(options, row);
            assert.equal(drawnOnRow(wide.client, 1), 'General       Nov 17');
            const narrow = makeView(options, row, { termWidth: 40 });
            assert.equal(drawnOnRow(narrow.client, 1), 'General             ');
        });

        it('clips to the terminal on a narrow screen', function () {
            const { client } = makeView(
                {
                    position: { row: 1, col: 31 },
                    dimens: { width: 20, height: 1 },
                    columns: { a: { width: 'fill' } },
                },
                [{ a: 'abcdefghijklmnopqrst' }],
                { termWidth: 40 }
            );
            assert.equal(drawnOnRow(client, 1), 'abcdefghij');
        });

        it('group rows span the view: format, fillChar, justify', function () {
            const { client } = makeView(
                {
                    dimens: { width: 20, height: 3 },
                    columns: { a: { width: 'fill' } },
                    group: { format: '|08── |15{confName} ', fillChar: '|08─' },
                },
                [g('', { confName: 'fsxNet' }), { a: 'x' }]
            );
            assert.equal(drawnOnRow(client, 1), '── fsxNet ──────────');
            const raw = rawOnRow(client, 1);
            //  the fill is drawn in its own colour
            assert.ok(raw.includes(`${pipeToAnsi('|08')}─────`));
        });
    });

    describe('header', function () {
        const opts = extra =>
            Object.assign(
                {
                    dimens: { width: 16, height: 4 },
                    header: true,
                    separator: ' ',
                    columns: {
                        name: { label: 'Area', width: 'fill' },
                        n: { label: 'New', width: 5, type: 'number' },
                    },
                    columnOrder: ['name', 'n'],
                },
                extra
            );

        it('is off by default (headerless is first-class)', function () {
            const { client } = makeView(Object.assign(opts(), { header: undefined }), [
                { name: 'a', n: 1 },
            ]);
            assert.equal(drawnOnRow(client, 1), 'a              1');
        });

        it('aligns labels to the column widths and justification', function () {
            const { client } = makeView(opts({ headerSGR: '|11' }), [
                { name: 'a', n: 1 },
            ]);
            assert.equal(drawnOnRow(client, 1), 'Area         New');
            assert.equal(drawnOnRow(client, 2), 'a              1');
            assert.ok(rawOnRow(client, 1).includes(pipeToAnsi('|11')));
        });

        it('shows the sort indicator on the sorted column', function () {
            const { view, client } = makeView(
                opts({ sort: { column: 'n', order: 'desc' } }),
                [{ name: 'a', n: 1 }]
            );
            assert.equal(drawnOnRow(client, 1), 'Area        New▼');
            view.toggleSortOrder();
            assert.equal(drawnOnRow(client, 1), 'Area        New▲');
            view.setSort('name');
            assert.equal(drawnOnRow(client, 1), 'Area▲        New');
        });

        it('headerFormat with setHeaderData', function () {
            const { view, client } = makeView(
                opts({ headerFormat: 'Conf: {conf}', columns: undefined }),
                ['x']
            );
            view.setHeaderData({ conf: 'fsxNet' });
            assert.equal(drawnOnRow(client, 1), 'Conf: fsxNet    ');
            assert.equal(drawnOnRow(client, 2), 'x               ');
        });

        it('takes a body line: paging and the window use the rest', function () {
            const items = [];
            for (let i = 0; i < 10; ++i) {
                items.push({ name: `r${i}`, n: i });
            }
            const { view } = makeView(opts(), items);
            assert.deepEqual(view.viewWindow, { top: 0, bottom: 2 });
            view.focusNextPageItem();
            assert.equal(view.getFocusItemIndex(), 3);
        });
    });

    describe('sorting', function () {
        const rows = () => [
            g('A'),
            { key: 'a1', name: 'beta', n: 9, d: '2026-11-01' },
            { key: 'a2', name: 'Alpha', n: 10, d: '2026-11-03' },
            { key: 'a3', name: 'gamma', n: null, d: null },
            { key: 'a4', name: 'delta', n: 2, d: '2026-10-01' },
            g('B'),
            { key: 'b1', name: 'zed', n: 1 },
            { key: 'b2', name: 'yak', n: 5 },
        ];
        const columns = {
            name: { width: 'fill' },
            n: { width: 3, type: 'number' },
            d: { width: 10, type: 'date' },
        };
        const keys = view => view.getItems().map(i => i.key || i.text);

        it('keeps module order without a sort', function () {
            const { view } = makeView({ columns }, rows());
            assert.deepEqual(keys(view), ['A', 'a1', 'a2', 'a3', 'a4', 'B', 'b1', 'b2']);
        });

        it('sorts within groups by type; numbers numerically, empty last', function () {
            const { view } = makeView({ columns, sort: { column: 'n' } }, rows());
            assert.deepEqual(keys(view), ['A', 'a4', 'a1', 'a2', 'a3', 'B', 'b1', 'b2']);
            view.toggleSortOrder();
            assert.deepEqual(keys(view), ['A', 'a2', 'a1', 'a4', 'a3', 'B', 'b2', 'b1']);
        });

        it('text sorts case-insensitively; dates by time', function () {
            const { view } = makeView({ columns, sort: { column: 'name' } }, rows());
            assert.deepEqual(keys(view), ['A', 'a2', 'a1', 'a4', 'a3', 'B', 'b2', 'b1']);
            view.setSort('d', 'desc');
            assert.deepEqual(keys(view).slice(0, 5), ['A', 'a2', 'a1', 'a4', 'a3']);
        });

        it('then breaks ties', function () {
            const { view } = makeView(
                {
                    columns: { s: {}, n: { type: 'number' } },
                    sort: { column: 's', then: { column: 'n', order: 'desc' } },
                },
                [
                    { key: 1, s: 'x', n: 1 },
                    { key: 2, s: 'a', n: 1 },
                    { key: 3, s: 'x', n: 3 },
                ]
            );
            assert.deepEqual(
                view.getItems().map(i => i.key),
                [2, 3, 1]
            );
        });

        it('sort: true sorts by text, as on a VM', function () {
            const { view } = makeView({ sort: true }, ['b', 'C', 'a']);
            assert.deepEqual(view.getItems(), ['a', 'b', 'C']);
        });

        it('a sort column without a column definition sorts by that field', function () {
            const { view } = makeView({ sort: { column: 'rank' } }, [
                { text: 'x', rank: 3 },
                { text: 'y', rank: 1 },
            ]);
            assert.deepEqual(
                view.getItems().map(i => i.text),
                ['y', 'x']
            );
        });

        it('keeps focus on the same row after a re-sort', function () {
            const { view } = makeView({ columns }, rows());
            view.focusNext(); //  a2
            assert.equal(view.getFocusedItem().key, 'a2');
            const events = [];
            view.on('index update', (idx, item) => events.push([idx, item.key]));
            view.setSort('n', 'asc');
            assert.equal(view.getFocusedItem().key, 'a2');
            assert.equal(view.getFocusItemIndex(), 3);
            assert.deepEqual(events, [[3, 'a2']]);
        });

        it('cycleSort goes through sortable and wraps; setSort(null) restores module order', function () {
            const { view } = makeView(
                {
                    columns: Object.assign({}, columns, {
                        n: { width: 3, type: 'number', sortOrder: 'desc' },
                    }),
                    sortable: ['name', 'n'],
                },
                rows()
            );
            assert.equal(view.getSort(), null);
            assert.deepEqual(view.cycleSort(), {
                column: 'name',
                order: 'asc',
                then: [],
            });
            assert.deepEqual(view.cycleSort(), { column: 'n', order: 'desc', then: [] });
            assert.equal(view.cycleSort().column, 'name');
            view.setSort(null);
            assert.equal(view.getSort(), null);
            assert.deepEqual(keys(view), ['A', 'a1', 'a2', 'a3', 'a4', 'B', 'b1', 'b2']);
        });

        it('cycleSort defaults to every visible column', function () {
            const { view } = makeView({ columns, columnOrder: ['n', 'name'] }, rows());
            assert.equal(view.cycleSort().column, 'n');
            assert.equal(view.cycleSort().column, 'name');
            assert.equal(view.cycleSort().column, 'n');
        });

        it('toggleSortOrder without a sort does nothing', function () {
            const { view } = makeView({ columns }, rows());
            assert.equal(view.toggleSortOrder(), null);
            assert.deepEqual(keys(view), ['A', 'a1', 'a2', 'a3', 'a4', 'B', 'b1', 'b2']);
        });

        it('setSort keeps the configured then tie-breakers', function () {
            const { view } = makeView(
                { columns, sort: { column: 'n', then: 'name' } },
                rows()
            );
            assert.deepEqual(view.setSort('d', 'asc'), {
                column: 'd',
                order: 'asc',
                then: [{ column: 'name', order: 'asc' }],
            });
        });
    });

    describe('colour precedence', function () {
        const S = code => pipeToAnsi(code);
        const make = (column, rowState) =>
            makeView(
                {
                    dimens: { width: 10, height: 2 },
                    styleSGR1: S('|07'),
                    focusSGR: '|00|17',
                    stateSGR: { new: '|15' },
                    columns: { a: Object.assign({ width: 10 }, column) },
                },
                [{ a: 'x', state: rowState }, { a: 'y' }]
            );

        it('view default, then column sgr, then stateSGR, then column focusSGR', function () {
            let { client } = make({ sgr: '|03' }, undefined);
            assert.ok(rawOnRow(client, 1).startsWith(`${S('|00|17')}${S('|03')}x`));
            assert.ok(rawOnRow(client, 2).startsWith(`${S('|07')}${S('|03')}y`));

            ({ client } = make({ sgr: '|03' }, 'new'));
            assert.ok(
                rawOnRow(client, 1).startsWith(`${S('|00|17')}${S('|03')}${S('|15')}x`)
            );

            ({ client } = make({ sgr: '|03', focusSGR: '|14' }, 'new'));
            assert.ok(
                rawOnRow(client, 1).startsWith(
                    `${S('|00|17')}${S('|03')}${S('|15')}${S('|14')}x`
                )
            );
            //  column focusSGR applies to the focused row only
            assert.ok(rawOnRow(client, 2).startsWith(`${S('|07')}${S('|03')}y`));
        });

        it('without focusSGR the lightbar is the view focus SGR (styleSGR2)', function () {
            const { client } = makeView(
                {
                    dimens: { width: 4, height: 1 },
                    styleSGR2: S('|30'),
                    columns: { a: { width: 4 } },
                },
                [{ a: 'x' }]
            );
            assert.ok(rawOnRow(client, 1).startsWith(`${S('|30')}x`));
        });

        it('focusColumns lights only those columns', function () {
            const { client } = makeView(
                {
                    dimens: { width: 4, height: 1 },
                    styleSGR1: S('|07'),
                    focusSGR: '|17',
                    focusColumns: ['b'],
                    columns: { a: { width: 2 }, b: { width: 2 } },
                    columnOrder: ['a', 'b'],
                },
                [{ a: 'x', b: 'y' }]
            );
            const raw = rawOnRow(client, 1);
            assert.ok(raw.startsWith(`${S('|07')}x`));
            assert.ok(raw.includes(`${S('|17')}y`));
        });

        it('altRowSGR stripes rows, restarting after each group', function () {
            const { client } = makeView(
                {
                    dimens: { width: 4, height: 5 },
                    styleSGR1: S('|07'),
                    altRowSGR: '|08',
                    columns: { a: { width: 4 } },
                },
                [{ a: 'a' }, { a: 'b' }, { a: 'c' }, g('G'), { a: 'd' }]
            );
            //  row 1 is focused
            assert.ok(rawOnRow(client, 2).startsWith(`${S('|07')}${S('|08')}b`));
            assert.ok(rawOnRow(client, 3).startsWith(`${S('|07')}c`));
            assert.ok(rawOnRow(client, 5).startsWith(`${S('|07')}d`));
        });
    });

    describe('pipe codes', function () {
        const columns = {
            subj: { field: 'subject', width: 10 },
            area: { field: 'areaName', width: 10 },
        };
        const row = { subject: '|12hi', areaName: '|12Gen' };

        it('plain fields show their pipe codes; operator text keeps colour', function () {
            const { client } = makeView(
                {
                    dimens: { width: 20, height: 1 },
                    columns,
                    columnOrder: ['subj', 'area'],
                    plainFields: ['subject'],
                },
                [row]
            );
            assert.equal(drawnOnRow(client, 1), '|12hi     Gen       ');
        });

        it('pipeCodes: true and false override the module per column', function () {
            const { client } = makeView(
                {
                    dimens: { width: 20, height: 1 },
                    columns: {
                        subj: { field: 'subject', width: 10, pipeCodes: true },
                        area: { field: 'areaName', width: 10, pipeCodes: false },
                    },
                    columnOrder: ['subj', 'area'],
                    plainFields: ['subject'],
                },
                [row]
            );
            assert.equal(drawnOnRow(client, 1), 'hi        |12Gen    ');
        });

        it('formats keep their colour while plain fields stay literal', function () {
            const { client } = makeView(
                {
                    dimens: { width: 20, height: 1 },
                    columns: {
                        subj: { field: 'subject', format: '|14[{value}] {from}' },
                    },
                    plainFields: ['subject', 'from'],
                },
                [{ subject: '|03x', from: '|05bob' }]
            );
            assert.equal(drawnOnRow(client, 1), '[|03x] |05bob       ');
            assert.ok(rawOnRow(client, 1).includes(pipeToAnsi('|14')));
        });

        it('setPlainFields applies to column-less rows and group formats', function () {
            const { view, client } = makeView(
                {
                    dimens: { width: 12, height: 2 },
                    itemFormat: '{text}',
                    group: { format: '-{name}-' },
                },
                [g('', { name: '|09x' }), { text: '|10y' }],
                { draw: false }
            );
            view.setPlainFields(['text', 'name']);
            view.redraw();
            assert.equal(drawnOnRow(client, 1), '-|09x-      ');
            assert.equal(drawnOnRow(client, 2), '|10y        ');
        });

        it('labels keep pipe colour', function () {
            const { client } = makeView(
                {
                    dimens: { width: 6, height: 2 },
                    header: true,
                    columns: { a: { label: '|11Area', width: 6 } },
                },
                [{ a: 'x' }]
            );
            assert.equal(drawnOnRow(client, 1), 'Area  ');
        });
    });

    describe('updateItem', function () {
        const items = () => {
            const out = [];
            for (let i = 0; i < 10; ++i) {
                out.push({ key: `k${i}`, name: `r${i}`, n: i });
            }
            return out;
        };
        const options = {
            dimens: { width: 10, height: 3 },
            columns: { name: { width: 5 }, n: { width: 5 } },
            columnOrder: ['name', 'n'],
        };

        it('redraws that row only and keeps focus and scroll', function () {
            const { view, client } = makeView(options, items());
            view.focusLast();
            view.focusPrevious(); //  index 8, window 7..9
            const top = view.viewWindow.top;
            client.writes.length = 0;
            assert.equal(view.updateItem('k9', { n: 99 }), true);
            assert.deepEqual(rowsWritten(client), [3]);
            assert.equal(drawnOnRow(client, 3), 'r9      99');
            assert.equal(view.getFocusItemIndex(), 8);
            assert.equal(view.viewWindow.top, top);
        });

        it('by index; an off-screen row is not drawn; unknown rows return false', function () {
            const { view, client } = makeView(options, items());
            client.writes.length = 0;
            assert.equal(view.updateItem(8, { name: 'x' }), true);
            assert.deepEqual(rowsWritten(client), []);
            assert.equal(view.getItem(8).name, 'x');
            assert.equal(view.updateItem('nope', { n: 1 }), false);
            assert.equal(view.updateItem(42, { n: 1 }), false);
        });

        it('a focused row that becomes unselectable moves focus on', function () {
            const { view } = makeView(options, items());
            view.updateItem('k0', { selectable: false });
            assert.equal(view.getFocusItemIndex(), 1);
        });
    });

    describe('setItems', function () {
        const rows = names => names.map(n => ({ key: n, text: n }));

        it('without keepFocus goes to the first selectable row', function () {
            const { view } = makeView({}, rows(['a', 'b', 'c']));
            view.focusLast();
            view.setItems([g('G'), ...rows(['a', 'b'])]);
            assert.equal(view.getFocusItemIndex(), 1);
        });

        it('keepFocus refocuses by key, then by clamped index', function () {
            const { view } = makeView({}, rows(['a', 'b', 'c', 'd']));
            view.focusNext();
            view.focusNext(); //  c
            view.setItems(rows(['x', 'c', 'y']), { keepFocus: true });
            assert.equal(view.getFocusItemIndex(), 1);

            view.focusLast(); //  y at 2
            view.setItems(rows(['p', 'q', 'r', 's']), { keepFocus: true });
            assert.equal(view.getFocusItemIndex(), 2);

            view.focusLast(); //  s at 3
            view.setItems([...rows(['m', 'n']), g('G')], { keepFocus: true });
            assert.equal(view.getFocusItemIndex(), 1);
        });

        it('falls back to data as the key', function () {
            const { view } = makeView({}, [
                { text: 'a', data: 10 },
                { text: 'b', data: 20 },
            ]);
            view.focusNext();
            view.setItems(
                [
                    { text: 'b', data: 20 },
                    { text: 'a', data: 10 },
                ],
                { keepFocus: true }
            );
            assert.equal(view.getFocusItemIndex(), 0);
        });

        it("does not change the caller's row objects", function () {
            const row = { key: 'a', n: 1 };
            const { view } = makeView({}, [row]);
            view.updateItem('a', { n: 2 });
            assert.equal(row.n, 1);
        });
    });

    describe('focus matching', function () {
        const list = () => [
            g('A'),
            { text: 'a1', n: 0 },
            { text: 'a2', n: 3 },
            g('B'),
            { text: 'b1', n: 0 },
            { text: 'b2', n: 1 },
        ];
        const hasNew = item => item.n > 0;

        it('focusNextMatching finds the next match, wrapping by default', function () {
            const { view } = makeView({}, list());
            assert.equal(view.focusNextMatching(hasNew), 2);
            assert.equal(view.focusNextMatching(hasNew), 5);
            assert.equal(view.focusNextMatching(hasNew), 2);
        });

        it('wrap: false stops at the end; no match leaves focus alone', function () {
            const { view } = makeView({}, list());
            view.focusLast();
            assert.equal(view.focusNextMatching(hasNew, { wrap: false }), -1);
            assert.equal(view.getFocusItemIndex(), 5);
            assert.equal(
                view.focusNextMatching(item => 'zz' === item.text),
                -1
            );
            assert.equal(view.getFocusItemIndex(), 5);
        });

        it('focusPreviousMatching goes backwards; groups never match', function () {
            const { view } = makeView({}, list());
            view.focusLast();
            assert.equal(view.focusPreviousMatching(hasNew), 2);
            assert.equal(
                view.focusPreviousMatching(() => true, { wrap: false }),
                1
            );
            assert.equal(
                view.focusPreviousMatching(() => true, { wrap: false }),
                -1
            );
        });

        it('findIndex and getFocusedItem', function () {
            const { view } = makeView({}, list());
            assert.equal(
                view.findIndex(item => 'b1' === item.text),
                4
            );
            assert.equal(view.getFocusedItem().text, 'a1');
        });
    });

    describe('setDefaults', function () {
        it('module defaults sit under menu/theme mci, and TV keys deep-merge', function () {
            const { view, client } = makeView({}, null, { draw: false });
            //  menu/theme mci, applied first by the view controller
            view.setPropertyValue('columns', { n: { sgr: '|10' } });
            view.setPropertyValue('textOverflow', '!');
            view.setDefaults({
                columns: {
                    name: { width: 4 },
                    n: { width: 3, type: 'number', sgr: '|08' },
                },
                columnOrder: ['name', 'n'],
                emptyText: 'none',
                textOverflow: '…',
                focusItemAtTop: true,
            });
            const cfg = view.getConfig();
            assert.deepEqual(cfg.columns, {
                name: { width: 4 },
                n: { width: 3, type: 'number', sgr: '|10' },
            });
            assert.equal(cfg.emptyText, 'none');
            assert.equal(view.textOverflow, '!'); //  menu value kept
            assert.equal(view.focusItemAtTop, true); //  not set by menu: default applies
            view.setItems([{ name: 'abcdef', n: 7 }]);
            view.redraw();
            assert.equal(drawnOnRow(client, 1).slice(0, 7), 'abc!  7');
        });

        it('later setDefaults calls merge into earlier ones', function () {
            const { view } = makeView({}, null, { draw: false });
            view.setDefaults({ group: { format: '{text}', fillChar: '-' } });
            view.setDefaults({ group: { sgr: '|08' } });
            assert.deepEqual(view.getConfig().group, {
                format: '{text}',
                fillChar: '-',
                sgr: '|08',
            });
        });

        it('built-ins sit lowest', function () {
            const { view } = makeView({}, null, { draw: false });
            assert.deepEqual(view.getConfig().sortIndicator, { asc: '▲', desc: '▼' });
            view.setDefaults({ sortIndicator: { asc: '^' } });
            assert.deepEqual(view.getConfig().sortIndicator, { asc: '^', desc: '▼' });
        });
    });

    describe('getData', function () {
        it('returns data whenever set, numbers included, else the index', function () {
            const { view } = makeView({}, [
                { text: 'a', data: 42 },
                { text: 'b', data: 'x' },
                { text: 'c' },
                'd',
            ]);
            const got = [];
            for (let i = 0; i < 4; ++i) {
                got.push(view.getData());
                view.focusNext();
            }
            assert.deepEqual(got, [42, 'x', 2, 3]);
        });
    });

    describe('column-less mode (VM drop-in)', function () {
        it('draws strings like a VM, padded in the normal colour', function () {
            const { client } = makeView(
                {
                    dimens: { width: 6, height: 3 },
                    styleSGR1: pipeToAnsi('|07'),
                    styleSGR2: pipeToAnsi('|31'),
                },
                ['one', '|14two']
            );
            assert.equal(drawnOnRow(client, 1), 'one   ');
            assert.equal(drawnOnRow(client, 2), 'two   ');
            assert.ok(rawOnRow(client, 1).startsWith(`${pipeToAnsi('|31')}one`));
            assert.equal(drawnOnRow(client, 3), '      ');
        });

        it('itemFormat / focusItemFormat for object rows', function () {
            const { view, client } = makeView(
                {
                    dimens: { width: 12, height: 2 },
                    itemFormat: '{name} ({n})',
                    focusItemFormat: '>{name}<',
                },
                [
                    { name: 'a', n: 1 },
                    { name: 'b', n: 2 },
                ]
            );
            assert.equal(drawnOnRow(client, 1), '>a<         ');
            assert.equal(drawnOnRow(client, 2), 'b (2)       ');
            view.focusNext();
            assert.equal(drawnOnRow(client, 1), 'a (1)       ');
            assert.equal(drawnOnRow(client, 2), '>b<         ');
        });

        it('stateSGR colours a row', function () {
            const { client } = makeView(
                {
                    dimens: { width: 4, height: 2 },
                    styleSGR1: pipeToAnsi('|07'),
                    stateSGR: { new: '|15' },
                },
                [{ text: 'a' }, { text: 'b', state: 'new' }]
            );
            assert.ok(rawOnRow(client, 2).startsWith(`${pipeToAnsi('|07|15')}b`));
        });
    });
});
