'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { ViewController } = require('../core/view_controller.js');

//
//  A ViewController needs nothing but a client to build its key map; the
//  views themselves are not involved. The client has to be an EventEmitter --
//  the constructor subscribes to its key presses.
//
function makeClient(menuConfig) {
    const warnings = [];

    const log = {
        warn: (obj, msg) => warnings.push({ obj, msg }),
    };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        log[level] = () => {};
    });

    const client = new events.EventEmitter();
    client.log = log;
    client.currentMenuModule = { menuName: 'someMenu', menuConfig: menuConfig || {} };

    //  everything drawing-related is a no-op here
    client.term = new Proxy(
        { termHeight: 25, termWidth: 80, termType: 'ansi' },
        { get: (t, p) => (p in t ? t[p] : () => {}) }
    );

    return { client, warnings };
}

function makeController() {
    const { client, warnings } = makeClient();
    return { vc: new ViewController({ client }), warnings };
}

describe('ViewController: mapping actionKeys', () => {
    it('binds every key an entry names', () => {
        const { vc, warnings } = makeController();

        vc.mapActionKeys(
            [
                { keys: ['escape', 'q'], action: '@systemMethod:prevMenu' },
                { keys: ['p'], action: '@method:postNewMessage' },
            ],
            'form'
        );

        assert.equal(vc.actionKeyMap['escape'].action, '@systemMethod:prevMenu');
        assert.equal(vc.actionKeyMap['q'].action, '@systemMethod:prevMenu');
        assert.equal(vc.actionKeyMap['p'].action, '@method:postNewMessage');
        assert.deepEqual(warnings, []);
    });

    //
    //  The case this is really about. ConfigLoader leaves an "@reference:"
    //  that does not resolve in place as a string, so it arrives here looking
    //  like this -- and before, it was dropped without a word, which reads to
    //  the operator as a key that has stopped working for no reason.
    //
    it('reports an unresolved @reference rather than dropping it quietly', () => {
        const { vc, warnings } = makeController();

        vc.mapActionKeys(['@reference:common.quitToPrevEntry'], 'form');

        assert.deepEqual(vc.actionKeyMap, {});
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].obj.entry, '@reference:common.quitToPrevEntry');
        assert.equal(warnings[0].obj.menu, 'someMenu');
        assert.equal(warnings[0].obj.index, 0);
        assert.match(warnings[0].msg, /binds nothing/);
    });

    it('names the form or prompt it came from', () => {
        const { vc, warnings } = makeController();

        vc.mapActionKeys(['@reference:nope'], 'prompt');

        assert.match(warnings[0].msg, /prompt actionKeys/);
    });

    //  an entry with no "keys" at all is just as inert
    it('reports an entry that names no keys', () => {
        const { vc, warnings } = makeController();

        vc.mapActionKeys([{ action: '@method:somethingUseful' }], 'form');

        assert.deepEqual(vc.actionKeyMap, {});
        assert.equal(warnings.length, 1);
    });

    //  "actionKeys: [ ]" with a stray comma is enough to produce one of these
    it('survives a null entry', () => {
        const { vc, warnings } = makeController();

        assert.doesNotThrow(() => vc.mapActionKeys([null], 'form'));
        assert.equal(warnings.length, 1);
    });

    //
    //  One bad entry should cost you that entry, not the whole menu.
    //
    it('still binds the good entries around a bad one', () => {
        const { vc, warnings } = makeController();

        vc.mapActionKeys(
            [
                { keys: ['escape'], action: '@systemMethod:prevMenu' },
                '@reference:common.nope',
                { keys: ['d'], action: '@method:addToDownloadQueue' },
            ],
            'form'
        );

        assert.equal(vc.actionKeyMap['escape'].action, '@systemMethod:prevMenu');
        assert.equal(vc.actionKeyMap['d'].action, '@method:addToDownloadQueue');
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].obj.index, 1);
    });
});

//
//  The above drive mapActionKeys directly. These go through the two callers,
//  so that the mapping is known to still be reached from a menu and from a
//  prompt rather than only to work when called by hand.
//
describe('ViewController: actionKeys through the real load path', () => {
    const actionKeys = [
        { keys: ['escape', 'q'], action: '@systemMethod:prevMenu' },
        '@reference:common.doesNotResolve',
        { keys: ['p'], action: '@method:postNewMessage' },
    ];

    it('loadFromMenuConfig binds the menu form keys', done => {
        const { client, warnings } = makeClient({
            form: { 0: { mci: {}, actionKeys } },
        });
        const vc = new ViewController({ client });

        vc.loadFromMenuConfig({ mciMap: {} }, err => {
            assert.equal(err, null);
            assert.deepEqual(Object.keys(vc.actionKeyMap).sort(), ['escape', 'p', 'q']);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0].msg, /form actionKeys/);
            done();
        });
    });

    it('loadFromPromptConfig binds the prompt keys', done => {
        const { client, warnings } = makeClient();
        const vc = new ViewController({ client });

        vc.loadFromPromptConfig({ mciMap: {}, config: { mci: {}, actionKeys } }, err => {
            assert.equal(err, null);
            assert.deepEqual(Object.keys(vc.actionKeyMap).sort(), ['escape', 'p', 'q']);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0].msg, /prompt actionKeys/);
            done();
        });
    });
});
