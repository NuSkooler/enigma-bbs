'use strict';

//
//  Setup of the node message screen (#1143) and of sysop chat: the first
//  finishes (its callback runs) whether or not the art has a preview view;
//  the second, when it cannot be set up, says why and ends the chat for
//  both sides instead of leaving a screen nobody can type in.
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const configModule = require('../core/config.js');

//  A form as the modules use it: views by ID, plus what leave() and
//  prevMenu() touch. |views| stays empty so the real teardown has nothing
//  of ours to destroy.
function makeForm(viewsById, extra) {
    return Object.assign(
        {
            views: {},
            _views: viewsById,
            hasView: id => !!viewsById[id],
            getView: id => viewsById[id],
            detachClientEvents: () => {},
        },
        extra
    );
}

function makeLog() {
    const entries = [];
    const log = {
        entries,
        errors: () => entries.filter(e => e.level === 'error'),
    };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => entries.push({ level, obj, msg });
    });
    return log;
}

function makeClient(node, username) {
    const calls = { goto: [], prev: 0, startIdle: 0, stopIdle: 0, initSucceeded: 0 };
    const client = {
        node,
        user: { username, properties: {} },
        term: { termHeight: 25, rawWrite: () => {}, write: () => {} },
        log: makeLog(),
        calls,
        startIdleMonitor: () => ++calls.startIdle,
        stopIdleMonitor: () => ++calls.stopIdle,
    };
    client.menuStack = {
        goto: (name, opts, cb) => {
            calls.goto.push({ name, opts });
            return cb && cb(null);
        },
        //  as the real stack: the menu on top is left, then the one under
        //  it runs
        prev: cb => {
            ++calls.prev;
            if (client.currentMenuModule) {
                client.currentMenuModule.leave();
            }
            return cb && cb(null);
        },
        initSucceeded: () => ++calls.initSucceeded,
        initFailureWouldCycle: () => false,
    };
    return client;
}

