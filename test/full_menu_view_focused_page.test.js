'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { ViewController } = require('../core/view_controller.js');

//
//  FullMenuView: the page drawn when the layout is rebuilt (a focus change
//  rebuilds it) is the one that holds the focused item. The focused item
//  used to be put one page past the end when it was the last item, which
//  drew nothing and stuck the view, and on the page before its own when its
//  column had moved to a new page.
//

const BASE_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
    theme: { default: 'luciano_blocktronics' },
    paths: { themes: '/nonexistent/themes', art: '/nonexistent/art' },
    term: { cp437TermList: [], utf8TermList: [] },
};

const ITEMS = [
    'General',
    'Retro computing',
    'Amiga',
    'Door games',
    'FidoNet echoes',
    'Coding',
    'Art scene',
    'Tracker music',
    'Hardware',
    'Buy and sell',
    'Off topic',
    'Sysops only',
];

function makeClient(menuConfig) {
    const client = new events.EventEmitter();
    client.log = { warns: [] };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.warn = (obj, msg) => client.log.warns.push({ obj, msg });
    client.term = { termWidth: 80, termHeight: 25, out: '' };
    client.term.write = s => {
        client.term.out += Buffer.isBuffer(s) ? s.toString('latin1') : String(s);
    };
    client.term.rawWrite = client.term.write;
    client.term.beginWrite = () => {};
    client.term.commitWrite = () => {};
    client.currentMenuModule = { menuName: 'testMenu', menuConfig, menuMethods: {} };
    return client;
}

function mci(code, id, row, col) {
    return { code, id, position: [row, col], args: [], SGR: '\x1b[0;37m' };
}

//  FM1 (12 items, 4 per column) and a VM2 to move focus to; |width| 68 is
//  one page of three columns, 30 is three pages of one column each
function load(width) {
    const client = makeClient({
        form: {
            0: {
                mci: {
                    FM1: {
                        focus: true,
                        width,
                        height: 4,
                        itemHorizSpacing: 3,
                        items: ITEMS,
                    },
                    VM2: { width: 10, height: 2, items: ['one', 'two'] },
                },
            },
        },
    });
    const vc = new ViewController({ client });
    vc.loadFromMenuConfig(
        { mciMap: { FM1: mci('FM', 1, 5, 6), VM2: mci('VM', 2, 16, 6) } },
        err => assert.ifError(err)
    );
    return { client, vc, fm: vc.getView(1) };
}

const press = (client, name, ch = '') => client.emit('key press', ch, { name });

describe('FullMenuView focused page', function () {
    let previousConfig;
    const vcs = [];

    before(function () {
        previousConfig = configModule._pushTestConfig(BASE_CONFIG);
    });

    after(function () {
        configModule._popTestConfig(previousConfig);
    });

    afterEach(function () {
        vcs.splice(0).forEach(vc => vc.detachClientEvents());
    });

    function setup(width) {
        const loaded = load(width);
        vcs.push(loaded.vc);
        return loaded;
    }

    it('one page, the last item focused: a focus change redraws it, and keys still work', function () {
        const { client, fm } = setup(68);
        assert.equal(fm.pages.length, 1);

        press(client, 'end');
        assert.equal(fm.focusedItemIndex, 11);

        client.term.out = '';
        press(client, 'tab', '\t');
        assert.equal(fm.currentPage, 0);
        assert.match(client.term.out, /Sysops only/);
        assert.match(client.term.out, /General/);

        press(client, 'tab', '\t');
        client.term.out = '';
        press(client, 'up arrow');
        assert.equal(fm.focusedItemIndex, 10);
        assert.match(client.term.out, /Off topic/);
        assert.deepEqual(client.log.warns, []);
    });

    it('several pages: a focus change redraws the page that holds the focused item', function () {
        const { client, fm } = setup(30);
        assert.deepEqual(
            fm.pages.map(page => [page.start, page.end]),
            [
                [0, 3],
                [4, 7],
                [8, 11],
            ]
        );

        //  item 9: the third page, not the last item of its column
        press(client, 'right arrow');
        press(client, 'right arrow');
        press(client, 'down arrow');
        assert.equal(fm.focusedItemIndex, 9);

        client.term.out = '';
        press(client, 'tab', '\t');
        assert.equal(fm.currentPage, 2);
        assert.match(client.term.out, /Buy and sell/);
        assert.doesNotMatch(client.term.out, /Tracker music/);
        assert.deepEqual(client.log.warns, []);
    });

    it('several pages, the last item focused: a focus change redraws the last page', function () {
        const { client, fm } = setup(30);

        press(client, 'end');
        assert.equal(fm.focusedItemIndex, 11);

        client.term.out = '';
        press(client, 'tab', '\t');
        assert.equal(fm.currentPage, 2);
        assert.match(client.term.out, /Sysops only/);

        press(client, 'tab', '\t');
        press(client, 'home');
        assert.equal(fm.focusedItemIndex, 0);
        assert.equal(fm.currentPage, 0);
        assert.deepEqual(client.log.warns, []);
    });

    it('the first page still comes up for the first item', function () {
        const { client, fm } = setup(30);

        client.term.out = '';
        press(client, 'tab', '\t');
        assert.equal(fm.currentPage, 0);
        assert.match(client.term.out, /General/);
        assert.doesNotMatch(client.term.out, /Hardware/);
        assert.deepEqual(client.log.warns, []);
    });
});
