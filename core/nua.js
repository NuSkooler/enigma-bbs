/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const User = require('./user.js');
const theme = require('./theme.js');
const login = require('./system_menu_method.js').login;
const Config = require('./config.js').get;
const messageArea = require('./message_area.js');
const { getISOTimestampString } = require('./database.js');
const UserProps = require('./user_property.js');

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'NUA',
    desc: 'New User Application',
};

const MciViewIds = {
    userName: 1,
    password: 9,
    confirm: 10,
    errMsg: 11,
};

exports.getModule = class NewUserAppModule extends MenuModule {
    constructor(options) {
        super(options);

        const self = this;

        this.menuMethods = {
            //
            //  Validation stuff
            //
            validatePassConfirmMatch: function (data, cb) {
                const passwordView = self.viewControllers.menu.getView(
                    MciViewIds.password
                );
                return cb(
                    passwordView.getData() === data
                        ? null
                        : new Error('Passwords do not match')
                );
            },

            viewValidationListener: function (err, cb) {
                const errMsgView = self.viewControllers.menu.getView(MciViewIds.errMsg);
                let newFocusId;

                if (err) {
                    errMsgView.setText(err.message);
                    err.view.clearText();

                    if (err.view.getId() === MciViewIds.confirm) {
                        newFocusId = MciViewIds.password;
                        self.viewControllers.menu
                            .getView(MciViewIds.password)
                            .clearText();
                    }
                } else {
                    errMsgView.clearText();
                }

                return cb(newFocusId);
            },

            //
            //  Submit handlers
            //
            submitApplication: function (formData, extraArgs, cb) {
                const newUser = new User();
                const config = Config();

                newUser.username = formData.value.username;

                //
                //  We have to disable ACS checks for initial default areas as the user is not yet ready
                //
                let confTag = messageArea.getDefaultMessageConferenceTag(
                    self.client,
                    true
                ); //  true=disableAcsCheck
                let areaTag = messageArea.getDefaultMessageAreaTagByConfTag(
                    self.client,
                    confTag,
                    true
                ); //  true=disableAcsCheck

                //  can't store undefined!
                confTag = confTag || '';
                areaTag = areaTag || '';

                newUser.properties = {
                    [UserProps.RealName]: formData.value.realName,
                    [UserProps.Birthdate]: getISOTimestampString(
                        formData.value.birthdate
                    ),
                    [UserProps.Sex]: formData.value.sex,
                    [UserProps.Location]: formData.value.location,
                    [UserProps.Affiliations]: formData.value.affils,
                    [UserProps.EmailAddress]: formData.value.email,
                    [UserProps.WebAddress]: formData.value.web,
                    [UserProps.AccountCreated]: getISOTimestampString(),

                    [UserProps.MessageConfTag]: confTag,
                    [UserProps.MessageAreaTag]: areaTag,

                    [UserProps.TermHeight]: self.client.term.termHeight,
                    [UserProps.TermWidth]: self.client.term.termWidth,

                    //  :TODO: Other defaults
                    //  :TODO: should probably have a place to create defaults/etc.
                };

                const defaultTheme = _.get(config, 'theme.default');
                if ('*' === defaultTheme) {
                    newUser.properties[UserProps.ThemeId] = theme.getRandomTheme();
                } else {
                    newUser.properties[UserProps.ThemeId] = defaultTheme;
                }

                //  :TODO: User.create() should validate email uniqueness!
                const createUserInfo = {
                    password: formData.value.password,
                    sessionId: self.client.session.uniqueId, //  used for events/etc.
                };
                newUser.create(createUserInfo, err => {
                    if (err) {
                        self.client.log.warn(
                            { error: err, username: formData.value.username },
                            'New user creation failed'
                        );

                        self.gotoMenu(extraArgs.error, err => {
                            if (err) {
                                return self.prevMenu(cb);
                            }
                            return cb(null);
                        });
                    } else {
                        self.client.log.info(
                            { username: formData.value.username, userId: newUser.userId },
                            `New user "${formData.value.username}" created`
                        );

                        //  Cache SysOp information now
                        //  :TODO: Similar to bbs.js. DRY
                        if (newUser.isSysOp()) {
                            config.general.sysOp = {
                                username: formData.value.username,
                                properties: newUser.properties,
                            };
                        }

                        if (
                            User.AccountStatus.inactive ===
                            self.client.user.properties[UserProps.AccountStatus]
                        ) {
                            return self.gotoMenu(extraArgs.inactive, cb);
                        } else {
                            //
                            //  If active now, we need to call login() to authenticate
                            //
                            return login(self, formData, extraArgs, cb);
                        }
                    }
                });
            },
        };
    }

    mciReady(mciData, cb) {
        return this.standardMCIReadyHandler(mciData, cb);
    }
};
