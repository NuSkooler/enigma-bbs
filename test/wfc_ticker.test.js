'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const configModule = require('../core/config.js');
const Events = require('../core/events.js');
const SysEvents = require('../core/system_events.js');
const { TickerView } = require('../core/ticker_view.js');

//  A TickerView driven straight through _advanceMotion(), with no timer and no
//  terminal, so cycle boundaries can be counted deterministically.
function headlessTicker(motion, text, width, holdTicks = 3) {
    const view = Object.create(TickerView.prototype);
    view.client = { term: { write: () => {} } };
    view.dimens = { width, height: 1 };
    view.position = { row: 1, col: 1 };
    view.motion = motion;
    view.effect = 'normal';
    view.holdTicks = holdTicks;
    view.fillChar = ' ';
    view._rawText = text;
    view._plainText = text;
    view._charColors = [];
    view._colorPhase = 0;
    view._resetMotion();
    return view;
}

function countCycles(view, ticks) {
    let n = 0;
    view.emit = ev => {
        if ('cycle complete' === ev) {
            n++;
        }
    };
    for (let i = 0; i < ticks; ++i) {
        view._advanceMotion();
    }
    return n;
}

describe('TickerView cycle boundary', () => {
    const motions = ['left', 'right', 'reveal', 'typewriter', 'fallLeft', 'fallRight'];

    motions.forEach(motion => {
        it(`emits 'cycle complete' for ${motion}`, () => {
            const view = headlessTicker(motion, 'hello world ticker', 10);
            assert.ok(countCycles(view, 200) > 0, `${motion} never completed a cycle`);
        });
    });

    it('emits for bounce when the text overflows the window', () => {
        const view = headlessTicker('bounce', 'hello world ticker', 10);
        assert.ok(countCycles(view, 200) > 0);
    });

    it('still emits for bounce when the text fits and nothing moves', () => {
        //  No overflow means no direction change, so the boundary the other
        //  motions use never arrives; a hold-length fallback covers it, else a
        //  feed would stall forever on one item.
        const view = headlessTicker('bounce', 'short', 40);
        assert.ok(countCycles(view, 200) > 0);
    });
});

describe('WFC activity ticker', () => {
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

    function makeWfc(configPatch = {}) {
        const WfcModule = require('../core/wfc.js').getModule;
        const client = {
            node: 1,
            user: {},
            term: {
                termHeight: 25,
                rawWrite: () => {},
                write: (d, c, cb) => cb && cb(),
            },
            log: { trace: () => {}, warn: () => {}, debug: () => {} },
        };
        const instance = new WfcModule({
            menuName: 'mainMenuWaitingForCaller',
            menuConfig: { config: Object.assign({ acs: 'SCID1' }, configPatch) },
            client,
        });

        const view = new EventEmitter();
        view.text = null;
        view.setText = t => (view.text = t);
        instance.getView = (form, id) => (6 === id ? view : null);
        instance._refreshAll = () => {};

        return { instance, view, client };
    }

    it('formats a configured event onto the feed', () => {
        const { instance, view } = makeWfc();
        instance._startActivityFeed();

        Events.emit(SysEvents.UserLogin, {
            user: { username: 'Umbra', realName: () => 'Mew' },
            client: { node: 3 },
        });

        instance._bindTicker(); //  drains the first item
        assert.ok(view.text, 'nothing reached the ticker');
        assert.ok(view.text.includes('Umbra'));
        assert.ok(view.text.includes('3'));

        instance._stopActivityFeed();
    });

    it('ignores an event with no configured format', () => {
        const { instance } = makeWfc();
        instance._startActivityFeed();

        //  userPostMessage has no default format, so it is opt-in only.
        Events.emit(SysEvents.UserPostMessage, {
            user: { username: 'Umbra' },
            areaTag: 'general',
        });

        assert.equal((instance.tickerFeed || []).length, 0);
        instance._stopActivityFeed();
    });

    it("advances on the view's cycle complete", () => {
        const { instance, view } = makeWfc();
        instance._startActivityFeed();
        instance._bindTicker();

        instance._pushTicker('one');
        instance._pushTicker('two');
        const first = view.text;

        view.emit('cycle complete');
        assert.notEqual(view.text, first, 'ticker did not advance on cycle');

        instance._stopActivityFeed();
    });

    it('falls back to idle text when the feed runs dry', () => {
        const { instance, view } = makeWfc({
            ticker: { idleText: '{totalCalls} calls' },
        });
        instance.stats = { totalCalls: 42 };
        instance._startActivityFeed();
        instance._bindTicker();

        assert.equal(view.text, '42 calls');
        instance._stopActivityFeed();
    });

    it('removes every listener it added', () => {
        //  The whole point of addMultipleEventListener() here: the .bind()
        //  shape leaked one ClientDisconnected listener per WFC visit.
        const before = Events.listenerCount(SysEvents.UserLogin);

        for (let i = 0; i < 4; ++i) {
            const { instance } = makeWfc();
            instance._startActivityFeed();
            instance._stopActivityFeed();
        }

        assert.equal(Events.listenerCount(SysEvents.UserLogin), before);
    });
});
