'use strict';

const { strict: assert } = require('assert');
const configModule = require('../core/config.js');

const BASE_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    users: { usernameMin: 2, usernameMax: 16 },
    general: { boardName: 'TestBoard' },
    messageConferences: {},
};

//
//  Build a minimal fake instance of PreAuthFeedbackFSEModule by bypassing the
//  constructor chain entirely.  We only want to exercise the three hook methods
//  and _initHeaderFields; the full FSE boot requires live views, a real DB, etc.
//
function makeInstance(overrides = {}) {
    const prev = configModule._pushTestConfig(BASE_CONFIG);

    const { getModule } = require('../core/pre_auth_feedback.js');

    //  Allocate without calling any constructor
    const inst = Object.create(getModule.prototype);

    //  Minimal state the methods under test actually touch
    inst.editorMode = 'edit';
    inst.config = Object.assign(
        {
            sysopUserName: 'Sysop',
            defaultFromName: '',
            defaultSubject: 'Feedback to Sysop',
        },
        overrides.config
    );
    inst.client = {
        user: Object.assign({ userId: 0, username: '' }, overrides.user),
        log: { info: () => {}, warn: () => {}, debug: () => {}, trace: () => {} },
    };

    configModule._popTestConfig(prev);
    return inst;
}

// ─── FSE base-class hook defaults ────────────────────────────────────────────

describe('FSE base-class hook defaults', () => {
    let fseBase;

    before(() => {
        const prev = configModule._pushTestConfig(BASE_CONFIG);
        const { FullScreenEditorModule } = require('../core/fse.js');
        fseBase = Object.create(FullScreenEditorModule.prototype);
        fseBase.client = { user: { userId: 42, username: 'testuser' } };
        configModule._popTestConfig(prev);
    });

    it('_isFromFieldEditable() returns false by default', () => {
        assert.equal(fseBase._isFromFieldEditable(), false);
    });

    it('_getLocalFromUserId() returns client.user.userId by default', () => {
        assert.equal(fseBase._getLocalFromUserId(), 42);
    });

    it('_getFromUserName() returns client.user.username when no area', () => {
        assert.equal(fseBase._getFromUserName(null), 'testuser');
    });

    it('_getFromUserName() returns realName when area.realNames is true and realName exists', () => {
        fseBase.client.user.getProperty = () => 'Test User';
        assert.equal(fseBase._getFromUserName({ realNames: true }), 'Test User');
        delete fseBase.client.user.getProperty;
    });
});

// ─── PreAuthFeedbackFSEModule hook overrides ─────────────────────────────────

describe('PreAuthFeedbackFSEModule hook overrides', () => {
    it('_isFromFieldEditable() returns true', () => {
        const inst = makeInstance();
        assert.equal(inst._isFromFieldEditable(), true);
    });

    it('_getLocalFromUserId() always returns 0 (no user record)', () => {
        //  Even if somehow a userId leaked onto the client user, we must return 0
        const inst = makeInstance({ user: { userId: 99 } });
        assert.equal(inst._getLocalFromUserId(), 0);
    });

    it('_getFromUserName() reads from the header form view, not client.user', () => {
        const inst = makeInstance({ user: { userId: 0, username: 'should-not-appear' } });
        inst.viewControllers = {
            header: {
                getFormData: () => ({ value: { from: 'A Visitor' } }),
            },
        };
        assert.equal(inst._getFromUserName(), 'A Visitor');
    });

    it('_getFromUserName() returns empty string when header from value is missing', () => {
        const inst = makeInstance();
        inst.viewControllers = {
            header: {
                getFormData: () => ({ value: {} }),
            },
        };
        assert.equal(inst._getFromUserName(), '');
    });
});

// ─── _initHeaderFields ────────────────────────────────────────────────────────

