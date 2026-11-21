'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { ToggleMenuView } = require('../core/toggle_menu_view.js');

//
//  #1138: page sysop. When the sysop goes away while the user types the
//  page, sendPage() shows the "send as mail?" offer; the page form (ET1)
//  must not stay attached under it, or keys go into the hidden field and
//  one Enter submits both forms. Same for the "page sent" pause: the key
//  that dismisses it must not be echoed into ET1 over the art.
//

const CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
    sysopChat: { pageCooldownMinutes: 5 },
};

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
    client.user = { userId: 42, username: 'caller' };
    client.node = 3;
    return client;
}

function type(client, s) {
    for (const ch of s) {
        client.emit('key press', ch, undefined);
    }
}

function enter(client) {
    client.emit('key press', '\r', { name: 'return' });
}

describe('page_sysop forms (#1138)', () => {
    let previousConfig;
    let SysopChat;
    let savedCreateSession;

    before(() => {
        previousConfig = configModule._pushTestConfig(CONFIG);
        SysopChat = require('../core/sysop_chat.js');
        savedCreateSession = SysopChat.createSession;
        SysopChat.createSession = () => 'session-1';
    });
    after(() => {
        SysopChat.createSession = savedCreateSession;
        configModule._popTestConfig(previousConfig);
    });

    //  The page module with its main form (ET1, submit: true) up and focused
    function makePageModule() {
        const PageSysop = require('../core/page_sysop.js').getModule;
        const client = makeClient();
        const mod = new PageSysop({
            menuName: 'pageSysop',
            menuConfig: { config: {} },
            client,
        });
        client.currentMenuModule = mod;

        const main = mod.addViewController(
            'main',
            new ViewController({ client, detached: true })
        );
        const message = new EditTextView({
            client,
            id: 1,
            position: { row: 10, col: 5 },
            dimens: { width: 30 },
            maxLength: 60,
        });
        message.submit = true;
        main.addView(message);
        main.setViewOrder();
        main.redrawAll();
        main.switchFocus(1);

        const calls = { sendPage: 0, confirm: 0 };
        main.on('submit', formData => {
            ++calls.sendPage;
            mod.sendPage({ value: { message: formData.value[1] } }, () => {});
        });

        return { mod, client, main, message, calls };
    }

    it('at the "send as mail?" offer only mailConfirm takes keys; Enter submits it alone', done => {
        const { mod, client, main, message, calls } = makePageModule();
        mod._isSysopAvailable = () => false;

        let confirmForm = null;
        mod.displayArtAndPrepViewController = (name, formId, options, cb) => {
            assert.equal(name, 'mailConfirm');
            setImmediate(() => {
                const vc = mod.addViewController(
                    name,
                    new ViewController({ client, detached: true })
                );
                const toggle = new ToggleMenuView({
                    client,
                    id: 1,
                    position: { row: 12, col: 5 },
                    items: ['Yes', 'No'],
                });
                toggle.submit = true;
                vc.addView(toggle);
                vc.setViewOrder();
                vc.redrawAll();
                vc.switchFocus(1);
                vc.on('submit', () => ++calls.confirm);
                confirmForm = vc;
                return cb(null);
            });
        };

        type(client, 'hi');
        enter(client);
        assert.equal(calls.sendPage, 1);

        setImmediate(() => {
            assert.ok(confirmForm, 'offer shown');
            const listeners = client.listeners('key press');
            assert.ok(!listeners.includes(main.clientKeyPressHandler), 'main detached');
            assert.equal(
                listeners.filter(l => l === confirmForm.clientKeyPressHandler).length,
                1,
                'mailConfirm attached once'
            );
            //  nothing else of a form: the capture dispatcher at most
            assert.ok(listeners.length <= 2);
            assert.equal(main.attached, false, 'page form detached');
            assert.equal(mod.viewControllers.main, undefined);
            assert.equal(mod._pendingMessage, 'hi');

            type(client, 'xyz');
            assert.equal(message.getData(), 'hi', 'no keys reach the hidden field');

            enter(client);
            assert.equal(calls.confirm, 1, 'mailConfirm submitted');
            assert.equal(calls.sendPage, 1, 'the page form did not submit again');
            assert.equal(mod._pendingMessage, 'hi');
            return done();
        });
    });

    it('at the "page sent" pause the dismissing key is not echoed into ET1', done => {
        const { mod, client, main, message } = makePageModule();
        mod._isSysopAvailable = () => true;
        mod._notifySysops = () => {};

        let artDrawnAt = null;
        mod.displayAsset = (spec, options, cb) => {
            setImmediate(() => {
                artDrawnAt = client.term.out.length;
                client.term.rawWrite('[page sent art]');
                return cb(null);
            });
        };
        mod.pausePrompt = (position, cb) => {
            client.waitForKeyPress(() => cb(null));
        };
        mod.prevMenu = cb => {
            const echoed = client.term.since(artDrawnAt);
            assert.ok(!echoed.includes('q'), `nothing echoed over the art: ${echoed}`);
            assert.equal(message.getData(), 'hi');
            assert.equal(main.attached, false);
            return cb(null);
        };

        type(client, 'hi');
        enter(client);

        //  a key typed while the art loads, then the one that dismisses it
        type(client, 'q');
        setImmediate(() => {
            mod.sendPage = () => assert.fail('page form submitted again');
            type(client, 'q');
            setImmediate(() => {
                assert.equal(message.getData(), 'hi');
                return done();
            });
        });
    });
});
