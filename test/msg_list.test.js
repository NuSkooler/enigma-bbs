'use strict';

const { strict: assert } = require('assert');

const MessageListModule = require('../core/msg_list.js').getModule;

//  VM1, the message list view every list menu focuses; see MciViewIds in
//  core/msg_list.js
const MSG_LIST_VIEW = 1;

//
//  The module is built through its real constructor -- it needs no menu stack
//  and no database until a method runs -- and |gotoMenu| is replaced so the
//  test sees where a post would have gone.
//
function makeList(config = {}) {
    const mod = new MessageListModule({
        menuName: 'messageBaseMessageList',
        menuConfig: { config },
        client: {
            log: { error: () => {}, info: () => {} },
            user: { userId: 1 },
        },
    });

    mod.went = null;
    mod.gotoMenu = (name, options, cb) => {
        mod.went = { name, options };
        return cb(null);
    };

    return mod;
}

const keyPress = messageIndex => ({
    submitId: MSG_LIST_VIEW,
    value: { messageIndex },
});

describe('msg_list: posting from a list', () => {
    //
    //  A personal or search list spans areas, so the area has to come from the
    //  message under the cursor rather than from whatever area the caller
    //  happens to be in.
    //
    it('posts into the area of the focused message', done => {
        const mod = makeList({
            messageAreaTag: 'general',
            messageList: [
                { areaTag: 'general', messageId: 1 },
                { areaTag: 'fsx_general', messageId: 2 },
            ],
        });

        mod.menuMethods.postNewMessage(keyPress(1), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.went.name, 'messageBaseNewPost');
            assert.equal(mod.went.options.extraArgs.messageAreaTag, 'fsx_general');
            done();
        });
    });

    //
    //  menu_stack snapshots |initialFocusIndex| through getSaveState() when a
    //  menu is entered and feeds it back on the way out, which is how the
    //  list restores the caller's row. selectMessage sets it for the same
    //  reason; without it, returning from a post lands on the first unread.
    //
    it('remembers the row so the list comes back where it was', done => {
        const mod = makeList({
            messageAreaTag: 'general',
            messageList: [
                { areaTag: 'general', messageId: 1 },
                { areaTag: 'general', messageId: 2 },
                { areaTag: 'general', messageId: 3 },
            ],
        });

        mod.menuMethods.postNewMessage(keyPress(2), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.initialFocusIndex, 2);
            assert.deepEqual(mod.getSaveState(), { initialFocusIndex: 2 });
            done();
        });
    });

    //  nothing to remember, and nothing to restore onto
    it('leaves the remembered row alone when the list is empty', done => {
        const mod = makeList({ messageAreaTag: 'general', messageList: [] });

        mod.menuMethods.postNewMessage(keyPress(0), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.initialFocusIndex, undefined);
            done();
        });
    });

    it('falls back to the menu area when the list is empty', done => {
        const mod = makeList({ messageAreaTag: 'general', messageList: [] });

        mod.menuMethods.postNewMessage(keyPress(0), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.went.options.extraArgs.messageAreaTag, 'general');
            done();
        });
    });

    //  a list entry carrying no area of its own belongs to the menu's area
    it('falls back to the menu area for an entry without one', done => {
        const mod = makeList({
            messageAreaTag: 'general',
            messageList: [{ messageId: 1 }],
        });

        mod.menuMethods.postNewMessage(keyPress(0), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.went.options.extraArgs.messageAreaTag, 'general');
            done();
        });
    });

    //  the same key pressed while another view holds focus is not a post
    it('ignores a submission from another view', done => {
        const mod = makeList({
            messageAreaTag: 'general',
            messageList: [{ areaTag: 'general', messageId: 1 }],
        });

        mod.menuMethods.postNewMessage(
            { submitId: 2, value: { messageIndex: 0 } },
            {},
            err => {
                assert.equal(err, null);
                assert.equal(mod.went, null, 'no menu was entered');
                done();
            }
        );
    });

    it('honours a menu that names its own post menu', done => {
        const mod = makeList({
            messageAreaTag: 'general',
            messageList: [{ areaTag: 'general', messageId: 1 }],
            menuNewPost: 'myOwnPostMenu',
        });

        mod.menuMethods.postNewMessage(keyPress(0), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.went.name, 'myOwnPostMenu');
            done();
        });
    });
});

