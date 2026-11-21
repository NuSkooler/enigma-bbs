'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { TickerView } = require('../core/ticker_view.js');
const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');
const { HorizontalMenuView } = require('../core/horizontal_menu_view.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const FormState = require('../core/form_state.js');

//
//  The full screen editor and the form states (F3b). The header, body and
//  footer forms that lose the keys but stay on screen are deactivated (their
//  views, listeners and timers kept), and the forms drawn over and shown
//  again later (the footers that take turns below the body, the quote
//  builder, the body under the quote builder) are covered. Before, every
//  one of them was torn down (setFocus(false) / detachClientEvents()): a
//  ticker or a status bar timer in the header or a footer stopped for good
//  at the first change of focus.
//
//  Each flow is driven by keys where the stock menu binds one, and checks
//  that a key reaches only the form that has the focus, that every
//  listener fires once however often the flow repeats, and that a covered
//  form draws nothing in the background.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
    messageConferences: {},
};

const HEADER_TICKER = '\x1b[2;60H';
const FOOTER_TICKER = '\x1b[24;60H';
const BODY_TICKER = '\x1b[10;60H';

const ESC = { name: 'escape' };
const CTRL = name => ({ name: `ctrl + ${name}` });

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    const term = { termWidth: 80, termHeight: 25, out: [] };
    term.write = (s, convertLf, cb) => {
        term.out.push(String(s));
        if (typeof convertLf === 'function') {
            convertLf();
        } else if (typeof cb === 'function') {
            cb();
        }
    };
    term.rawWrite = s => term.out.push(String(s));
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    term.since = n => term.out.slice(n).join('');
    client.term = term;
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    return client;
}

//  Interval timers fired by hand
function captureTimers() {
    const timers = [];
    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    global.setInterval = fn => {
        timers.push(fn);
        return timers.length;
    };
    global.clearInterval = id => {
        if (id) {
            timers[id - 1] = null;
        }
    };
    return {
        fireAll() {
            timers.slice().forEach(fn => fn && fn());
        },
        live() {
            return timers.filter(Boolean).length;
        },
        restore() {
            Object.assign(global, saved);
        },
    };
}

function key(client, ch, k) {
    client.emit('key press', ch, k);
}

function type(client, s) {
    for (const ch of s) {
        key(client, ch, undefined);
    }
}

function ticker(client, row, id = 9) {
    return new TickerView({
        client,
        id,
        position: { row, col: 60 },
        dimens: { width: 8, height: 1 },
        text: 'NEWS -- FILES -- DOORS',
        motion: 'left',
        holdTicks: 1,
    });
}

function form(client, views, actionKeys) {
    const vc = new ViewController({ client, detached: true });
    views.forEach(v => vc.addView(v));
    vc.setViewOrder();
    if (actionKeys) {
        vc.mapActionKeys(actionKeys, 'form');
    }
    return vc;
}

function method(name) {
    return `@method:${name}`;
}

