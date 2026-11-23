'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');

//
//  Page sysop's "send as mail" message is addressed by user ID (the root
//  user), but its To text is shown in the editor, checked by the editor's To
//  validator and kept in the saved mail. It said 'Sysop' unless
//  sysopUserName was configured, which on a board with no account of that
//  name failed the validator ("Failed to find user") as soon as the caller
//  left To. With no sysopUserName it is now the root user's username.
//

const CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
    sysopChat: { pageCooldownMinutes: 5 },
};

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.child = () => client.log;
    client.term = { termWidth: 80, termHeight: 25 };
    client.user = { userId: 42, username: 'caller' };
    client.node = 3;
    return client;
}

describe('page_sysop: "send as mail" To name', () => {
    let previousConfig;
    let User;
    let Message;
    let savedGetUserName;
    let lookups;

    before(() => {
        previousConfig = configModule._pushTestConfig(CONFIG);
        User = require('../core/user.js');
        Message = require('../core/message.js');
        savedGetUserName = User.getUserName;
    });
    after(() => {
        User.getUserName = savedGetUserName;
        configModule._popTestConfig(previousConfig);
    });

    //  the root user's name as the user database would give it
    function stubRootUserName(err, userName) {
        lookups = [];
        User.getUserName = (userId, cb) => {
            lookups.push(userId);
            return setImmediate(cb, err, userName);
        };
    }

    //  Accept the offer ("Yes") and capture where page sysop goes
    function confirmSendMail(menuConfig, cb) {
        const PageSysop = require('../core/page_sysop.js').getModule;
        const client = makeClient();
        const mod = new PageSysop({
            menuName: 'pageSysop',
            menuConfig: { config: menuConfig },
            client,
        });
        mod._pendingMessage = 'are you there?';
        mod.prevMenu = () => assert.fail('declined path taken');
        mod.gotoMenu = (name, options, done) => {
            done(null);
            return cb(name, options.extraArgs);
        };
        mod._confirmSendMail({ value: { confirm: 0 } }, err => assert.ifError(err));
    }

    it("with no sysopUserName, To is the root user's username", done => {
        stubRootUserName(null, 'NuSkooler');
        confirmSendMail({}, (menuName, extraArgs) => {
            assert.deepEqual(lookups, [User.RootUserID]);
            assert.equal(menuName, 'privateMailMenuCreateMessage');
            assert.equal(extraArgs.toUserId, User.RootUserID);

            const msg = extraArgs.message;
            assert.equal(msg.toUserName, 'NuSkooler');
            assert.equal(msg.fromUserName, 'caller');
            assert.equal(msg.subject, 'Page from caller');
            assert.equal(msg.message, 'are you there?');
            assert.equal(msg.areaTag, Message.WellKnownAreaTags.Private);
            assert.equal(
                msg.meta.System[Message.SystemMetaNames.LocalToUserID],
                User.RootUserID
            );
            return done();
        });
    });

    it('a configured sysopUserName wins, and the user database is not asked', done => {
        stubRootUserName(null, 'NuSkooler');
        confirmSendMail({ sysopUserName: 'The Boss' }, (menuName, extraArgs) => {
            assert.deepEqual(lookups, []);
            assert.equal(extraArgs.message.toUserName, 'The Boss');
            assert.equal(extraArgs.toUserId, User.RootUserID);
            return done();
        });
    });

    it("falls back to 'Sysop' when the root user's name cannot be read", done => {
        stubRootUserName(new Error('No matching user ID'));
        confirmSendMail({}, (menuName, extraArgs) => {
            assert.deepEqual(lookups, [User.RootUserID]);
            assert.equal(extraArgs.message.toUserName, 'Sysop');
            assert.equal(extraArgs.toUserId, User.RootUserID);
            return done();
        });
    });
});
