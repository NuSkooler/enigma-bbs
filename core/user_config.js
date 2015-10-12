/* jslint node: true */
'use strict';

var MenuModule			= require('./menu_module.js').MenuModule;
var ViewController		= require('./view_controller.js').ViewController;

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.getModule		= UserConfigModule;

exports.moduleInfo = {
	name		: 'User Configuration',
	desc		: 'Module for user configuration',
	author		: 'NuSkooler',
};

function UserConfigModule(options) {
	MenuModule.call(this, options);

	var self = this;


}

require('util').inherits(UserConfigModule, MenuModule);

UserConfigModule.prototype.mciReady = function(mciData, cb) {
	var self 	= this;
	var vc		= self.viewControllers.allViews = new ViewController( { client : self.client} );

	async.series(
		[
			function callParentMciReady(callback) {
				UserConfigModule.super_.prototype.mciReady.call(self, mciData, callback);
			}
		]
	);
};