//
//  An editor (edit mode, as messageBaseNewPost) with the stock forms, built
//  from views rather than art. A ticker sits in the header, one in the
//  editor footer (where %SB1 with a refreshInterval would draw) and one in
//  the body form. Art display is stubbed: the forms already exist, so
//  prepViewControllerWithArt() refocuses them, as it does on every footer
//  switch after the first.
//
function makeEditor(FullScreenEditorModule, { mode = 'edit' } = {}) {
    const client = makeClient();
    const inst = new FullScreenEditorModule({
        menuName: 'fseTest',
        menuConfig: {
            config: {
                art: {
                    header: 'H',
                    body: 'B',
                    footerEditor: 'FE',
                    footerEditorMenu: 'FEM',
                    footerView: 'FV',
                    footerFind: 'FF',
                    help: 'HELP',
                    quote: 'Q',
                },
                editorMode: mode,
                editorType: 'area',
            },
        },
        client,
    });
    client.currentMenuModule = inst;
    inst.header = { height: 4 };
    inst.body = { height: 18 };
    inst.isReady = true;

    const v = {
        headerTicker: ticker(client, 2),
        to: new EditTextView({
            client,
            id: 2,
            position: { row: 2, col: 10 },
            dimens: { width: 30 },
            maxLength: 30,
        }),
        subject: new EditTextView({
            client,
            id: 3,
            position: { row: 3, col: 10 },
            dimens: { width: 30 },
            maxLength: 30,
        }),
        message: new MultiLineEditTextView({
            client,
            id: 1,
            position: { row: 5, col: 1 },
            dimens: { width: 50, height: 10 },
            mode: 'edit',
        }),
        bodyTicker: ticker(client, 10),
        footerTicker: ticker(client, 24),
        menu: new HorizontalMenuView({
            client,
            id: 1,
            position: { row: 23, col: 1 },
            items: ['save', 'discard', 'help', 'upload'],
        }),
        viewMenu: new HorizontalMenuView({
            client,
            id: 1,
            position: { row: 23, col: 1 },
            items: ['prev', 'next', 'reply', 'quit', 'help'],
        }),
        find: new EditTextView({
            client,
            id: 1,
            position: { row: 23, col: 10 },
            dimens: { width: 20 },
            maxLength: 20,
        }),
        quotedMsg: new MultiLineEditTextView({
            client,
            id: 1,
            position: { row: 5, col: 1 },
            dimens: { width: 50, height: 5 },
            mode: 'preview',
        }),
        quoteLines: new VerticalMenuView({
            client,
            id: 3,
            position: { row: 12, col: 1 },
            dimens: { width: 50, height: 5 },
            items: [],
        }),
    };
    v.to.submit = false;
    v.subject.submit = true;

    const vcs = inst.viewControllers;
    vcs.header = form(
        client,
        [v.headerTicker, v.to, v.subject],
        [{ keys: ['escape'], action: method('headerEscapePressed') }]
    );
    vcs.header.on('submit', () => inst.menuMethods.headerSubmit({}, {}, () => {}));
    vcs.body = form(
        client,
        [v.message, v.bodyTicker],
        [
            { keys: ['escape'], action: method('editModeEscPressed') },
            { keys: ['ctrl + o'], action: method('editModeQuickHelp') },
            { keys: ['ctrl + f'], action: method('editModeFind') },
            { keys: ['ctrl + a'], action: method('editModeChangeSubject') },
        ]
    );
    vcs.footerEditor = form(client, [v.footerTicker]);
    vcs.footerEditorMenu = form(
        client,
        [v.menu],
        [
            { keys: ['escape'], action: method('editModeEscPressed') },
            { keys: ['?'], action: method('editModeMenuHelp') },
        ]
    );
    vcs.footerView = form(
        client,
        [v.viewMenu],
        [
            { keys: ['ctrl + f'], action: method('viewModeFind') },
            { keys: ['?'], action: method('viewModeMenuHelp') },
        ]
    );
    vcs.footerFind = form(
        client,
        [v.find],
        [{ keys: ['escape'], action: method('footerFindCancel') }]
    );
    vcs.quoteBuilder = form(
        client,
        [v.quotedMsg, v.quoteLines],
        [{ keys: ['escape'], action: method('quoteBuilderEscPressed') }]
    );
    vcs.footerFind.on('submit', fd =>
        inst.menuMethods.footerFindSubmit(fd, {}, () => {})
    );

    //  every form drawn once, as the art loads them
    Object.values(vcs).forEach(vc => vc.redrawAll());
    if ('edit' === mode) {
        //  only the footer shown takes part, as switchFooter() leaves it
        vcs.footerEditor.attachClientEvents();
    }

    //  art is not read: the forms exist, so they are refocused
    inst.displayAsset = (art, opts, cb) => cb(null, { height: 4, mciMap: {} });
    inst.prepViewControllerWithArt = (name, formId, opts, cb) =>
        inst.prepViewController(name, formId, {}, cb);

    inst.replyToMessage = {
        fromUserName: 'someone',
        modTimestamp: new Date(),
        getQuoteLines(opts, cb) {
            return cb(null, ['> one', '> two'], ['> one', '> two'], false);
        },
    };

    //  edit-position / text-edit-mode handler runs
    inst.positionUpdates = 0;
    const origUpdatePos = inst.updateEditModePosition.bind(inst);
    inst.updateEditModePosition = pos => {
        ++inst.positionUpdates;
        return origUpdatePos(pos);
    };

    inst.setInitialFooterMode();
    return { client, inst, v, vcs };
}

