/* jslint node: true */
'use strict';

//	ENiGMA½
const loadMenu	= require('./menu_util.js').loadMenu;
const Errors	= require('./enig_error.js').Errors;

//	deps
const _			= require('lodash');
const assert	= require('assert');

//	:TODO: Stack is backwards.... top should be most recent! :)

module.exports = class MenuStack {
	constructor(client) {
		this.client	= client;
		this.stack	= [];
	}

	push(moduleInfo) {
		return this.stack.push(moduleInfo);
	}

	pop() {
		return this.stack.pop();
	}

	peekPrev() {
		if(this.stackSize > 1) {
			return this.stack[this.stack.length - 2];
		}
	}

	top() {
		if(this.stackSize > 0) {
			return this.stack[this.stack.length - 1];
		}
	}

	get stackSize() {
		return this.stack.length;
	}

	get currentModule() {
		const top = this.top();
		if(top) {
			return top.instance;
		}
	}

	next(cb) {
		const currentModuleInfo = this.top();
		assert(currentModuleInfo, 'Empty menu stack!');

		const menuConfig = currentModuleInfo.instance.menuConfig;
		let nextMenu;

		if(_.isArray(menuConfig.next)) {
			nextMenu = this.client.acs.getConditionalValue(menuConfig.next, 'next');
			if(!nextMenu) {
				return cb(Errors.MenuStack('No matching condition for "next"', 'NOCONDMATCH'));
			}
		} else if(_.isString(menuConfig.next)) {
			nextMenu = menuConfig.next;
		} else {
			return cb(Errors.MenuStack('Invalid or missing "next" member in menu config', 'BADNEXT'));
		}

		if(nextMenu === currentModuleInfo.name) {
			return cb(Errors.MenuStack('Menu config "next" specifies current menu', 'ALREADYTHERE'));
		}

		this.goto(nextMenu, { }, cb);
	}

	prev(cb) {
		const menuResult = this.top().instance.getMenuResult();

		//	:TODO: leave() should really take a cb...
		this.pop().instance.leave();	//	leave & remove current

		const previousModuleInfo = this.pop();	//	get previous

		if(previousModuleInfo) {
			const opts = {
				extraArgs		: previousModuleInfo.extraArgs,
				savedState		: previousModuleInfo.savedState,
				lastMenuResult	: menuResult,
			};

			return this.goto(previousModuleInfo.name, opts, cb);
		}

		return cb(Errors.MenuStack('No previous menu available', 'NOPREV'));
	}

	goto(name, options, cb) {
		const currentModuleInfo = this.top();

		if(!cb && _.isFunction(options)) {
			cb = options;
			options = {};
		}

		const self = this;

		if(currentModuleInfo && name === currentModuleInfo.name) {
			if(cb) {
				cb(Errors.MenuStack('Already at supplied menu', 'ALREADYTHERE'));
			}
			return;
		}

		const loadOpts = {
			name		: name,
			client		: self.client,
		};

		if(_.isObject(options)) {
			loadOpts.extraArgs		= options.extraArgs || _.get(options, 'formData.value');
			loadOpts.lastMenuResult	= options.lastMenuResult;
		}

		loadMenu(loadOpts, (err, modInst) => {
			if(err) {
				//	:TODO: probably should just require a cb...
				const errCb = cb || self.client.defaultHandlerMissingMod();
				errCb(err);
			} else {
				self.client.log.debug( { menuName : name }, 'Goto menu module');

				const menuFlags = (options && Array.isArray(options.menuFlags)) ? options.menuFlags : modInst.menuConfig.options.menuFlags;

				if(currentModuleInfo) {
					//	save stack state
					currentModuleInfo.savedState = currentModuleInfo.instance.getSaveState();

					currentModuleInfo.instance.leave();

					if(currentModuleInfo.menuFlags.includes('noHistory')) {
						this.pop();
					}

					if(menuFlags.includes('popParent')) {
						this.pop().instance.leave();	//	leave & remove current
					}
				}

				self.push({
					name		: name,
					instance	: modInst,
					extraArgs	: loadOpts.extraArgs,
					menuFlags	: menuFlags,
				});

				//	restore previous state if requested
				if(options && options.savedState) {
					modInst.restoreSavedState(options.savedState);
				}

				const stackEntries = self.stack.map(stackEntry => {
					let name = stackEntry.name;
					if(stackEntry.instance.menuConfig.options.menuFlags.length > 0) {
						name += ` (${stackEntry.instance.menuConfig.options.menuFlags.join(', ')})`;
					}
					return name;
				});

				self.client.log.trace( { stack : stackEntries }, 'Updated menu stack' );

				modInst.enter();

				if(cb) {
					cb(null);
				}
			}
		});
	}
};
