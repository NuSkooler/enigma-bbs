'use strict';

const { strict: assert } = require('assert');

const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');
const { EditTextView } = require('../core/edit_text_view.js');

//
//  Sysop chat appends each line to a log panel (an MLE), which leaves the
//  cursor in the panel. The partner's lines arrive at any time, usually
//  while the user is typing: the cursor must go back to the input line,
//  after its prefix, where the next key echoes.
//

const INPUT_SGR = '\x1b[0;1;33m';

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
    return {
        term,
        user: { username: 'Sysop' },
        log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
    };
}

describe('sysop chat log lines leave the cursor in the input line', function () {
    let SysopChat;
    let savedTimeout;

    before(function () {
        SysopChat = require('../core/sysop_chat.js').getModule;
    });

    //  the live colour collapse timer is not under test
    beforeEach(function () {
        savedTimeout = {
            setTimeout: global.setTimeout,
            clearTimeout: global.clearTimeout,
        };
        global.setTimeout = () => 0;
        global.clearTimeout = () => {};
    });
    afterEach(function () {
        global.setTimeout = savedTimeout.setTimeout;
        global.clearTimeout = savedTimeout.clearTimeout;
    });

    function setup() {
        const client = makeClient();
        const sysopLog = new MultiLineEditTextView({
            client,
            id: 1,
            position: { row: 2, col: 1 },
            dimens: { width: 78, height: 8 },
            acceptsFocus: false,
        });
        const userLog = new MultiLineEditTextView({
            client,
            id: 3,
            position: { row: 12, col: 1 },
            dimens: { width: 78, height: 8 },
            acceptsFocus: false,
        });
        const input = new EditTextView({
            client,
            id: 2,
            position: { row: 22, col: 3 },
            dimens: { width: 60 },
            maxLength: 200,
            styleSGR2: INPUT_SGR,
        });
        input.prefixFormat = '|15{userName}|07> ';

        //  what _appendToPanel() and _enableLiveColorOnInput() need
        const mod = Object.create(SysopChat.prototype);
        mod.client = client;
        mod.config = {};
        mod.role = 'sysop';
        const views = { 1: sysopLog, 2: input, 3: userLog };
        mod.getView = (_form, id) => views[id];

        mod._enableLiveColorOnInput(input);
        input.setFocus(true);
        for (const ch of 'hey') {
            input.onKeyPress(ch);
        }
        return { client, mod, input, term: client.term };
    }

    it("a partner's line: back after the prefix and the typed text", function () {
        const { mod, input, term } = setup();
        const expected = term.pos();
        //  'Sysop> ' is 7 columns, then 'hey'
        assert.equal(expected, '22,13', 'precondition');

        mod.receiveMessage('|11User|07: hello there', 'user');
        assert.equal(term.pos(), expected);
        assert.equal(term.sgr, INPUT_SGR);

        input.onKeyPress('!');
        assert.equal(term.cells.get('22,13'), '!', 'the key echoes in the input line');
    });

    it('our own line, appended on submit', function () {
        const { mod, term } = setup();
        const expected = term.pos();
        mod._appendToPanel('sysop', '|15Sysop|07: hey');
        assert.equal(term.pos(), expected);
    });

    it('the patched, prefix-aware _repositionCursor() is what is used', function () {
        const { mod, input, term } = setup();
        let called = 0;
        const patched = input._repositionCursor;
        input._repositionCursor = () => {
            ++called;
            patched();
        };
        mod.receiveMessage('line', 'user');
        assert.equal(called, 1);
        assert.equal(term.pos(), '22,13');
    });

    it('no log view: nothing drawn, nothing moved', function () {
        const { mod, term } = setup();
        mod.getView = () => undefined;
        const before = term.pos();
        mod.receiveMessage('line', 'user');
        assert.equal(term.pos(), before);
    });
});