describe('msg_list: the focused row', () => {
    const list = () =>
        makeList({
            messageAreaTag: 'general',
            messageList: [
                { areaTag: 'general', messageId: 1 },
                { areaTag: 'fsx_general', messageId: 2 },
            ],
        });

    //  older menus submit the index as 'message' rather than 'messageIndex'
    it('reads the deprecated message member when messageIndex is absent', done => {
        const mod = list();

        mod.menuMethods.postNewMessage(
            { submitId: MSG_LIST_VIEW, value: { message: 1 } },
            {},
            err => {
                assert.equal(err, null);
                assert.equal(mod.went.options.extraArgs.messageAreaTag, 'fsx_general');
                done();
            }
        );
    });

    it('does not prompt to delete when another view holds focus', done => {
        const mod = list();
        mod.promptDeleteMessageConfirm = () => assert.fail('no delete prompt');

        mod.menuMethods.deleteSelected(
            { submitId: 2, value: { messageIndex: 0 } },
            {},
            err => {
                assert.equal(err, null);
                done();
            }
        );
    });

    it('prompts to delete the focused message', done => {
        const mod = list();
        mod.promptDeleteMessageConfirm = (messageIndex, cb) => {
            assert.equal(messageIndex, 1);
            return cb(null);
        };

        mod.menuMethods.deleteSelected(keyPress(1), {}, done);
    });

    //
    //  focusedMessageIndex() signals "another view held focus" with null, but
    //  a menu naming neither member gets undefined back, and the callers test
    //  with "null ===" so that such a menu keeps working. Pinned here because
    //  the distinction is invisible at a glance: "== null" would turn these
    //  menus into no-ops.
    //
    it('still acts on a submission that names no index at all', done => {
        const mod = list();

        mod.menuMethods.postNewMessage(
            { submitId: MSG_LIST_VIEW, value: {} },
            {},
            err => {
                assert.equal(err, null);
                assert.equal(mod.went.name, 'messageBaseNewPost');
                //  nothing selected, so the menu's own area
                assert.equal(mod.went.options.extraArgs.messageAreaTag, 'general');
                done();
            }
        );
    });

    //  and the other half of it: 0 is a row, not the absence of one
    it('treats the first row as a selection', done => {
        const mod = list();

        mod.menuMethods.postNewMessage(keyPress(0), {}, err => {
            assert.equal(err, null);
            assert.equal(mod.went.options.extraArgs.messageAreaTag, 'general');
            assert.equal(mod.initialFocusIndex, 0);
            done();
        });
    });

    it('prompts to delete the first row', done => {
        const mod = list();
        let prompted = false;
        mod.promptDeleteMessageConfirm = (messageIndex, cb) => {
            prompted = true;
            assert.equal(messageIndex, 0);
            return cb(null);
        };

        mod.menuMethods.deleteSelected(keyPress(0), {}, err => {
            assert.equal(err, null);
            assert.ok(prompted, 'expected a delete prompt for index 0');
            done();
        });
    });
});

describe('msg_list: first unread navigation', () => {
    function navigationList(messages, lastReadId = 20, focusedIndex = 0) {
        const mod = makeList({ messageAreaTag: 'general', messageList: messages });
        mod.lastReadId = lastReadId;
        const view = {
            focusedItemIndex: focusedIndex,
            setFocusItemIndex(index) {
                this.focusedItemIndex = index;
            },
        };
        mod.viewControllers.allViews = { getView: () => view };
        mod.populateCustomLabelsForSelected = index => {
            mod.labelIndex = index;
        };
        return { mod, view };
    }

    const messages = () => [10, 20, 30, 40, 50].map(messageId => ({ messageId }));

    function navigate(mod, method, cb) {
        mod.menuMethods[method](keyPress(0), {}, cb);
    }

    it('jumps back to the first unread after the restored focus changes', done => {
        const { mod, view } = navigationList(messages(), 20, 4);
        mod.restoreSavedState({ initialFocusIndex: 4 });
        navigate(mod, 'jumpToFirstUnread', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 2);
            assert.equal(mod.labelIndex, 2);
            assert.equal(mod.initialFocusIndex, 4);
            done();
        });
    });

    it('honours explicit unread flags in a list spanning areas', done => {
        const { mod, view } = navigationList(
            [
                { messageId: 100, isNew: false },
                { messageId: 5, isNew: true },
                { messageId: 200, isNew: true },
            ],
            0,
            2
        );
        navigate(mod, 'jumpToFirstUnread', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 1);
            done();
        });
    });

    it('can jump to unread index zero', done => {
        const { mod, view } = navigationList(messages(), 0, 4);
        navigate(mod, 'jumpToFirstUnread', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 0);
            done();
        });
    });

    it('does nothing when all messages are read', done => {
        const { mod, view } = navigationList(messages(), 50, 3);
        navigate(mod, 'jumpToFirstUnread', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 3);
            assert.equal(mod.labelIndex, undefined);
            done();
        });
    });

    it('does nothing for an empty list', done => {
        const { mod, view } = navigationList([], 0);
        view.setFocusItemIndex = () => assert.fail('empty list must not move focus');
        navigate(mod, 'jumpToFirstUnread', done);
    });

    it('does not change the list when another view holds focus', done => {
        const { mod, view } = navigationList(messages(), 20, 4);
        mod.menuMethods.jumpToFirstUnread({ submitId: 2, value: {} }, {}, err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 4);
            done();
        });
    });

    it('finds the unread row after earlier entries are removed', done => {
        const { mod, view } = navigationList(messages(), 20, 3);
        mod.config.messageList.splice(0, 1);
        navigate(mod, 'jumpToFirstUnread', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 1);
            done();
        });
    });

    it('does not jump to messages after marking the area read', done => {
        const messageArea = require('../core/message_area');
        const original = messageArea.updateMessageAreaLastReadId;
        const { mod, view } = navigationList(
            [
                { areaTag: 'general', messageId: 30, isNew: true },
                { areaTag: 'general', messageId: 40, isNew: true },
            ],
            20,
            1
        );
        mod.menuConfig.config = {};
        view.setItems = () => {};
        view.redraw = () => {};
        messageArea.updateMessageAreaLastReadId = (_user, _area, _id, cb) => cb(null);
        mod.markAllMessagesAsRead(err => {
            messageArea.updateMessageAreaLastReadId = original;
            assert.ifError(err);
            navigate(mod, 'jumpToFirstUnread', err2 => {
                assert.ifError(err2);
                assert.equal(view.focusedItemIndex, 1);
                done();
            });
        });
    });

    it('Home stops at the first unread before reaching the top', done => {
        const { mod, view } = navigationList(messages(), 20, 4);
        navigate(mod, 'messageListHome', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 2);
            navigate(mod, 'messageListHome', err2 => {
                assert.ifError(err2);
                assert.equal(view.focusedItemIndex, 0);
                done();
            });
        });
    });

    it('End stops at the first unread before reaching the bottom', done => {
        const { mod, view } = navigationList(messages(), 20, 0);
        navigate(mod, 'messageListEnd', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 2);
            navigate(mod, 'messageListEnd', err2 => {
                assert.ifError(err2);
                assert.equal(view.focusedItemIndex, 4);
                done();
            });
        });
    });

    it('Home and End reach the extremes when there are no unread messages', done => {
        const { mod, view } = navigationList(messages(), 50, 3);
        navigate(mod, 'messageListHome', err => {
            assert.ifError(err);
            assert.equal(view.focusedItemIndex, 0);
            navigate(mod, 'messageListEnd', err2 => {
                assert.ifError(err2);
                assert.equal(view.focusedItemIndex, 4);
                done();
            });
        });
    });
});

