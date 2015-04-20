/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var art				= require('../core/art.js');
var user			= require('../core/user.js');
var theme			= require('../core/theme.js');
var Log				= require('../core/logger.js').log;
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;
var Config			= require('../core/config.js').config;

var util			= require('util');

//var async			= require('async');

//	:TODO: clean up requires

exports.moduleInfo = {
	name	: 'Apply',
	desc	: 'Application Module',
	author	: 'NuSkooler',
};

exports.getModule	= ApplyModule;


function ApplyModule(menuConfig) {
	MenuModule.call(this, menuConfig);

	var self = this;

	this.menuMethods.submitApplication = function(formData, extraArgs) {
		var usernameView		= self.viewController.getView(1);
		var passwordView		= self.viewController.getView(9);
		var pwConfirmView		= self.viewController.getView(10);
		var statusView			= self.viewController.getView(11);

		self.validateApplication(formData, function validated(errString, clearFields) {
			if(errString) {
				statusView.setText(errString);

				clearFields.forEach(function formId(id) {
					self.viewController.getView(id).setText('');
				});

				self.viewController.switchFocus(clearFields[0]);
			} else {
				var newUser = new user.User();
				newUser.username = formData.value.username;

				newUser.properties = {
					real_name		: formData.value.realName,
					age				: formData.value.age,
					sex				: formData.value.sex,
					location		: formData.value.location,
					affiliation		: formData.value.affils,
					email_address	: formData.value.email,
					web_address		: formData.value.web,
					
					art_theme_id	: Config.defaults.theme,	//	:TODO: allow '*' = random
					account_status	: user.User.AccountStatus.inactive,

					//	:TODO: Other defaults
					//	:TODO: should probably have a place to create defaults/etc.					
					//	:TODO: set account_status to default based on Config.user...
				};

				newUser.create({ password : formData.value.pw }, function created(err) {
					if(err) {
						self.client.gotoMenuModule( { name : extraArgs.error } );
					} else {
						Log.info( { username : formData.value.username, userId : newUser.userId }, 'New user created');

						if(user.User.AccountStatus.inactive === self.client.user.properties.account_status) {
							self.client.gotoMenuModule( { name : extraArgs.inactive } );
						} else {
							self.client.gotoMenuModule( { name : this.menuConfig.next } );
						}
					}
				});			
			}
		});
	};

	this.validateApplication = function(formData, cb) {
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

		if(formData.value.pw.length < Config.users.passwordMin) {
			cb('Password too short!', [ 9, 10 ]);
			return;
		}

		if(formData.value.pw !== formData.value.pwConfirm) {
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
	};
}

util.inherits(ApplyModule, MenuModule);

ApplyModule.prototype.enter = function(client) {
	ApplyModule.super_.prototype.enter.call(this, client);
};

ApplyModule.prototype.beforeArt = function() {
	ApplyModule.super_.prototype.beforeArt.call(this);
};

ApplyModule.prototype.mciReady = function(mciData) {
	ApplyModule.super_.prototype.mciReady.call(this, mciData);

	var self = this;

	self.viewController = self.addViewController(new ViewController({ client : self.client } ));
	self.viewController.loadFromMCIMapAndConfig( { mciMap : mciData.menu, menuConfig : self.menuConfig }, function onViewReady(err) {
	
	});
};