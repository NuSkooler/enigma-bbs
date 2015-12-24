/* jslint node: true */
'use strict';

var MenuModule			= require('./menu_module.js').MenuModule;
var ViewController		= require('./view_controller.js').ViewController;
var theme 				= require('./theme.js');
var sysValidate			= require('./system_view_validate.js');

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');
var moment				= require('moment');

exports.getModule		= UserConfigModule;

exports.moduleInfo = {
	name		: 'User Configuration',
	desc		: 'Module for user configuration',
	author		: 'NuSkooler',
};

var MciCodeIds = {
	RealName	: 1,
	BirthDate	: 2,
	Sex			: 3,
	Loc			: 4,
	Affils		: 5,
	Email		: 6,
	Web			: 7,
	TermHeight	: 8,
	Theme		: 9,
	Password	: 10,
	PassConfirm	: 11,	
	ThemeInfo	: 20,
	ErrorMsg	: 21,
	
	SaveCancel	: 25,
};

function UserConfigModule(options) {
	MenuModule.call(this, options);

	var self = this;
	
	self.getView = function(viewId) {
		return self.viewControllers.menu.getView(viewId);
	};

	self.setViewText = function(viewId, text) {
		var v = self.getView(viewId);
		if(v) {
			v.setText(text);
		}
	};

	this.menuMethods = {
		//
		//	Validation support
		//
		validateEmailAvail : function(data, cb) {
			//
			//	If nothing changed, we know it's OK
			//
			if(self.client.user.properties.email_address.toLowerCase() === data.toLowerCase()) {
				return cb(null);
			}
			
			//	Otherwise we can use the standard system method
			return sysValidate.validateEmailAvail(data, cb);
		},
		
		validatePassword : function(data, cb) {
			//
			//	Blank is OK - this means we won't be changing it
			//
			if(!data || 0 === data.length) {
				return cb(null);
			}
			
			//	Otherwise we can use the standard system method
			return sysValidate.validatePasswordSpec(data, cb);
		},
		
		validatePassConfirmMatch : function(data, cb) {
			var passwordView = self.getView(MciCodeIds.Password);
			cb(passwordView.getData() === data ? null : new Error('Passwords do not match'));
		},
		
		viewValidationListener : function(err, cb) {
			var errMsgView = self.getView(MciCodeIds.ErrorMsg);
			var newFocusId;
			if(errMsgView) {
				if(err) {
					errMsgView.setText(err.message);
					
					if(err.view.getId() === MciCodeIds.PassConfirm) {
						newFocusId = MciCodeIds.Password;
						var passwordView = self.getView(MciCodeIds.Password);
						passwordView.clearText();
						err.view.clearText();
					}
				} else {
					errMsgView.clearText();
				}
			}
			cb(newFocusId);
		},
		
		saveChanges : function(formData, extraArgs) {
			assert(formData.value.password === formData.value.passwordConfirm);
			
			var newProperties = {
				real_name			: formData.value.realName,
				birthdate			: new Date(Date.parse(formData.value.birthdate)).toISOString(),
				sex					: formData.value.sex,
				location			: formData.value.location,
				affiliation			: formData.value.affils,
				email_address		: formData.value.email,
				web_address			: formData.value.web,
				term_height			: formData.value.termHeight.toString(),				
				theme_id			: self.availThemeInfo[formData.value.theme].themeId,
			};
			
			self.client.user.persistProperties(newProperties, function persisted(err) {			
				if(err) {
					self.client.log.warn( { error : err.toString() }, 'Failed persisting updated properties');
					//	:TODO: warn end user!
					self.prevMenu();
				} else {
					//
					//	New password if it's not empty
					//
					self.client.log.info('User updated properties');
					
					if(formData.value.password.length > 0) {
						self.client.user.setNewAuthCredentials(formData.value.password, function newAuthStored(err) {
							if(err) {
								//	:TODO: warn the end user!
								self.client.log.warn( { error : err.toString() }, 'Failed storing new authentication credentials');
							} else {
								self.client.log.info('User changed authentication credentials');
							}
							self.prevMenu();
						});
					} else {
						self.prevMenu();
					}
				}
			});
		},
	};
}

require('util').inherits(UserConfigModule, MenuModule);

UserConfigModule.prototype.mciReady = function(mciData, cb) {
	var self 	= this;
	var vc		= self.viewControllers.menu = new ViewController( { client : self.client} );
	
	var currentThemeIdIndex = 0;

	async.series(
		[
			function callParentMciReady(callback) {
				UserConfigModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				vc.loadFromMenuConfig( { callingMenu : self, mciMap : mciData.menu }, callback);
			},
			function prepareAvailableThemes(callback) {
				self.availThemeInfo = _.sortBy(_.map(theme.getAvailableThemes(), function makeThemeInfo(t, themeId) {		
					return {
						themeId		: themeId,
						name		: t.info.name,
						author		: t.info.author,
						desc		: _.isString(t.info.desc) ? t.info.desc : '',
						group		: _.isString(t.info.group) ? t.info.group : '',
					};
				}), 'name');
				
				currentThemeIdIndex = _.findIndex(self.availThemeInfo, function cmp(ti) {
					return ti.themeId === self.client.user.properties.theme_id;
				});
				
				callback(null);
			},
			function populateViews(callback) {
				var user = self.client.user;

				self.setViewText(MciCodeIds.RealName, user.properties.real_name);
				self.setViewText(MciCodeIds.BirthDate, moment(user.properties.birthdate).format('YYYYMMDD'));
				self.setViewText(MciCodeIds.Sex, user.properties.sex);
				self.setViewText(MciCodeIds.Loc, user.properties.location);
				self.setViewText(MciCodeIds.Affils, user.properties.affiliation);
				self.setViewText(MciCodeIds.Email, user.properties.email_address);
				self.setViewText(MciCodeIds.Web, user.properties.web_address);
				self.setViewText(MciCodeIds.TermHeight, user.properties.term_height.toString());
						
				
				var themeView = self.getView(MciCodeIds.Theme);
				if(themeView) {
					themeView.setItems(_.map(self.availThemeInfo, 'name'));
					themeView.setFocusItemIndex(currentThemeIdIndex);
				}
				
				var realNameView = self.getView(MciCodeIds.RealName);
				if(realNameView) {
					realNameView.setFocus(true);	//	:TODO: HACK! menu.hjson sets focus, but manual population above breaks this. Needs a real fix!
				}
				
				callback(null);
			}
		],
		function complete(err) {
			if(err) {
				self.client.log.warn( { error : err.toString() }, 'User configuration failed to init');
				self.prevMenu();
			} else {
				cb(null);
			}
		}
	);
};
