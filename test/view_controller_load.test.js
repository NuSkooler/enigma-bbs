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
//  *   redrawAll(): every view is drawn, the initial focus view included
//      (it is drawn again at focus, as it always has been). A %FM with
//      `items` and no `height` is sized by that first draw.
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

    describe('redrawAll()', () => {
        it('redrawAll(id) draws every view, view |id| included', () => {
            const client = makeClient();
            const vc = new ViewController({ client, detached: true });
            const field = new EditTextView({
                client,
                id: 1,
                position: { row: 2, col: 2 },
                dimens: { width: 10, height: 1 },
                acceptsFocus: true,
                acceptsInput: true,
            });
            field.setText('VISIBLE', false);
            vc.addView(field);

            client.term.out.length = 0;
            vc.redrawAll(1);
            assert.ok(client.term.out.join('').includes('VISIBLE'));
        });

        it('a %FM with items and no height keeps its layout (sized by the first draw)', () => {
            const client = makeClient();
            client.term.outputEncoding = 'cp437';
            client.currentMenuModule = {
                menuConfig: { config: {} },
                menuMethods: {},
                menuName: 'fm',
            };
            const items = Array.from({ length: 40 }, (_, i) => `item${i + 1}`);
            const vc = new ViewController({ client });
            let called = 0;
            vc.loadFromPromptConfig(
                {
                    mciMap: {
                        FM1: {
                            code: 'FM',
                            id: 1,
                            position: [3, 5],
                            args: [],
                            SGR: '\x1b[0;37m',
                            focusSGR: '\x1b[0;1;33;44m',
                        },
                    },
                    config: { mci: { FM1: { items, focus: true, width: 60 } } },
                },
                err => {
                    ++called;
                    assert.ifError(err);
                }
            );
            assert.equal(called, 1);

            const fm = vc.getView(1);
            //  the same as before F2: 22 rows (to the bottom of a 25 row
            //  terminal from row 3), two columns of 22 items on one page
            assert.deepEqual(fm.dimens, { width: 60, height: 22 });
            assert.equal(fm.itemsPerRow, 22);
            assert.equal(fm.pages.length, 1);

            //  and nothing drawn below the terminal
            const out = client.term.out.join('');
            const rows = [...out.matchAll(/\x1b\[(\d+);\d+H/g)].map(m => +m[1]);
            assert.ok(Math.max(...rows) <= 25, `lowest row ${Math.max(...rows)}`);
            vc.detachClientEvents();
        });
    });
});
