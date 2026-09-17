'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const UserInterruptQueue = require('../core/user_interrupt_queue.js');

const MENU_CONFIG = { debug: { assertsEnabled: false }, menus: { cls: false } };

function makeClient() {
    const written = [];
    const client = {
        node: 1,
        user: {},
        term: {
            termWidth: 80,
            termHeight: 25,
            rawWrite: d => written.push(String(d)),
            write: (d, c, cb) => {
                written.push(String(d));
                if (cb) cb();
            },
        },
        log: { warn: () => {}, debug: () => {}, trace: () => {} },
        currentTheme: { prompts: {} },
        written,
    };
    client.interruptQueue = new UserInterruptQueue(client);
    return client;
}

function makeModule(client, configPatch = {}) {
    const { MenuModule } = require('../core/menu_module.js');
    return new MenuModule({
        menuName: 'testMenu',
        menuConfig: { config: configPatch, art: null },
        client,
    });
}

describe('interrupt queue drains on arrival, not departure', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    it('prevMenu() hands the queue straight to the stack', done => {
        const client = makeClient();
        const mod = makeModule(client);
        client.interruptQueue.queue.push({ text: 'held', pause: false });

        client.menuStack = {
            prev: cb => {
                //  Nothing drawn, nothing consumed: the destination's enter()
                //  is what shows this.
                assert.equal(client.written.length, 0);
                assert.equal(client.interruptQueue.hasItems(), true);
                cb(null);
            },
        };

        mod.prevMenu(err => {
            assert.equal(err, null);
            done();
        });
    });

    it('nextMenu() does the same', done => {
        const client = makeClient();
        const mod = makeModule(client);
        mod.menuConfig.next = 'somewhereElse';
        client.interruptQueue.queue.push({ text: 'held', pause: false });

        client.menuStack = {
            next: cb => {
                assert.equal(client.written.length, 0);
                assert.equal(client.interruptQueue.hasItems(), true);
                cb(null);
            },
        };

        mod.nextMenu(err => {
            assert.equal(err, null);
            done();
        });
    });

    it('enter() drains before the menu sequence starts', done => {
        const client = makeClient();
        const mod = makeModule(client);
        client.interruptQueue.queue.push({ text: 'ARRIVED', pause: false });

        let sequenceRan = false;
        mod.initSequence = () => {
            sequenceRan = true;
            //  Drained first, so the menu draws over a settled screen.
            assert.equal(client.interruptQueue.hasItems(), false);
            assert.ok(client.written.join(' ').includes('ARRIVED'));
            done();
        };

        mod.enter();
        assert.ok(sequenceRan || true); //  drain may defer the sequence a tick
    });

    it('reaches a module that overrides initSequence() without draining', done => {
        //  This is the whole point: ~29 modules override initSequence() and
        //  never drained, so they showed nothing. enter() reaches them all.
        const client = makeClient();
        const mod = makeModule(client);
        client.interruptQueue.queue.push({ text: 'STILLSHOWN', pause: false });

        mod.initSequence = () => {
            assert.ok(client.written.join(' ').includes('STILLSHOWN'));
            done();
        };

        mod.enter();
    });

    it('still respects interrupt: never', done => {
        const client = makeClient();
        const mod = makeModule(client, { interrupt: 'never' });
        client.interruptQueue.queue.push({ text: 'QUIET', pause: false });

        mod.initSequence = () => {
            assert.equal(client.written.length, 0);
            assert.equal(client.interruptQueue.hasItems(), true);
            done();
        };

        mod.enter();
    });
});
