/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;

exports.getModule	= MessageEditorModule;

exports.moduleInfo = {
	name	: 'Message Editor',
	desc	: 'A module for editing messages',
	author	: 'NuSkooler',
};

function MessageEditorModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(MessageEditorModule, MenuModule);