function keyListeners(client) {
    return client.listeners('key press').length;
}

//  forms with a key listener now
function attachedForms(vcs) {
    return Object.keys(vcs)
        .filter(name => vcs[name].attached)
        .sort();
}

function stubThemeArt(theme) {
    const saved = theme.displayThemeArt;
    theme.displayThemeArt = (opts, cb) => cb(null, { mciMap: {}, height: 10 });
    return () => {
        theme.displayThemeArt = saved;
    };
}

describe('FSE form states (F3b)', () => {
    let FullScreenEditorModule;
    let theme;
    let previousConfig;
    let timers;
    let restoreThemeArt;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
        ({ FullScreenEditorModule } = require('../core/fse.js'));
        theme = require('../core/theme.js');
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });
    beforeEach(() => {
        timers = captureTimers();
        restoreThemeArt = stubThemeArt(theme);
    });
    afterEach(() => {
        timers.restore();
        restoreThemeArt();
    });

    function editor(opts) {
        return makeEditor(FullScreenEditorModule, opts);
    }

    //  header (To) has the keys, as a fresh compose starts
    function startCompose(ed) {
        ed.inst.switchToHeader();
        return ed;
    }

    //  body has the keys
    function toBody(ed) {
        ed.inst.switchToBody();
        return ed;
    }

    describe('header and body', () => {
        it('a fresh compose: keys reach the To field only; the body is inactive, not torn down', () => {
            const { client, v, vcs } = startCompose(editor());

            assert.deepEqual(attachedForms(vcs), ['footerEditor', 'header']);
            type(client, 'bob');
            assert.equal(v.to.getData(), 'bob');
            assert.equal(v.message.getData(), '');

            assert.ok(FormState.isFormInactive(vcs.body));
            assert.equal(View.isDestroyed(v.message), false);
            assert.equal(View.isDestroyed(v.bodyTicker), false);
        });

        it('header -> body: keys reach the body only; the header ticker keeps drawing', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));

            assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            type(client, 'hello');
            assert.equal(v.message.getData(), 'hello');
            assert.equal(v.to.getData(), '');
            assert.equal(v.message.hasFocus, true);
            assert.equal(View.getInputFocusView(client), v.message);

            //  inactive but on screen: it animates (it stopped for good before)
            assert.ok(FormState.isFormInactive(vcs.header));
            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(n).includes(HEADER_TICKER), 'header ticker drew');
        });

        it('Ctrl-A: the subject takes the keys; Escape gives them back to the body', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));
            type(client, 'x');

            key(client, undefined, CTRL('a'));
            assert.deepEqual(attachedForms(vcs), ['footerEditor', 'header']);
            assert.equal(v.subject.hasFocus, true);
            type(client, 'Subj');
            assert.equal(v.subject.getData(), 'Subj');
            assert.equal(v.message.getData(), 'x');

            key(client, undefined, ESC);
            assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            type(client, 'y');
            assert.equal(v.message.getData(), 'xy');
            assert.equal(v.subject.getData(), 'Subj');
        });

        it('header <-> body cycles keep one listener of each kind, each firing once', () => {
            const { client, inst, v } = toBody(startCompose(editor()));
            const base = keyListeners(client);

            for (let i = 0; i < 4; ++i) {
                key(client, undefined, CTRL('a'));
                key(client, undefined, ESC);
            }

            assert.equal(keyListeners(client), base);
            [v.to, v.subject, v.message].forEach(view =>
                assert.equal(view.listenerCount('action'), 1, `view ${view.id}`)
            );
            assert.equal(v.message.listenerCount('edit position'), 1);
            assert.equal(v.message.listenerCount('text edit mode'), 1);

            inst.positionUpdates = 0;
            type(client, 'a');
            assert.equal(inst.positionUpdates, 1, 'edit position handled once per key');
            assert.equal(v.message.getData(), 'a');
        });
    });

    describe('Escape menu (switchFooter)', () => {
        it('Escape: the menu takes the keys; the editor footer is covered, the body inactive', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));
            type(client, 'msg');

            key(client, undefined, ESC);
            assert.equal(vcs.footerEditorMenu.attached, true);
            assert.deepEqual(attachedForms(vcs), ['footerEditorMenu']);
            assert.ok(
                FormState.getFormCoverToken(vcs.footerEditor),
                'editor footer covered'
            );
            assert.ok(FormState.isFormInactive(vcs.body));
            assert.equal(View.getInputFocusView(client), v.menu);

            //  plain keys do not reach the body
            type(client, 'zz');
            assert.equal(v.message.getData(), 'msg');

            //  the covered footer draws nothing; the header still does
            const n = client.term.out.length;
            timers.fireAll();
            const sent = client.term.since(n);
            assert.ok(
                !sent.includes(FOOTER_TICKER),
                'covered footer ticker drew nothing'
            );
            assert.ok(sent.includes(HEADER_TICKER), 'header ticker drew');
        });

        it('Escape again: back to the body, the editor footer redrawn and ticking again', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));
            key(client, undefined, ESC);
            timers.fireAll(); //  the footer ticker misses a draw

            const n = client.term.out.length;
            key(client, undefined, ESC);
            assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            assert.ok(FormState.getFormCoverToken(vcs.footerEditorMenu), 'menu covered');
            assert.equal(FormState.getFormCoverToken(vcs.footerEditor), null);
            assert.ok(client.term.since(n).includes(FOOTER_TICKER), 'footer redrawn');

            type(client, 'ok');
            assert.equal(v.message.getData(), 'ok');
            assert.equal(v.message.hasFocus, true);
            assert.equal(View.getInputFocusView(client), v.message);

            const m = client.term.out.length;
            timers.fireAll();
            assert.ok(client.term.since(m).includes(FOOTER_TICKER), 'footer ticks again');
        });

        it('Escape menu cycles: no listener stacks; each fires once; keys to one form', () => {
            const { client, inst, v, vcs } = toBody(startCompose(editor()));
            const base = keyListeners(client);

            for (let i = 0; i < 5; ++i) {
                key(client, undefined, ESC);
                assert.deepEqual(attachedForms(vcs), ['footerEditorMenu']);
                key(client, undefined, ESC);
                assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            }

            assert.equal(keyListeners(client), base);
            [v.message, v.menu].forEach(view =>
                assert.equal(view.listenerCount('action'), 1)
            );
            assert.equal(v.message.listenerCount('edit position'), 1);

            inst.positionUpdates = 0;
            type(client, 'q');
            assert.equal(inst.positionUpdates, 1);
            assert.equal(v.message.getData(), 'q');
            //  the timers: one per ticker, none restarted or leaked
            assert.equal(timers.live(), 3);
        });

        it('the menu (an HM1 key) gets its keys only while it is shown', () => {
            const { client, v } = toBody(startCompose(editor()));
            key(client, undefined, ESC);
            const before = v.menu.getData();
            key(client, undefined, { name: 'right arrow' });
            assert.notEqual(v.menu.getData(), before, 'menu moved');

            key(client, undefined, ESC); //  back to the body
            const shown = v.menu.getData();
            key(client, undefined, { name: 'right arrow' });
            assert.equal(v.menu.getData(), shown, 'hidden menu did not move');
        });
    });

    describe('find', () => {
        it('Ctrl-F: the find field takes the keys; cancel gives them back to the body', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));
            type(client, 'needle in text');

            key(client, undefined, CTRL('f'));
            assert.deepEqual(attachedForms(vcs), ['footerFind']);
            assert.ok(FormState.getFormCoverToken(vcs.footerEditor));
            type(client, 'nee');
            assert.equal(v.find.getData(), 'nee');
            assert.equal(v.message.getData(), 'needle in text');

            key(client, undefined, ESC);
            assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            assert.ok(FormState.getFormCoverToken(vcs.footerFind), 'find kept, covered');
            assert.equal(View.isDestroyed(v.find), false);
            assert.equal(View.getInputFocusView(client), v.message);
        });

        it('find cycles: one listener each; keys to one form', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));
            const base = keyListeners(client);
            for (let i = 0; i < 4; ++i) {
                key(client, undefined, CTRL('f'));
                assert.deepEqual(attachedForms(vcs), ['footerFind']);
                key(client, undefined, ESC);
            }
            assert.equal(keyListeners(client), base);
            assert.equal(v.find.listenerCount('action'), 1);
            assert.equal(v.message.listenerCount('edit position'), 1);
            type(client, 'k');
            assert.equal(v.message.getData(), 'k');
            assert.equal(v.find.getData(), '');
        });
    });

    describe('quote builder', () => {
        function openQuote({ client, inst }) {
            key(client, undefined, ESC); //  the menu
            inst.menuMethods.editModeMenuQuote({}, {}, () => {});
        }

        it('the quote list takes the keys; body and menu covered, body ticker silent', () => {
            const ed = toBody(startCompose(editor()));
            const { client, v, vcs } = ed;
            type(client, 'm');
            openQuote(ed);

            assert.deepEqual(attachedForms(vcs), ['quoteBuilder']);
            assert.ok(FormState.getFormCoverToken(vcs.body), 'body covered');
            assert.ok(FormState.getFormCoverToken(vcs.footerEditorMenu), 'menu covered');
            assert.equal(View.getInputFocusView(client), v.quoteLines);

            type(client, 'abc');
            assert.equal(v.message.getData(), 'm');

            const n = client.term.out.length;
            timers.fireAll();
            const sent = client.term.since(n);
            assert.ok(!sent.includes(BODY_TICKER), 'body ticker under the quote builder');
            assert.ok(!sent.includes(FOOTER_TICKER));
            assert.ok(sent.includes(HEADER_TICKER), 'header still shown, still ticks');
        });

        it('Escape finishes: back to the body; the builder kept, covered', () => {
            const ed = toBody(startCompose(editor()));
            const { client, v, vcs } = ed;
            openQuote(ed);
            timers.fireAll();

            const n = client.term.out.length;
            key(client, undefined, ESC);
            assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            assert.ok(FormState.getFormCoverToken(vcs.quoteBuilder));
            assert.equal(FormState.getFormCoverToken(vcs.body), null);
            assert.equal(View.isDestroyed(v.quoteLines), false);
            assert.ok(client.term.since(n).includes(BODY_TICKER), 'body ticker redrawn');

            type(client, 'z');
            assert.ok(v.message.getData().endsWith('z'));
            assert.equal(View.getInputFocusView(client), v.message);
        });

        it('quote builder cycles: listeners once each; keys to one form', () => {
            const ed = toBody(startCompose(editor()));
            const { client, v, vcs } = ed;
            const base = keyListeners(client);
            for (let i = 0; i < 3; ++i) {
                openQuote(ed);
                assert.deepEqual(attachedForms(vcs), ['quoteBuilder']);
                key(client, undefined, ESC);
                assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            }
            assert.equal(keyListeners(client), base);
            [v.quoteLines, v.message, v.menu].forEach(view =>
                assert.equal(view.listenerCount('action'), 1)
            );
            assert.equal(v.message.listenerCount('edit position'), 1);
            assert.equal(timers.live(), 3);
        });
    });

    describe('help', () => {
        it('menu ? help: the dismissing key goes nowhere; the menu has the keys after', () => {
            const ed = toBody(startCompose(editor()));
            const { client, v, vcs } = ed;
            type(client, 'm');
            key(client, undefined, ESC);
            key(client, '?', undefined);

            //  under the help cover
            assert.ok(FormState.getFormCoverToken(vcs.footerEditorMenu));
            const n = client.term.out.length;
            timers.fireAll();
            assert.ok(
                !client.term.since(n).includes(HEADER_TICKER),
                'nothing under help'
            );

            key(client, 'x', undefined); //  dismiss
            assert.deepEqual(attachedForms(vcs), ['footerEditorMenu']);
            assert.equal(View.getInputFocusView(client), v.menu);
            assert.equal(v.message.getData(), 'm');
            assert.equal(v.menu.listenerCount('action'), 1);
        });

        it('Ctrl-O help from the body: the key is not typed; the body keeps the keys', () => {
            const { client, v, vcs } = toBody(startCompose(editor()));
            type(client, 'm');
            key(client, undefined, CTRL('o'));
            key(client, 'x', undefined); //  dismiss
            assert.equal(v.message.getData(), 'm');
            assert.deepEqual(attachedForms(vcs), ['body', 'footerEditor']);
            type(client, 'n');
            assert.equal(v.message.getData(), 'mn');
        });
    });

    describe('view mode', () => {
        function viewer() {
            const ed = editor({ mode: 'view' });
            ed.inst.switchToFooter();
            return ed;
        }

        it('the footer has the keys; header and body inactive, their tickers draw', () => {
            const { client, v, vcs } = viewer();
            assert.deepEqual(attachedForms(vcs), ['footerView']);
            assert.ok(FormState.isFormInactive(vcs.header));
            assert.ok(FormState.isFormInactive(vcs.body));
            const n = client.term.out.length;
            timers.fireAll();
            const sent = client.term.since(n);
            assert.ok(sent.includes(HEADER_TICKER));
            assert.ok(sent.includes(BODY_TICKER));
            assert.equal(View.getInputFocusView(client), v.viewMenu);
        });

        it('? help and back: the footer has the keys again, one listener', () => {
            const { client, v, vcs } = viewer();
            for (let i = 0; i < 3; ++i) {
                key(client, '?', undefined);
                key(client, 'x', undefined);
                assert.deepEqual(attachedForms(vcs), ['footerView']);
            }
            assert.equal(v.viewMenu.listenerCount('action'), 1);
            assert.equal(View.getInputFocusView(client), v.viewMenu);
        });

        it('Ctrl-F find and cancel: keys to the find field, then back to the footer', () => {
            const { client, v, vcs } = viewer();
            for (let i = 0; i < 3; ++i) {
                key(client, undefined, CTRL('f'));
                assert.deepEqual(attachedForms(vcs), ['footerFind']);
                assert.ok(FormState.getFormCoverToken(vcs.footerView));
                type(client, 'q');
                key(client, undefined, ESC);
                assert.deepEqual(attachedForms(vcs), ['footerView']);
                assert.ok(FormState.getFormCoverToken(vcs.footerFind));
            }
            assert.equal(v.viewMenu.listenerCount('action'), 1);
            assert.equal(v.find.listenerCount('action'), 1);
            assert.equal(View.getInputFocusView(client), v.viewMenu);
        });
    });

    describe('leave()', () => {
        it('destroys every form, the covered and inactive ones too', () => {
            const ed = toBody(startCompose(editor()));
            const { client, vcs } = ed;
            key(client, undefined, ESC);
            key(client, undefined, ESC);
            ed.inst.leave();
            Object.keys(vcs).forEach(name =>
                assert.ok(FormState.isFormDestroyed(vcs[name]), name)
            );
            assert.equal(timers.live(), 0, 'every ticker stopped');
            assert.equal(View.isBackgroundDrawSuspended(client), false);
        });
    });

    describe('MultiLineEditTextView blur', () => {
        it('a pending pipe code collapse does not draw after the body loses the keys', () => {
            const { client, v } = toBody(startCompose(editor()));
            const saved = {
                setTimeout: global.setTimeout,
                clearTimeout: global.clearTimeout,
            };
            const pending = new Map();
            let next = 1;
            global.setTimeout = fn => {
                pending.set(next, fn);
                return next++;
            };
            global.clearTimeout = id => pending.delete(id);
            try {
                type(client, '|12x'); //  a code, then a key past it
                assert.equal(pending.size, 1, 'collapse scheduled');
                key(client, undefined, ESC); //  the menu
                assert.equal(pending.size, 0, 'dropped on blur');
            } finally {
                Object.assign(global, saved);
            }
            assert.equal(View.getInputFocusView(client), v.menu);
        });
    });
});
