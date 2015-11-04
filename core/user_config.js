/* jslint node: true */
'use strict';

var MenuModule			= require('./menu_module.js').MenuModule;
var ViewController		= require('./view_controller.js').ViewController;

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
	Email		: 1,
	Loc			: 2,
	Web			: 3,
	Affils		: 4,

	BirthDate	: 5,
	Sex			: 6,

	Theme		: 10,
	ScreenSize	: 11,
};

function UserConfigModule(options) {
	MenuModule.call(this, options);

	var self = this;

	self.setViewText = function(viewId, text) {
		var v = self.viewControllers.menu.getView(viewId);
		if(v) {
			v.setText(text);
		}
	};

	this.menuMethods = {
		exitKeyPressed : function(formData, extraArgs) {
			//	:TODO: save/etc.
			self.prevMenu();
		}
	};
}

require('util').inherits(UserConfigModule, MenuModule);

UserConfigModule.prototype.mciReady = function(mciData, cb) {
	var self 	= this;
	var vc		= self.viewControllers.menu = new ViewController( { client : self.client} );

	async.series(
		[
			function callParentMciReady(callback) {
				UserConfigModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				vc.loadFromMenuConfig( { callingMenu : self, mciMap : mciData.menu }, callback);
			},
			function populateViews(callback) {
				var user = self.client.user;

				self.setViewText(MciCodeIds.Email, user.properties.email_address);
				self.setViewText(MciCodeIds.Loc, user.properties.location);
				self.setViewText(MciCodeIds.Web, user.properties.web_address);
				self.setViewText(MciCodeIds.Affils, user.properties.affiliation);
				self.setViewText(MciCodeIds.BirthDate, moment(user.properties.birthdate).format('YYYYMMDD'));
				self.setViewText(MciCodeIds.Sex, user.properties.sex);

			}
		]
	);
};
