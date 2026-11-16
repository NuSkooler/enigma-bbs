/* eslint-disable no-control-regex */
'use strict';

//
//  MenuModule#updateCustomViewTextsWithFilter() and its skipUnchanged option
//  (WP3 PR B). Without the option every custom view is drawn on every call,
//  byte for byte as on origin/master 27e47fc9 (pinned below, measured there
//  with test/helpers/custom_view_scenario.js). With it, a TextView whose text
//  comes out the same is not drawn again.
//

const { strict: assert } = require('assert');
const crypto = require('crypto');

const { MenuModule } = require('../core/menu_module.js');
const { TextView } = require('../core/text_view.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { MaskEditTextView } = require('../core/mask_edit_text_view.js');
const { ButtonView } = require('../core/button_view.js');
const { StatusBarView } = require('../core/status_bar_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');

const {
    makeCaptureClient,
    buildScenario,
    runNoOptionScenario,
} = require('./helpers/custom_view_scenario.js');
const { VirtualScreen } = require('./helpers/virtual_screen.js');

const CLASSES = {
    MenuModule,
    TextView,
    EditTextView,
    StatusBarView,
    MultiLineEditTextView,
};

//  measured on origin/master 27e47fc9 (1600 bytes), less the 3 columns of
//  padding the EditTextView drew past its width: it shows "|04Bob" as typed,
//  and views now pad what they draw, so "|04" is 3 columns, not 0 (#1022)
const MASTER_NO_OPTION_LENGTH = 1594;
const MASTER_NO_OPTION_MD5 = '4a30957ce9afe60e3a055187d49b7ef2';

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

function textView(client, id, row, width = 20) {
    return new TextView({ client, id, position: { row, col: 2 }, dimens: { width } });
}

function makeModule(client, views, config, focusedView = null) {
    const mod = Object.create(MenuModule.prototype);
    mod.client = client;
    mod.menuConfig = { config };
    mod.viewControllers = {
        main: {
            getView: id => views[id],
            getFocusedView: () => focusedView,
        },
    };
    return mod;
}

//  Rows that a write went to, from the CSI row;col H moves in it
function rowsDrawn(writes) {
    const rows = new Set();
    writes.join('').replace(/\x1b\[(\d+);(\d+)H/g, (m, row) => {
        rows.add(parseInt(row, 10));
        return m;
    });
    return [...rows].sort((a, b) => a - b);
}

describe('MenuModule custom views: skipUnchanged', () => {
    describe('without the option', () => {
        it('draws every view on every call, the same bytes as master', () => {
            const out = runNoOptionScenario(CLASSES);
            assert.equal(out.length, MASTER_NO_OPTION_LENGTH);
            assert.equal(md5(out), MASTER_NO_OPTION_MD5);
        });

        it('draws an unchanged view again', () => {
            const { client, writes } = makeCaptureClient();
            const views = { 10: textView(client, 10, 4) };
            const mod = makeModule(client, views, { mainInfoFormat10: 'x {n}' });
            mod.updateCustomViewTextsWithFilter('main', 10, { n: 1 });
            writes.length = 0;
            mod.updateCustomViewTextsWithFilter('main', 10, { n: 1 });
            assert.deepEqual(rowsDrawn(writes), [4]);
        });
    });

    describe('with skipUnchanged', () => {
        const skip = { skipUnchanged: true };

        function twoLabels() {
            const { client, writes } = makeCaptureClient();
            const views = {
                10: textView(client, 10, 4),
                11: textView(client, 11, 5),
            };
            const mod = makeModule(client, views, {
                mainInfoFormat10: '|15{calls:>5} |07calls',
                mainInfoFormat11: '|10{users} users',
            });
            return { client, writes, views, mod };
        }

        it('writes nothing when no text changed', () => {
            const { writes, mod } = twoLabels();
            mod.updateCustomViewTextsWithFilter('main', 10, { calls: 1, users: 2 }, skip);
            assert.ok(writes.length > 0, 'the first call draws');
            writes.length = 0;

            mod.updateCustomViewTextsWithFilter('main', 10, { calls: 1, users: 2 }, skip);
            assert.equal(writes.length, 0);
        });

        it('draws only the view whose text changed, as setText() would', () => {
            const { client, writes, views, mod } = twoLabels();
            mod.updateCustomViewTextsWithFilter('main', 10, { calls: 1, users: 2 }, skip);
            writes.length = 0;

            mod.updateCustomViewTextsWithFilter('main', 10, { calls: 2, users: 2 }, skip);
            assert.deepEqual(rowsDrawn(writes), [4]);

            //  the same picture the old path draws for that view
            const drawn = writes.join('');
            const ref = makeCaptureClient();
            const refView = textView(ref.client, 10, 4);
            refView.setText('|15    2 |07calls');
            assert.equal(drawn, ref.writes.join(''));
            assert.equal(views[10].getData(), refView.getData());
            assert.ok(client);
        });

        it('draws when a predefined MCI value in the format changes', () => {
            const { client, writes } = makeCaptureClient();
            const views = { 10: textView(client, 10, 4) };
            const mod = makeModule(client, views, { mainInfoFormat10: 'Time {CT}' });

            client.timeFormat = '[12:00]';
            mod.updateCustomViewTextsWithFilter('main', 10, {}, skip);
            writes.length = 0;

            mod.updateCustomViewTextsWithFilter('main', 10, {}, skip);
            assert.equal(writes.length, 0, 'same time, nothing drawn');

            client.timeFormat = '[12:01]';
            mod.updateCustomViewTextsWithFilter('main', 10, {}, skip);
            assert.deepEqual(rowsDrawn(writes), [4]);
            assert.ok(writes.join('').includes('12:01'));
        });

        it('draws a view that has never been drawn, though its text is unchanged', () => {
            const { client, writes } = makeCaptureClient();
            const views = { 10: textView(client, 10, 4) };
            const mod = makeModule(client, views, { mainInfoFormat10: '{blank}' });
            assert.ok(!views[10].hasDrawnOnce);

            mod.updateCustomViewTextsWithFilter('main', 10, { blank: '' }, skip);
            assert.deepEqual(rowsDrawn(writes), [4]);
            assert.ok(views[10].hasDrawnOnce);

            writes.length = 0;
            mod.updateCustomViewTextsWithFilter('main', 10, { blank: '' }, skip);
            assert.equal(writes.length, 0);
        });

        it('compares a StatusBarView too: it keeps TextView setText() and getData()', () => {
            const { client, writes } = makeCaptureClient();
            const views = {
                10: new StatusBarView({
                    client,
                    id: 10,
                    position: { row: 1, col: 2 },
                    dimens: { width: 20 },
                }),
            };
            const mod = makeModule(client, views, { mainInfoFormat10: 'Avl:{a}' });
            mod.updateCustomViewTextsWithFilter('main', 10, { a: 'Y' }, skip);
            writes.length = 0;
            mod.updateCustomViewTextsWithFilter('main', 10, { a: 'Y' }, skip);
            assert.equal(writes.length, 0);
            mod.updateCustomViewTextsWithFilter('main', 10, { a: 'N' }, skip);
            assert.deepEqual(rowsDrawn(writes), [1]);
        });

        it('leaves MLE, EditTextView, MaskEditTextView and ButtonView as they were', () => {
            //  The same calls, with and without the option, give the same bytes
            const run = options => {
                const { client, writes } = makeCaptureClient();
                const views = {
                    10: new MultiLineEditTextView({
                        client,
                        id: 10,
                        position: { row: 10, col: 2 },
                        dimens: { width: 30, height: 3 },
                        mode: 'preview',
                        acceptsFocus: false,
                    }),
                    11: new EditTextView({
                        client,
                        id: 11,
                        position: { row: 7, col: 2 },
                        dimens: { width: 20 },
                        maxLength: 20,
                    }),
                    12: new MaskEditTextView({
                        client,
                        id: 12,
                        position: { row: 8, col: 2 },
                        maskPattern: '##/##',
                    }),
                    13: new ButtonView({
                        client,
                        id: 13,
                        position: { row: 9, col: 2 },
                        dimens: { width: 10 },
                    }),
                };
                const mod = makeModule(client, views, {
                    mainInfoFormat10: 'log {n}',
                    mainInfoFormat11: '|04{name}',
                    mainInfoFormat12: '{date}',
                    mainInfoFormat13: '{label}',
                });
                const obj = { n: 1, name: 'Bob', date: '12/34', label: 'OK' };
                mod.updateCustomViewTextsWithFilter('main', 10, obj, options);
                mod.updateCustomViewTextsWithFilter('main', 10, obj, options);
                mod.updateCustomViewTextsWithFilter(
                    'main',
                    10,
                    { ...obj, n: 2 },
                    Object.assign({ appendMultiLine: true }, options)
                );
                return writes.join('');
            };

            const without = run(undefined);
            assert.ok(without.length > 0);
            assert.equal(run({ skipUnchanged: true }), without);
        });

        it('moves the cursor back to the focused view only when something was drawn', () => {
            const { client, writes } = makeCaptureClient();
            const input = new EditTextView({
                client,
                id: 2,
                position: { row: 13, col: 21 },
                dimens: { width: 20 },
                maxLength: 20,
                acceptsFocus: true,
                acceptsInput: true,
            });
            const views = { 2: input, 10: textView(client, 10, 4) };
            const mod = makeModule(client, views, { mainInfoFormat10: '{n}' }, input);
            input.setFocus(true);

            let repositioned = 0;
            input._repositionCursor = () => {
                ++repositioned;
            };

            mod.updateCustomViewTextsWithFilter('main', 10, { n: 1 }, skip);
            assert.equal(repositioned, 1);

            writes.length = 0;
            mod.updateCustomViewTextsWithFilter('main', 10, { n: 1 }, skip);
            assert.equal(repositioned, 1, 'nothing drawn, the cursor was not moved');
            assert.equal(writes.length, 0);

            mod.updateCustomViewTextsWithFilter('main', 10, { n: 2 }, skip);
            assert.equal(repositioned, 2);

            //  without the option it always runs, as before
            mod.updateCustomViewTextsWithFilter('main', 10, { n: 2 });
            assert.equal(repositioned, 3);
        });

        it('runs the same scenario as master to the same screen, in fewer bytes', () => {
            const without = runNoOptionScenario(CLASSES);

            const { mod, client, writes } = buildScenario(CLASSES);
            [
                { calls: 1, name: 'Bob', avail: 'Y', time: '[12:00]' },
                { calls: 2, name: 'Bob', avail: 'Y', time: '[12:01]' },
                { calls: 2, name: 'Bob', avail: 'Y', time: '[12:01]' },
            ].forEach(t => {
                client.timeFormat = t.time;
                mod.updateCustomViewTextsWithFilter('main', 10, t, skip);
            });
            const withSkip = writes.join('');
            assert.ok(withSkip.length < without.length);
            assert.equal(
                new VirtualScreen().write(withSkip).snapshot(),
                new VirtualScreen().write(without).snapshot()
            );
        });
    });

    describe('canSkipUnchangedText()', () => {
        it('takes TextView and StatusBarView, not the views that keep raw text', () => {
            const { client } = makeCaptureClient();
            const pos = { row: 1, col: 1 };
            const dimens = { width: 10 };
            const can = v => MenuModule.canSkipUnchangedText(v);

            assert.ok(can(new TextView({ client, position: pos, dimens })));
            assert.ok(can(new StatusBarView({ client, position: pos, dimens })));
            assert.ok(!can(new EditTextView({ client, position: pos, dimens })));
            assert.ok(
                !can(new MaskEditTextView({ client, position: pos, maskPattern: '##' }))
            );
            assert.ok(!can(new ButtonView({ client, position: pos, dimens })));
            assert.ok(
                !can(
                    new MultiLineEditTextView({
                        client,
                        position: pos,
                        dimens: { width: 10, height: 2 },
                    })
                )
            );
        });
    });

    describe('the screens that opt in', () => {
        //  each refresh hands updateCustomViewTextsWithFilter() its options
        function captureOptions(instance) {
            const calls = [];
            instance.updateCustomViewTextsWithFilter = (form, start, obj, options) => {
                calls.push({ form, start, options });
            };
            return calls;
        }

        it('MRC custom views', () => {
            const MrcModule = require('../core/mrc.js').getModule;
            const mrc = Object.create(MrcModule.prototype);
            mrc.customFormatObj = { roomName: 'lobby' };
            const calls = captureOptions(mrc);
            mrc.updateCustomViews();
            assert.equal(calls.length, 1);
            assert.equal(calls[0].form, 'mrcChat');
            assert.equal(calls[0].options.skipUnchanged, true);
        });

        it('sysop chat status', () => {
            const SysopChatModule = require('../core/sysop_chat.js').getModule;
            const chat = Object.create(SysopChatModule.prototype);
            chat.sessionId = 'none';
            chat.chatStartTime = new Date();
            chat.client = { node: 2, user: { username: 'Bob' } };
            const calls = captureOptions(chat);
            chat._updateStatus();
            assert.equal(calls.length, 1);
            assert.equal(calls[0].form, 'chat');
            assert.equal(calls[0].options.skipUnchanged, true);
        });
    });
});
