/* jslint node: true */
'use strict';

var ansi					= require('../core/ansi_term.js');
var art						= require('../core/art.js');
var user					= require('../core/user.js');
var theme					= require('../core/theme.js');
var Log						= require('../core/logger.js').log;
var MenuModule				= require('../core/menu_module.js').MenuModule;
var ViewController			= require('../core/view_controller.js').ViewController;
var Config					= require('../core/config.js').config;
var sysMenuMethod			= require('../core/system_menu_method.js');
var getDefaultMessageArea	= require('../core/message_area.js').getDefaultMessageArea;

var util					= require('util');
var async					= require('async');

exports.submitApplication	= submitApplication;

function validateApplicationData(formData, cb) {
	//	:TODO: This entire section should be replaced with a generic form validation system!!
	async.waterfall(
		[
			function basics(callback) {
				if(formData.value.username.length < Config.users.usernameMin) {
					cb(new Error('Handle too short!'), [ 1 ]);
					return;
				}

				if(formData.value.username.length > Config.users.usernameMax) {
					cb(new Error('Handle too long!'), [ 1 ]);
					return;
				}

				var re = new RegExp(Config.users.usernamePattern);
				if(!re.test(formData.value.username)) {
					cb(new Error('Handle contains invalid characters!'), [ 1 ] );
					return;
				}

				var invalidNames = Config.users.newUserNames + Config.users.badUserNames;
				if(invalidNames.indexOf(formData.value.username.toLowerCase()) > -1) {
					cb(new Error('Handle is blacklisted!'), [ 1 ] );
					return;
				}

				if(isNaN(Date.parse(formData.value.birthdate))) {
					cb(new Error('Invalid birthdate!'), [ 3 ] );
					return;
				}

				if(formData.value.password.length < Config.users.passwordMin) {
					cb(new Error('Password too short!'), [ 9, 10 ]);
					return;
				}

				if(formData.value.password !== formData.value.passwordConfirm) {
					cb(new Error('Passwords do not match!'), [ 9, 10 ]);
					return;
				}

				callback(null);
			},
			function email(callback) {
				user.getUserIdsWithProperty('email_address', formData.value.email, function userIdsWithEmail(err, uids) {
					if(err) {
						callback(new Error('Internal system error: ' + err.toString()), [ 1 ]);
					} else if(uids.length > 0) {
						callback(new Error('Email address not unique!'), [ 7 ] );
					} else {
						callback(null);
					}
				});
			},
			function userName(callback) {
				user.getUserIdAndName(formData.value.username, function userIdAndName(err) {
					var alreadyExists = !err;
					if(alreadyExists) {
						callback(new Error('Username unavailable!'), [ 1 ] );
					} else {
						cb(null);
					}
				});
			}
		],
		function complete(err, viewIds) {
			cb(err, viewIds);
		}
	);	
}

function submitApplication(callingMenu, formData, extraArgs) {
	var client				= callingMenu.client;
	var menuConfig			= callingMenu.menuConfig;
	var menuViewController	= callingMenu.viewControllers.menu;

	var views = {
		username	: menuViewController.getView(1),
		password	: menuViewController.getView(9),
		confirm		: menuViewController.getView(10),
		errorMsg	: menuViewController.getView(11)
	};

	validateApplicationData(formData, function validationResult(err, viewIds) {
		if(err) {
			views.errorMsg.setText(err.toString().replace('Error: ', ''));

			viewIds.forEach(function formId(id) {
				menuViewController.getView(id).clearText('');
			});

			menuViewController.switchFocus(viewIds[0]);
		} else {
			//	Seems legit!
			//	:TODO: All of this should be a system API, not a mod, e.g. createNewUser(...)
			var newUser = new user.User();

			newUser.username = formData.value.username;

			newUser.properties = {
				real_name			: formData.value.realName,
				birthdate			: new Date(Date.parse(formData.value.birthdate)).toISOString(),
				sex					: formData.value.sex,
				location			: formData.value.location,
				affiliation			: formData.value.affils,
				email_address		: formData.value.email,
				web_address			: formData.value.web,
				account_created		: new Date().toISOString(),

				message_area_name	: getDefaultMessageArea().name,

				term_height			: client.term.termHeight,
				term_width			: client.term.termWidth,
				
				//	:TODO: This is set in User.create() -- proabbly don't need it here:
				//account_status	: Config.users.requireActivation ? user.User.AccountStatus.inactive : user.User.AccountStatus.active,

				//	:TODO: Other defaults
				//	:TODO: should probably have a place to create defaults/etc.
			};

			if('*' === Config.defaults.theme) {
				newUser.properties.theme_id = theme.getRandomTheme();
			} else {
				newUser.properties.theme_id = Config.defaults.theme;
			}

			//	:TODO: .create() should also validate email uniqueness!
			newUser.create( { password : formData.value.password }, function created(err) {
				if(err) {
					Log.info( { error : err, username : formData.value.username }, 'New user creation failed');

					callingMenu.gotoMenu(extraArgs.error, function result(err) {
						if(err) {
							callingMenu.prevMenu();
						}
					});
				} else {
					Log.info( { username : formData.value.username, userId : newUser.userId }, 'New user created');

					//	Cache SysOp information now
					//	:TODO: Similar to bbs.js. DRY
					if(newUser.isSysOp()) {
						Config.general.sysOp = {
							username	: formData.value.username,
							properties	: newUser.properties,
						};
					}

					if(user.User.AccountStatus.inactive === client.user.properties.account_status) {
						callingMenu.gotoMenu(extraArgs.inactive);
					} else {
						//
						//	If active now, we need to call login() to authenticate
						//
						sysMenuMethod.login(callingMenu, formData, extraArgs);
					}
				}
			});
		}
	});
}
