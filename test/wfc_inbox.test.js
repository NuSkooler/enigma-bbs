'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const WfcInbox = require('../core/wfc_inbox.js');
const { InterruptType } = require('../core/user_interrupt_queue.js');

function makeClient() {
    return {
        node: 1,
        user: {},
        term: { termHeight: 25, rawWrite: () => {}, write: (d, c, cb) => cb && cb() },
        log: { trace: () => {}, warn: () => {}, debug: () => {} },
    };
}

function makeWfc(configPatch = {}) {
    const WfcModule = require('../core/wfc.js').getModule;
    const client = makeClient();
    const instance = new WfcModule({
        menuName: 'mainMenuWaitingForCaller',
        menuConfig: { config: Object.assign({ acs: 'SCID1' }, configPatch) },
        client,
    });
    //  _routeInterruptItem() nudges a refresh; there are no views here.
    instance._refreshAll = () => {};
    return { instance, client };
}

describe('WfcInbox', () => {
    it('is per-connection and survives the module being re-created', () => {
        const client = makeClient();
        const first = WfcInbox.forClient(client);
        first.add({ type: InterruptType.NodeMsg, text: 'still here' });

        //  MenuStack.prev() discards the WFC module and builds a fresh one; the
        //  inbox hangs off the client precisely so this does not lose anything.
        const second = WfcInbox.forClient(client);
        assert.equal(second, first);
        assert.equal(second.count(), 1);
        assert.equal(second.all()[0].text, 'still here');
    });

    it('reports unread separately from total, and marks read', () => {
        const inbox = new WfcInbox();
        const a = inbox.add({ type: InterruptType.NodeMsg, text: 'a' });
        inbox.add({ type: InterruptType.NodeMsg, text: 'b' });

        assert.equal(inbox.count(), 2);
        assert.equal(inbox.unreadCount(), 2);

        inbox.markRead(a.id);
        assert.equal(inbox.count(), 2);
        assert.equal(inbox.unreadCount(), 1);
        assert.equal(inbox.latestUnread().text, 'b');
    });

    it('evicts read items before unread ones when full', () => {
        const inbox = new WfcInbox(3);
        const first = inbox.add({ type: InterruptType.NodeMsg, text: 'oldest-unread' });
        const second = inbox.add({ type: InterruptType.NodeMsg, text: 'read-one' });
        inbox.add({ type: InterruptType.NodeMsg, text: 'c' });
        inbox.markRead(second.id);

        inbox.add({ type: InterruptType.NodeMsg, text: 'd' }); //  over the cap

        const texts = inbox.all().map(i => i.text);
        assert.equal(inbox.count(), 3);
        assert.ok(texts.includes('oldest-unread'), 'unread item must outlive a read one');
        assert.ok(!texts.includes('read-one'));
        assert.ok(inbox.get(first.id));
    });

    it('removes by id', () => {
        const inbox = new WfcInbox();
        const item = inbox.add({ type: InterruptType.NodeMsg, text: 'bye' });
        assert.equal(inbox.remove(item.id).text, 'bye');
        assert.equal(inbox.count(), 0);
        assert.equal(inbox.remove(item.id), undefined);
    });
});