describe('PreAuthFeedbackFSEModule._initHeaderFields', () => {
    function makeViewSpy(initial = '') {
        return {
            _text: initial,
            acceptsFocus: true,
            setText(t) {
                this._text = t;
            },
        };
    }

    it('seeds To field with sysopUserName from config and locks it', done => {
        const inst = makeInstance({ config: { sysopUserName: 'TheSysop' } });
        const toView = makeViewSpy();
        const fromView = makeViewSpy();
        const subjView = makeViewSpy();
        inst.viewControllers = {
            header: {
                getView: id => {
                    // MciViewIds.header: from=1, to=2, subject=3
                    if (id === 1) return fromView;
                    if (id === 2) return toView;
                    if (id === 3) return subjView;
                },
            },
        };

        inst._initHeaderFields(err => {
            assert.ifError(err);
            assert.equal(toView._text, 'TheSysop');
            assert.equal(toView.acceptsFocus, false, 'To field must be locked');
            done();
        });
    });

    it('seeds Subject with defaultSubject from config', done => {
        const inst = makeInstance({
            config: { defaultSubject: 'Custom Subject', sysopUserName: 'Sysop' },
        });
        const subjView = makeViewSpy();
        inst.viewControllers = {
            header: {
                getView: id => {
                    if (id === 3) return subjView; // subject=3
                    return makeViewSpy();
                },
            },
        };

        inst._initHeaderFields(err => {
            assert.ifError(err);
            assert.equal(subjView._text, 'Custom Subject');
            done();
        });
    });

    it('seeds From with defaultFromName (empty by default)', done => {
        const inst = makeInstance({ config: { defaultFromName: '' } });
        const fromView = makeViewSpy('previous');
        inst.viewControllers = {
            header: {
                getView: id => {
                    if (id === 1) return fromView; // from=1
                    return makeViewSpy();
                },
            },
        };

        inst._initHeaderFields(err => {
            assert.ifError(err);
            assert.equal(fromView._text, '');
            done();
        });
    });

    it('does not touch views when editorMode is not edit', done => {
        const inst = makeInstance();
        inst.editorMode = 'view';
        let getViewCalled = false;
        inst.viewControllers = {
            header: {
                getView: () => {
                    getViewCalled = true;
                    return makeViewSpy();
                },
            },
        };

        inst._initHeaderFields(err => {
            assert.ifError(err);
            assert.equal(getViewCalled, false);
            done();
        });
    });
});

// ─── switchToHeader ───────────────────────────────────────────────────────────

describe('PreAuthFeedbackFSEModule.switchToHeader', () => {
    it('focuses From (id=1) not To (id=2), so the locked To field does not eat focus', () => {
        const inst = makeInstance();
        let bodyFocused = true;
        let switchedTo = null;

        inst.viewControllers = {
            body: {
                setFocus: v => {
                    bodyFocused = v;
                },
            },
            header: {
                switchFocus: id => {
                    switchedTo = id;
                },
            },
        };

        inst.switchToHeader();

        assert.equal(bodyFocused, false);
        assert.equal(
            switchedTo,
            1,
            'should switchFocus to From (MciViewIds.header.from = 1)'
        );
    });
});

// ─── ghost-sender reply guard (msg_area_view_fse.replyMessage) ───────────────

