/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const theme = require('./theme.js');
const sysValidate = require('./system_view_validate.js');
const UserProps = require('./user_property.js');
const { getISOTimestampString } = require('./database.js');

//  deps
const async = require('async');
const assert = require('assert');
const _ = require('lodash');
const moment = require('moment');

exports.moduleInfo = {
    name: 'User Configuration',
    desc: 'Module for user configuration',
    author: 'NuSkooler',
};

const MciCodeIds = {
    RealName: 1,
    BirthDate: 2,
    Sex: 3,
    Loc: 4,
    Affils: 5,
    Email: 6,
    Web: 7,
    TermHeight: 8,
    Theme: 9,
    Password: 10,
    PassConfirm: 11,
    ThemeInfo: 20,
    ErrorMsg: 21,

    SaveCancel: 25,
};

exports.getModule = class UserConfigModule extends MenuModule {
    constructor(options) {
        super(options);

        const self = this;

        this.menuMethods = {
            //
            //  Validation support
            //
            validateEmailAvail: function (data, cb) {
                //
                //  If nothing changed, we know it's OK
                //
                if (
                    self.client.user.properties[UserProps.EmailAddress].toLowerCase() ===
                    data.toLowerCase()
                ) {
                    return cb(null);
                }

                //  Otherwise we can use the standard system method
                return sysValidate.validateEmailAvail(data, cb);
            },

            validatePassword: function (data, cb) {
                //
                //  Blank is OK - this means we won't be changing it
                //
                if (!data || 0 === data.length) {
                    return cb(null);
                }

                //  Otherwise we can use the standard system method
                return sysValidate.validatePasswordSpec(data, cb);
            },

            validatePassConfirmMatch: function (data, cb) {
                var passwordView = self.getMenuView(MciCodeIds.Password);
                cb(
                    passwordView.getData() === data
                        ? null
                        : new Error('Passwords do not match')
                );
            },

            viewValidationListener: function (err, cb) {
                var errMsgView = self.getMenuView(MciCodeIds.ErrorMsg);
                var newFocusId;
                if (errMsgView) {
                    if (err) {
                        errMsgView.setText(err.message);

                        if (err.view.getId() === MciCodeIds.PassConfirm) {
                            newFocusId = MciCodeIds.Password;
                            var passwordView = self.getMenuView(MciCodeIds.Password);
                            passwordView.clearText();
                            err.view.clearText();
                        }
                    } else {
                        errMsgView.clearText();
                    }
                }
                cb(newFocusId);
            },

            //
            //  Handlers
            //
            saveChanges: function (formData, extraArgs, cb) {
                assert(formData.value.password === formData.value.passwordConfirm);

                const newProperties = {
                    [UserProps.RealName]: formData.value.realName,
                    [UserProps.Birthdate]: getISOTimestampString(
                        formData.value.birthdate
                    ),
                    [UserProps.Sex]: formData.value.sex,
                    [UserProps.Location]: formData.value.location,
                    [UserProps.Affiliations]: formData.value.affils,
                    [UserProps.EmailAddress]: formData.value.email,
                    [UserProps.WebAddress]: formData.value.web,
                    [UserProps.TermHeight]: formData.value.termHeight.toString(),
                    [UserProps.ThemeId]:
                        self.availThemeInfo[formData.value.theme].themeId,
                };

                //  runtime set theme
                theme.setClientTheme(self.client, newProperties.theme_id);

                //  persist all changes
                self.client.user.persistProperties(newProperties, err => {
                    if (err) {
                        self.client.log.warn(
                            { error: err.toString() },
                            'Failed persisting updated properties'
                        );
                        //  :TODO: warn end user!
                        return self.prevMenu(cb);
                    }
                    //
                    //  New password if it's not empty
                    //
                    self.client.log.info('User updated properties');

                    if (formData.value.password.length > 0) {
                        self.client.user.setNewAuthCredentials(
                            formData.value.password,
                            err => {
                                if (err) {
                                    self.client.log.error(
                                        { err: err },
                                        'Failed storing new authentication credentials'
                                    );
                                } else {
                                    self.client.log.info(
                                        'User changed authentication credentials'
                                    );
                                }
                                return self.prevMenu(cb);
                            }
                        );
                    } else {
                        return self.prevMenu(cb);
                    }
                });
            },
        };
    }

    getMenuView(viewId) {
        return this.viewControllers.menu.getView(viewId);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = (self.viewControllers.menu = new ViewController({
                client: self.client,
            }));
            let currentThemeIdIndex = 0;

            async.series(
                [
                    function loadFromConfig(callback) {
                        vc.loadFromMenuConfig(
                            { callingMenu: self, mciMap: mciData.menu },
                            callback
                        );
                    },
                    function prepareAvailableThemes(callback) {
                        self.availThemeInfo = _.sortBy(
                            [...theme.getAvailableThemes()].map(entry => {
                                const theme = entry[1].get();
                                return {
                                    themeId: theme.info.themeId,
                                    name: theme.info.name,
                                    author: theme.info.author,
                                    desc: _.isString(theme.info.desc)
                                        ? theme.info.desc
                                        : '',
                                    group: _.isString(theme.info.group)
                                        ? theme.info.group
                                        : '',
                                };
                            }),
                            'name'
                        );

                        currentThemeIdIndex = Math.max(
                            0,
                            _.findIndex(self.availThemeInfo, function cmp(ti) {
                                return (
                                    ti.themeId ===
                                    self.client.user.properties[UserProps.ThemeId]
                                );
                            })
                        );

                        callback(null);
                    },
                    function populateViews(callback) {
                        const user = self.client.user;

                        self.setViewText(
                            'menu',
                            MciCodeIds.RealName,
                            user.properties[UserProps.RealName]
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.BirthDate,
                            moment(user.properties[UserProps.Birthdate]).format(
                                'YYYYMMDD'
                            )
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.Sex,
                            user.properties[UserProps.Sex]
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.Loc,
                            user.properties[UserProps.Location]
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.Affils,
                            user.properties[UserProps.Affiliations]
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.Email,
                            user.properties[UserProps.EmailAddress]
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.Web,
                            user.properties[UserProps.WebAddress]
                        );
                        self.setViewText(
                            'menu',
                            MciCodeIds.TermHeight,
                            user.properties[UserProps.TermHeight].toString()
                        );

                        var themeView = self.getMenuView(MciCodeIds.Theme);
                        if (themeView) {
                            themeView.setItems(_.map(self.availThemeInfo, 'name'));
                            themeView.setFocusItemIndex(currentThemeIdIndex);
                        }

                        var realNameView = self.getMenuView(MciCodeIds.RealName);
                        if (realNameView) {
                            realNameView.setFocus(true); //  :TODO: HACK! menu.hjson sets focus, but manual population above breaks this. Needs a real fix!
                        }

                        callback(null);
                    },
                ],
                function complete(err) {
                    if (err) {
                        self.client.log.warn(
                            { error: err.toString() },
                            'User configuration failed to init'
                        );
                        self.prevMenu();
                    } else {
                        cb(null);
                    }
                }
            );
        });
    }
};
