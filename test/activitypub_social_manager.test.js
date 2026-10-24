'use strict';

const { strict: assert } = require('assert');

//  Regression tests for #832: ESC did not back out of the ActivityPub Social
//  Manager. Space on an empty Following list never called back, so
//  ViewController.waitActionCompletion stayed set and dropped every later key.

const configModule = require('../core/config.js');

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
};

const log = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
};

const SPACE = { key: { name: 'space' } };

function makeManager({ items = [], focusIndex = 0, getModule } = {}) {
    const previous = configModule._pushTestConfig(TEST_CONFIG);
    try {
        const SocialManager =
            getModule || require('../core/activitypub/social_manager.js').getModule;

        const client = {
            log,
            user: {},
            currentTheme: { prompts: {} },
            on: () => {},
            removeListener: () => {},
        };
        const mgr = new SocialManager({
            menuName: 'activityPubSocialManager',
            menuConfig: { config: {} },
            client,
        });
        client.currentMenuModule = mgr;

        mgr.followingActors = items;
        const listView = {
            getFocusItemIndex: () => focusIndex,
            setItems: () => {},
            redraw: () => {},
        };
        mgr.getView = (_form, id) => (id === 1 ? listView : null);
        return { mgr, client };
    } finally {
        configModule._popTestConfig(previous);
    }
}

describe('ActivityPub Social Manager', () => {
    describe('Space on the Following list', () => {
        it('calls back when nothing is selected (empty list)', done => {
            const { mgr } = makeManager();
            mgr.menuMethods.actorListKeyPressed(SPACE, {}, err => {
                assert.equal(err, null);
                done();
            });
        });

        it('clears waitActionCompletion so later keys (ESC) are not dropped', done => {
            const { ViewController } = require('../core/view_controller.js');
            const { mgr, client } = makeManager();
            const vc = new ViewController({ client });

            const action = { action: '@method:actorListKeyPressed' };
            vc.handleActionWrapper(SPACE, action, () => {
                assert.equal(vc.waitActionCompletion, false);

                //  a follow-up action (e.g. ESC) must actually run
                let ran = false;
                mgr.menuMethods.escLike = (_f, _e, cb) => {
                    ran = true;
                    return cb(null);
                };
                vc.handleActionWrapper(SPACE, { action: '@method:escLike' }, () => {
                    assert.ok(ran, 'follow-up action was silently dropped');
                    done();
                });
            });
        });

        it('still calls back when toggling a selected actor fails', done => {
            const { mgr } = makeManager({
                items: [{ id: 'https://example.com/u/a', status: true }],
            });
            mgr._followingActorToggled = (_info, cb) => cb(new Error('boom'));
            mgr._updateSelectedActorInfo = () => {};
            mgr.menuMethods.actorListKeyPressed(SPACE, {}, err => {
                assert.equal(err, null);
                done();
            });
        });
    });

    describe('empty selection in other collections', () => {
        const cases = [
            ['Followers', 'delete'],
            ['FollowRequests', 'space'],
            ['FollowRequests', 'delete'],
        ];
        for (const [collection, key] of cases) {
            it(`calls back for ${key} on an empty ${collection} list`, done => {
                const { Collections } = require('../core/activitypub/const.js');
                const { mgr } = makeManager();
                mgr.currentCollection = Collections[collection];
                mgr.followerActors = [];
                mgr.followRequests = [];
                mgr.menuMethods.actorListKeyPressed({ key: { name: key } }, {}, err => {
                    assert.equal(err, null);
                    done();
                });
            });
        }
    });

    describe('initSequence', () => {
        it('logs the error and leaves via prevMenu() if setup fails', () => {
            //  getServer() has no registry hook, so load a private copy of the
            //  module against a stubbed listening_server, then restore the cache.
            const lsPath = require.resolve('../core/listening_server.js');
            const smPath = require.resolve('../core/activitypub/social_manager.js');
            const savedLsExports = require.cache[lsPath].exports;
            const savedSm = require.cache[smPath];

            let getModule;
            try {
                require.cache[lsPath].exports = {
                    getServer: () => ({ instance: {} }),
                };
                delete require.cache[smPath];
                getModule = require(smPath).getModule;
            } finally {
                require.cache[lsPath].exports = savedLsExports;
                if (savedSm) {
                    require.cache[smPath] = savedSm;
                } else {
                    delete require.cache[smPath];
                }
            }

            //  the stub must not leak into later requires
            assert.equal(require('../core/listening_server.js'), savedLsExports);
            assert.equal(
                typeof require('../core/listening_server.js').startup,
                'function'
            );

            const { mgr, client } = makeManager({ getModule });
            const logged = [];
            client.log = Object.assign({}, log, {
                error: (...a) => logged.push(a),
            });

            let left = 0;
            let finished = 0;
            mgr.prevMenu = () => ++left;
            mgr.finishedLoading = () => ++finished;
            mgr.beforeArt = cb => cb(null);
            mgr._displayMainPage = cb => cb(new Error('db exploded'));

            mgr.initSequence();

            assert.equal(left, 1);
            assert.equal(finished, 0);
            assert.equal(logged.length, 1);
        });
    });
});