describe('WFC interrupt routing', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({ menus: { cls: false } });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    it('takes a node message into the inbox and eats it', () => {
        const { instance, client } = makeWfc();
        const eaten = instance._routeInterruptItem({
            type: InterruptType.NodeMsg,
            from: { userName: 'Umbra', nodeId: 2 },
            text: 'hello',
        });

        assert.equal(eaten, true, 'must not fall through to the queue');
        assert.equal(WfcInbox.forClient(client).unreadCount(), 1);
    });

    it('drops a sysop page here, because pendingPages already has it', () => {
        const { instance, client } = makeWfc();
        const eaten = instance._routeInterruptItem({
            type: InterruptType.SysopPage,
            from: { userName: 'Umbra', nodeId: 2 },
            text: 'page',
        });

        assert.equal(eaten, true);
        assert.equal(WfcInbox.forClient(client).count(), 0);
    });

    it('lets an untagged item fall through to the normal queue', () => {
        const { instance } = makeWfc();
        assert.equal(instance._routeInterruptItem({ text: 'no type' }), false);
        assert.equal(
            instance._routeInterruptItem({ type: InterruptType.System, text: 'sys' }),
            false
        );
    });

    it('honours a configured sink list over the default', () => {
        //  Send node messages straight through instead of to the inbox.
        const { instance, client } = makeWfc({
            notifications: { nodeMsg: { sinks: ['interrupt'] } },
        });

        const eaten = instance._routeInterruptItem({
            type: InterruptType.NodeMsg,
            from: { userName: 'Umbra', nodeId: 2 },
            text: 'hello',
        });

        assert.equal(eaten, false);
        assert.equal(WfcInbox.hasInbox(client), false);
    });

    it('drops a type configured with no sinks', () => {
        const { instance, client } = makeWfc({
            notifications: { nodeMsg: { sinks: [] } },
        });

        assert.equal(
            instance._routeInterruptItem({ type: InterruptType.NodeMsg, text: 'x' }),
            true
        );
        assert.equal(WfcInbox.hasInbox(client), false);
    });

    it('naming a not-yet-built sink is inert rather than an error', () => {
        //  log/ticker arrive in phases 4 and 5; a config written ahead of them
        //  must still load and must still consume the item.
        const { instance, client } = makeWfc({
            notifications: { achievementGlobal: { sinks: ['log', 'ticker'] } },
        });

        assert.equal(
            instance._routeInterruptItem({
                type: InterruptType.AchievementGlobal,
                text: 'someone did a thing',
            }),
            true
        );
        assert.equal(WfcInbox.hasInbox(client), false);
    });
});

describe('WFC config cleanups', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({ menus: { cls: false } });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    function makeWfcWithUser(configPatch, visible) {
        const WfcModule = require('../core/wfc.js').getModule;
        let current = visible;
        const client = makeClient();
        client.user = {
            isVisible: () => current,
            setVisibility: v => (current = v),
        };
        const instance = new WfcModule({
            menuName: 'mainMenuWaitingForCaller',
            menuConfig: { config: Object.assign({ acs: 'SCID1' }, configPatch) },
            client,
        });
        return { instance, isVisible: () => current };
    }

    it('accepts the documented booleans for opVisibility', () => {
        //  wfc.md documented a boolean while the code matched only strings, so
        //  `opVisibility: false` was a silent no-op -- the form Xibalba uses.
        const hidden = makeWfcWithUser({ opVisibility: false }, true);
        hidden.instance._applyOpVisibility();
        assert.equal(hidden.isVisible(), false);

        const shown = makeWfcWithUser({ opVisibility: true }, false);
        shown.instance._applyOpVisibility();
        assert.equal(shown.isVisible(), true);
    });

    it('still accepts the string spellings, and leaves visibility alone by default', () => {
        const hidden = makeWfcWithUser({ opVisibility: 'hidden' }, true);
        hidden.instance._applyOpVisibility();
        assert.equal(hidden.isVisible(), false);

        const untouched = makeWfcWithUser({}, true);
        untouched.instance._applyOpVisibility();
        assert.equal(untouched.isVisible(), true);
    });

    it('warns about an unknown sink or notification type', () => {
        const WfcModule = require('../core/wfc.js').getModule;
        const client = makeClient();
        const warnings = [];
        client.log = {
            trace: () => {},
            debug: () => {},
            warn: (obj, msg) => warnings.push(msg),
        };

        const instance = new WfcModule({
            menuName: 'mainMenuWaitingForCaller',
            menuConfig: {
                config: {
                    acs: 'SCID1',
                    notifications: {
                        nodeMsg: { sinks: ['inbx'] }, //  typo
                        nodeMessage: { sinks: ['inbox'] }, //  wrong type name
                        sysopPage: { sinks: 'inbox' }, //  not an array
                    },
                },
            },
            client,
        });

        instance._validateNotificationConfig();

        assert.ok(
            warnings.some(w => /unknown sink/.test(w)),
            "no warning for a typo'd sink"
        );
        assert.ok(
            warnings.some(w => /unknown notification type/.test(w)),
            'no warning for an unknown type'
        );
        assert.ok(
            warnings.some(w => /must be an array/.test(w)),
            'no warning for a non-array sinks value'
        );
    });
});

