/* jslint node: true */
'use strict';

//	ENiGMA½
var menuUtil	= require('./menu_util.js');

var _			= require('lodash');

/*
MenuStack(client)
	stack[] push, pop, ...

	next()
	goto(name, options, cb)
	prev()

MenuModule
	nextMenu()
	gotoMenu(name, options, cb)
	prevMenu()
*/

module.exports	= MenuStack;

function MenuStack(client) {
	this.client	= client;
	this.stack	= [];

	var self	= this;

	this.push = function(moduleInfo) {
		return self.stack.push(moduleInfo);
	};

	this.pop = function() {
		return self.stack.pop();
	};

	this.top = function() {
		return self.stack[self.stack.length - 1];
	};
}

MenuStack.prototype.next = function(cb) {
	var currentModuleInfo = this.menuStack.top();

	/*
		{
			instance : modInst,
			menuConfig : {}, 
			extraArgs : {}
			name : 'menuName',
			savedState : {}
		}
	*/

	if(!_.isString(currentModuleInfo.menuConfig.next)) {
		this.log.error('No \'next\' member in menu config!');
		return;
	}

	if(current.menuConfig.next === currentModuleInfo.name) {
		this.log.warn('Menu config \'next\' specifies current menu!');
		return;
	}

	this.goto(current.menuConfig.next, { }, cb);
};

MenuStack.prototype.prev = function() {

};

MenuStack.prototype.goto = function(name, options, cb) {
	var currentModuleInfo = this.menuStack.top();

	var self = this;

	if(name === currentModuleInfo.name) {
		var err = new Error('Already at supplied menu!');
	
		self.client.log.warn( { menuName : name, error : err.toString() }, 'Cannot go to menu');

		if(cb) {
			cb(err);	//	non-fatal
		}
		return;
	}

	var loadOpts = {
		name		: name,
		client		: self.client, 
		extraArgs	: options.extraArgs,
	};

	menuUtil.loadMenu(loadOpts, function menuLoaded(err, modInst) {
		if(err) {
			var errCb = cb || self.defaultHandlerMissingMod();
			errCb(err);
		} else {
			self.client.detachCurrentMenuModule();

			self.client.log.debug( { menuName : name }, 'Goto menu module');

			var modInfo = {
				name		: name,
				instance	: modInst,
				extraArgs	: options.extraArgs,
			};

			self.push(modInfo);

			modInst.enter(self.client);

			if(cb) {
				cb(null);
			}
		}
	});
};

MenuStack.prototype.getCurrentModule = function() {
	return this.top().instance;
};
