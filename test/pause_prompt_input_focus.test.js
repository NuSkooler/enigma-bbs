'use strict';

//
//  A pause prompt takes no typing, but the menu's forms stay attached under
//  it and their focused field keeps hasFocus. A ticker in the pause art must
//  not put the cursor back into that field (no longer on screen): the
//  client's input focus is set aside while the pause waits, and given back
//  after the key.
//

const { strict: assert } = require('assert');
const events = require('events');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const UserProps = require('../core/user_property.js');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const FIELD_FOCUS_SGR = '\x1b[0;1;37;44m';

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return quietLog;
    },
};

//  A real ClientTerminal (art display needs its encoding) whose socket
//  tracks the cursor, the SGR and every write, as a terminal would
function makeTerm(ClientTerminal) {
    const track = {
        cursor: { row: 1, col: 1 },
        sgr: '',
        all: [],
    };
    const consume = s => {
        track.all.push(s);
        let i = 0;
        while (i < s.length) {
            if ('\x1b' === s[i] && '[' === s[i + 1]) {
                let j = i + 2;
                while (j < s.length && /[0-9;?]/.test(s[j])) {
                    ++j;
                }
                if ('H' === s[j] || 'f' === s[j]) {
                    const [row, col] = s.slice(i + 2, j).split(';');
                    track.cursor = {
                        row: parseInt(row, 10) || 1,
                        col: parseInt(col, 10) || 1,
                    };
                } else if ('m' === s[j]) {
                    track.sgr = s.slice(i, j + 1);
                }
                i = j + 1;
                continue;
            }
            if ('\r' === s[i]) {
                track.cursor.col = 1;
            } else if ('\n' === s[i]) {
                ++track.cursor.row;
            } else {
                ++track.cursor.col;
            }
            ++i;
        }
    };

    const term = new ClientTerminal({
        writable: true,
        write(data, cb) {
            consume(Buffer.from(data).toString('latin1'));
            if (cb) {
                cb(null);
            }
        },
    });
    term.outputEncoding = 'cp437';
    term.termWidth = 80;
    term.termHeight = 25;

    track.pos = () => `${track.cursor.row},${track.cursor.col}`;
    track.since = n => track.all.slice(n).join('');
    return { term, track };
}

//  until |cond()|, letting file reads and callbacks run
async function waitFor(cond, what) {
    for (let i = 0; i < 500 && !cond(); ++i) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(cond(), `timed out waiting for ${what}`);
}

