/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule	= require('../core/menu_module.js').MenuModule;
const User			= require('../core/user.js');
const theme			= require('../core/theme.js');
const login			= require('../core/system_menu_method.js').login;
const Config		= require('../core/config.js').config;
const messageArea	= require('../core/message_area.js');

exports.moduleInfo = {
	name	: 'NUA',
	desc	: 'New User Application',
};

const MciViewIds = {
	userName	: 1,
	password	: 9,
	confirm		: 10,
	errMsg		: 11,
};

exports.getModule = class NewUserAppModule extends MenuModule {
	
	constructor(options) {
		super(options);
		
		const self = this;

		this.menuMethods = {
			//
			//	Validation stuff
			//
			validatePassConfirmMatch : function(data, cb) {
				const passwordView = self.viewControllers.menu.getView(MciViewIds.password);
				return cb(passwordView.getData() === data ? null : new Error('Passwords do not match'));
			},

			viewValidationListener : function(err, cb) {
				const errMsgView = self.viewControllers.menu.getView(MciViewIds.errMsg);
				let newFocusId;
				
				if(err) {
					errMsgView.setText(err.message);
					err.view.clearText();

					if(err.view.getId() === MciViewIds.confirm) {
						newFocusId = MciViewIds.password;
						self.viewControllers.menu.getView(MciViewIds.password).clearText();
					}
				} else {
					errMsgView.clearText();
				}

				return cb(newFocusId);
			},


			//
			//	Submit handlers
			//
			submitApplication : function(formData, extraArgs, cb) {
				const newUser = new User();

				newUser.username = formData.value.username;

				//
				//	We have to disable ACS checks for initial default areas as the user is not yet ready
				//            
				let confTag     = messageArea.getDefaultMessageConferenceTag(self.client, true);				//	true=disableAcsCheck
				let areaTag     = messageArea.getDefaultMessageAreaTagByConfTag(self.client, confTag, true);	//	true=disableAcsCheck

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
				newUser.create(formData.value.password, err => {
					if(err) {
						self.client.log.info( { error : err, username : formData.value.username }, 'New user creation failed');

						self.gotoMenu(extraArgs.error, err => {
							if(err) {
								return self.prevMenu(cb);
							}
							return cb(null);
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

						if(User.AccountStatus.inactive === self.client.user.properties.account_status) {
							return self.gotoMenu(extraArgs.inactive, cb);
						} else {
							//
							//	If active now, we need to call login() to authenticate
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
