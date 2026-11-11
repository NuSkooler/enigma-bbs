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

        //  menu name -> client.lastActivityTime when its init last failed;
        //  see initFailureWouldCycle()
        this.initFailures = new Map();
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
        if (this.client.clientEnded) {
            return this._refuseEnded('(previous)', cb);
        }

        const menuResult = this.top().instance.getMenuResult();

        this.pop().instance.leave(); //  leave & remove current

        const previousModuleInfo = this.pop(); //  get previous; we'll re-create a instance

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
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }
        options = options || {};

        const currentModuleInfo = this.top();

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

        if (this.client.clientEnded) {
            return this._refuseEnded(name, cb);
        }

        const loadOpts = {
            name: name,
            client: this.client,
        };

        if (
            currentModuleInfo &&
            currentModuleInfo.menuFlags.includes(MenuFlags.ForwardArgs)
        ) {
            loadOpts.extraArgs = currentModuleInfo.extraArgs;
        } else {
            loadOpts.extraArgs = options.extraArgs || _.get(options, 'formData.value');
        }
        loadOpts.lastMenuResult = options.lastMenuResult;

        loadMenu(loadOpts, (err, modInst) => {
            //  the caller may have gone while the menu was loading
            if (this.client.clientEnded) {
                return this._refuseEnded(name, cb);
            }

            if (err) {
                const errCb = cb || this.client.defaultHandlerMissingMod();
                errCb(err);
            } else {
                this.client.log.debug({ menuName: name }, 'Goto menu module');

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
                    currentModuleInfo.left = true; //  see _refuseEnded()

                    if (currentModuleInfo.menuFlags.includes(MenuFlags.NoHistory)) {
                        this.pop();
                    }
                }

                this.push({
                    name: name,
                    instance: modInst,
                    extraArgs: loadOpts.extraArgs,
                    menuFlags: menuFlags,
                });

                //  restore previous state if requested
                if (options.savedState) {
                    modInst.restoreSavedState(options.savedState);
                }

                if (this.client.log.level() <= bunyan.TRACE) {
                    const stackEntries = this.stack.map(stackEntry => {
                        let name = stackEntry.name;
                        if (stackEntry.instance.menuConfig.config.menuFlags.length > 0) {
                            name += ` (${stackEntry.instance.menuConfig.config.menuFlags.join(
                                ', '
                            )})`;
                        }
                        return name;
                    });

                    this.client.log.trace({ stack: stackEntries }, 'Updated menu stack');
                }

                modInst.enter();

                if (cb) {
                    cb(null);
                }
            }
        });
    }

    //
    //  A session that has ended goes nowhere. Navigating used to carry on
    //  regardless: a menu was created and entered for a terminal that was no
    //  longer there, and anything that kept navigating -- a menu bouncing
    //  between two others, or the menu chain of a caller who had already gone
    //  (#999) -- did so for the life of the process.
    //
    //  The menu being left still gets its leave(), as it would have done
    //  when the next one was entered: it is a module's one chance to clean
    //  up (a door's node count, an upload's temp files, ...). Only once,
    //  though: the top may already have been left, by an earlier refusal or
    //  because prev() / reload() popped the menu that was above it.
    //
    _refuseEnded(name, cb) {
        const top = this.top();
        if (top && !top.left) {
            top.left = true;
            top.instance.leave();
        }

        this.client.log.debug({ menuName: name }, 'Not going to menu: session has ended');

        if (cb) {
            return cb(
                Errors.MenuStack('The session has ended', ErrorReasons.ClientEnded)
            );
        }
    }

    //
    //  Called by a menu whose init sequence failed, before it falls back to
    //  the previous menu. Returns true when that fallback would cycle: this
    //  menu has already failed with no input from the caller since, so the
    //  previous menu advanced straight back here without the caller doing
    //  anything (e.g. its pause prompt could not be shown, and it has
    //  autoNext). Falling back again would repeat that forever.
    //
    //  The same failure after a key press is allowed: that is the caller
    //  trying again.
    //
    initFailureWouldCycle(menuName) {
        const activity = this.client.lastActivityTime;
        const wouldCycle = this.initFailures.get(menuName) === activity;
        this.initFailures.set(menuName, activity);
        return wouldCycle;
    }

    //
    //  A menu whose init sequence succeeded has no failure on record: a later
    //  failure of the same menu, even with no input in between (a timed or
    //  sysop-initiated return, say), is a first failure again and falls back.
    //
    initSucceeded(menuName) {
        this.initFailures.delete(menuName);
    }
};
