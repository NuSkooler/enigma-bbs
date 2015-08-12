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
		var fse = new FullScreenEditor( {
			client		: this.client,
			art			: this.menuConfig.config.fseArt,
			font		: this.menuConfig.font,
			editorType	: 'area',
			editorMode	: 'edit',
		});

		fse.on('error', function fseError(err) {

		});

		fse.enter();
	};
}

require('util').inherits(MessageAreaPostModule, MenuModule);

/*
MessageAreaPostModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};
*/

