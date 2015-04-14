/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var art				= require('../core/art.js');
var user			= require('../core/user.js');
var theme			= require('../core/theme.js');
var MenuModule		= require('../core/menu_module.js').MenuModule;

//var view			= require('../core/view.js');
var textView		= require('../core/text_view.js');
var editTextView	= require('../core/edit_text_view.js');
var ViewController	= require('../core/view_controller.js').ViewController;

//var async			= require('async');

//	:TODO: clean up requires
//	:TODO: rename to matrix.js

exports.moduleInfo = {
	name	: 'Matrix',
	desc	: 'Standardish Matrix',
	author	: 'NuSkooler',
};

exports.getModule	= MatrixModule;


function MatrixModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(MatrixModule, MenuModule);

MatrixModule.prototype.enter = function(client) {
	MatrixModule.super_.prototype.enter.call(this, client);
};

MatrixModule.prototype.beforeArt = function() {
	MatrixModule.super_.prototype.beforeArt.call(this);

	this.client.term.write(ansi.resetScreen());
};

MatrixModule.prototype.mciReady = function(mciMap) {
	MatrixModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	if(mciMap.ET1 && mciMap.ET2 && mciMap.BN1 && mciMap.BN2 && mciMap.BN3) {
		//
		//	Form via EditTextViews and ButtonViews
		//	* ET1 - userName
		//	* ET2 - password
		//	* BN1 - Login
		//	* BN2 - New
		//	* BN3 - Bye!
		//
	} else if(mciMap.VM1) {
		//
		//	Menu via VerticalMenuView
		//
		//	* VM1 - menu with the following items:
		//		0 - Login
		//		1 - New
		//		2 - Bye!
		//
		//var vc = new ViewController(client);
		var vc = self.addViewController(new ViewController({ client : self.client } ));

		vc.on('submit', function onSubmit(form) {
			console.log(form);

			var viewModuleMap = {
				'0' : 'login',
				'1' : 'new',
				'2' : 'logoff',
			};

			if(0 === form.id && 1 === form.submitId) {
				console.log(viewModuleMap[form.values[1]]);
				self.client.gotoMenuModule(viewModuleMap[form.values[1]]);
			}
		});

		vc.loadFromMCIMap(mciMap);
		vc.setViewOrder();
		//	:TODO: Localize
		vc.getView(1).setItems(['Login', 'New User', 'Goodbye!']);
		vc.getView(1).submit = true;
		vc.switchFocus(1);
	}
};