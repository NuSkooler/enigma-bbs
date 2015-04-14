/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var art				= require('../core/art.js');
var user			= require('../core/user.js');
var theme			= require('../core/theme.js');
var Log				= require('../core/logger.js').log;
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;

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

	this.menuMethods.submitApplication = function(args) {
		console.log('do submit')
	};
}

require('util').inherits(ApplyModule, MenuModule);

ApplyModule.prototype.enter = function(client) {
	ApplyModule.super_.prototype.enter.call(this, client);
};

ApplyModule.prototype.beforeArt = function() {
	ApplyModule.super_.prototype.beforeArt.call(this);
};

ApplyModule.prototype.mciReady = function(mciMap) {
	ApplyModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	self.viewController = self.addViewController(new ViewController({ client : self.client } ));
	self.viewController.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {

		var usernameView		= self.viewController.getView(1);
		var passwordView		= self.viewController.getView(9);
		var pwConfirmView		= self.viewController.getView(10);
		var statusView			= self.viewController.getView(11);

		self.viewController.on('leave', function leaveView(view) {
			switch(view.getId()) {
				case 1 : 
					user.getUserIdAndName(view.getViewData(), function userIdAndName(err) {
						var alreadyExists = !err;
						if(alreadyExists) {
							statusView.setText('Username unavailable!');
							self.viewController.switchFocus(1);	//	don't allow to leave
						} else {
							statusView.setText('');
							self.viewController.switchFocus(2);
						}
					});
					break;
			}
		});
/*
		usernameView.on('leave', function leaveUsername() {
			user.getUserIdAndName(usernameView.getViewData(), function userIdAndName(err) {
				var alreadyExists = !err;
				if(alreadyExists) {
					statusView.setText('Username unavailable!');
					self.viewController.switchFocus(1);	//	don't allow to leave
				} else {
					statusView.setText('');
					self.viewController.switchFocus(2);
				}
			});
		});

		passwordView.on('leave', function leavePw() {
			if(passwordView.getViewData().length < 3) {
				statusView.setText('Password too short!');
				self.viewController.switchFocus(9);
			} else {
				statusView.setText('');
			}
		});

		pwConfirmView.on('leave', function leavePwConfirm() {
			if(passwordView.getViewData() !== pwConfirmView.getViewData()) {
				statusView.setText('Passwords must match!');
				self.viewController.switchFocus(9);
			} else {
				statusView.setText('');
			}
		});
*/

		
	});
};