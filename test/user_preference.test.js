'use strict';

//  User preferences (#447): @systemMethod:setUserPreference, the
//  user_pref_select module, the PV round trip and the pref__ guard.

const { strict: assert } = require('assert');

const acsParser = require('../core/acs_parser.js');
const ACS = require('../core/acs.js');
const UserProps = require('../core/user_property.js');
const UserPreference = require('../core/user_preference.js');
const SystemMenuMethod = require('../core/system_menu_method.js');
const UserPrefSelect = require('../core/user_pref_select.js');
const { VerticalMenuView } = require('../core/vertical_menu_view.js');
const { TableView } = require('../core/table_view.js');

//
//  A user with the persist API's shape: persistProperty() / removeProperty()
//  update the live properties as the real ones do, and record what reached
//  the database.
//
function makeUser(props = {}, groups = ['users']) {
    return {
        userId: 7,
        groups,
        properties: Object.assign({}, props),
        writes: [],
        isGroupMember(names) {
            names = Array.isArray(names) ? names : [names];
            return names.some(n => this.groups.includes(n));
        },
        getProperty(name) {
            return this.properties[name];
        },
        persistProperty(name, value, cb) {
            this.properties[name] = value;
            this.writes.push({ op: 'set', name, value });
            return cb(null, value);
        },
        removeProperty(name, cb) {
            delete this.properties[name];
            this.writes.push({ op: 'remove', name });
            return cb(null);
        },
    };
}

function makeLog() {
    const log = { warnings: [] };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        log[level] = () => {};
    });
    log.warn = (obj, msg) => log.warnings.push({ obj, msg });
    return log;
}

function makeClient(user) {
    const client = {
        user,
        log: makeLog(),
        term: {
            termWidth: 80,
            termHeight: 25,
            outputEncoding: 'cp437',
            termType: 'ansi',
            write: () => {},
            rawWrite: () => {},
        },
        session: { isSecure: false },
        node: 1,
        isLocal: () => false,
    };
    client.acs = new ACS({ client, user });
    return client;
}

function pv(user, acs) {
    return acsParser.parse(acs, { subject: { client: makeClient(user), user } });
}

//  A menu the system method runs on, recording where it went next
function makeCallingMenu(user) {
    const menu = {
        client: makeClient(user),
        went: null,
        prevMenu(cb) {
            menu.went = { prev: true };
            return cb(null);
        },
        gotoMenu(name, options, cb) {
            if (!cb && 'function' === typeof options) {
                cb = options;
            }
            menu.went = { goto: name };
            return cb(null);
        },
    };
    return menu;
}

//  formData that fails the test if anything reads it
const untouchableFormData = new Proxy(
    {},
    {
        get(target, prop) {
            throw new Error(`formData.${String(prop)} was read`);
        },
        has(target, prop) {
            throw new Error(`formData has "${String(prop)}" was checked`);
        },
    }
);

function setPref(menu, extraArgs, formData = untouchableFormData) {
    return new Promise(resolve => {
        SystemMenuMethod.setUserPreference(menu, formData, extraArgs, err =>
            resolve(err)
        );
    });
}

