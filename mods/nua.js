/* jslint node: true */
'use strict';
var MenuModule				= require('../core/menu_module.js').MenuModule;
var user					= require('../core/user.js');
var theme					= require('../core/theme.js');
var login					= require('../core/system_menu_method.js').login;
var Config					= require('../core/config.js').config;
var messageArea             = require('../core/message_area.js');

var async					= require('async');

exports.getModule	= NewUserAppModule;

exports.moduleInfo = {
	name	: 'NUA',
	desc	: 'New User Application',
};

var MciViewIds = {
	userName	: 1,
	password	: 9,
	confirm		: 10,
	errMsg		: 11,
};

function NewUserAppModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.menuMethods = {
		//
		//	Validation stuff
		//
		validatePassConfirmMatch : function(data, cb) {
			var passwordView = self.viewControllers.menu.getView(MciViewIds.password);
			cb(passwordView.getData() === data ? null : new Error('Passwords do not match'));
		},

		viewValidationListener : function(err, cb) {
			var errMsgView = self.viewControllers.menu.getView(MciViewIds.errMsg);
			var newFocusId;
			if(err) {
				errMsgView.setText(err.message);
				err.view.clearText();

				if(err.view.getId() === MciViewIds.confirm) {
					newFocusId = MciViewIds.password;
					var passwordView = self.viewControllers.menu.getView(MciViewIds.password);
					passwordView.clearText();
				}
			} else {
				errMsgView.clearText();
			}

			cb(newFocusId);
		},


		//
		//	Submit handlers
		//
		submitApplication : function(formData, extraArgs) {
			var newUser = new user.User();

			newUser.username = formData.value.username;

			//
			//	We have to disable ACS checks for initial default areas as the user is not yet ready
			//            
            var confTag     = messageArea.getDefaultMessageConferenceTag(self.client, true);				//	true=disableAcsCheck
            var areaTag     = messageArea.getDefaultMessageAreaTagByConfTag(self.client, confTag, true);	//	true=disableAcsCheck
            
            //  can't store undefined!
            confTag = confTag || '';
            areaTag = areaTag || '';
			
			newUser.properties = {
				real_name			: formData.value.realName,
				birthdate			: new Date(Date.parse(formData.value.birthdate)).toISOString(), 	//	:TODO: Use moment & explicit ISO string format
				sex					: formData.value.sex,
				location			: formData.value.location,
				affiliation			: formData.value.affils,
				email_address		: formData.value.email,
				web_address			: formData.value.web,
				account_created		: new Date().toISOString(),	//	:TODO: Use moment & explicit ISO string format
                
				message_conf_tag    : confTag,
				message_area_tag    : areaTag,

				term_height			: self.client.term.termHeight,
				term_width			: self.client.term.termWidth,				

				//	:TODO: Other defaults
				//	:TODO: should probably have a place to create defaults/etc.
			};

			if('*' === Config.defaults.theme) {
				newUser.properties.theme_id = theme.getRandomTheme();
			} else {
				newUser.properties.theme_id = Config.defaults.theme;
			}
			
			//	:TODO: User.create() should validate email uniqueness!
			newUser.create( { password : formData.value.password }, function created(err) {
				if(err) {
					self.client.log.info( { error : err, username : formData.value.username }, 'New user creation failed');

					self.gotoMenu(extraArgs.error, function result(err) {
						if(err) {
							self.prevMenu();
						}
					});
				} else {
					self.client.log.info( { username : formData.value.username, userId : newUser.userId }, 'New user created');

					//	Cache SysOp information now
					//	:TODO: Similar to bbs.js. DRY
					if(newUser.isSysOp()) {
						Config.general.sysOp = {
							username	: formData.value.username,
							properties	: newUser.properties,
						};
					}

					if(user.User.AccountStatus.inactive === self.client.user.properties.account_status) {
						self.gotoMenu(extraArgs.inactive);
					} else {
						//
						//	If active now, we need to call login() to authenticate
						//
						login(self, formData, extraArgs);
					}
				}
			});
		},
	};
}

require('util').inherits(NewUserAppModule, MenuModule);

NewUserAppModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};