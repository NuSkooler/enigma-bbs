/* jslint node: true */
'use strict';

const MenuModule		= require('./menu_module.js').MenuModule;
const ViewController	= require('./view_controller.js').ViewController;
const theme 			= require('./theme.js');
const sysValidate		= require('./system_view_validate.js');

const async				= require('async');
const assert			= require('assert');
const _					= require('lodash');
const moment			= require('moment');

exports.moduleInfo = {
	name		: 'User Configuration',
	desc		: 'Module for user configuration',
	author		: 'NuSkooler',
};

const MciCodeIds = {
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

exports.getModule = class UserConfigModule extends MenuModule {
	constructor(options) {
		super(options);

		const self = this;

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

			//
			//	Handlers
			//
			saveChanges : function(formData, extraArgs, cb) {
				assert(formData.value.password === formData.value.passwordConfirm);

				const newProperties = {
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

				//  runtime set theme
				theme.setClientTheme(self.client, newProperties.theme_id);

				//  persist all changes
				self.client.user.persistProperties(newProperties, err => {
					if(err) {
						self.client.log.warn( { error : err.toString() }, 'Failed persisting updated properties');
						//	:TODO: warn end user!
						return self.prevMenu(cb);
					}
					//
					//	New password if it's not empty
					//
					self.client.log.info('User updated properties');

					if(formData.value.password.length > 0) {
						self.client.user.setNewAuthCredentials(formData.value.password, err => {
							if(err) {
								self.client.log.error( { err : err }, 'Failed storing new authentication credentials');
							} else {
								self.client.log.info('User changed authentication credentials');
							}
							return self.prevMenu(cb);
						});
					} else {
						return self.prevMenu(cb);
					}
				});
			},
		};
	}

	getView(viewId) {
		return this.viewControllers.menu.getView(viewId);
	}

	mciReady(mciData, cb) {
		super.mciReady(mciData, err => {
			if(err) {
				return cb(err);
			}

			const self 				= this;
			const vc				= self.viewControllers.menu = new ViewController( { client : self.client} );
			let currentThemeIdIndex = 0;

			async.series(
				[
					function loadFromConfig(callback) {
						vc.loadFromMenuConfig( { callingMenu : self, mciMap : mciData.menu }, callback);
					},
					function prepareAvailableThemes(callback) {
						self.availThemeInfo = _.sortBy([...theme.getAvailableThemes()].map(entry => {
							const theme = entry[1];
							return {
								themeId		: theme.info.themeId,
								name		: theme.info.name,
								author		: theme.info.author,
								desc		: _.isString(theme.info.desc) ? theme.info.desc : '',
								group		: _.isString(theme.info.group) ? theme.info.group : '',
							};
						}), 'name');

						currentThemeIdIndex = Math.max(0, _.findIndex(self.availThemeInfo, function cmp(ti) {
							return ti.themeId === self.client.user.properties.theme_id;
						}));

						callback(null);
					},
					function populateViews(callback) {
						var user = self.client.user;

						self.setViewText('menu', MciCodeIds.RealName, user.properties.real_name);
						self.setViewText('menu', MciCodeIds.BirthDate, moment(user.properties.birthdate).format('YYYYMMDD'));
						self.setViewText('menu', MciCodeIds.Sex, user.properties.sex);
						self.setViewText('menu', MciCodeIds.Loc, user.properties.location);
						self.setViewText('menu', MciCodeIds.Affils, user.properties.affiliation);
						self.setViewText('menu', MciCodeIds.Email, user.properties.email_address);
						self.setViewText('menu', MciCodeIds.Web, user.properties.web_address);
						self.setViewText('menu', MciCodeIds.TermHeight, user.properties.term_height.toString());


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
		});
	}
};