describe('User preferences (#447)', function () {
    describe('pref__ is reserved', () => {
        it('no UserProps value starts with pref__', () => {
            const taken = Object.entries(UserProps).filter(
                ([, v]) => 'string' === typeof v && v.startsWith('pref__')
            );
            assert.deepEqual(taken, [], 'pref__ is reserved for user preferences');
        });

        it('every UserProps value is refused as a preference name', () => {
            Object.values(UserProps).forEach(v => {
                assert.equal(UserPreference.isValidPrefName(v), false, v);
            });
        });
    });

    describe('@systemMethod:setUserPreference', () => {
        it('persists a valid preference and goes back to the previous menu', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            const err = await setPref(menu, {
                pref: 'pref__msg_reader',
                value: 'lampboard',
            });

            assert.equal(err, null);
            assert.deepEqual(user.writes, [
                { op: 'set', name: 'pref__msg_reader', value: 'lampboard' },
            ]);
            assert.deepEqual(menu.went, { prev: true });
            assert.equal(menu.client.log.warnings.length, 0);
        });

        it('goes to the menu named by next', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            await setPref(menu, {
                pref: 'pref__msg_reader',
                value: 'classic',
                next: 'mainMenu',
            });
            assert.deepEqual(menu.went, { goto: 'mainMenu' });
        });

        it('accepts every character PV can test', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            const err = await setPref(menu, { pref: 'pref__A-z_0+9', value: 'Xy-_+09' });
            assert.equal(err, null);
            assert.equal(user.properties['pref__A-z_0+9'], 'Xy-_+09');
        });

        it('stores a number or boolean value as text', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            await setPref(menu, { pref: 'pref__style', value: 2 });
            await setPref(menu, { pref: 'pref__flag', value: true });
            assert.equal(user.properties.pref__style, '2');
            assert.equal(user.properties.pref__flag, 'true');
        });

        it('null clears the preference', async () => {
            const user = makeUser({ pref__msg_reader: 'lampboard' });
            const menu = makeCallingMenu(user);
            const err = await setPref(menu, { pref: 'pref__msg_reader', value: null });

            assert.equal(err, null);
            assert.deepEqual(user.writes, [{ op: 'remove', name: 'pref__msg_reader' }]);
            assert.equal(user.properties.pref__msg_reader, undefined);
            assert.deepEqual(menu.went, { prev: true });
        });

        const badPrefs = [
            ['a core property', 'account_status'],
            ['the bare prefix', 'pref__'],
            ['a single underscore', 'pref_reader'],
            ['a dot', 'pref__msg.reader'],
            ['a colon', 'pref__msg:reader'],
            ['a space', 'pref__msg reader'],
            ['a missing name', undefined],
            ['a number', 42],
        ];
        badPrefs.forEach(([what, pref]) => {
            it(`refuses ${what} as the name, with a warning and no write`, async () => {
                const user = makeUser();
                const menu = makeCallingMenu(user);
                const err = await setPref(menu, { pref, value: 'x' });

                assert.ok(err, 'refused');
                assert.deepEqual(user.writes, []);
                assert.equal(menu.went, null, 'stays on the menu');
                assert.equal(menu.client.log.warnings.length, 1);
            });
        });

        const badValues = [
            ['a dot', 'v1.2'],
            ['a colon', 'a:b'],
            ['a space', 'a b'],
            ['a comma', 'a,b'],
            ['a bracket', 'a]'],
            ['an empty string', ''],
            ['a missing value', undefined],
            ['an object', { x: 1 }],
            ['a fraction', 1.5],
        ];
        badValues.forEach(([what, value]) => {
            it(`refuses ${what} as the value, with a warning and no write`, async () => {
                const user = makeUser();
                const menu = makeCallingMenu(user);
                const err = await setPref(menu, { pref: 'pref__msg_reader', value });

                assert.ok(err, 'refused');
                assert.deepEqual(user.writes, []);
                assert.equal(menu.went, null);
                assert.equal(menu.client.log.warnings.length, 1);
            });
        });

        it('never reads formData', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            const err = await setPref(menu, { pref: 'pref__msg_reader', value: 'x' });
            assert.equal(err, null);
        });

        it('ignores a pref and value submitted in formData', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            const err = await setPref(
                menu,
                {},
                {
                    value: { pref: 'pref__msg_reader', value: 'x' },
                    pref: 'pref__msg_reader',
                }
            );
            assert.ok(err, 'refused: nothing in extraArgs');
            assert.deepEqual(user.writes, []);
        });

        it('refuses when extraArgs is missing', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            const err = await setPref(menu, undefined);
            assert.ok(err);
            assert.deepEqual(user.writes, []);
        });
    });

    describe('PV round trip', () => {
        it('PV matches a preference set by the system method, and not once cleared', async () => {
            const user = makeUser();
            const menu = makeCallingMenu(user);
            const acs = 'PV[pref__msg_reader,lampboard]';

            assert.equal(pv(user, acs), false, 'unset matches nothing');

            await setPref(menu, { pref: 'pref__msg_reader', value: 'lampboard' });
            assert.equal(pv(user, acs), true);
            assert.equal(pv(user, 'PV[pref__msg_reader,classic]'), false);

            await setPref(menu, { pref: 'pref__msg_reader', value: null });
            assert.equal(pv(user, acs), false);
        });

        it('PV matches a number value written as text', async () => {
            const user = makeUser();
            await setPref(makeCallingMenu(user), { pref: 'pref__style', value: 2 });
            assert.equal(pv(user, 'PV[pref__style,2]'), true);
        });

        it('the routing array picks the board default once the preference is cleared', async () => {
            const user = makeUser();
            const client = makeClient(user);
            const routing = [
                { acs: 'PV[pref__msg_reader,lampboard]', action: '@menu:lampboardMain' },
                { action: '@menu:mainMenuGlobalNewScan' },
            ];

            assert.equal(
                client.acs.getConditionalValue(routing, 'action'),
                '@menu:mainMenuGlobalNewScan'
            );
            await setPref(makeCallingMenu(user), {
                pref: 'pref__msg_reader',
                value: 'lampboard',
            });
            assert.equal(
                client.acs.getConditionalValue(routing, 'action'),
                '@menu:lampboardMain'
            );
        });
    });

    describe('user_pref_select', () => {
        //  a stand-in for a TL view: what it was last given
        function makeTextView() {
            return {
                text: undefined,
                setText(t) {
                    this.text = t;
                },
                getData() {
                    return this.text;
                },
                redraw() {},
            };
        }

        function makeListView(kind) {
            const client = makeClient(makeUser());
            const opts = {
                client,
                id: 1,
                position: { row: 1, col: 1 },
                dimens: { width: 40, height: 6 },
            };
            const view = 'TV' === kind ? new TableView(opts) : new VerticalMenuView(opts);
            view.redraws = 0;
            const redraw = view.redraw.bind(view);
            view.redraw = () => {
                ++view.redraws;
                return redraw();
            };
            return view;
        }

        const Choices = [
            {
                value: 'classic',
                text: 'Classic new scan',
                desc: 'One message after another',
            },
            {
                value: 'lampboard',
                text: 'Index reader',
                desc: 'A table of areas',
                acs: 'GM[users]',
            },
            { value: 'sysop-only', text: 'Op reader', desc: 'Ops', acs: 'GM[sysops]' },
        ];

        function makeModule({ config = {}, user = makeUser(), kind = 'VM' } = {}) {
            const client = makeClient(user);
            const mod = new UserPrefSelect.getModule({
                menuName: 'userPrefSelectReader',
                menuConfig: {
                    config: Object.assign(
                        {
                            pref: 'pref__msg_reader',
                            choices: Choices,
                            mainInfoFormat10: '{currentName}|{name}|{pref}',
                        },
                        config
                    ),
                },
                client,
            });

            const views = {
                1: makeListView(kind),
                2: makeTextView(),
                10: makeTextView(),
            };
            views[1].redraw(); //  drawn before any key, as in real life
            mod.viewControllers.main = {
                getView: id => views[id],
                getFocusedView: () => views[1],
            };
            mod.views = views;
            mod.user = user;
            return mod;
        }

        function init(mod) {
            return new Promise((resolve, reject) =>
                mod._initChoiceList(err => (err ? reject(err) : resolve()))
            );
        }

        function select(mod) {
            return new Promise(resolve =>
                mod.menuMethods.select(untouchableFormData, {}, err => resolve(err))
            );
        }

        const names = mod => mod.items.map(i => i.name);

        ['VM', 'TV'].forEach(kind => {
            describe(`on a ${kind}1`, () => {
                it('lists the board default and the choices the caller passes acs for', async () => {
                    const mod = makeModule({ kind });
                    await init(mod);
                    assert.deepEqual(names(mod), [
                        '(board default)',
                        'Classic new scan',
                        'Index reader',
                    ]);
                    assert.equal(mod.views[1].items.length, 3);
                });

                it('marks the board default as current while the preference is unset', async () => {
                    const mod = makeModule({ kind });
                    await init(mod);
                    assert.deepEqual(
                        mod.items.map(i => i.currentIndicator),
                        ['*', ' ', ' ']
                    );
                    assert.equal(mod.items[0].text, '* (board default)');
                    assert.equal(mod.items[1].text, '  Classic new scan');
                });

                it('marks the stored choice and starts on it', async () => {
                    const mod = makeModule({
                        kind,
                        user: makeUser({ pref__msg_reader: 'lampboard' }),
                    });
                    await init(mod);
                    assert.deepEqual(
                        mod.items.map(i => i.isCurrent),
                        [false, false, true]
                    );
                    assert.equal(mod.views[1].focusedItemIndex, 2);
                    assert.equal(mod.views[2].text, 'A table of areas', 'TL2 desc');
                    assert.equal(
                        mod.views[10].text,
                        'Index reader|Index reader|pref__msg_reader'
                    );
                });

                it('persists the focused choice and redraws with the new mark', async () => {
                    const mod = makeModule({ kind });
                    await init(mod);
                    mod.views[1].setFocusItemIndex(1);
                    const redraws = mod.views[1].redraws;

                    assert.equal(await select(mod), null);
                    assert.deepEqual(mod.user.writes, [
                        { op: 'set', name: 'pref__msg_reader', value: 'classic' },
                    ]);
                    assert.ok(mod.views[1].redraws > redraws, 'redrawn');
                    assert.equal(mod.views[1].focusedItemIndex, 1, 'focus stays');
                    assert.deepEqual(
                        mod.views[1].items.map(i => i.currentIndicator),
                        [' ', '*', ' ']
                    );
                    assert.equal(pv(mod.user, 'PV[pref__msg_reader,classic]'), true);
                    assert.equal(mod.views[10].text.split('|')[0], 'Classic new scan');
                });

                it('the board default clears the preference', async () => {
                    const user = makeUser({ pref__msg_reader: 'lampboard' });
                    const mod = makeModule({ kind, user });
                    await init(mod);
                    mod.views[1].setFocusItemIndex(0);

                    await select(mod);
                    assert.deepEqual(user.writes, [
                        { op: 'remove', name: 'pref__msg_reader' },
                    ]);
                    assert.equal(pv(user, 'PV[pref__msg_reader,lampboard]'), false);
                    assert.equal(mod.items[0].isCurrent, true);
                });
            });
        });

        it('shows a preference no longer offered as the board default', async () => {
            const mod = makeModule({
                user: makeUser({ pref__msg_reader: 'sysop-only' }),
            });
            await init(mod);
            assert.equal(mod.items[0].isCurrent, true);
        });

        it('offers a choice to callers its acs passes', async () => {
            const mod = makeModule({ user: makeUser({}, ['users', 'sysops']) });
            await init(mod);
            assert.ok(names(mod).includes('Op reader'));
        });

        it('takes indicator and default texts from config', async () => {
            const mod = makeModule({
                config: {
                    currentIndicator: '>',
                    notCurrentIndicator: '-',
                    defaultText: 'Whatever the board uses',
                    defaultDesc: 'The sysop picks',
                },
            });
            await init(mod);
            assert.equal(mod.items[0].text, '> Whatever the board uses');
            assert.equal(mod.items[1].currentIndicator, '-');
            assert.equal(mod.views[2].text, 'The sysop picks');
        });

        it('skips choices with bad values, with one warning', async () => {
            const mod = makeModule({
                config: {
                    choices: [
                        { value: 'ok', text: 'OK' },
                        { value: 'has.dot', text: 'Bad 1' },
                        { value: 'has space', text: 'Bad 2' },
                        { value: null, text: 'Bad 3' },
                        { text: 'Bad 4' },
                        'not an object',
                        { value: 3, text: 'Three' },
                    ],
                },
            });
            await init(mod);
            assert.deepEqual(names(mod), ['(board default)', 'OK', 'Three']);
            assert.equal(mod.items[2].value, '3');
            assert.equal(mod.client.log.warnings.length, 1);
        });

        it('refuses to load with a pref outside pref__', async () => {
            const mod = makeModule({ config: { pref: 'theme_id' } });
            await assert.rejects(init(mod), /pref/);
            assert.deepEqual(mod.user.writes, []);
        });

        it('refuses to load without its list view', async () => {
            const mod = makeModule();
            mod.viewControllers.main.getView = () => undefined;
            await assert.rejects(init(mod), /MCI 1/);
        });

        it('Esc / Q (done) goes back', done => {
            const mod = makeModule();
            mod.prevMenu = cb => cb(null, 'went back');
            mod.menuMethods.done({}, {}, (err, how) => {
                assert.equal(how, 'went back');
                done();
            });
        });
    });
});
