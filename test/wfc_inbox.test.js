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
