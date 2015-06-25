/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;

var async			= require('async');
var assert			= require('assert');
var _				= require('lodash');

exports.getModule	= FullScreenEditorModule;

exports.moduleInfo = {
	name	: 'Full Screen Editor (FSE)',
	desc	: 'A full screen editor/viewer',
	author	: 'NuSkooler',
};

function FullScreenEditorModule(options) {
	MenuModule.call(this, options);

	var self = this;
	var args = options.menuConfig.args;

	/*
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

					callback(null);
				},
				function displayBody(callback) {

				},
				function displayFooter(callback) {
					
				}
			]
		);	
	};
	*/
}

require('util').inherits(FullScreenEditorModule, MenuModule);

FullScreenEditorModule.prototype.enter = function(client) {	
	FullScreenEditorModule.super_.prototype.enter.call(this, client);
};

