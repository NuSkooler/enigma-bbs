'use strict';

//  Regression coverage for navigating a VerticalMenuView that has no items.
//
//  An empty list is legitimately reachable (a list built from a log file that
//  is empty/rotated/unreadable, a filtered result set, etc.).  Before this was
//  fixed, arrow/page navigation walked focusedItemIndex out of range -- including
//  negative -- and two separate dereferences threw:
//
//    * _focusRedraw() -> this.items[idx].focused = ...
//        "Cannot set properties of undefined (setting 'focused')"
//        Not caught anywhere; it escaped the ssh2 data handler and dropped the
//        user's connection.
//
//    * MenuView.getItem() -> this.items[-1].text, reached via getData()
//        "Cannot read properties of undefined (reading 'text')"
//        Caught by ViewController.getFormData(), but logged on every keypress.

const { strict: assert } = require('assert');

const { VerticalMenuView } = require('../core/vertical_menu_view.js');

//  Minimal client stub — satisfies View base requirements without a real terminal.
function makeClient() {
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: () => {},
            rawWrite: () => {},
        },
    };
}

function makeView(opts = {}) {
    const view = new VerticalMenuView(
        Object.assign(
            {
                client: makeClient(),
                id: 1,
                position: { row: 1, col: 1 },
                dimens: { width: 40, height: 5 },
            },
            opts
        )
    );

    //  Mirror the real lifecycle: a view is always drawn (which establishes
    //  viewWindow) before it can receive any key press.
    view.redraw();

    return view;
}

describe('VerticalMenuView with an empty item list', () => {
    describe('focus navigation does not throw', () => {
        it('focusNext()', () => {
            const view = makeView();
            assert.doesNotThrow(() => view.focusNext());
        });

        it('focusPrevious()', () => {
            const view = makeView();
            assert.doesNotThrow(() => view.focusPrevious());
        });

        it('focusNextPageItem()', () => {
            const view = makeView();
            assert.doesNotThrow(() => view.focusNextPageItem());
        });

        it('focusPreviousPageItem()', () => {
            const view = makeView();
            assert.doesNotThrow(() => view.focusPreviousPageItem());
        });

        it('focusFirst()', () => {
            const view = makeView();
            assert.doesNotThrow(() => view.focusFirst());
        });

        it('focusLast()', () => {
            const view = makeView();
            assert.doesNotThrow(() => view.focusLast());
        });
    });

    describe('focusedItemIndex never leaves a valid range', () => {
        it('focusPrevious() does not produce a negative index', () => {
            const view = makeView();
            view.focusPrevious();
            assert.equal(view.focusedItemIndex, 0);
        });

        it('focusLast() does not produce a negative index', () => {
            const view = makeView();
            view.focusLast();
            assert.equal(view.focusedItemIndex, 0);
        });

        it('repeated mixed navigation leaves the index at 0', () => {
            const view = makeView();

            //  the sort of key mashing that originally dropped the connection
            for (let i = 0; i < 10; ++i) {
                view.focusNext();
                view.focusPrevious();
                view.focusNextPageItem();
                view.focusPreviousPageItem();
                view.focusLast();
                view.focusFirst();
            }

            assert.equal(view.focusedItemIndex, 0);
        });
    });

    describe('getData() / getItem() stay safe after navigation', () => {
        it('getData() does not throw once focus has been moved', () => {
            const view = makeView();
            view.focusPrevious(); //  previously set focusedItemIndex to -1
            assert.doesNotThrow(() => view.getData());
        });

        it('getItem(-1) returns null rather than dereferencing items[-1]', () => {
            const view = makeView();
            assert.equal(view.getItem(-1), null);
        });

        it('getItem(0) returns null on an empty list', () => {
            const view = makeView();
            assert.equal(view.getItem(0), null);
        });
    });

    describe('onKeyPress navigation', () => {
        const keys = ['up', 'down', 'page up', 'page down', 'home', 'end'];

        keys.forEach(name => {
            it(`"${name}" does not throw`, () => {
                const view = makeView();
                assert.doesNotThrow(() => view.onKeyPress(null, { name }));
            });
        });
    });
});

describe('VerticalMenuView with items (unchanged behaviour)', () => {
    const ITEMS = ['one', 'two', 'three'];

    it('focusNext() advances focus', () => {
        const view = makeView({ items: ITEMS });
        view.focusNext();
        assert.equal(view.focusedItemIndex, 1);
    });

    it('focusNext() wraps at the end', () => {
        const view = makeView({ items: ITEMS });
        view.setFocusItemIndex(ITEMS.length - 1);
        view.focusNext();
        assert.equal(view.focusedItemIndex, 0);
    });

    it('focusPrevious() wraps at the start', () => {
        const view = makeView({ items: ITEMS });
        view.focusPrevious();
        assert.equal(view.focusedItemIndex, ITEMS.length - 1);
    });

    it('focusLast() selects the final item', () => {
        const view = makeView({ items: ITEMS });
        view.focusLast();
        assert.equal(view.focusedItemIndex, ITEMS.length - 1);
    });

    it('getItem() returns item text', () => {
        const view = makeView({ items: ITEMS });
        assert.equal(view.getItem(0), 'one');
    });

    describe('setFocusItemIndex() clamps out-of-range values', () => {
        it('an index past the end clamps to the last item', () => {
            const view = makeView({ items: ITEMS });
            view.setFocusItemIndex(99);
            assert.equal(view.focusedItemIndex, ITEMS.length - 1);
        });

        it('a negative index clamps to the first item', () => {
            const view = makeView({ items: ITEMS });
            view.setFocusItemIndex(-5);
            assert.equal(view.focusedItemIndex, 0);
        });
    });

    it('a list emptied by setItems() resets focus and stays navigable', () => {
        const view = makeView({ items: ITEMS });
        view.focusLast();

        view.setItems([]);
        assert.equal(view.focusedItemIndex, 0);

        assert.doesNotThrow(() => view.focusNext());
        assert.doesNotThrow(() => view.focusPrevious());
        assert.doesNotThrow(() => view.getData());
    });
});
