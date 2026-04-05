'use strict';

const { strict: assert } = require('assert');

//
//  sys_event_user_log.js requires events.js (which needs logger, etc.) at
//  load time.  Patch Module._load to intercept only requires that originate
//  from the module under test.
//
const Module = require('module');
const _originalLoad = Module._load;

//  Minimal system-event names — only what the module dispatches on.
const SYSTEM_EVENTS = {
    NewUser: 'codes.l33t.enigma.system.user_new',
    UserLogin: 'codes.l33t.enigma.system.user_login',
    UserLogoff: 'codes.l33t.enigma.system.user_logoff',
    UserUpload: 'codes.l33t.enigma.system.user_upload',
    UserDownload: 'codes.l33t.enigma.system.user_download',
    UserPostMessage: 'codes.l33t.enigma.system.user_post_message',
    UserSendMail: 'codes.l33t.enigma.system.user_send_mail',
    UserRunDoor: 'codes.l33t.enigma.system.user_run_door',
    UserSendNodeMsg: 'codes.l33t.enigma.system.user_send_node_msg',
    UserAchievementEarned: 'codes.l33t.enigma.system.user_achievement_earned',
};

//  Captured handler — set when addMultipleEventListener is called.
let capturedHandler = null;

const STUBS = {
    './events.js': {
        getSystemEvents: () => SYSTEM_EVENTS,
        addMultipleEventListener: (_events, listener) => {
            capturedHandler = listener;
        },
    },
    './user_log_name.js': {
        NewUser: 'new_user',
        Login: 'login',
        Logoff: 'logoff',
        UlFiles: 'ul_files',
        UlFileBytes: 'ul_file_bytes',
        DlFiles: 'dl_files',
        DlFileBytes: 'dl_file_bytes',
        PostMessage: 'post_message',
        SendMail: 'send_mail',
        RunDoor: 'run_door',
        RunDoorMinutes: 'run_door_minutes',
        SendNodeMsg: 'send_node_msg',
        AchievementEarned: 'achievement_earned',
        AchievementPointsEarned: 'achievement_points_earned',
    },
    './system_property.js': {
        NewUsersTodayCount: 'new_users_today_count',
    },
};

Module._load = function (request, parent, isMain) {
    const fromModule =
        parent && parent.filename && parent.filename.includes('sys_event_user_log');
    if (fromModule && Object.prototype.hasOwnProperty.call(STUBS, request)) {
        return STUBS[request];
    }
    return _originalLoad(request, parent, isMain);
};

const systemEventUserLogInit = require('../core/sys_event_user_log.js');

//  Restore after load.
Module._load = _originalLoad;

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeUser(id = 1) {
    return { userId: id, username: `user${id}` };
}

function makeStatLog(overrides = {}) {
    return Object.assign(
        {
            appendUserLogEntry: () => {},
            incrementUserStat: () => {},
            incrementNonPersistentSystemStat: () => {},
        },
        overrides
    );
}

