/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var art				= require('../core/art.js');
var user			= require('../core/user.js');
var theme			= require('../core/theme.js');
var Log				= require('../core/logger.js').log;
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;

var async			= require('async');

//	:TODO: clean up requires

exports.moduleInfo = {
	name	: 'Login',
	desc	: 'Login Module',
	author	: 'NuSkooler',
};

exports.getModule	= LoginModule;


function LoginModule(menuConfig) {
	MenuModule.call(this, menuConfig);

	var self = this;

	//	:TODO: Handle max login attempts before hangup
	//	:TODO: probably should persist failed login attempts to user DB

	this.menuMethods.attemptLogin = function(args) {
		self.client.user.authenticate(args.username, args.password, function onAuth(err) {
			if(err) {
				//	:TODO: change to simple login/username prompts - no buttons.

				Log.info( { username : args.username }, 'Failed login attempt %s', err);

				//	:TODO: localize:
				//	:TODO: create a blink label of sorts - simulate blink with ICE
				self.viewController.getView(5).setText('Invalid username or password!');
				self.clearForm();
				self.viewController.switchFocus(1);
				
				setTimeout(function onTimeout() {
					//	:TODO: should there be a block input type of pattern here? self.client.ignoreInput() ... self.client.acceptInput()

					self.viewController.getView(5).clearText();	//	:TODO: for some reason this doesn't clear the last character
					self.viewController.switchFocus(1);
				}, 2000);

			} else {
				Log.info( { username : self.client.user.username }, 'Successful login');

				//	:TODO: persist information about login to user

				async.parallel(
					[
						function loadThemeConfig(callback) {
							theme.getThemeInfo(self.client.user.properties.art_theme_id, function themeInfo(err, info) {
								self.client.currentThemeInfo = info;
								callback(null);
							});
						}
					],
					function complete(err, results) {
						self.client.gotoMenuModule( { name : args.next.success } );		
					}
				);
			}
		});
	};

	this.clearForm = function() {
		[ 1, 2, ].forEach(function onId(id) {
			self.viewController.getView(id).clearText();
		});
	};
}

require('util').inherits(LoginModule, MenuModule);

LoginModule.prototype.enter = function(client) {
	LoginModule.super_.prototype.enter.call(this, client);
};

LoginModule.prototype.beforeArt = function() {
	LoginModule.super_.prototype.beforeArt.call(this);

	//this.client.term.write(ansi.resetScreen());
};

LoginModule.prototype.mciReady = function(mciMap) {
	LoginModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	self.viewController = self.addViewController(new ViewController( { client : self.client } ));
	self.viewController.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {
	});
};