/* jslint node: true */
'use strict';

//  ENiGMA½
const loadMenu = require('./menu_util.js').loadMenu;
const { Errors, ErrorReasons } = require('./enig_error.js');
const { getResolvedSpec } = require('./menu_util.js');
const { MenuFlags } = require('./menu_module.js');

//  deps
const _ = require('lodash');
const assert = require('assert');
const bunyan = require('bunyan');

module.exports = class MenuStack {
    constructor(client) {
        this.client = client;
        this.stack = [];
    }

    push(moduleInfo) {
        return this.stack.push(moduleInfo);
    }

    pop() {
        return this.stack.pop();
    }

    peekPrev() {
        return this.stack[this.stack.length - 2];
    }

    top() {
        return this.stack[this.stack.length - 1];
    }

    get currentModule() {
        const top = this.top();
        assert(top, 'Empty menu stack!');
        return top.instance;
    }

    next(cb) {
        const currentModuleInfo = this.top();
        const menuConfig = currentModuleInfo.instance.menuConfig;
        const nextMenu = getResolvedSpec(this.client, menuConfig.next, 'next');
        if (!nextMenu) {
            return cb(
                Array.isArray(menuConfig.next)
                    ? Errors.MenuStack(
                        'No matching condition for "next"',
                        ErrorReasons.NoConditionMatch
                    )
                    : Errors.MenuStack(
                        'Invalid or missing "next" member in menu config',
                        ErrorReasons.InvalidNextMenu
                    )
            );
        }

        if (nextMenu === currentModuleInfo.name) {
            return cb(
                Errors.MenuStack(
                    'Menu config "next" specifies current menu',
                    ErrorReasons.AlreadyThere
                )
            );
        }

        this.goto(nextMenu, {}, cb);
    }

    prev(cb) {
        const menuResult = this.top().instance.getMenuResult();

        this.pop().instance.leave(); //  leave & remove current

        const previousModuleInfo = this.pop(); //  get previous

        if (previousModuleInfo) {
            const opts = {
                extraArgs: previousModuleInfo.extraArgs,
                savedState: previousModuleInfo.savedState,
                lastMenuResult: menuResult,
            };

            return this.goto(previousModuleInfo.name, opts, cb);
        }

        return cb(
            Errors.MenuStack('No previous menu available', ErrorReasons.NoPreviousMenu)
        );
    }

    goto(name, options, cb) {
        const currentModuleInfo = this.top();

        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        options = options || {};
        const self = this;

        if (currentModuleInfo && name === currentModuleInfo.name) {
            if (cb) {
                cb(
                    Errors.MenuStack(
                        'Already at supplied menu',
                        ErrorReasons.AlreadyThere
                    )
                );
            }
            return;
        }

        const loadOpts = {
            name: name,
            client: self.client,
        };

        if (currentModuleInfo && currentModuleInfo.menuFlags.includes(MenuFlags.ForwardArgs)) {
            loadOpts.extraArgs = currentModuleInfo.extraArgs;
        } else {
            loadOpts.extraArgs = options.extraArgs || _.get(options, 'formData.value');
        }
        loadOpts.lastMenuResult = options.lastMenuResult;

        loadMenu(loadOpts, (err, modInst) => {
            if (err) {
                const errCb = cb || self.client.defaultHandlerMissingMod();
                errCb(err);
            } else {
                self.client.log.debug({ menuName: name }, 'Goto menu module');

                if (!this.client.acs.hasMenuModuleAccess(modInst)) {
                    if (cb) {
                        return cb(Errors.AccessDenied('No access to this menu'));
                    }
                    return;
                }

                //
                //  If menuFlags were supplied in menu.hjson, they should win over
                //  anything supplied in code.
                //
                let menuFlags;
                if (0 === modInst.menuConfig.config.menuFlags.length) {
                    menuFlags = Array.isArray(options.menuFlags) ? options.menuFlags : [];
                } else {
                    menuFlags = modInst.menuConfig.config.menuFlags;

                    //  in code we can ask to merge in
                    if (
                        Array.isArray(options.menuFlags) &&
                        options.menuFlags.includes(MenuFlags.MergeFlags)
                    ) {
                        menuFlags = [...new Set(options.menuFlags)]; // make unique
                    }
                }

                if (currentModuleInfo) {
                    //  save stack state
                    currentModuleInfo.savedState =
                        currentModuleInfo.instance.getSaveState();

                    currentModuleInfo.instance.leave();

                    if (currentModuleInfo.menuFlags.includes(MenuFlags.NoHistory)) {
                        this.pop().instance.leave(); // leave & remove current from stack
                    }
                }

                self.push({
                    name: name,
                    instance: modInst,
                    extraArgs: loadOpts.extraArgs,
                    menuFlags: menuFlags,
                });

                //  restore previous state if requested
                if (options.savedState) {
                    modInst.restoreSavedState(options.savedState);
                }

                if (self.client.log.level() <= bunyan.TRACE) {
                    const stackEntries = self.stack.map(stackEntry => {
                        let name = stackEntry.name;
                        if (stackEntry.instance.menuConfig.config.menuFlags.length > 0) {
                            name += ` (${stackEntry.instance.menuConfig.config.menuFlags.join(
                                ', '
                            )})`;
                        }
                        return name;
                    });

                    self.client.log.trace({ stack: stackEntries }, 'Updated menu stack');
                }

                modInst.enter();

                if (cb) {
                    cb(null);
                }
            }
        });
    }
};