describe('pause prompts set the input focus aside', function () {
    let tmp;
    let prevConfig;
    let theme;
    let View;
    let ViewController;
    let EditTextView;
    let MenuModule;
    let UserInterruptQueue;
    let ClientTerminal;
    let timers;
    let savedTimers;

    before(function () {
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-pause-focus-'));
        const themeDir = paths.join(tmp, 'themes', 'test_theme');
        fs.mkdirSync(themeDir, { recursive: true });
        fs.mkdirSync(paths.join(tmp, 'general'), { recursive: true });
        //  a one line pause prompt with a ticker in it
        fs.writeFileSync(paths.join(themeDir, 'PAUSETK.ans'), '>> %TK1 <<');

        prevConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'Test' },
            paths: {
                themes: paths.join(tmp, 'themes'),
                art: paths.join(tmp, 'general'),
                mods: paths.join(tmp, 'mods'),
            },
            theme: { default: 'test_theme', preLogin: 'test_theme' },
        });

        theme = require('../core/theme.js');
        ({ View } = require('../core/view.js'));
        ({ ViewController } = require('../core/view_controller.js'));
        ({ EditTextView } = require('../core/edit_text_view.js'));
        ({ MenuModule } = require('../core/menu_module.js'));
        UserInterruptQueue = require('../core/user_interrupt_queue.js');
        ({ ClientTerminal } = require('../core/client_term.js'));
    });

    after(function () {
        configModule._popTestConfig(prevConfig);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    beforeEach(function () {
        timers = [];
        savedTimers = {
            setInterval: global.setInterval,
            clearInterval: global.clearInterval,
        };
        global.setInterval = fn => {
            timers.push(fn);
            return timers.length;
        };
        global.clearInterval = id => {
            if (id) {
                timers[id - 1] = null;
            }
        };
    });

    afterEach(function () {
        global.setInterval = savedTimers.setInterval;
        global.clearInterval = savedTimers.clearInterval;
    });

    const fireAll = () => timers.forEach(fn => fn && fn());
    //  the pause prompt's ticker has been made once its timer is set
    const tickerUp = () => timers.some(Boolean);

    function makeClient() {
        const client = new events.EventEmitter();
        client.log = quietLog;
        const { term, track } = makeTerm(ClientTerminal);
        client.term = term;
        client.track = track;
        client.user = {
            properties: { [UserProps.ThemeId]: 'test_theme' },
            isAuthenticated: () => false,
        };
        client.currentTheme = {
            info: { themeId: 'test_theme' },
            menus: {},
            prompts: {
                pauseTk: {
                    art: 'PAUSETK',
                    config: { trailingLF: 'no' },
                    mci: {
                        TK1: {
                            text: 'press any key to continue',
                            width: 12,
                            motion: 'left',
                        },
                    },
                },
            },
        };
        client.currentMenuModule = {
            menuName: 'testMenu',
            menuConfig: {},
            menuMethods: {},
        };
        client.waitForKeyPress = cb => client.once('key press', cb);
        return client;
    }

    //  the menu under the pause: one form with a focused command field
    function makeMenuForm(client) {
        const vc = new ViewController({ client });
        const field = new EditTextView({
            client,
            id: 1,
            position: { row: 20, col: 5 },
            dimens: { width: 30 },
            maxLength: 30,
            styleSGR2: FIELD_FOCUS_SGR,
        });
        vc.addView(field);
        vc.setViewOrder();
        vc.switchFocus(1);
        return { vc, field };
    }

    //  the tick's draw: goes to the ticker, never into the field, no hide/show
    function assertTickLeftAtTicker(track, out) {
        const m = /\x1b\[(\d+);(\d+)H/.exec(out); //  eslint-disable-line no-control-regex
        assert.ok(m, `the tick drew the ticker: ${JSON.stringify(out)}`);
        assert.ok(!out.includes('\x1b[20;'), 'no move into the field');
        assert.ok(!out.includes(HIDE_CURSOR) && !out.includes(SHOW_CURSOR));
        assert.equal(
            track.pos(),
            `${m[1]},${parseInt(m[2], 10) + 12}`,
            'cursor left after the ticker'
        );
    }

    function pause(client, options = {}) {
        const state = { done: false };
        theme.displayThemedPause(
            client,
            Object.assign({ promptName: 'pauseTk', clearPrompt: false }, options),
            () => {
                state.done = true;
            }
        );
        return state;
    }

    it('a ticker in the pause leaves the cursor at the ticker, as before', async function () {
        const client = makeClient();
        const { field } = makeMenuForm(client);
        assert.equal(View.getInputFocusView(client), field, 'precondition');

        const state = pause(client);
        await waitFor(tickerUp, 'the pause ticker');
        assert.equal(state.done, false, 'waiting for the key');
        assert.equal(View.getInputFocusView(client), null, 'set aside');

        for (let i = 0; i < 3; ++i) {
            const n = client.track.all.length;
            fireAll();
            assertTickLeftAtTicker(client.track, client.track.since(n));
        }
    });

    it('after the key, tracking is back on the field and a later draw restores it', async function () {
        const client = makeClient();
        const { field } = makeMenuForm(client);
        const state = pause(client);
        await waitFor(tickerUp, 'the pause ticker');

        client.emit('key press', ' ', { name: 'space' });
        await waitFor(() => state.done, 'the pause to finish');
        assert.equal(View.getInputFocusView(client), field);

        //  a background draw after the pause puts the cursor in the field
        field.drawInBackground(() => client.term.write('\x1b[2;2Hdrawn'));
        assert.equal(client.track.pos(), `20,${5 + field.cursorPos.col}`);
        assert.equal(client.track.sgr, FIELD_FOCUS_SGR);
    });

    it('is given back on the error path too (a prompt that does not exist)', async function () {
        const client = makeClient();
        const { field } = makeMenuForm(client);
        const state = pause(client, { promptName: 'noSuchPrompt' });
        await waitFor(() => state.done, 'the pause to fail');
        assert.equal(View.getInputFocusView(client), field);
    });

    it('is not given back if the form was torn down during the pause', async function () {
        const client = makeClient();
        const { vc, field } = makeMenuForm(client);
        const state = pause(client);
        await waitFor(tickerUp, 'the pause ticker');

        vc.detachClientEvents();
        assert.equal(field.hasFocus, true, 'the field still says it has focus');
        client.emit('key press', ' ', { name: 'space' });
        await waitFor(() => state.done, 'the pause to finish');
        assert.equal(View.getInputFocusView(client), null, 'not resurrected');
    });

    it('is not given back over a view that took focus during the pause', async function () {
        const client = makeClient();
        makeMenuForm(client);
        const state = pause(client);
        await waitFor(tickerUp, 'the pause ticker');

        const other = new EditTextView({
            client,
            id: 7,
            position: { row: 10, col: 10 },
            dimens: { width: 10 },
            maxLength: 10,
        });
        other.setFocus(true);
        client.emit('key press', ' ', { name: 'space' });
        await waitFor(() => state.done, 'the pause to finish');
        assert.equal(View.getInputFocusView(client), other);
    });

    it('a realtime interrupt (cls, text, pause) with a ticker pause', async function () {
        //  MenuModule.attemptInterruptNow() -> interruptQueue.displayWithItem()
        //  -> currentMenuModule.pausePrompt()
        const client = makeClient();
        const { field } = makeMenuForm(client);

        const mod = Object.create(MenuModule.prototype);
        mod.client = client;
        mod.menuConfig = { config: { pausePrompt: 'pauseTk' } };
        client.currentMenuModule = mod;

        let finished = false;
        UserInterruptQueue.prototype.displayWithItem.call(
            { client },
            { cls: true, text: 'A message from the sysop', pause: true },
            err => {
                assert.ifError(err);
                finished = true;
            }
        );
        await waitFor(tickerUp, 'the pause ticker');
        assert.equal(finished, false, 'paused');

        const n = client.track.all.length;
        fireAll();
        assertTickLeftAtTicker(client.track, client.track.since(n));

        client.emit('key press', ' ', { name: 'space' });
        await waitFor(() => finished, 'the interrupt to finish');
        assert.equal(View.getInputFocusView(client), field);
    });
});
