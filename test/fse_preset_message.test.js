'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { Client } = require('../core/client.js');

//
//  #1144: page sysop's "send as mail?" sends the caller to the private mail
//  editor with a message already addressed to the sysop (extraArgs.message).
//  The editor opened with To, Subject and the body empty, and with "Field
//  cannot be empty" already showing in the header.
//
//  The editor here is the real one, its forms loaded from the stock
//  privateMailMenuCreateMessage config (misc/menu_templates/private_mail.in.hjson);
//  only the art is stubbed (an mciMap per section).
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

//  the stock privateMailMenuCreateMessage forms 0-2 (header, body, editor footer)
const FORMS = {
    0: {
        mci: {
            TL1: { argName: 'from' },
            ET2: {
                argName: 'to',
                focus: true,
                validate: '@systemMethod:validateGeneralMailAddressedTo',
                maxLength: 36,
            },
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
            TL1: mci('TL', 1, 1, 10),
            ET2: mci('ET', 2, 2, 10),
            ET3: mci('ET', 3, 3, 10),
            TL4: mci('TL', 4, 4, 10),
        },
    },
    B: { height: 19, mciMap: { MT1: mci('MT', 1, 5, 1) } },
    FE: { height: 1, mciMap: { SB1: mci('SB', 1, 24, 1) } },
};

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
        userId: 42,
        username: 'caller',
        realName: () => 'Caller',
        getProperty: () => undefined,
    };
    client.acs = {
        hasMessageBodyUpload: () => false,
        hasMessageConfWrite: () => true,
        hasMessageAreaWrite: () => true,
    };
    return client;
}

describe('FSE: a new message started from a preset message (#1144)', () => {
    let previousConfig;
    let AreaPostFSEModule;
    let Message;

    before(() => {
        previousConfig = configModule._pushTestConfig(CONFIG);
        AreaPostFSEModule = require('../core/msg_area_post_fse.js').getModule;
        Message = require('../core/message.js');
    });
    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    //  The editor as page sysop's gotoMenu() starts it, drawn and ready
    function openEditor(extraArgs, cb) {
        const client = makeClient();
        const editor = new AreaPostFSEModule({
            menuName: 'privateMailMenuCreateMessage',
            menuConfig: {
                config: {
                    art: { header: 'H', body: 'B', footerEditor: 'FE' },
                    editorMode: 'edit',
                    editorType: 'email',
                    messageAreaTag: 'private_mail',
                    noUpdateLastReadId: true,
                },
                form: FORMS,
            },
            extraArgs,
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

    function presetMail() {
        return new Message({
            areaTag: Message.WellKnownAreaTags.Private,
            toUserName: 'Sysop',
            fromUserName: 'caller',
            subject: 'Page from caller',
            message: 'are you there?',
        });
    }

    it('fills To, Subject and the body from the preset message', done => {
        openEditor(
            {
                messageAreaTag: Message.WellKnownAreaTags.Private,
                toUserId: 1,
                message: presetMail(),
            },
            editor => {
                assert.equal(headerText(editor, 1), 'caller');
                assert.equal(headerText(editor, 2), 'Sysop');
                assert.equal(headerText(editor, 3), 'Page from caller');
                assert.equal(editor._bodyView.getData(), 'are you there?');
                //  ready to add to or save: the body has the keys, alone
                assert.ok(editor.viewControllers.body.attached);
                assert.ok(!editor.viewControllers.header.attached);
                done();
            }
        );
    });

    it('shows no validation error before the caller has typed anything', done => {
        openEditor(
            {
                messageAreaTag: Message.WellKnownAreaTags.Private,
                toUserId: 1,
                message: presetMail(),
            },
            editor => {
                assert.equal(headerText(editor, 4), '');
                done();
            }
        );
    });

    it('a fresh compose (no preset) opens empty, on To, with no validation error', done => {
        openEditor({}, (editor, client) => {
            assert.equal(headerText(editor, 2), '');
            assert.equal(headerText(editor, 3), '');
            assert.equal(editor._bodyView.getData(), '');
            assert.equal(headerText(editor, 4), '');
            assert.equal(editor.viewControllers.header.focusedView.id, 2);
            assert.ok(editor.viewControllers.header.attached);
            assert.ok(!editor.viewControllers.body.attached);
            client.emit('key press', 'b', undefined);
            assert.equal(headerText(editor, 2), 'b');
            done();
        });
    });
});