describe('node message setup (#1143)', () => {
    let previousConfig;
    let NodeMessage;

    before(() => {
        previousConfig = configModule._pushTestConfig({
            menus: { cls: false },
            debug: { assertsEnabled: false },
        });
        NodeMessage = require('../core/node_msg.js').getModule;
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    function makeNodeMessage({ withPreview, menuConfig } = {}) {
        const client = makeClient(1, 'caller');

        const nodeSelect = Object.assign(new EventEmitter(), {
            setItems: () => {},
            setFocusItemIndex: () => {},
            redraw: () => {},
        });
        const message = Object.assign(new EventEmitter(), {
            text: '',
            getData() {
                return this.text;
            },
            focusCalls: 0,
            setFocus() {
                ++this.focusCalls;
            },
        });
        const preview = withPreview
            ? { texts: [], setText: t => preview.texts.push(t) }
            : null;

        const views = { 1: nodeSelect, 2: message };
        if (preview) {
            views[3] = preview;
        }

        let focused = message;
        const instance = new NodeMessage({
            menuName: 'nodeMessage',
            menuConfig: menuConfig || { config: {} },
            client,
            extraArgs: {},
        });
        client.currentMenuModule = instance;

        instance.prepViewController = (name, formId, mciMap, cb) => {
            instance.viewControllers[name] = makeForm(views, {
                getFocusedView: () => focused,
            });
            return cb(null);
        };
        instance.updateCustomViewTextsWithFilter = () => {};

        return {
            instance,
            client,
            message,
            preview,
            focus: v => (focused = v),
            nodeSelect,
        };
    }

    //  mciReady()'s callback, or 'never' if it has not run by the next turn
    function runMciReady(instance, cb) {
        let result = 'never';
        instance.mciReady({ menu: {} }, err => (result = err));
        setImmediate(() => cb(result));
    }

    it('completes setup when the art has a preview view', done => {
        const { instance } = makeNodeMessage({ withPreview: true });
        runMciReady(instance, result => {
            assert.equal(result, null, 'mciReady() never called back');
            return done();
        });
    });

    it('completes setup when the art has no preview view', done => {
        const { instance } = makeNodeMessage({ withPreview: false });
        runMciReady(instance, result => {
            assert.equal(result, null);
            return done();
        });
    });

    it('updates the preview on every key, as it is typed', done => {
        const { instance, message, preview } = makeNodeMessage({ withPreview: true });
        runMciReady(instance, () => {
            ['h', 'hi', 'hi!'].forEach(text => {
                message.text = text;
                message.emit('key press', text.slice(-1), {});
                //  synchronously, with no timer in between
                assert.equal(preview.texts[preview.texts.length - 1], text);
            });
            assert.deepEqual(preview.texts, ['h', 'hi', 'hi!']);
            assert.equal(message.focusCalls, 3, 'the message field keeps the cursor');
            return done();
        });
    });

    it('leaves the preview alone while another view has focus', done => {
        const { instance, message, preview, focus, nodeSelect } = makeNodeMessage({
            withPreview: true,
        });
        runMciReady(instance, () => {
            focus(nodeSelect);
            message.text = 'x';
            message.emit('key press', 'x', {});
            assert.deepEqual(preview.texts, []);
            return done();
        });
    });

    //  What the caller gets from a setup that finishes: the rest of the
    //  menu's init sequence runs (pause, realtime interrupts, autoNext)
    it('finishes the init sequence: realtime interrupts are allowed', done => {
        const { instance } = makeNodeMessage({
            withPreview: true,
            menuConfig: { config: { interrupt: 'realtime' } },
        });
        let finished = false;
        instance.finishedLoading = () => (finished = true);

        instance.initSequence();
        setImmediate(() => {
            assert.equal(finished, true, 'finishedLoading() never ran');
            assert.equal(instance.realTimeInterrupt, 'allowed');
            return done();
        });
    });
});

describe('sysop chat setup failures', () => {
    let previousConfig;
    let SysopChat;
    let SysopChatModule;

    before(() => {
        previousConfig = configModule._pushTestConfig({
            menus: { cls: false },
            debug: { assertsEnabled: false },
        });
        SysopChatModule = require('../core/sysop_chat.js');
        SysopChat = SysopChatModule.getModule;
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    afterEach(() => {
        SysopChatModule.getSessions().clear();
    });

    //  |viewIds|: the views the chat art provides; |artErr|: the art failed
    function makeChat({ client, role, sessionId, viewIds, artErr }) {
        const switched = [];
        const instance = new SysopChat({
            menuName: 'sysopChat',
            menuConfig: { config: {} },
            client,
            extraArgs: { sessionId, role },
        });
        client.currentMenuModule = instance;

        const views = {};
        (viewIds || [1, 2, 3, 4]).forEach(id => (views[id] = { id }));

        instance.displayArtAndPrepViewController = (name, formId, options, cb) => {
            if (artErr) {
                return cb(artErr);
            }
            instance.viewControllers[name] = makeForm(views, {
                switchFocus: id => switched.push(id),
            });
            return cb(null);
        };
        instance.updateCustomViewTextsWithFilter = () => {};
        instance._enableLiveColorOnInput = () => {};

        let finished = 0;
        instance.finishedLoading = () => ++finished;

        return {
            instance,
            switched,
            finished: () => finished,
        };
    }

    function settle(cb) {
        setImmediate(() => setImmediate(cb));
    }

    function startSession() {
        const userClient = makeClient(2, 'caller');
        const sysopClient = makeClient(1, 'sysop');
        const sessionId = SysopChatModule.createSession(userClient, 'help');
        SysopChatModule.activateSession(sessionId, sysopClient);
        return { userClient, sysopClient, sessionId };
    }

    it('sysop side, art lacking %ET2: logs which code, ends the chat, never pulls the user in', done => {
        const { userClient, sysopClient, sessionId } = startSession();
        const sysop = makeChat({
            client: sysopClient,
            role: 'sysop',
            sessionId,
            viewIds: [1, 3, 4],
        });

        sysop.instance.initSequence();
        settle(() => {
            const errors = sysopClient.log.errors();
            assert.equal(errors.length, 1, 'expected one error logged');
            assert.equal(errors[0].obj.menuName, 'sysopChat');
            assert.equal(errors[0].obj.role, 'sysop');
            assert.deepEqual(errors[0].obj.missingMci, ['ET2']);
            assert.deepEqual(errors[0].obj.requiredMci, ['MT1', 'ET2', 'MT3', 'ET4']);
            assert.match(errors[0].obj.error, /Missing MCI 2/);

            assert.equal(SysopChatModule.getSessions().has(sessionId), false);
            assert.equal(sysopClient.calls.prev, 1, 'sysop not sent back');
            assert.equal(sysopClient.calls.stopIdle, 0);
            assert.ok(sysopClient.calls.startIdle >= 1);
            assert.equal(sysop.finished(), 0);
            assert.deepEqual(sysop.switched, []);

            assert.deepEqual(userClient.calls.goto, [], 'user pulled into a dead chat');
            assert.equal(userClient.calls.prev, 0);
            return done();
        });
    });

    it('user side, sysop already waiting: logs, tells the sysop, and both leave', done => {
        const { userClient, sysopClient, sessionId } = startSession();
        const session = SysopChatModule.getSessions().get(sessionId);

        let sysopTold = 0;
        session.sysopModule = {
            chatEnded: () => ++sysopTold,
            _updateStatus: () => {},
        };

        const user = makeChat({
            client: userClient,
            role: 'user',
            sessionId,
            viewIds: [1, 2, 3],
        });

        user.instance.initSequence();
        settle(() => {
            const errors = userClient.log.errors();
            assert.equal(errors.length, 1);
            assert.equal(errors[0].obj.role, 'user');
            assert.deepEqual(errors[0].obj.missingMci, ['ET4']);

            assert.equal(sysopTold, 1, 'sysop left waiting in the chat');
            assert.equal(SysopChatModule.getSessions().has(sessionId), false);
            assert.equal(userClient.calls.prev, 1, 'user not sent back');
            assert.equal(user.finished(), 0);
            assert.equal(sysopClient.calls.prev, 0, 'chatEnded() moves the sysop');
            return done();
        });
    });

    it('art that will not load: logs the error without a missing list, ends the chat', done => {
        const { sysopClient, sessionId } = startSession();
        const { Errors } = require('../core/enig_error.js');
        makeChat({
            client: sysopClient,
            role: 'sysop',
            sessionId,
            artErr: Errors.DoesNotExist('No art for SYSOPCHAT'),
        }).instance.initSequence();

        settle(() => {
            const errors = sysopClient.log.errors();
            assert.equal(errors.length, 1);
            assert.match(errors[0].obj.error, /SYSOPCHAT/);
            assert.equal(errors[0].obj.missingMci, undefined);
            assert.equal(SysopChatModule.getSessions().has(sessionId), false);
            assert.equal(sysopClient.calls.prev, 1);
            return done();
        });
    });

    it('a chat left while loading is not navigated again', done => {
        const { sysopClient, sessionId } = startSession();
        const chat = makeChat({
            client: sysopClient,
            role: 'sysop',
            sessionId,
            viewIds: [1, 3, 4],
        });
        chat.instance.leave(); //  e.g. hung up while the art loaded
        chat.instance.initSequence();
        settle(() => {
            assert.equal(sysopClient.log.errors().length, 0);
            assert.equal(sysopClient.calls.prev, 0);
            return done();
        });
    });

    it('a chat that sets up behaves as before: sysop pulls the user in, then the user joins', done => {
        const { userClient, sysopClient, sessionId } = startSession();
        const session = SysopChatModule.getSessions().get(sessionId);

        const sysop = makeChat({ client: sysopClient, role: 'sysop', sessionId });
        sysop.instance.initSequence();

        settle(() => {
            assert.equal(sysopClient.log.errors().length, 0);
            assert.equal(sysop.finished(), 1);
            assert.equal(session.sysopModule, sysop.instance);
            assert.deepEqual(sysop.switched, [2]);
            assert.equal(sysopClient.calls.stopIdle, 1);
            assert.equal(sysopClient.calls.prev, 0);
            assert.deepEqual(userClient.calls.goto, [
                { name: 'sysopChat', opts: { extraArgs: { sessionId, role: 'user' } } },
            ]);

            session.pendingMessages = [{ displayLine: 'early', senderRole: 'sysop' }];
            const appended = [];
            let sysopStatus = 0;
            sysop.instance._updateStatus = () => ++sysopStatus;

            const user = makeChat({ client: userClient, role: 'user', sessionId });
            user.instance._appendToPanel = (role, line) => appended.push([role, line]);
            user.instance.initSequence();

            settle(() => {
                assert.equal(userClient.log.errors().length, 0);
                assert.equal(user.finished(), 1);
                assert.equal(session.userModule, user.instance);
                assert.deepEqual(user.switched, [4]);
                assert.deepEqual(appended, [['sysop', 'early']]);
                assert.equal(sysopStatus, 1);
                assert.equal(userClient.calls.stopIdle, 1);
                assert.equal(userClient.calls.prev, 0);
                assert.equal(SysopChatModule.getSessions().has(sessionId), true);

                clearInterval(sysop.instance._statusTimer);
                clearInterval(user.instance._statusTimer);
                return done();
            });
        });
    });
});
