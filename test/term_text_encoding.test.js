'use strict';

//  Displayable text must go through term.write() (which encodes to the
//  client's output encoding), never term.rawWrite() (bytes untouched).
//  These use a real ClientTerminal over a fake socket, set to CP437.

const { strict: assert } = require('assert');

const { ClientTerminal } = require('../core/client_term.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');

function makeClient() {
    const chunks = [];
    const output = {
        writable: true,
        write: (data, cb) => {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            cb && cb(null);
        },
    };
    const term = new ClientTerminal(output);
    term.termWidth = 80;
    term.termHeight = 25;
    return { client: { term }, sent: () => Buffer.concat(chunks) };
}

describe('displayable text is encoded for the client (CP437)', () => {
    it('VerticalMenuView.drawRemovedItem sends a non-ASCII fillChar as 0xB0', () => {
        const { client, sent } = makeClient();
        const view = new VerticalMenuView({
            client,
            id: 1,
            position: { row: 1, col: 1 },
            dimens: { width: 4, height: 5 },
            fillChar: '░',
        });
        view.drawRemovedItem(0);
        const out = sent();
        assert(out.includes(Buffer.from([0xb0, 0xb0, 0xb0, 0xb0])), 'CP437 shade bytes');
        assert(!out.includes(Buffer.from('░')), 'no UTF-8 shade');
    });

    it('MultiLineEditTextView overwrite-mode typed char is sent as CP437', () => {
        const { client, sent } = makeClient();
        const view = new MultiLineEditTextView({
            client,
            dimens: { width: 20, height: 5 },
        });
        view.setText('hello', { scrollMode: 'top' });
        view.cursorPos = { row: 0, col: 0 };
        view.overtypeMode = true;
        view.keyPressCharacter('é'); //  e-acute = 0x82 in CP437
        const out = sent();
        assert(out.includes(Buffer.from([0x82])), 'CP437 byte');
        assert(!out.includes(Buffer.from('é')), 'no UTF-8 sequence');
    });
});
