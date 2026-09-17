'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const UserInterruptQueue = require('../core/user_interrupt_queue.js');

function makeChatModule() {
    const SysopChat = require('../core/sysop_chat.js').getModule;

    const written = [];
    const client = {
        node: 1,
        user: {},
        term: {
            termHeight: 25,
            rawWrite: d => written.push(String(d)),
            write: (d, c, cb) => {
                written.push(String(d));
                if (cb) cb();
            },
        },
        log: { trace: () => {}, warn: () => {}, debug: () => {} },
        written,
    };
    client.interruptQueue = new UserInterruptQueue(client);

    const instance = new SysopChat({
        menuName: 'sysopChat',
        menuConfig: { config: {} },
        client,
        extraArgs: { sessionId: 'x', role: 'sysop' },
    });
    client.currentMenuModule = instance;
    return { instance, client };
}

describe('sysop chat and interrupts', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({ menus: { cls: false } });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    it('never paints over a live chat', () => {
        const { client } = makeChatModule();

        //  Deliberately untyped: a live chat must not be painted over
        //  whatever produced the item.
        client.interruptQueue.queueItem({
            from: { userName: 'Umbra', nodeId: 2 },
            text: 'mid-conversation',
            pause: true,
        });

        assert.equal(client.written.length, 0, 'wrote to a live chat screen');
        assert.equal(client.interruptQueue.hasItems(), true, 'item was dropped');
    });

    it('hands the queue to the destination instead of flushing on exit', done => {
        const { instance, client } = makeChatModule();

        client.interruptQueue.queueItem({
            text: 'waiting',
            pause: true,
        });

        let detached = false;
        instance.detachViewControllers = () => (detached = true);
        client.menuStack = {
            prev: cb => {
                //  By the time the stack pops, nothing should have been drawn
                //  and the item should still be queued for the destination.
                assert.equal(client.written.length, 0, 'flushed on the way out');
                assert.equal(client.interruptQueue.hasItems(), true);
                assert.equal(detached, true, 'form still attached during exit');
                cb(null);
            },
        };

        instance.prevMenu(err => {
            assert.equal(err, null);
            return done();
        });
    });
});