describe('WFC status bar panels', () => {
    const { StatusBarView } = require('../core/status_bar_view.js');

    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({
            menus: { cls: false },
            general: { boardName: 'Test Board' },
        });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    //  A stand-in for a panel-mode %SB5 that records what it was handed.
    function fakeStatusBar(names) {
        const view = { panels: {}, setCalls: 0 };
        view.getPanelNames = () => names.slice();
        view.setPanels = updates => {
            view.setCalls++;
            Object.assign(view.panels, updates);
        };
        return view;
    }

    function makeWfcWithStatusBar(configPatch, names) {
        const { instance, client } = makeWfc(configPatch);
        const view = fakeStatusBar(names);
        instance.getView = (form, id) => ('main' === form && 5 === id ? view : null);
        return { instance, client, view };
    }

    function nodeMsg(text) {
        return {
            type: InterruptType.NodeMsg,
            from: { userName: 'Umbra', nodeId: 2 },
            text,
        };
    }

    it('lists panel names, and none outside panel mode', () => {
        const panelled = Object.create(StatusBarView.prototype);
        panelled.refreshInterval = 0;
        panelled._initPanels([{ name: 'now', width: 10 }, { width: 5 }]);
        assert.deepEqual(panelled.getPanelNames(), ['now', '1']);

        const single = Object.create(StatusBarView.prototype);
        assert.deepEqual(single.getPanelNames(), []);
    });

    it('fills every named panel from statusBar<Name>Format against the stats', () => {
        const { instance, view } = makeWfcWithStatusBar(
            {
                statusBarUserFormat: 'op:{currentUserName}',
                statusBarMailFormat: 'Prv:{newPrivateMail}',
            },
            ['user', 'mail', 'label', 'messages', 'pages']
        );
        instance.stats = { currentUserName: 'NuSkooler', newPrivateMail: 3 };

        instance._updateStatusBarPanels();

        assert.equal(view.panels.user, 'op:NuSkooler');
        assert.equal(view.panels.mail, 'Prv:3');
        //  messages/pages work with no config at all
        assert.equal(view.panels.messages, 'MSG 0');
        assert.equal(view.panels.pages, 'PAGE 0');
        //  no format: a static `text` label panel must be left alone
        assert.ok(!('label' in view.panels), 'unconfigured panel was overwritten');
    });

    it('uses the active format only while the count is non-zero', () => {
        const { instance, view } = makeWfcWithStatusBar(
            {
                statusBarMessagesFormat: 'msg {count}',
                statusBarMessagesActiveFormat: 'MSG! {count}',
                statusBarPagesFormat: 'page {count}',
                statusBarPagesActiveFormat: 'PAGE! {count}',
            },
            ['messages', 'pages']
        );

        instance._updateStatusBarPanels();
        assert.equal(view.panels.messages, 'msg 0');
        assert.equal(view.panels.pages, 'page 0');

        instance._inbox().add(nodeMsg('hi'));
        instance.pendingPages.push({ userName: 'Umbra', nodeId: 2 });
        instance._updateStatusBarPanels();
        assert.equal(view.panels.messages, 'MSG! 1');
        assert.equal(view.panels.pages, 'PAGE! 1');
    });

    it('falls back to the normal format when no active format is set', () => {
        const { instance, view } = makeWfcWithStatusBar(
            { statusBarMessagesFormat: 'msg {count}' },
            ['messages']
        );
        instance._inbox().add(nodeMsg('hi'));
        instance._updateStatusBarPanels();
        assert.equal(view.panels.messages, 'msg 1');
    });

    //  A stand-in for a single-mode %SB5, with or without its own `text`.
    function makeWfcWithSingleStatusBar(configPatch, textTemplate) {
        const { instance } = makeWfc(configPatch);
        const view = fakeStatusBar([]);
        view.text = null;
        view.hasTextTemplate = () => !!textTemplate;
        view.setText = text => {
            view.text = text;
        };
        instance.getView = (form, id) => ('main' === form && 5 === id ? view : null);
        return { instance, view };
    }

    it('gives an unconfigured single-mode status bar the whole header', () => {
        const { instance, view } = makeWfcWithSingleStatusBar({});
        instance.stats = {
            now: '10/29/2026',
            currentUserName: 'NuSkooler',
            newPrivateMail: 1,
            newMessagesAddrTo: 2,
            availIndicator: 'Y',
            visIndicator: 'N',
            pendingNodeMessageCount: 3,
            pendingPageCount: 0,
        };

        instance._updateStatusBarPanels();
        assert.equal(
            view.text,
            '10/29/2026  NuSkooler  Prv:1 Addr:2  Avl:Y Vis:N  Msg:3 Page:0'
        );
        assert.equal(view.setCalls, 0);

        const custom = makeWfcWithSingleStatusBar({ statusBarFormat: '{now}!' });
        custom.instance.stats = { now: 'today' };
        custom.instance._updateStatusBarPanels();
        assert.equal(custom.view.text, 'today!');
    });

    it('leaves a single-mode status bar with its own text template alone', () => {
        const { instance, view } = makeWfcWithSingleStatusBar({}, '{CT}');
        instance.stats = { now: 'today' };
        instance._updateStatusBarPanels();
        assert.equal(view.text, null);
    });

    it('reports whether a single-mode status bar has a text template', () => {
        const bare = Object.create(StatusBarView.prototype);
        bare._format = '';
        assert.equal(bare.hasTextTemplate(), false);

        const clock = Object.create(StatusBarView.prototype);
        clock._format = '{CT}';
        assert.equal(clock.hasTextTemplate(), true);
    });

    it('updates the count the moment a node message arrives', () => {
        const { instance, view } = makeWfcWithStatusBar({}, ['messages']);
        instance.viewControllers.main = {}; //  dashboard is up

        instance._routeInterruptItem(nodeMsg('ding'));
        assert.equal(view.panels.messages, 'MSG 1');
    });

    it('does not paint the status bar while a sub-viewer owns the screen', () => {
        const { instance, view } = makeWfcWithStatusBar({}, ['messages']);
        instance.viewControllers.main = {};
        instance.viewControllers.messages = {};

        instance._routeInterruptItem(nodeMsg('ding'));
        assert.equal(view.setCalls, 0);

        //  ...nor before the dashboard has been drawn at all
        delete instance.viewControllers.messages;
        delete instance.viewControllers.main;
        instance._routeInterruptItem(nodeMsg('dong'));
        assert.equal(view.setCalls, 0);
    });

    it('puts boardName in the stats, for idleText and custom MCI', () => {
        const StatLog = require('../core/stat_log.js');
        const saved = {
            getSystemStat: StatLog.getSystemStat,
            getSystemStatNum: StatLog.getSystemStatNum,
            getUserStatNumByClient: StatLog.getUserStatNumByClient,
        };
        StatLog.getSystemStat = () => ({});
        StatLog.getSystemStatNum = () => 7;
        StatLog.getUserStatNumByClient = () => 0;

        //  wfc.js captures config.get when it is first loaded, which may have
        //  been under some other file's test config. Load a private copy so it
        //  sees the boardName pushed above, then put the shared one back.
        const wfcPath = require.resolve('../core/wfc.js');
        const sharedWfc = require.cache[wfcPath];
        delete require.cache[wfcPath];

        try {
            const WfcModule = require('../core/wfc.js').getModule;
            const client = makeClient();
            const instance = new WfcModule({
                menuName: 'mainMenuWaitingForCaller',
                menuConfig: {
                    config: {
                        acs: 'SCID1',
                        statusAvailableIndicators: ['N', 'Y'],
                        statusVisibleIndicators: ['N', 'Y'],
                        dateFormat: 'YYYY-MM-DD',
                        timeFormat: 'HH:mm',
                        ticker: { idleText: '{boardName} - {totalCalls} calls' },
                    },
                },
                client,
            });
            client.user = {
                username: 'NuSkooler',
                realName: () => 'Bryan',
                isAvailable: () => true,
                isVisible: () => true,
            };

            instance._refreshStats(() => {});
            assert.equal(instance.stats.boardName, 'Test Board');

            const ticker = { setText: t => (ticker.text = t) };
            instance.getView = (form, id) => (6 === id ? ticker : null);
            instance._advanceTicker();
            assert.equal(ticker.text, 'Test Board - 7 calls');
        } finally {
            Object.assign(StatLog, saved);
            if (sharedWfc) {
                require.cache[wfcPath] = sharedWfc;
            } else {
                delete require.cache[wfcPath];
            }
        }
    });
});

