/* jslint node: true */
'use strict';

//	ENiGMA½
var loadMenu	= require('./menu_util.js').loadMenu;

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

//	:TODO: Clean up client attach/detach/etc.
//	:TODO: Cleanup up client currentMenuModule related stuff (all over!). Make this a property that returns .menuStack.getCurrentModule()

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
		if(self.stackSize() > 0) {
			return self.stack[self.stack.length - 1];
		}
	};

	this.stackSize = function() {
		return self.stack.length;
	}
}

MenuStack.prototype.next = function(cb) {
	var currentModuleInfo = this.top();

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

MenuStack.prototype.prev = function(cb) {
	var previousModuleInfo = this.pop();
	
	if(previousModuleInfo) {
		this.goto(previousModuleInfo.name, { extraArgs : previousModuleInfo.extraArgs, savedState : previousModuleInfo.savedState }, cb);
	} else {
		cb(new Error('No previous menu available!'));
	}
};

MenuStack.prototype.goto = function(name, options, cb) {
	var currentModuleInfo = this.menuStack.top();

	var self = this;

	if(currentModuleInfo && name === currentModuleInfo.name) {
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

	loadMenu(loadOpts, function menuLoaded(err, modInst) {
		if(err) {
			var errCb = cb || self.defaultHandlerMissingMod();
			errCb(err);
		} else {
			self.client.log.debug( { menuName : name }, 'Goto menu module');

			if(currentModuleInfo) {
				//	save stack state
				currentModuleInfo.savedState = currentModuleInfo.instance.getSaveState();

				currentModuleInfo.instance.leave();
			}

			self.push( {
				name		: name,
				instance	: modInst,
				extraArgs	: options.extraArgs,
			});

			//	restore previous state if requested
			if(options.savedState) {
				modInst.restoreSavedState(options.savedState);
			}

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
