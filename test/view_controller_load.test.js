'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { ViewController } = require('../core/view_controller.js');
const { TextView } = require('../core/text_view.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { MaskEditTextView } = require('../core/mask_edit_text_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');

//
//  ViewController form loading:
//
//  *   applyViewConfig(): an `mci` key that does not parse is skipped with a
//      warning; the rest of the form loads (it used to hang the menu). Keys
//      are still matched unanchored, as before (`MET3` configures view 3).
//  *   redrawAll(initialFocusId): the initial focus view is drawn once, by
//      switchFocus(), when its setFocus() draws it; otherwise (an MLE, a
//      view that takes no focus) redrawAll() draws it as before.
//

function makeClient() {
    const client = new events.EventEmitter();
    client.log = { warnings: [] };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.warn = (obj, msg) => client.log.warnings.push({ obj, msg });
    const term = { termWidth: 80, termHeight: 25, out: [] };
    term.write = s => term.out.push(String(s));
    term.rawWrite = s => term.out.push(String(s));
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    client.term = term;
    return client;
}

function countDraws(view) {
    view.draws = 0;
    const redraw = view.redraw.bind(view);
    view.redraw = (...args) => {
        ++view.draws;
        return redraw(...args);
    };
    return view;
}

describe('ViewController form loading', () => {
    describe('applyViewConfig()', () => {
        it('skips a key that does not parse, with a warning, and still calls back', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            const field = new EditTextView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
            });
            vc.addView(field);

            let called = 0;
            vc.applyViewConfig(
                { mci: { tl1: { width: 9 }, ET1: { argName: 'name', focus: true } } },
                (err, info) => {
                    ++called;
                    assert.ifError(err);
                    assert.equal(info.initialFocusId, 1);
                }
            );

            assert.equal(called, 1, 'called back');
            assert.equal(field.submitArgName, 'name', 'the good key applied');
            assert.equal(client.log.warnings.length, 1);
            assert.deepEqual(client.log.warnings[0].obj, { mci: 'tl1' });
        });

        it('a form whose only key does not parse calls back too', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            let called = 0;
            vc.applyViewConfig({ mci: { 'bad key': {} } }, () => ++called);
            assert.equal(called, 1);
        });

        it('keeps matching keys unanchored: MET3 configures view 3, as before', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            const birthdate = new MaskEditTextView({
                client,
                id: 3,
                position: { row: 3, col: 1 },
                maskPattern: '####/##/##',
            });
            vc.addView(birthdate);
            vc.applyViewConfig({ mci: { MET3: { argName: 'birthdate' } } }, err =>
                assert.ifError(err)
            );
            assert.equal(birthdate.submitArgName, 'birthdate');
            assert.equal(client.log.warnings.length, 0);
        });
    });

    describe('redrawAll(initialFocusId)', () => {
        function load(client, views, initialFocusId) {
            const vc = new ViewController({ client });
            views.forEach(v => vc.addView(countDraws(v)));
            vc.setViewOrder();
            vc.redrawAll(initialFocusId);
            if (initialFocusId) {
                vc.switchFocus(initialFocusId);
            }
            return vc;
        }

        it('draws a focused text field once (by switchFocus), the others once', () => {
            const client = makeClient();
            const label = new TextView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
                text: 'Name:',
            });
            const field = new EditTextView({
                client,
                id: 2,
                position: { row: 1, col: 8 },
                acceptsFocus: true,
            });
            const other = new EditTextView({
                client,
                id: 3,
                position: { row: 2, col: 8 },
                acceptsFocus: true,
            });
            load(client, [label, field, other], 2);

            assert.equal(field.draws, 1, 'the focus view is drawn once');
            assert.equal(field.hasFocus, true);
            assert.equal(label.draws, 1);
            assert.equal(other.draws, 1);
        });

        it('draws an initial focus view that takes no focus (switchFocus skips it)', () => {
            const client = makeClient();
            const label = new TextView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
                text: 'Hello',
            });
            load(client, [label], 1);
            assert.equal(label.draws, 1);
            assert.equal(label.hasFocus, undefined);
        });

        it('draws a focused MultiLineEditTextView: its setFocus() does not draw the text', () => {
            const client = makeClient();
            const body = new MultiLineEditTextView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 3 },
                mode: 'preview',
            });
            body.setText('message body');
            load(client, [body], 1);
            assert.equal(body.draws, 1, 'drawn by redrawAll()');
            assert.ok(client.term.out.join('').includes('message body'));
        });

        it('without an initial focus id every view is drawn', () => {
            const client = makeClient();
            const a = new EditTextView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
                acceptsFocus: true,
            });
            const b = new EditTextView({
                client,
                id: 2,
                position: { row: 2, col: 1 },
                acceptsFocus: true,
            });
            load(client, [a, b]);
            assert.equal(a.draws, 1);
            assert.equal(b.draws, 1);
        });
    });
});
