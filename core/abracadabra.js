/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;
var DropFile				= require('./door.js').DropFile;

exports.moduleInfo = {
	name	: 'Abracadabra',
	desc	: 'External BBS Door Module',
	author	: 'NuSkooler',
};

function AbracadabraModule(options) {
	MenuModule.call(this, options);

}

require('util').inherits(AbracadabraModule, MenuModule);