'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');

function makeClient() {
    const written = [];
    const client = {
        node: 1,
        user: {},
        term: {
            termHeight: 25,
            rawWrite: d => written.push(String(d)),
            write: (d, conv, cb) => {
                written.push(String(d));
                if (cb) {
                    cb();
                }
            },
        },
        log: { trace: () => {}, warn: () => {}, debug: () => {} },
        written,
    };

    const UserInterruptQueue = require('../core/user_interrupt_queue.js');
    client.interruptQueue = new UserInterruptQueue(client);

    //  No current menu module -> queueItem()'s attemptInterruptNow() throws and
    //  the item is queued, which is what we want to inspect here.
    client.currentMenuModule = null;
    return client;
}

describe('UserInterruptQueue', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({ menus: { cls: false } });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    it('drains oldest first', done => {
        const client = makeClient();
        ['first', 'second', 'third'].forEach(text =>
            client.interruptQueue.queueItem({ text, pause: false })
        );

        const seen = [];
        const drain = () => {
            if (!client.interruptQueue.hasItems()) {
                assert.deepEqual(seen, ['first', 'second', 'third']);
                return done();
            }
            client.interruptQueue.displayNext({}, err => {
                assert.equal(err, null);
                const all = client.written.join(' ');
                ['first', 'second', 'third'].forEach(t => {
                    if (all.includes(t) && !seen.includes(t)) {
                        seen.push(t);
                    }
                });
                drain();
            });
        };
        drain();
    });

    it('tags an untyped item as System rather than leaving it unroutable', () => {
        const client = makeClient();
        const { InterruptType } = require('../core/user_interrupt_queue.js');

        client.interruptQueue.queueItem({ text: 'no type given', pause: false });

        assert.equal(client.interruptQueue.queue.length, 1);
        assert.equal(client.interruptQueue.queue[0].type, InterruptType.System);
    });

    it("preserves a producer's type and from block", () => {
        const client = makeClient();
        const { InterruptType } = require('../core/user_interrupt_queue.js');

        client.interruptQueue.queueItem({
            type: InterruptType.NodeMsg,
            from: { userName: 'Umbra', userId: 2, nodeId: 2 },
            text: 'hi',
            pause: false,
        });

        const item = client.interruptQueue.queue[0];
        assert.equal(item.type, InterruptType.NodeMsg);
        assert.equal(item.from.userName, 'Umbra');
        assert.equal(item.from.nodeId, 2);
    });

    it('still rejects an item with neither text nor contents', () => {
        const client = makeClient();
        client.interruptQueue.queueItem({ pause: false });
        assert.equal(client.interruptQueue.hasItems(), false);
    });

    it('exposes every type a producer sets', () => {
        const { InterruptType } = require('../core/user_interrupt_queue.js');
        [
            'NodeMsg',
            'Achievement',
            'AchievementGlobal',
            'SysopPage',
            'TimeWarning',
            'System',
        ].forEach(k => assert.equal(typeof InterruptType[k], 'string'));
    });
});
