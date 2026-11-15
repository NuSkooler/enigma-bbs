'use strict';

//
//  MultiLineEditTextView#addText(), a chat log's way in (WP3 PR B). It goes
//  out as one write; while the top visible line stays put only the new rows
//  are drawn; once the view scrolls the whole visible area is, as before.
//  Whatever path it takes, the screen must end up as a full redraw leaves it.
//

const { strict: assert } = require('assert');

const { ClientTerminal } = require('../core/client_term.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');
const { LineBuffer } = require('../core/line_buffer.js');
const { pipeToAnsi } = require('../core/color_codes.js');
const { captureSession } = require('./helpers/wfc_dashboard_harness.js');
const { VirtualScreen } = require('./helpers/virtual_screen.js');

//  The MRC chat log in luciano_blocktronics: %MT1 at 3,4, 72x18
const MRC_LOG = { position: { row: 3, col: 4 }, dimens: { width: 72, height: 18 } };
const SMALL_LOG = { position: { row: 3, col: 4 }, dimens: { width: 30, height: 4 } };

function makeLog(layout = SMALL_LOG, extra = {}) {
    const { term, writes } = captureSession(ClientTerminal);
    const client = { term, log: { trace() {}, debug() {}, warn() {}, error() {} } };
    const view = new MultiLineEditTextView(
        Object.assign(
            {
                client,
                id: 1,
                position: Object.assign({}, layout.position),
                dimens: Object.assign({}, layout.dimens),
                mode: 'preview',
                autoScroll: true,
                acceptsFocus: false,
            },
            extra
        )
    );
    view.redraw(); //  as the view controller does once the art is up
    const screen = new VirtualScreen();
    const wire = () => Buffer.concat(writes).toString('latin1');
    return { view, term, writes, screen, wire };
}

//  addText() as it was on origin/master 27e47fc9, for the byte comparison
function legacyAddText(view, text, options = { scrollMode: 'default' }) {
    const normalized = (text || '').replace(/\r\n|\r/g, '\n');
    const isEmpty = view.buffer.lines.length === 1 && view.buffer.lines[0].chars === '';
    if (isEmpty) {
        view.buffer.setText(normalized);
    } else {
        const tmp = new LineBuffer({ width: view.buffer.width });
        tmp.setText(normalized);
        view.buffer.lines.push(...tmp.lines);
    }
    switch (options.scrollMode || 'default') {
        case 'top':
        case 'start':
            view.cursorStartOfDocument();
            break;
        case 'end':
        case 'bottom':
            view.cursorEndOfDocument();
            break;
        default:
            if (view.isEditMode() || view.autoScroll) {
                view.cursorEndOfDocument();
            } else {
                view.cursorStartOfDocument();
            }
            break;
    }
}

//  One addText(): the socket writes and bytes it cost
function add(log, text, options) {
    const before = log.writes.length;
    const bytesBefore = log.wire().length;
    log.view.addText(text, options);
    return {
        writes: log.writes.length - before,
        bytes: log.wire().length - bytesBefore,
    };
}

//  The screen after everything so far, and again after a full redraw on top:
//  equal when the incremental drawing left nothing out
function assertSameAsFullRedraw(log) {
    const screen = new VirtualScreen().write(log.wire());
    const drawn = screen.snapshot();
    const cursor = screen.cursor();

    log.view.redraw();
    log.view.moveClientCursorToCursorPos();
    const full = new VirtualScreen().write(log.wire());

    assert.equal(drawn, full.snapshot(), 'screen differs from a full redraw');
    assert.deepEqual(cursor, full.cursor(), 'cursor differs from a full redraw');
}

const line = n => pipeToAnsi(`|10<|02user${n}|10>|00 |03message number ${n}|00`);

