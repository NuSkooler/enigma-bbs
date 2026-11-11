'use strict';

//  Views on terminals narrower than the 80 columns most art assumes (#991).

const { strict: assert } = require('assert');

const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const { TextView } = require('../core/text_view.js');
const { renderStringLength } = require('../core/string_util.js');

function makeClient(termWidth) {
    const writes = [];
    return {
        writes,
        term: {
            termWidth,
            termHeight: 25,
            write: s => writes.push(s),
            rawWrite: s => writes.push(s),
        },
    };
}

//  The text a write puts on screen after its leading cursor move
const drawnText = write => write.replace(/^\x1b\[\d+;\d+H/, ''); // eslint-disable-line no-control-regex

describe('View.clipToTerminalWidth', () => {
    const makeView = (termWidth, col) =>
        new TextView({
            client: makeClient(termWidth),
            position: { row: 1, col },
            dimens: { width: 10, height: 1 },
        });

    it('leaves text that fits alone', () => {
        assert.equal(makeView(40, 31).clipToTerminalWidth('0123456789'), '0123456789');
    });

    it('cuts text off at the right edge of the terminal', () => {
        const clipped = makeView(40, 31).clipToTerminalWidth('0123456789ABCDEF');
        assert.equal(renderStringLength(clipped), 10);
        assert.ok(clipped.startsWith('0123456789'));
    });

    it('does not count color codes as columns', () => {
        const clipped = makeView(40, 36).clipToTerminalWidth('\x1b[1;33mABCDEFGH');
        assert.equal(renderStringLength(clipped), 5);
        assert.ok(clipped.startsWith('\x1b[1;33mABCDE'));
    });

    it('never splits a wide character at the edge', () => {
        //  4 columns left; the third wide char would straddle the edge
        const clipped = makeView(40, 37).clipToTerminalWidth('日本語');
        assert.ok(clipped.startsWith('日本'));
        assert.equal(renderStringLength(clipped), 4);
    });
});

describe('VerticalMenuView on a 40-column terminal', () => {
    const LONG = 'narrow40              Testville              Nov 10th 09:14pm';

    const drawItems = termWidth => {
        const client = makeClient(termWidth);
        const view = new VerticalMenuView({
            client,
            id: 1,
            position: { row: 3, col: 5 },
            dimens: { width: 70, height: 5 },
        });
        view.setItems([LONG, 'short']);
        client.writes.length = 0;
        view.redraw();
        return client.writes.filter(w => w.includes('narrow40') || w.includes('short'));
    };

    it('does not draw an item past the right edge of the screen', () => {
        for (const write of drawItems(40)) {
            assert.ok(
                renderStringLength(drawnText(write)) <= 36,
                `drew ${renderStringLength(drawnText(write))} columns from column 5`
            );
        }
    });

    it('draws the item in full on an 80-column terminal', () => {
        const [first] = drawItems(80);
        assert.ok(drawnText(first).includes(LONG));
    });
});
