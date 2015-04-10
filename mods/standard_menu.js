/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;
var menuUtil		= require('../core/menu_util.js');

exports.getModule	= StandardMenuModule;

exports.moduleInfo = {
	name	: 'Standard Menu Module',
	desc	: 'Menu module handling most standard stuff',
	author	: 'NuSkooler',
};

function StandardMenuModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(StandardMenuModule, MenuModule);


StandardMenuModule.prototype.enter = function(client) {
	StandardMenuModule.super_.prototype.enter.call(this, client);
};

StandardMenuModule.prototype.beforeArt = function() {
	StandardMenuModule.super_.prototype.beforeArt.call(this);
};

StandardMenuModule.prototype.mciReady = function(mciMap) {
	StandardMenuModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	var vc = self.addViewController(new ViewController(self.client));
	vc.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {
		if(err) {
			console.log(err);
		} else {
		/*	vc.on('submit', function onFormSubmit(formData) {
				console.log(formData);
			});*/
		}
	});
	

/*
	menuUtil.getFormConfig(self.menuConfig, mciMap, function onFormConfig(err, formConfig) {
		console.log(formConfig);
		var vc = self.addViewController(new ViewController(self.client));
		vc.loadFromMCIMap(mciMap);
		vc.setViewOrder();

		Object.keys(formConfig.mci).forEach(function onFormMci(mci) {
			var viewId = parseInt(mci[2]);
			if(formConfig.mci[mci].items && formConfig.mci[mci].items.length > 0) {
				vc.getView(viewId).setItems(formConfig.mci[mci].items);
			}
		});

		//vc.getView(1).setItems(['Login', 'New User', 'Goodbye!']);
		vc.getView(1).submit = true;
		vc.switchFocus(1);
	});
*/

	/*
	{
		"menuName" : {
			"form" : [
				{
					"mciReq" : [ "MC1", "MC2", ... ],
					"MC1" : {
						"text" : "...",
						"focus" : true,
						"submit" : true,
					},

				}


			]
		}
	}*/

	/*
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
		var vc = self.addViewController(new ViewController(self.client));

		vc.on('submit', function onSubmit(form) {
			console.log(form);

			var viewModuleMap = {
				'0' : 'login',
				'1' : 'new',
				'2' : 'logoff',
			};

			if(0 === form.id && 1 === form.submitId) {
				console.log(viewModuleMap[form.value[1]]);
				self.client.gotoMenuModule(viewModuleMap[form.value[1]]);
			}
		});

		vc.loadFromMCIMap(mciMap);
		vc.setViewOrder();
		//	:TODO: Localize
		vc.getView(1).setItems(['Login', 'New User', 'Goodbye!']);
		vc.getView(1).submit = true;
		vc.switchFocus(1);
	}
	*/
};
