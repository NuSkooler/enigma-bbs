'use strict';

//
//  Regression coverage for #712 — "Problems navigating the message menu".
//
//  Root cause: the FSE keeps several ViewControllers (header, body, footer[s])
//  and relies on exactly ONE of them being attached to the client 'key press'
//  event at a time. The client emits key presses to *every* attached listener,
//  so if two input-accepting VCs are attached at once each keystroke (and ESC
//  command-menu navigation) is delivered to both — corrupting input and making
//  the command bar appear to "hang".
//
//  The #706 init fix reused _returnFocusToBody() at startup, which attached the
//  body VC without detaching the header VC that _setInitialFocus() had just
//  attached, producing exactly that double-attach. These tests lock in the fix.
//

const { strict: assert } = require('assert');
const events = require('events');
const configModule = require('../core/config.js');

const BASE_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    messageConferences: {},
};

// ─── Mechanism: client 'key press' delivery follows attach/detach ─────────────
//
//  These tests exercise the real ViewController against a real EventEmitter
//  client to prove the hazard the FSE fix guards against: two attached VCs each
//  receive the same keystroke; detaching one stops delivery to it.

describe('ViewController client key-press attachment invariant (#712)', () => {
    const { ViewController } = require('../core/view_controller.js');

    //  Minimal EventEmitter client with just enough term surface for
    //  switchFocus()/setFocus() batched writes.
    function makeClient() {
        const client = new events.EventEmitter();
        client.term = {
            termWidth: 80,
            termHeight: 25,
            write: () => {},
            rawWrite: () => {},
            beginWrite: () => {},
            commitWrite: () => {},
        };
        return client;
    }

    //  A view stub that records key presses and satisfies the bits of the View
    //  contract that ViewController touches (focus + action listener wiring).
    function makeSpyView(id) {
        const view = new events.EventEmitter();
        view.id = id;
        view.acceptsFocus = true;
        view.acceptsInput = true;
        view.hasFocus = false;
        view.keyPresses = [];
        view.setFocus = focused => {
            view.hasFocus = focused;
        };
        view.onKeyPress = (ch, key) => {
            view.keyPresses.push({ ch, key });
        };
        return view;
    }

    //  Build a detached VC (so we control attach timing explicitly) with a
    //  single spy view already focused.
    function makeVC(client, viewId) {
        const vc = new ViewController({ client, formId: 0, detached: true });
        const view = makeSpyView(viewId);
        vc.addView(view);
        vc.focusedView = view;
        return { vc, view };
    }

    it('a single attached VC receives key presses', () => {
        const client = makeClient();
        const { vc, view } = makeVC(client, 1);

        vc.attachClientEvents();
        client.emit('key press', 'a', undefined);

        assert.equal(view.keyPresses.length, 1);
        assert.equal(view.keyPresses[0].ch, 'a');
    });

    it('TWO attached VCs both receive the same key press (the #712 hazard)', () => {
        const client = makeClient();
        const a = makeVC(client, 1);
        const b = makeVC(client, 2);

        a.vc.attachClientEvents();
        b.vc.attachClientEvents();

        client.emit('key press', 'x', undefined);

        //  This is the corruption: one keystroke lands in two views at once.
        assert.equal(a.view.keyPresses.length, 1, 'first VC received the key');
        assert.equal(b.view.keyPresses.length, 1, 'second VC also received it');
    });

    it('detaching a VC stops key delivery to it — only the attached VC gets keys', () => {
        const client = makeClient();
        const header = makeVC(client, 1);
        const body = makeVC(client, 2);

        header.vc.attachClientEvents();
        body.vc.attachClientEvents();

        //  Simulate the fix: detach the header before working in the body.
        header.vc.detachClientEvents();

        client.emit('key press', 'z', undefined);

        assert.equal(
            header.view.keyPresses.length,
            0,
            'detached header must NOT receive keys'
        );
        assert.equal(body.view.keyPresses.length, 1, 'body still receives keys');
    });

    it('detachClientEvents() removes the client key-press listener (no leak)', () => {
        const client = makeClient();
        const { vc } = makeVC(client, 1);

        assert.equal(client.listenerCount('key press'), 0);
        vc.attachClientEvents();
        assert.equal(client.listenerCount('key press'), 1);
        vc.detachClientEvents();
        assert.equal(
            client.listenerCount('key press'),
            0,
            'listener must be removed on detach'
        );
    });
});

// ─── FSE init focus: header, not body (#712 / #706 interaction) ───────────────

