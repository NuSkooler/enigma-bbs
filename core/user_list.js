/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { getUserList } = require('./user.js');
const { Errors } = require('./enig_error.js');
const UserProps = require('./user_property.js');

//  deps
const moment = require('moment');
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'User List',
    desc: 'Lists all system users',
    author: 'NuSkooler',
};

const MciViewIds = {
    userList: 1,
};

exports.getModule = class UserListModule extends MenuModule {
    constructor(options) {
        super(options);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    next => {
                        return this.prepViewController('userList', 0, mciData.menu, next);
                    },
                    next => {
                        const userListView = this.viewControllers.userList.getView(
                            MciViewIds.userList
                        );
                        if (!userListView) {
                            return cb(
                                Errors.MissingMci(
                                    `Missing user list MCI ${MciViewIds.userList}`
                                )
                            );
                        }

                        const fetchOpts = {
                            properties: [
                                UserProps.RealName,
                                UserProps.Location,
                                UserProps.Affiliations,
                                UserProps.LastLoginTs,
                            ],
                            propsCamelCase: true, //  e.g. real_name -> realName
                        };
                        getUserList(fetchOpts, (err, userList) => {
                            if (err) {
                                return next(err);
                            }

                            const dateTimeFormat = _.get(
                                this,
                                'menuConfig.config.dateTimeFormat',
                                this.client.currentTheme.helpers.getDateTimeFormat(
                                    'short'
                                )
                            );

                            userList = userList.map(entry => {
                                return Object.assign(entry, {
                                    text: entry.userName,
                                    affils: entry.affiliation,
                                    lastLoginTs: moment(entry.lastLoginTimestamp).format(
                                        dateTimeFormat
                                    ),
                                });
                            });

                            userListView.setItems(userList);
                            userListView.redraw();
                            return next(null);
                        });
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Error loading user list'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }
};
