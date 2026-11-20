'use strict';

const { strict: assert } = require('assert');

const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');
const { EditTextView } = require('../core/edit_text_view.js');

//
//  MRC lines arrive from the server whenever they are sent, usually while
//  the user is typing. Adding one to the chat log draws it and leaves the
//  cursor in the log; the input line's next key then echoed there.
//

const INPUT_SGR = '\x1b[0;1;36m';

//  The cursor position and current SGR as a terminal would track them
function makeClient() {
    const term = {
        termWidth: 80,
        termHeight: 25,
        cursor: { row: 1, col: 1 },
        sgr: '',
        cells: new Map(),
    };
    const consume = s => {
        s = Buffer.isBuffer(s) ? s.toString('latin1') : String(s);
        let i = 0;
        while (i < s.length) {
            if ('\x1b' === s[i] && '[' === s[i + 1]) {
                let j = i + 2;
                while (j < s.length && /[0-9;?]/.test(s[j])) {
                    ++j;
                }
                if ('H' === s[j]) {
                    const [row, col] = s.slice(i + 2, j).split(';');
                    term.cursor = {
                        row: parseInt(row, 10) || 1,
                        col: parseInt(col, 10) || 1,
                    };
                } else if ('m' === s[j]) {
                    term.sgr = s.slice(i, j + 1);
                }
                i = j + 1;
                continue;
            }
            term.cells.set(`${term.cursor.row},${term.cursor.col}`, s[i]);
            ++term.cursor.col;
            ++i;
        }
    };
    term.write = consume;
    term.rawWrite = consume;
    term.pos = () => `${term.cursor.row},${term.cursor.col}`;
    return { term, log: { trace() {}, debug() {}, warn() {}, info() {} } };
}

describe('MRC chat log lines leave the cursor in the input line', () => {
    let mrcModule;
    before(() => {
        mrcModule = require('../core/mrc.js').getModule;
    });

    function setup() {
        const client = makeClient();
        const chatLog = new MultiLineEditTextView({
            client,
            id: 1,
            position: { row: 2, col: 1 },
            dimens: { width: 70, height: 15 },
        });
        chatLog.setPropertyValue('mode', 'preview');
        const input = new EditTextView({
            client,
            id: 2,
            position: { row: 22, col: 3 },
            dimens: { width: 60 },
            maxLength: 140,
            styleSGR2: INPUT_SGR,
        });

        //  addMessageToChatLog() needs only these
        const mod = Object.create(mrcModule.prototype);
        mod.client = client;
        mod.userPrefs = {};
        mod.config = { maxScrollbackLines: 500 };
        mod.viewControllers = {
            mrcChat: { getView: id => ({ 1: chatLog, 2: input })[id] },
        };

        input.setFocus(true);
        for (const ch of 'hel') {
            input.onKeyPress(ch);
        }
        return { client, mod, input, term: client.term };
    }

    it('puts the cursor back after the typed text, in the input colour', () => {
        const { mod, input, term } = setup();
        assert.equal(term.pos(), '22,6', 'precondition');

        mod.addMessageToChatLog('|11someone|07: hi all');
        assert.equal(term.pos(), '22,6');
        assert.equal(term.sgr, INPUT_SGR);

        input.onKeyPress('l');
        assert.equal(term.cells.get('22,6'), 'l', 'the key echoes in the input line');
    });

    it('with several lines at once', () => {
        const { mod, term } = setup();
        mod.addMessageToChatLog(['one', 'two\nthree']);
        assert.equal(term.pos(), '22,6');
    });
});
