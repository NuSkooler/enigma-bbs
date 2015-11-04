/* jslint node: true */
'use strict';

//	ENiGMA½
var loadMenu	= require('./menu_util.js').loadMenu;

var _			= require('lodash');
var assert		= require('assert');

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

	this.peekPrev = function() {
		if(this.stackSize() > 1) {
			return self.stack[self.stack.length - 2];
		}
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
	assert(currentModuleInfo, 'Empty menu stack!');

	var menuConfig = currentModuleInfo.instance.menuConfig;

	if(!_.isString(menuConfig.next)) {
		cb(new Error('No \'next\' member in menu config!'));
		return;
	}

	if(menuConfig.next === currentModuleInfo.name) {
		cb(new Error('Menu config \'next\' specifies current menu!'));
		return;
	}

	this.goto(menuConfig.next, { }, cb);
};

MenuStack.prototype.prev = function(cb) {
	this.pop().instance.leave();			//	leave & remove current
	var previousModuleInfo = this.pop();	//	get previous

	if(previousModuleInfo) {
		this.goto(previousModuleInfo.name, { extraArgs : previousModuleInfo.extraArgs, savedState : previousModuleInfo.savedState }, cb);
	} else {
		cb(new Error('No previous menu available!'));
	}
};

MenuStack.prototype.goto = function(name, options, cb) {
	var currentModuleInfo = this.top();

	if(!cb && _.isFunction(options)) {
		cb = options;
	}

	var self = this;

	if(currentModuleInfo && name === currentModuleInfo.name) {
		if(cb) {
			cb(new Error('Already at supplied menu!'));
		}
		return;
	}

	var loadOpts = {
		name		: name,
		client		: self.client, 
	};

	if(options) {
		loadOpts.extraArgs = options.extraArgs;
	}

	loadMenu(loadOpts, function menuLoaded(err, modInst) {
		if(err) {
			var errCb = cb || self.defaultHandlerMissingMod();
			errCb(err);
		} else {
			//	:TODO: Move this log to caller
			self.client.log.debug( { menuName : name }, 'Goto menu module');

			if(currentModuleInfo) {
				//	save stack state
				currentModuleInfo.savedState = currentModuleInfo.instance.getSaveState();

				currentModuleInfo.instance.leave();
			}

			self.push({
				name		: name,
				instance	: modInst,
				extraArgs	: loadOpts.extraArgs,
			});

			//	restore previous state if requested
			if(options && options.savedState) {
				modInst.restoreSavedState(options.savedState);
			}

			modInst.enter(self.client);

			self.client.log.trace(
				{ stack : _.map(self.stack, function(si) { return si.name; } ) },
				'Updated menu stack');

			if(cb) {
				cb(null);
			}
		}
	});
};

MenuStack.prototype.getCurrentModule = function() {
	return this.top().instance;
};