describe('msg_list: shipped keyboard bindings', () => {
    const fs = require('fs');
    const paths = require('path');
    const hjson = require('hjson');
    const ConfigLoader = require('../core/config_loader');
    const { ViewController } = require('../core/view_controller');
    const { VerticalMenuView } = require('../core/vertical_menu_view');
    const readTemplate = name =>
        hjson.parse(
            fs
                .readFileSync(
                    paths.join(__dirname, '../misc/menu_templates', `${name}.in.hjson`),
                    'utf8'
                )
                .replace(/%INCLUDE_FILES%/g, '')
        );
    const menus = new ConfigLoader({ hotReload: false })._resolveAtSpecs(
        require('lodash').defaultsDeep(readTemplate('main'), readTemplate('message_base'))
    ).menus;

    for (const name of [
        'messageBaseMessageList',
        'messageBaseMyMessagesList',
        'messageBaseSearchResultsMessageList',
    ]) {
        it(`${name} dispatches U and Home/End through the real view controller`, () => {
            const mod = makeList({
                messageList: [10, 20, 30, 40, 50].map(messageId => ({
                    messageId,
                    text: String(messageId),
                })),
            });
            mod.lastReadId = 20;
            const client = Object.assign(
                new (require('events').EventEmitter)(),
                mod.client
            );
            mod.client = client;
            client.log.trace = () => {};
            client.log.warn = err => assert.fail(JSON.stringify(err));
            client.currentMenuModule = mod;
            client.term = { termWidth: 80, termHeight: 25, write() {}, rawWrite() {} };
            const view = new VerticalMenuView({
                client,
                id: 1,
                position: { row: 1, col: 1 },
                dimens: { width: 40, height: 5 },
            });
            view.setItems(mod.config.messageList);
            view.submitArgName = 'messageIndex';
            view.setFocusItemIndex(4);
            const vc = new ViewController({ client });
            vc.addView(view);
            vc.focusedView = view;
            mod.viewControllers.allViews = vc;
            mod.populateCustomLabelsForSelected = index => {
                mod.labelIndex = index;
            };
            vc.mapActionKeys(menus[name].form[0].actionKeys, 'form');

            for (const [key, expected] of [
                ['u', 2],
                ['home', 0],
                ['end', 2],
                ['end', 4],
                ['shift + u', 2],
            ]) {
                vc.clientKeyPressHandler(null, { name: key });
                assert.equal(view.focusedItemIndex, expected, key);
                assert.equal(mod.labelIndex, expected, 'selection labels follow focus');
                assert.equal(vc.focusedView, view, 'keyboard focus remains on the list');
            }
        });
    }

    for (const name of ['MSGLIST.ANS', 'MYMSGLST.ANS', 'MSRCHLST.ANS']) {
        it(`${name} tells the caller about the unread shortcut`, () => {
            const bytes = fs.readFileSync(
                paths.join(__dirname, '../art/themes/luciano_blocktronics', name)
            );
            const text = bytes
                .subarray(0, bytes.indexOf(0x1a))
                .toString('latin1')
                .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
            assert.match(text, /U:unread/);
        });
    }
});