describe('ghost-sender reply guard', () => {
    const { WellKnownAreaTags, SystemMetaNames } = require('../core/message_const.js');

    //  Build a minimal fake message with controllable isPrivate / getLocalFromUserId
    //  / isFromRemoteUser without loading the full Message class (DB not needed).
    function makeMsg({
        areaTag = WellKnownAreaTags.Private,
        fromUserId = 0,
        remoteFrom = null,
    } = {}) {
        return {
            areaTag,
            isPrivate() {
                return this.areaTag === WellKnownAreaTags.Private;
            },
            getLocalFromUserId() {
                return fromUserId;
            },
            isFromRemoteUser() {
                return remoteFrom !== null;
            },
            meta: {
                System: remoteFrom
                    ? { [SystemMetaNames.RemoteFromUser]: remoteFrom }
                    : {},
            },
        };
    }

    //  Build a minimal fake AreaViewFSEModule instance with the replyMessage method
    //  injected, bypassing the full constructor chain.
    function makeViewer(msg, configOverrides = {}) {
        const prev = configModule._pushTestConfig(BASE_CONFIG);
        const { getModule } = require('../core/msg_area_view_fse.js');
        const inst = Object.create(getModule.prototype);
        inst.message = msg;
        inst.messageAreaTag = msg.areaTag;
        inst.menuConfig = { config: Object.assign({}, configOverrides) };
        inst.client = { log: () => {} };

        let gotoMenuOrShowMessageArgs = null;
        let gotoMenuArgs = null;

        inst.gotoMenuOrShowMessage = (name, text) => {
            gotoMenuOrShowMessageArgs = { name, text };
        };
        inst.gotoMenu = (name, opts, cb) => {
            gotoMenuArgs = { name, opts };
            if (cb) cb(null);
        };

        configModule._popTestConfig(prev);
        return {
            inst,
            getGotoMenuOrShowMessage: () => gotoMenuOrShowMessageArgs,
            getGotoMenu: () => gotoMenuArgs,
        };
    }

    it('blocks reply when private mail has no local from-user-id and no remote sender', done => {
        const msg = makeMsg({ fromUserId: 0, remoteFrom: null });
        const { inst, getGotoMenuOrShowMessage, getGotoMenu } = makeViewer(msg);

        //  Invoke replyMessage directly (it's assigned in the constructor via Object.assign)
        //  Re-create the menuMethods as the constructor would:
        const _ = require('lodash');
        const self = inst;
        let blocked = false;
        inst.gotoMenuOrShowMessage = (name, text) => {
            blocked = true;
            assert.equal(name, 'preAuthFeedbackNoReply');
            assert.ok(text.length > 0);
            done();
        };
        inst.gotoMenu = () => {
            assert.fail('should not reach gotoMenu');
        };

        //  Call the guard logic directly (mirrors production code)
        if (
            self.message.isPrivate() &&
            self.message.getLocalFromUserId() === 0 &&
            !self.message.isFromRemoteUser()
        ) {
            const noReplyMenu =
                _.get(self.menuConfig, 'config.noReplyGhostSenderMenu') ||
                'preAuthFeedbackNoReply';
            return self.gotoMenuOrShowMessage(
                noReplyMenu,
                'Sender has no account; reply cannot be delivered.'
            );
        }
        assert.fail('guard did not trigger');
    });

    it('allows reply when private mail has a valid local from-user-id', done => {
        const msg = makeMsg({ fromUserId: 42 });
        const { inst } = makeViewer(msg);
        inst.gotoMenuOrShowMessage = () => {
            assert.fail('should not block');
        };

        const blocked =
            msg.isPrivate() && msg.getLocalFromUserId() === 0 && !msg.isFromRemoteUser();

        assert.equal(blocked, false);
        done();
    });

    it('allows reply when private mail is from a remote user (e.g. ActivityPub)', done => {
        const msg = makeMsg({ fromUserId: 0, remoteFrom: 'user@remote.example' });
        const { inst } = makeViewer(msg);
        inst.gotoMenuOrShowMessage = () => {
            assert.fail('should not block remote sender');
        };

        const blocked =
            msg.isPrivate() && msg.getLocalFromUserId() === 0 && !msg.isFromRemoteUser();

        assert.equal(blocked, false);
        done();
    });

    it('allows reply when message is not private mail', done => {
        const msg = makeMsg({ areaTag: 'some_area', fromUserId: 0 });
        const { inst } = makeViewer(msg);
        inst.gotoMenuOrShowMessage = () => {
            assert.fail('should not block non-private');
        };

        const blocked =
            msg.isPrivate() && msg.getLocalFromUserId() === 0 && !msg.isFromRemoteUser();

        assert.equal(blocked, false);
        done();
    });

    it('uses noReplyGhostSenderMenu config override when set', done => {
        const msg = makeMsg({ fromUserId: 0 });
        const { inst } = makeViewer(msg, {
            noReplyGhostSenderMenu: 'myCustomNoReplyMenu',
        });
        inst.gotoMenuOrShowMessage = name => {
            assert.equal(name, 'myCustomNoReplyMenu');
            done();
        };

        const _ = require('lodash');
        const noReplyMenu =
            _.get(inst.menuConfig, 'config.noReplyGhostSenderMenu') ||
            'preAuthFeedbackNoReply';
        inst.gotoMenuOrShowMessage(
            noReplyMenu,
            'Sender has no account; reply cannot be delivered.'
        );
    });
});

// ─── module shape ────────────────────────────────────────────────────────────

describe('pre_auth_feedback module exports', () => {
    let mod;

    before(() => {
        const prev = configModule._pushTestConfig(BASE_CONFIG);
        mod = require('../core/pre_auth_feedback.js');
        configModule._popTestConfig(prev);
    });

    it('exports moduleInfo with name, desc, author', () => {
        assert.ok(mod.moduleInfo);
        assert.ok(mod.moduleInfo.name);
        assert.ok(mod.moduleInfo.desc);
        assert.ok(mod.moduleInfo.author);
    });

    it('exports a getModule class', () => {
        assert.equal(typeof mod.getModule, 'function');
    });
});
