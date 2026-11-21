'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { MaskEditTextView } = require('../core/mask_edit_text_view.js');

//
//  ViewController form loading:
//
//  *   applyViewConfig(): an `mci` key that does not parse is skipped with a
//      warning; the rest of the form loads (it used to hang the menu). Keys
//      are still matched unanchored, as before (`MET3` configures view 3).
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
});
