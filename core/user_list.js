/* jslint node: true */
'use strict';

const MenuModule		= require('./menu_module.js').MenuModule;
const User				= require('./user.js');
const ViewController	= require('./view_controller.js').ViewController;
const stringFormat		= require('./string_format.js');

const moment			= require('moment');
const async				= require('async');
const _					= require('lodash');

/*
	Available listFormat/focusListFormat object members:

	userId			: User ID
	userName		: User name/handle
	lastLoginTs		: Last login timestamp
	status			: Status: active | inactive
	location		: Location
	affiliation		: Affils
	note			: User note
*/

exports.moduleInfo = {
    name		: 'User List',
    desc		: 'Lists all system users',
    author		: 'NuSkooler',
};

const MciViewIds = {
    UserList	: 1,
};

exports.getModule = class UserListModule extends MenuModule {
    constructor(options) {
        super(options);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            const self		= this;
            const vc		= self.viewControllers.allViews = new ViewController( { client : self.client } );

            let userList = [];

            const USER_LIST_OPTS = {
                properties : [ 'location', 'affiliation', 'last_login_timestamp' ],
            };

            async.series(
                [
                    function loadFromConfig(callback) {
                        var loadOpts = {
                            callingMenu		: self,
                            mciMap			: mciData.menu,
                        };

                        vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function fetchUserList(callback) {
                        //	:TODO: Currently fetching all users - probably always OK, but this could be paged
                        User.getUserList(USER_LIST_OPTS, function got(err, ul) {
                            userList = ul;
                            callback(err);
                        });
                    },
                    function populateList(callback) {
                        var userListView = vc.getView(MciViewIds.UserList);

                        var listFormat 		= self.menuConfig.config.listFormat || '{userName} - {affils}';
                        var focusListFormat	= self.menuConfig.config.focusListFormat || listFormat;	//	:TODO: default changed color!
                        var dateTimeFormat	= self.menuConfig.config.dateTimeFormat || 'ddd MMM DD';

                        function getUserFmtObj(ue) {
                            return {
                                userId		: ue.userId,
                                userName	: ue.userName,
                                affils		: ue.affiliation,
                                location	: ue.location,
                                //	:TODO: the rest!
                                note		: ue.note || '',
                                lastLoginTs	: moment(ue.last_login_timestamp).format(dateTimeFormat),
                            };
                        }

                        userListView.setItems(_.map(userList, function formatUserEntry(ue) {
                            return stringFormat(listFormat, getUserFmtObj(ue));
                        }));

                        userListView.setFocusItems(_.map(userList, function formatUserEntry(ue) {
                            return stringFormat(focusListFormat, getUserFmtObj(ue));
                        }));

                        userListView.redraw();
                        callback(null);
                    }
                ],
                function complete(err) {
                    if(err) {
                        self.client.log.error( { error : err.toString() }, 'Error loading user list');
                    }
                    cb(err);
                }
            );
        });
    }
};
