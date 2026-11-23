'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { Client } = require('../core/client.js');

//
//  Pre-auth feedback opens with the cursor on From, which is empty unless
//  defaultFromName is set and is validated non-empty. Its switchToHeader()
//  moved the focus with switchFocus(), which validates the view focus is
//  leaving even when that is the view asked for: From was checked before the
//  visitor had typed anything, and "Field cannot be empty" showed as the
//  editor opened.
//
//  The editor here is the real module, its forms loaded from the stock
//  preAuthFeedback config (misc/menu_templates/login.in.hjson); only the art
//  is stubbed (an mciMap per section, with the codes the stock
//  msg_op_feedback_header art has).
//

const CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
    messageConferences: {},
    theme: { default: 'luciano_blocktronics' },
    paths: { themes: '/nonexistent/themes', art: '/nonexistent/art' },
    term: { cp437TermList: [], utf8TermList: [] },
};

//  the stock preAuthFeedback forms 0-2 (header, body, editor footer)
const FORMS = {
    0: {
        mci: {
            ET1: {
                argName: 'from',
                maxLength: 36,
                focus: true,
                validate: '@systemMethod:validateNonEmpty',
            },
            ET2: { argName: 'to' },
            ET3: {
                argName: 'subject',
                maxLength: 72,
                submit: true,
                validate: '@systemMethod:validateMessageSubject',
            },
        },
        submit: {
            3: [{ value: { subject: null }, action: '@method:headerSubmit' }],
        },
    },
    1: {
        mci: { MT1: { width: 79, height: 14, argName: 'message', mode: 'edit' } },
        submit: { '*': [{ value: 'message', action: '@method:editModeEscPressed' }] },
        actionKeys: [{ keys: ['escape'], viewId: 1 }],
    },
    2: {
        mci: {
            SB1: {
                width: 9,
                panels: [
                    { name: 'mode', width: 3 },
                    { name: 'pos', width: 5 },
                ],
            },
        },
    },
};

function mci(code, id, row, col) {
    return { code, id, position: [row, col], args: [], SGR: '\x1b[0;37m' };
}

const ART = {
    H: {
        height: 4,
        mciMap: {
            ET1: mci('ET', 1, 1, 10),
            ET2: mci('ET', 2, 2, 10),
            ET3: mci('ET', 3, 3, 10),
            TL4: mci('TL', 4, 4, 10),
        },
    },
    B: { height: 19, mciMap: { MT1: mci('MT', 1, 5, 1) } },
    FE: { height: 1, mciMap: { SB1: mci('SB', 1, 24, 1) } },
};

//  a visitor at the login matrix: nobody is logged in
function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.child = () => client.log;
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
    client.term = term;
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.user = {
        userId: 0,
        username: '',
        isAuthenticated: () => false,
        realName: () => '',
        getProperty: () => undefined,
    };
    client.acs = {
        hasMessageBodyUpload: () => false,
        hasMessageConfWrite: () => true,
        hasMessageAreaWrite: () => true,
    };
    return client;
}

describe('pre-auth feedback: opening the editor', () => {
    let previousConfig;
    let PreAuthFeedback;

    before(() => {
        previousConfig = configModule._pushTestConfig(CONFIG);
        PreAuthFeedback = require('../core/pre_auth_feedback.js').getModule;
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    //  The editor as the login matrix starts it, drawn and ready
    function openEditor(config, cb) {
        const client = makeClient();
        const editor = new PreAuthFeedback({
            menuName: 'preAuthFeedback',
            menuConfig: {
                config: Object.assign(
                    {
                        art: { header: 'H', body: 'B', footerEditor: 'FE' },
                        editorType: 'email',
                        editorMode: 'edit',
                    },
                    config
                ),
                form: FORMS,
            },
            client,
        });
        client.currentMenuModule = editor;
        editor.displayAsset = (name, options, done) =>
            setImmediate(done, null, ART[name]);
        editor.finishedLoading = () => cb(editor, client);
        editor.initSequence();
        return editor;
    }

    const headerText = (editor, id) =>
        editor.viewControllers.header.getView(id).getData();

    function type(client, s) {
        for (const ch of s) {
            client.emit('key press', ch, undefined);
        }
    }

    const enter = client => client.emit('key press', '\r', { name: 'return' });

    it('opens on an empty From with no validation error showing', done => {
        openEditor({}, (editor, client) => {
            const header = editor.viewControllers.header;
            assert.equal(headerText(editor, 1), '');
            assert.equal(headerText(editor, 4), '');
            assert.equal(header.focusedView.id, 1);
            assert.ok(header.attached);
            assert.ok(!editor.viewControllers.body.attached);

            //  the header has the keys: typing goes into From
            type(client, 'Visitor');
            assert.equal(headerText(editor, 1), 'Visitor');
            done();
        });
    });

    it('still refuses an empty From when the visitor leaves it', done => {
        openEditor({}, (editor, client) => {
            enter(client);
            setImmediate(() => {
                assert.equal(headerText(editor, 4), 'Field cannot be empty');
                assert.equal(editor.viewControllers.header.focusedView.id, 1);

                type(client, 'Visitor');
                enter(client);
                setImmediate(() => {
                    assert.equal(headerText(editor, 4), '');
                    //  To is locked: Enter on From goes on to Subject
                    assert.equal(editor.viewControllers.header.focusedView.id, 3);
                    done();
                });
            });
        });
    });

    it('fills From, To and Subject from the menu config', done => {
        openEditor(
            {
                defaultFromName: 'Guest',
                sysopUserName: 'NuSkooler',
                defaultSubject: 'Hello',
            },
            editor => {
                assert.equal(headerText(editor, 1), 'Guest');
                assert.equal(headerText(editor, 2), 'NuSkooler');
                assert.equal(headerText(editor, 3), 'Hello');
                assert.equal(headerText(editor, 4), '');
                assert.equal(editor.viewControllers.header.focusedView.id, 1);
                done();
            }
        );
    });
});
