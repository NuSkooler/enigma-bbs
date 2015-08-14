/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;
var FullScreenEditor		= require('../core/fse--class.js');	//	:TODO: fix this
//var theme					= require('../core/theme.js');

var async					= require('async');
var assert					= require('assert');
var _						= require('lodash');

exports.getModule			= MessageAreaPostModule;

exports.moduleInfo = {
	name	: 'Message Area Post',
	desc	: 'Module posting a new message to an area',
	author	: 'NuSkooler',
};

function MessageAreaPostModule(options) {
	MenuModule.call(this, options);

	var self = this;


	this.initSequence = function() {
		self.fse = new FullScreenEditor( {
			callingMenu	: this,
			client		: this.client,
			//	:TODO: should pass in full config? want access to keymap/etc. as well
			art			: this.menuConfig.config.fseArt,
			font		: this.menuConfig.font,
			editorType	: 'area',
			editorMode	: 'edit',
		});

		self.fse.on('error', function fseError(err) {
			console.log('fse error: ' + err)
		});

		self.fse.enter();
	};

	this.menuMethods = {
		//	:TODO: is there a cleaner way to achieve this?
		fseSubmitProxy : function(formData, extraArgs) {
			self.fse.submitHandler(formData, extraArgs);
		}
	};
}

require('util').inherits(MessageAreaPostModule, MenuModule);

/*
MessageAreaPostModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};
*/

