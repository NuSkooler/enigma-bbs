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

exports.submitApplication	= submitApplication;

function validateApplicationData(formData, cb) {
	if(formData.value.username.length < Config.users.usernameMin) {
		cb('Handle too short!', [ 1 ]);
		return;
	}

	if(formData.value.username.length > Config.users.usernameMax) {
		cb('Handle too long!', [ 1 ]);
		return;
	}

	var re = new RegExp(Config.users.usernamePattern);
	if(!re.test(formData.value.username)) {
		cb('Handle contains invalid characters!', [ 1 ] );
		return;
	}

	var invalidNames = Config.users.newUserNames + Config.users.badUserNames;
	if(invalidNames.indexOf(formData.value.username.toLowerCase()) > -1) {
		cb('Handle is blacklisted!', [ 1 ] );
		return;
	}

	if(isNaN(Date.parse(formData.value.birthdate))) {
		cb('Invalid birthdate!', [ 3 ] );
		return;
	}

	if(formData.value.password.length < Config.users.passwordMin) {
		cb('Password too short!', [ 9, 10 ]);
		return;
	}

	if(formData.value.password !== formData.value.passwordConfirm) {
		cb('Passwords do not match!', [ 9, 10 ]);
		return;
	}

	user.getUserIdAndName(formData.value.username, function userIdAndName(err) {
		var alreadyExists = !err;
		if(alreadyExists) {
			cb('Username unavailable!', [ 1  ] );
		} else {
			cb(null);
		}
	});
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

	validateApplicationData(formData, function validationResult(errorMsg, viewIds) {
		if(errorMsg) {
			views.errorMsg.setText(errorMsg);

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

			newUser.create( { password : formData.value.password }, function created(err) {
				if(err) {
					Log.info( { error : err, username : formData.value.username }, 'New user creation failed');

					client.gotoMenuModule( { name : extraArgs.error } );
				} else {
					Log.info( { username : formData.value.username, userId : newUser.userId }, 'New user created');

					if(user.User.AccountStatus.inactive === client.user.properties.account_status) {
						client.gotoMenuModule( { name : extraArgs.inactive } );
					} else {
						//
						//	If active now, we need to call login() to authenticate
						//
						sysMenuMethod.login(callingMenu, formData, extraArgs);
					//	client.gotoMenuModule( { name : menuConfig.next } );
					}
				}
			});
		}
	});
}
