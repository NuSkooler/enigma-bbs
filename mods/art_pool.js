/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;


exports.getModule			= ArtPoolModule;

exports.moduleInfo = {
	name	: 'Art Pool',
	desc	: 'Display art from a pool of options',
	author	: 'NuSkooler',
};

function ArtPoolModule(options) {
	MenuModule.call(this, options);

	var config		= this.menuConfig.config;

	//
	//	:TODO: General idea
	//	* Break up some of MenuModule initSequence's calls into methods
	//	* initSequence here basically has general "clear", "next", etc. as per normal
	//	* Display art -> ooptinal pause -> display more if requested, etc.
	//	* Finally exit & move on as per normal
	
}

require('util').inherits(ArtPoolModule, MenuModule);

MessageAreaModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};