describe('WFC message format tokens', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({ menus: { cls: false } });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    function item(read) {
        return {
            id: 1,
            type: InterruptType.NodeMsg,
            from: { userName: 'Umbra', nodeId: 2 },
            text: 'hello',
            timestamp: new Date(0),
            read,
        };
    }

    function makeFormatter(configPatch) {
        const { instance } = makeWfc(
            Object.assign({ dateTimeFormat: 'YYYY-MM-DD' }, configPatch)
        );
        return (msg, i) => instance._messageFormatObj(msg, i);
    }

    it('marks unread messages with unreadIndicator, default *', () => {
        const fmt = makeFormatter({});
        assert.equal(fmt(item(false), 0).unreadIndicator, '*');
        assert.equal(fmt(item(true), 0).unreadIndicator, '');
    });

    it('honours a configured unreadIndicator', () => {
        const fmt = makeFormatter({ unreadIndicator: '|14N' });
        assert.equal(fmt(item(false), 0).unreadIndicator, '|14N');
        assert.equal(fmt(item(true), 0).unreadIndicator, '');
    });
});

describe('WFC screens that take over from the dashboard', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({
            menus: { cls: false },
            general: { boardName: 'Test Board' },
        });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    //  A form 0 that records whether it was let go
    function withMainForm(instance) {
        const main = { detached: 0 };
        main.detachClientEvents = () => main.detached++;
        main.getView = () => null;
        instance.viewControllers.main = main;
        return main;
    }

    //  Detaching form 0 destroyed its ticker's timer for good; keeping it
    //  attached left its keys live, so escape in the message viewer also ran
    //  form 0's prevMenu and left the WFC. It is dropped instead, and drawn
    //  again from the art on the way back.
    it('drops form 0 for the message viewer', () => {
        const { instance } = makeWfc();
        const main = withMainForm(instance);
        instance._displayMessagesFallback = cb => cb(null);

        instance._displayMessagesPage(() => {});
        assert.equal(main.detached, 1);
        assert.equal(instance.viewControllers.main, undefined);
        assert.equal(instance._mainFormOwnsScreen(), false);
    });

    it('drops form 0 for the help page and the full log', () => {
        const { instance } = makeWfc({ art: { help: 'wfchelp' } });
        let main = withMainForm(instance);
        instance.displayAsset = () => {}; //  never calls back: help stays up
        instance._displayHelpPage(() => {});
        assert.equal(main.detached, 1);
        assert.equal(instance.viewControllers.main, undefined);

        main = withMainForm(instance);
        instance._readLogSnapshot = cb => cb(null, []);
        instance.displayArtAndPrepViewController = (name, formId, opts, cb) => cb(null);
        instance._displayFullLogPage(() => {});
        assert.equal(main.detached, 1);
        assert.equal(instance.viewControllers.main, undefined);
    });

    it('does not paint form 0 when a node drops while it is gone', () => {
        const { instance } = makeWfc();
        let refreshed = false;
        instance._refreshAll = () => (refreshed = true);
        instance._clientDisconnected({});
        assert.equal(refreshed, false);
    });
});