describe('MultiLineEditTextView#addText()', () => {
    describe('the log not full yet: only the new rows', () => {
        it('one write per line, and the screen a full redraw would leave', () => {
            const log = makeLog();
            for (let n = 0; n < 4; ++n) {
                const cost = add(log, line(n), { scrollMode: 'end' });
                assert.equal(cost.writes, 1);
                assert.equal(log.view.topVisibleIndex, 0);
            }
            assertSameAsFullRedraw(log);
        });

        it('fewer bytes than the full repaint', () => {
            const branch = makeLog(MRC_LOG);
            const master = makeLog(MRC_LOG);
            for (let n = 0; n < 10; ++n) {
                const before = master.wire().length;
                legacyAddText(master.view, line(n), { scrollMode: 'end' });
                const full = master.wire().length - before;
                const partial = add(branch, line(n), { scrollMode: 'end' }).bytes;
                assert.ok(partial < full, `line ${n}: ${partial} >= ${full}`);
            }
            assert.equal(
                new VirtualScreen().write(branch.wire()).snapshot(),
                new VirtualScreen().write(master.wire()).snapshot()
            );
        });

        it('replaces the empty first line rather than adding below it', () => {
            const log = makeLog();
            add(log, 'first', { scrollMode: 'end' });
            assert.equal(log.view.buffer.lines.length, 1);
            assert.equal(
                new VirtualScreen().write(log.wire()).text()[2].slice(3, 8),
                'first'
            );
            assertSameAsFullRedraw(log);
        });

        it('a wrapped line and several lines at once', () => {
            const log = makeLog();
            add(log, 'one', { scrollMode: 'end' });
            add(log, 'a line long enough to wrap across two rows here', {
                scrollMode: 'end',
            });
            assertSameAsFullRedraw(log);
            add(log, 'x\ny', { scrollMode: 'end' }); //  now five rows: scrolls
            assertSameAsFullRedraw(log);
        });

        it('held at the start, lines past the bottom draw nothing but the cursor', () => {
            const log = makeLog();
            for (let n = 0; n < 6; ++n) {
                add(log, `line ${n}`, { scrollMode: 'start' });
            }
            const cost = add(log, 'below the fold', { scrollMode: 'start' });
            assert.equal(cost.writes, 1);
            assert.ok(cost.bytes < 20, `${cost.bytes} bytes`);
            assertSameAsFullRedraw(log);
        });

        it('in edit mode too', () => {
            const log = makeLog(SMALL_LOG, { mode: 'edit', acceptsFocus: true });
            add(log, 'quoted |04line', { scrollMode: 'end' });
            add(log, 'another', { scrollMode: 'end' });
            assertSameAsFullRedraw(log);
        });
    });

    describe('the log full: the whole visible area', () => {
        it('the same bytes as before, in one write', () => {
            const branch = makeLog();
            const master = makeLog();
            for (let n = 0; n < 4; ++n) {
                add(branch, line(n), { scrollMode: 'end' });
                legacyAddText(master.view, line(n), { scrollMode: 'end' });
            }
            for (let n = 4; n < 8; ++n) {
                const before = master.wire().length;
                legacyAddText(master.view, line(n), { scrollMode: 'end' });
                const expected = master.wire().slice(before);

                const writesBefore = branch.writes.length;
                const bytesBefore = branch.wire().length;
                branch.view.addText(line(n), { scrollMode: 'end' });
                assert.equal(branch.writes.length - writesBefore, 1);
                assert.equal(branch.wire().slice(bytesBefore), expected);
                assert.ok(branch.view.topVisibleIndex > 0);
            }
            assertSameAsFullRedraw(branch);
        });

        it('a search in progress repaints in full', () => {
            const log = makeLog();
            add(log, 'alpha', { scrollMode: 'end' });
            log.view._findState = { query: 'alpha', matches: [], currentIndex: -1 };
            const master = makeLog();
            legacyAddText(master.view, 'alpha', { scrollMode: 'end' });
            master.view._findState = log.view._findState;

            const before = master.wire().length;
            legacyAddText(master.view, 'beta', { scrollMode: 'end' });
            const expected = master.wire().slice(before);

            const bytesBefore = log.wire().length;
            log.view.addText('beta', { scrollMode: 'end' });
            assert.equal(log.wire().slice(bytesBefore), expected);
        });

        it('a view never drawn is drawn in full', () => {
            const { term, writes } = captureSession(ClientTerminal);
            const view = new MultiLineEditTextView({
                client: { term, log: {} },
                id: 1,
                position: { row: 3, col: 4 },
                dimens: { width: 30, height: 4 },
                mode: 'preview',
                acceptsFocus: false,
            });
            view.addText('hello', { scrollMode: 'end' });
            const screen = new VirtualScreen().write(
                Buffer.concat(writes).toString('latin1')
            );
            //  the rows below are erased, not left to whatever was there
            assert.equal(screen.text()[2].slice(3, 8), 'hello');
            assert.ok(
                Buffer.concat(writes).toString('latin1').split('\x1b[6;4H').length > 1
            );
        });
    });

    describe('cursorStartOfDocument() / cursorEndOfDocument()', () => {
        it('still draw and move the cursor as before', () => {
            const log = makeLog();
            ['a', 'b', 'c', 'd', 'e', 'f'].forEach(t =>
                add(log, t, { scrollMode: 'end' })
            );
            let before = log.wire().length;
            log.view.cursorStartOfDocument();
            assert.equal(log.view.topVisibleIndex, 0);
            assert.ok(log.wire().length > before);
            assertSameAsFullRedraw(log);

            before = log.wire().length;
            log.view.cursorEndOfDocument();
            assert.equal(log.view.topVisibleIndex, 2);
            assert.ok(log.wire().length > before);
            assertSameAsFullRedraw(log);
        });
    });

    describe('without beginWrite()/commitWrite() on the terminal', () => {
        it('draws all the same', () => {
            const out = [];
            const term = {
                termWidth: 80,
                termHeight: 25,
                write: s => out.push(s),
                rawWrite: s => out.push(s),
            };
            const view = new MultiLineEditTextView({
                client: { term, log: {} },
                id: 1,
                position: { row: 3, col: 4 },
                dimens: { width: 30, height: 4 },
                mode: 'preview',
                acceptsFocus: false,
            });
            view.redraw();
            view.addText('hello', { scrollMode: 'end' });
            view.addText('world', { scrollMode: 'end' });
            const text = new VirtualScreen().write(out.join('')).text();
            assert.equal(text[2].slice(3, 8), 'hello');
            assert.equal(text[3].slice(3, 8), 'world');
        });
    });
});
