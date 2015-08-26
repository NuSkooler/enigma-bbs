/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;

exports.getModule		= MessageListModule;

exports.moduleInfo = {
	name	: 'Message List',
	desc	: 'Module for listing/browsing available messages',
	author	: 'NuSkooler',
};

//
//	:TODO:
//	* Avail data:
//		To
//		From
//		Subject
//		Date
//		Status (New/Read)
//		Message Num (Area)
//		Message Total (Area)
//		Message Area desc
//		Message Area Name
//		
//	Ideas
//	* Module config can define custom formats for items & focused items (inc. Pipe Codes)
//	* Single list view
//	* 

function MessageListModule(options) {
	MenuModule.call(this, options);

	var self = this;
}

require('util').inherits(MessageListModule, MenuModule);

