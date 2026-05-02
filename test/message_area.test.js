'use strict';

const { strict: assert } = require('assert');

//
//  Config mock — must be in place before requiring message_area, which reads
//  Config().messageConferences via the Config.get binding installed in setup.js.
//
const configModule = require('../core/config.js');

//  A small fixture that exercises:
//   - a normal conference with one regular area
//   - a conference flagged hideFromBrowse: true with one area
//   - a normal conference with one area flagged hideFromBrowse: true
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    messageConferences: {
        normal_conf: {
            name: 'Normal',
            desc: 'Regular conference',
            areas: {
                regular_area: { name: 'Regular', desc: 'A regular area' },
                hidden_area: {
                    name: 'Hidden Area',
                    desc: 'Hidden via area-level hideFromBrowse',
                    hideFromBrowse: true,
                },
            },
        },
        hidden_conf: {
            name: 'Hidden Conf',
            desc: 'Hidden via conf-level hideFromBrowse',
            hideFromBrowse: true,
            areas: {
                some_area: { name: 'Some Area', desc: 'Lives inside a hidden conf' },
            },
        },
    },
};

//  No client is supplied — pass { noClient: true } to bypass the assertion.
//  ACS checks are skipped in that mode, so we test purely the hide-by-flag
//  behavior here without dragging in a full client/ACS stack.
//
//  All tests in this file go inside one wrapping describe so the
//  configModule.get override is scoped to THIS suite's hooks. Top-level
//  before()/after() in mocha are *root* hooks that wrap every test in every
//  file, which would clobber the configs other test files install per-test.
let messageArea;
let previousGet;

describe('message_area — hideFromBrowse', function () {
    before(() => {
        previousGet = configModule.get;
        configModule.get = () => TEST_CONFIG;
        //  message_area.js looks up configModule.get lazily on each call,
        //  so a fresh require isn't necessary; the cache state doesn't
        //  matter. (The earlier capture-at-load-time pattern required a
        //  cache delete here.)
        messageArea = require('../core/message_area.js');
    });
    after(() => {
        configModule.get = previousGet;
    });

    // ─── getAvailableMessageConferences — hideFromBrowse ─────────────────────

    describe('getAvailableMessageConferences()', function () {
        it('omits hideFromBrowse confs by default', () => {
            const confs = messageArea.getAvailableMessageConferences(null, {
                noClient: true,
            });
            assert.ok('normal_conf' in confs, 'normal conf must be present');
            assert.ok(!('hidden_conf' in confs), 'hidden_conf must be omitted');
        });

        it('includes hideFromBrowse confs when includeHidden=true', () => {
            const confs = messageArea.getAvailableMessageConferences(null, {
                noClient: true,
                includeHidden: true,
            });
            assert.ok('normal_conf' in confs);
            assert.ok('hidden_conf' in confs);
        });

        it('still omits SystemInternal regardless of includeHidden', () => {
            //  SystemInternal is filtered by a separate gate; includeHidden
            //  must not re-enable system_internal.
            const previousConfig = TEST_CONFIG.messageConferences;
            TEST_CONFIG.messageConferences = Object.assign({}, previousConfig, {
                system_internal: { name: 'sys', areas: {} },
            });
            try {
                const confs = messageArea.getAvailableMessageConferences(null, {
                    noClient: true,
                    includeHidden: true,
                });
                assert.ok(!('system_internal' in confs));
            } finally {
                TEST_CONFIG.messageConferences = previousConfig;
            }
        });
    });

    // ─── getAvailableMessageAreasByConfTag — hideFromBrowse ─────────────────

    describe('getAvailableMessageAreasByConfTag()', function () {
        it('omits hideFromBrowse areas by default (no client)', () => {
            const areas = messageArea.getAvailableMessageAreasByConfTag('normal_conf');
            assert.ok('regular_area' in areas);
            assert.ok(!('hidden_area' in areas));
        });

        it('includes hideFromBrowse areas when includeHidden=true (no client)', () => {
            const areas = messageArea.getAvailableMessageAreasByConfTag('normal_conf', {
                includeHidden: true,
            });
            assert.ok('regular_area' in areas);
            assert.ok('hidden_area' in areas);
        });

        it('omits hideFromBrowse areas under noAcsCheck=true by default', () => {
            const fakeClient = { acs: { hasMessageAreaRead: () => true } };
            const areas = messageArea.getAvailableMessageAreasByConfTag('normal_conf', {
                client: fakeClient,
                noAcsCheck: true,
            });
            assert.ok('regular_area' in areas);
            assert.ok(!('hidden_area' in areas));
        });

        it('includes hideFromBrowse areas under noAcsCheck + includeHidden', () => {
            const fakeClient = { acs: { hasMessageAreaRead: () => true } };
            const areas = messageArea.getAvailableMessageAreasByConfTag('normal_conf', {
                client: fakeClient,
                noAcsCheck: true,
                includeHidden: true,
            });
            assert.ok('regular_area' in areas);
            assert.ok('hidden_area' in areas);
        });

        it('omits hideFromBrowse areas during ACS check by default', () => {
            const fakeClient = { acs: { hasMessageAreaRead: () => true } };
            const areas = messageArea.getAvailableMessageAreasByConfTag('normal_conf', {
                client: fakeClient,
            });
            assert.ok('regular_area' in areas);
            assert.ok(!('hidden_area' in areas));
        });

        it('includes hideFromBrowse areas during ACS check with includeHidden', () => {
            const fakeClient = { acs: { hasMessageAreaRead: () => true } };
            const areas = messageArea.getAvailableMessageAreasByConfTag('normal_conf', {
                client: fakeClient,
                includeHidden: true,
            });
            assert.ok('regular_area' in areas);
            assert.ok('hidden_area' in areas);
        });
    });
});