//  Fire an event through the captured multi-listener.
function fire(eventName, eventPayload) {
    assert.ok(capturedHandler, 'handler must be registered before firing events');
    capturedHandler(eventPayload, eventName);
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('systemEventUserLogInit()', function () {
    describe('handler registration', function () {
        it('registers a multi-event listener on init', () => {
            capturedHandler = null;
            const statLog = makeStatLog();
            systemEventUserLogInit(statLog);
            assert.ok(
                capturedHandler,
                'addMultipleEventListener should have been called'
            );
        });
    });

    describe('UserSendMail event', function () {
        it('calls incrementUserStat with MailSentCount and 1', () => {
            const user = makeUser();
            const calls = [];
            const statLog = makeStatLog({
                incrementUserStat: (u, statName, by) => calls.push({ u, statName, by }),
            });

            capturedHandler = null;
            systemEventUserLogInit(statLog);

            fire(SYSTEM_EVENTS.UserSendMail, { user });

            const UserProps = require('../core/user_property.js');
            assert.ok(
                calls.some(
                    c =>
                        c.u === user &&
                        c.statName === UserProps.MailSentCount &&
                        c.by === 1
                ),
                'incrementUserStat must be called with MailSentCount, 1'
            );
        });

        it('also calls appendUserLogEntry for the mail event', () => {
            const user = makeUser();
            const appended = [];
            const statLog = makeStatLog({
                appendUserLogEntry: (u, name, val) => appended.push({ u, name, val }),
                incrementUserStat: () => {},
            });

            capturedHandler = null;
            systemEventUserLogInit(statLog);

            fire(SYSTEM_EVENTS.UserSendMail, { user });

            assert.ok(
                appended.some(a => a.u === user && a.name === 'send_mail'),
                'appendUserLogEntry should be called with send_mail log name'
            );
        });
    });

    describe('UserSendNodeMsg event', function () {
        it('calls incrementUserStat with NodeMsgSentCount and 1 (direct)', () => {
            const user = makeUser();
            const calls = [];
            const statLog = makeStatLog({
                incrementUserStat: (u, statName, by) => calls.push({ u, statName, by }),
            });

            capturedHandler = null;
            systemEventUserLogInit(statLog);

            fire(SYSTEM_EVENTS.UserSendNodeMsg, { user, global: false });

            const UserProps = require('../core/user_property.js');
            assert.ok(
                calls.some(
                    c =>
                        c.u === user &&
                        c.statName === UserProps.NodeMsgSentCount &&
                        c.by === 1
                ),
                'incrementUserStat must be called with NodeMsgSentCount, 1 for direct messages'
            );
        });

        it('calls incrementUserStat with NodeMsgSentCount and 1 (global)', () => {
            const user = makeUser();
            const calls = [];
            const statLog = makeStatLog({
                incrementUserStat: (u, statName, by) => calls.push({ u, statName, by }),
            });

            capturedHandler = null;
            systemEventUserLogInit(statLog);

            fire(SYSTEM_EVENTS.UserSendNodeMsg, { user, global: true });

            const UserProps = require('../core/user_property.js');
            assert.ok(
                calls.some(
                    c =>
                        c.u === user &&
                        c.statName === UserProps.NodeMsgSentCount &&
                        c.by === 1
                ),
                'incrementUserStat must be called with NodeMsgSentCount, 1 for global messages'
            );
        });

        it('appends "direct" for non-global messages', () => {
            const user = makeUser();
            const appended = [];
            const statLog = makeStatLog({
                appendUserLogEntry: (u, name, val) => appended.push({ u, name, val }),
                incrementUserStat: () => {},
            });

            capturedHandler = null;
            systemEventUserLogInit(statLog);

            fire(SYSTEM_EVENTS.UserSendNodeMsg, { user, global: false });

            assert.ok(
                appended.some(
                    a => a.u === user && a.name === 'send_node_msg' && a.val === 'direct'
                ),
                'should append "direct" for non-global node messages'
            );
        });

        it('appends "global" for global messages', () => {
            const user = makeUser();
            const appended = [];
            const statLog = makeStatLog({
                appendUserLogEntry: (u, name, val) => appended.push({ u, name, val }),
                incrementUserStat: () => {},
            });

            capturedHandler = null;
            systemEventUserLogInit(statLog);

            fire(SYSTEM_EVENTS.UserSendNodeMsg, { user, global: true });

            assert.ok(
                appended.some(
                    a => a.u === user && a.name === 'send_node_msg' && a.val === 'global'
                ),
                'should append "global" for global node messages'
            );
        });
    });

    describe('unhandled event', function () {
        it('does not throw for unknown event names', () => {
            const statLog = makeStatLog();
            capturedHandler = null;
            systemEventUserLogInit(statLog);
            assert.doesNotThrow(() => {
                fire('codes.l33t.enigma.system.unknown_event', { user: makeUser() });
            });
        });
    });
});
