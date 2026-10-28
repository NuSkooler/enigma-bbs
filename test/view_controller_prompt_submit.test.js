'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');

//
//  A menu's prompt (the "...cmd:" line) submits whatever was typed. When that
//  matches no "submit" entry the field has to be emptied, or the next command
//  is appended to the last (#945).
//
function makeClient(menuConfig) {
    const log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = () => {};
    });

    const client = new events.EventEmitter();
    client.log = log;
    client.currentMenuModule = { menuName: 'someMenu', menuConfig };
    client.term = new Proxy(
        { termHeight: 25, termWidth: 80, termType: 'ansi' },
        { get: (t, p) => (p in t ? t[p] : () => {}) }
    );
    return client;
}

//  builds a controller with one real text entry view, wired up as a prompt
function makePrompt({ submitNotify, callingMenu = true } = {}) {
    const menuConfig = {
        submit: [
            { value: { 1: 'Q' }, action: '@menu:quit' },
            { value: { 1: 'G' }, action: '@menu:goodbye' },
        ],
    };
    const client = makeClient(menuConfig);
    const vc = new ViewController({ client });

    const view = new EditTextView({
        client,
        id: 1,
        position: { row: 1, col: 1 },
        dimens: { width: 20 },
        maxLength: 20,
        acceptsFocus: true,
        acceptsInput: true,
    });
    vc.addView(view);

    const opts = { mciMap: {}, config: {} };
    if (callingMenu) {
        opts.callingMenu = client.currentMenuModule;
    }
    if (submitNotify) {
        opts.submitNotify = submitNotify;
    }
    vc.loadFromPromptConfig(opts, err => assert.ifError(err));

    return { vc, view };
}

function submit(vc, view, text) {
    view.setText(text);
    vc.emit('submit', vc.getFormData());
}

describe('ViewController: prompt submit with no matching action', () => {
    it('clears the field so the next command is not appended', () => {
        const { vc, view } = makePrompt();

        submit(vc, view, 'XYZ');

        assert.equal(view.getData(), '');
        assert.equal(view.cursorPos.col, 0);

        //  the next command is exactly what is typed, and matches
        view.setText('Q');
        assert.deepEqual(vc.getFormData().value, { 1: 'Q' });
    });

    it('does not clear a field whose value matches an action', () => {
        const { vc, view } = makePrompt();
        let handled = 0;
        vc.handleActionWrapper = (fd, conf, cb) => {
            ++handled;
            assert.equal(conf.action, '@menu:quit');
            cb && cb();
        };

        submit(vc, view, 'Q');

        assert.equal(handled, 1);
        assert.equal(view.getData(), 'Q');
    });

    it('leaves the field alone when the caller supplies submitNotify', () => {
        let notified = 0;
        const { vc, view } = makePrompt({ submitNotify: () => ++notified });

        submit(vc, view, 'XYZ');

        assert.equal(notified, 1);
        assert.equal(view.getData(), 'XYZ');
    });

    it('leaves the field alone for a prompt not owned by a menu', () => {
        const { vc, view } = makePrompt({ callingMenu: false });

        submit(vc, view, 'XYZ');

        assert.equal(view.getData(), 'XYZ');
    });
});