describe('FSE _finishEditModeInit (#712)', () => {
    let FullScreenEditorModule;

    before(() => {
        const prev = configModule._pushTestConfig(BASE_CONFIG);
        ({ FullScreenEditorModule } = require('../core/fse.js'));
        configModule._popTestConfig(prev);
    });

    function makeInst() {
        const inst = Object.create(FullScreenEditorModule.prototype);
        inst._calls = [];
        //  Spy out the collaborators _finishEditModeInit drives.
        inst.switchFooter = cb => {
            inst._calls.push('switchFooter');
            return cb();
        };
        inst.switchToHeader = () => {
            inst._calls.push('switchToHeader');
        };
        inst._returnFocusToBody = () => {
            inst._calls.push('_returnFocusToBody');
        };
        return inst;
    }

    it('fresh compose: redraws the footer then focuses the HEADER (never the body)', done => {
        const inst = makeInst();
        inst._finishEditModeInit(() => {
            assert.deepEqual(inst._calls, ['switchFooter', 'switchToHeader']);
            assert.ok(
                !inst._calls.includes('_returnFocusToBody'),
                'fresh compose must NOT return focus to the body (that re-introduces #712)'
            );
            done();
        });
    });

    it('upload round-trip (_focusBodyAfterInit): redraws the footer then focuses the BODY', done => {
        const inst = makeInst();
        inst._focusBodyAfterInit = true;
        inst._finishEditModeInit(() => {
            assert.deepEqual(inst._calls, ['switchFooter', '_returnFocusToBody']);
            assert.ok(
                !inst._calls.includes('switchToHeader'),
                'returning from upload must keep the cursor in the body, not the header'
            );
            done();
        });
    });

    it('focuses the header only after the footer redraw completes', done => {
        const inst = makeInst();
        //  Make switchFooter defer its callback so ordering is observable.
        let footerCbInvoked = false;
        inst.switchFooter = cb => {
            inst._calls.push('switchFooter');
            setImmediate(() => {
                footerCbInvoked = true;
                cb();
            });
        };

        inst._finishEditModeInit(() => {
            assert.ok(footerCbInvoked, 'header focus ran before footer redraw finished');
            assert.deepEqual(inst._calls, ['switchFooter', 'switchToHeader']);
            done();
        });
    });
});

// ─── FSE _returnFocusToBody detaches the header (defense in depth, #712) ───────

describe('FSE _returnFocusToBody (#712)', () => {
    let FullScreenEditorModule;

    before(() => {
        const prev = configModule._pushTestConfig(BASE_CONFIG);
        ({ FullScreenEditorModule } = require('../core/fse.js'));
        configModule._popTestConfig(prev);
    });

    //  A fake body MLTEV that satisfies observeEditorEvents() and the edit-mode
    //  indicator reads made by _returnFocusToBody().
    function makeBodyView() {
        const view = new events.EventEmitter();
        view.getTextEditMode = () => 'insert';
        view.getEditPosition = () => ({ row: 0, col: 0 });
        return view;
    }

    function makeInst({ headerAttached }) {
        const inst = Object.create(FullScreenEditorModule.prototype);
        inst.editorMode = 'view'; //  short-circuits updateTextEditMode/Position work
        inst.client = {
            term: { beginWrite: () => {}, commitWrite: () => {} },
        };

        const bodyView = makeBodyView();
        inst._headerSetFocusCalls = [];

        inst.viewControllers = {
            header: {
                attached: headerAttached,
                setFocus(focused) {
                    inst._headerSetFocusCalls.push(focused);
                    //  Mirror ViewController.setFocus → detachClientEvents guard.
                    if (!focused) {
                        this.attached = false;
                    }
                },
            },
            body: {
                switchFocusCalls: [],
                switchFocus(id) {
                    this.switchFocusCalls.push(id);
                },
                getView: () => bodyView,
            },
        };
        return inst;
    }

    it('detaches the header (setFocus(false)) before focusing the body', () => {
        const inst = makeInst({ headerAttached: true });

        inst._returnFocusToBody();

        assert.deepEqual(
            inst._headerSetFocusCalls,
            [false],
            'header must be told to lose focus (detach) exactly once'
        );
        assert.equal(inst.viewControllers.header.attached, false);
        assert.deepEqual(
            inst.viewControllers.body.switchFocusCalls,
            [1],
            'body MLTEV (view id 1) must be focused'
        );
    });

    it('is safe when the header is not attached (still just focuses the body)', () => {
        const inst = makeInst({ headerAttached: false });

        assert.doesNotThrow(() => inst._returnFocusToBody());

        //  setFocus(false) is still called, but it is a no-op when not attached.
        assert.deepEqual(inst.viewControllers.body.switchFocusCalls, [1]);
    });

    it('does nothing to a header that does not exist (overlay-only forms)', () => {
        const inst = makeInst({ headerAttached: true });
        delete inst.viewControllers.header;

        assert.doesNotThrow(() => inst._returnFocusToBody());
        assert.deepEqual(inst.viewControllers.body.switchFocusCalls, [1]);
    });
});
