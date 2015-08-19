/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;
//var theme					= require('../core/theme.js');

//var async					= require('async');
//var assert					= require('assert');
//var _						= require('lodash');

exports.getModule			= MessageAreaModule;

exports.moduleInfo = {
	name	: 'Message Area',
	desc	: 'Module for interacting with area messages',
	author	: 'NuSkooler',
};

function MessageAreaModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.menuMethods = {
		changeArea : function(formData, extraArgs) {
			//	:TODO: clean this code up
		}
	};
}

require('util').inherits(MessageAreaModule, MenuModule);

MessageAreaModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};

