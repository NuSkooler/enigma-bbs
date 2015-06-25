/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;

var async			= require('async');
var assert			= require('assert');
var _				= require('lodash');

exports.getModule	= MessageEditorModule;

exports.moduleInfo = {
	name	: 'Message Editor',
	desc	: 'A module for editing messages',
	author	: 'NuSkooler',
};

function MessageEditorModule(options) {
	MenuModule.call(this, options);

	var self = this;
	var args = options.menuConfig.args;

	this.initSequence = function() {
		async.waterfall(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
				function displayHeader(callback) {
					if(_.isString(args.art.header)) {
						self.displayArtAsset(args.art.header, function hdrDisplayed(err, mciMap) {

						});
					}
				}
			]
		);	
	};
}

require('util').inherits(MessageEditorModule, MenuModule);

MessageEditorModule.prototype.enter = function(client) {	
	MessageEditorModule.super_.prototype.enter.call(this, client);
};

