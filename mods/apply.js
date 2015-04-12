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

	this.clearForm = function() {
		[ 1, 2, ].forEach(function onId(id) {
			self.viewController.getView(id).clearText();
		});
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

	self.viewController = self.addViewController(new ViewController(self.client));
	self.viewController.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {

		var usernameView		= self.viewController.getView(1);
		var userExistsView		= self.viewController.getView(10);
		usernameView.on('leave', function leave() {
			user.getUserIdAndName(usernameView.getViewData(), function userIdAndName(err) {
				if(!err) {
					userExistsView.setText('That username already exists!');
				} else {
					userExistsView.setText('');
				}
				//if(11 !== self.viewController.getFocusedView()) {
				self.viewController.switchFocus(2);
				//}
			});
		});

		var pwView 				= self.viewController.getView(8);
		var pwConfirmView		= self.viewController.getView(9);
		var pwSecureView		= self.viewController.getView(11);
		var pwConfirmNoticeView	= self.viewController.getView(12);

		//	:TODO: show a secure meter here instead
		pwView.on('leave', function pwLeave() {
			if(pwView.getViewData().length > 3) {
				pwSecureView.setColor(32);
				pwSecureView.setText('Secure');
			} else {
				pwSecureView.setColor(31);
				pwSecureView.setText('Insecure!');
			}
		});

		pwConfirmView.on('leave', function confirmPwLeave() {
			if(pwView.getViewData() !== pwConfirmView.getViewData()) {
				pwConfirmNoticeView.setText('Passwords must match!');
			} else {
				pwConfirmNoticeView.setText('');
			}
		});
	});
};