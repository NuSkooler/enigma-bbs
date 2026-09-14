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
