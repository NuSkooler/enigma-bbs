'use strict';

//
//  F4: a view placed by config `position` in prompt art lands where an art
//  marker at that spot would. A prompt drawn at a position moves its art's
//  markers there (theme.displayThemedPrompt()); config positions count from
//  the same place.
//

const { strict: assert } = require('assert');
const events = require('events');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const UserProps = require('../core/user_property.js');

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

async function waitFor(cond, what) {
    for (let i = 0; i < 500 && !cond(); ++i) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(cond(), `timed out waiting for ${what}`);
}

describe('views placed by config in prompt art (F4)', function () {
    let tmp;
    let prevConfig;
    let theme;
    let ViewController;
    let ClientTerminal;

    before(function () {
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-prompt-place-'));
        const themeDir = paths.join(tmp, 'themes', 'test_theme');
        fs.mkdirSync(themeDir, { recursive: true });
        fs.mkdirSync(paths.join(tmp, 'general'), { recursive: true });
        //  one line: a marker at column 3, and room for a placed view
        fs.writeFileSync(paths.join(themeDir, 'PLACEPR.ans'), 'X %TL1        Y');

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
        ({ ViewController } = require('../core/view_controller.js'));
        ({ ClientTerminal } = require('../core/client_term.js'));
    });

    after(function () {
        configModule._popTestConfig(prevConfig);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function makeClient() {
        const client = new events.EventEmitter();
        client.log = quietLog;
        const term = new ClientTerminal({
            writable: true,
            write: (data, cb) => cb && cb(null),
        });
        term.outputEncoding = 'cp437';
        term.termWidth = 80;
        term.termHeight = 25;
        client.term = term;
        client.user = {
            properties: { [UserProps.ThemeId]: 'test_theme' },
            isAuthenticated: () => false,
        };
        client.currentTheme = {
            info: { themeId: 'test_theme' },
            menus: {},
            prompts: {
                placed: {
                    art: 'PLACEPR',
                    config: { trailingLF: 'no' },
                    mci: {
                        TL1: { text: 'm' },
                        TL50: { position: { row: 1, col: 10 }, text: 'p' },
                    },
                },
            },
        };
        client.currentMenuModule = {
            menuName: 'testMenu',
            menuConfig: {},
            menuMethods: {},
        };
        return client;
    }

    async function showPrompt(position) {
        const client = makeClient();
        const vc = new ViewController({ client });
        let done = false;
        theme.displayThemedPrompt(
            'placed',
            client,
            { viewController: vc, position },
            err => {
                assert.ifError(err);
                done = true;
            }
        );
        await waitFor(() => done, 'the prompt');
        return vc;
    }

    it('drawn at the top left: positions are screen positions', async function () {
        const vc = await showPrompt(undefined);
        assert.deepEqual(vc.getView(1).position, { row: 1, col: 3 });
        assert.deepEqual(vc.getView(50).position, { row: 1, col: 10 });
        vc.destroy();
    });

    it('drawn at a position: placed views move with the markers', async function () {
        const vc = await showPrompt({ row: 20, col: 10 });
        //  the marker at art column 3 is moved 10 right, as always
        assert.deepEqual(vc.getView(1).position, { row: 20, col: 13 });
        //  and so is the view placed at art column 10
        assert.deepEqual(vc.getView(50).position, { row: 20, col: 20 });
        vc.destroy();
    });
});
