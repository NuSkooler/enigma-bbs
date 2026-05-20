/* jslint node: true */
'use strict';

const { FullScreenEditorModule, MciViewIds } = require('./fse.js');
const { persistMessage } = require('./message_area.js');
const Message = require('./message.js');
const User = require('./user.js');

const async = require('async');

exports.moduleInfo = {
    name: 'Pre-Auth Feedback',
    desc: 'Send feedback to the sysop before logging in',
    author: 'NuSkooler',
};

//
//  Allows an unauthenticated visitor to compose and send a private message
//  to the sysop.  The From name is free-text (not resolved to any user record)
//  so there is no way to impersonate an existing account via this path.
//
exports.getModule = class PreAuthFeedbackFSEModule extends FullScreenEditorModule {
    constructor(options) {
        //  Force private-mail compose mode regardless of menu config
        options.menuConfig = options.menuConfig || {};
        options.menuConfig.config = Object.assign({}, options.menuConfig.config, {
            editorType: 'email',
            editorMode: 'edit',
        });

        super(options);

        this.setConfigWithExtraArgs(options);

        this.editorMode = 'edit';
        this.editorType = 'email';

        //  Always addressed to the sysop (user id 1 / RootUserID)
        this.toUserId = User.RootUserID;
        this.messageAreaTag = Message.WellKnownAreaTags.Private;

        const self = this;

        this.menuMethods.editModeMenuSave = function (formData, extraArgs, cb) {
            let msg;
            async.series(
                [
                    function getMsg(callback) {
                        self.getMessage((err, msgObj) => {
                            msg = msgObj;
                            return callback(err);
                        });
                    },
                    function saveMsg(callback) {
                        return persistMessage(msg, callback);
                    },
                ],
                err => {
                    if (err) {
                        const errView = self.viewControllers.header.getView(
                            MciViewIds.header.errorMsg
                        );
                        if (errView) {
                            errView.setText(err.message);
                        }
                        return cb(err);
                    }

                    self.client.log.info(
                        {
                            fromName: msg.fromUserName,
                            subject: msg.subject,
                            uuid: msg.messageUuid,
                        },
                        'Pre-auth feedback sent to sysop'
                    );

                    return self.nextMenu(cb);
                }
            );
        };
    }

    //  The From field is free-text — the visitor types their name
    _isFromFieldEditable() {
        return true;
    }

    //  No user record exists for a pre-auth sender; leave fromUserId unset
    _getLocalFromUserId() {
        return 0;
    }

    //  Read fromUserName from the header form rather than from client.user
    _getFromUserName() {
        const headerValues = this.viewControllers.header.getFormData().value;
        return headerValues.from || '';
    }

    //  Start focus on From (id=1) rather than the locked To field (id=2)
    switchToHeader() {
        this.viewControllers.body.setFocus(false);
        this.viewControllers.header.switchFocus(MciViewIds.header.from);
    }

    //  Seed the header fields with defaults instead of reading client.user
    _initHeaderFields(cb) {
        if (this.editorMode === 'edit') {
            const fromView = this.viewControllers.header.getView(MciViewIds.header.from);
            if (fromView) {
                fromView.setText(this.config.defaultFromName || '');
            }

            const toView = this.viewControllers.header.getView(MciViewIds.header.to);
            if (toView) {
                const sysopName = this.config.sysopUserName || 'Sysop';
                toView.setText(sysopName);
                toView.acceptsFocus = false;
            }

            const subjView = this.viewControllers.header.getView(
                MciViewIds.header.subject
            );
            if (subjView) {
                subjView.setText(this.config.defaultSubject || 'Feedback to Sysop');
            }
        }
        return cb(null);
    }

    initSequence() {
        //  No ACS or area-write check needed — this path is intentionally open
        super.initSequence();
    }
};
