/* jslint node: true */
'use strict';

const paths				= require('path');
const events			= require('events');
const Log				= require('./logger.js').log;
const SystemEvents		= require('./system_events.js');

//	deps
const _					= require('lodash');
const async				= require('async');
const glob				= require('glob');

module.exports = new class Events extends events.EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(32);	//	:TODO: play with this...
    }

    getSystemEvents() {
        return SystemEvents;
    }

    addListener(event, listener) {
        Log.trace( { event : event }, 'Registering event listener');
        return super.addListener(event, listener);
    }

    emit(event, ...args) {
        Log.trace( { event : event }, 'Emitting event');
        return super.emit(event, ...args);
    }

    on(event, listener) {
        Log.trace( { event : event }, 'Registering event listener');
        return super.on(event, listener);
    }

    once(event, listener) {
        Log.trace( { event : event }, 'Registering single use event listener');
        return super.once(event, listener);
    }

    removeListener(event, listener) {
        Log.trace( { event : event }, 'Removing listener');
        return super.removeListener(event, listener);
    }

    startup(cb) {
        async.each(require('./module_util.js').getModulePaths(), (modulePath, nextPath) => {
            glob('*{.js,/*.js}', { cwd : modulePath }, (err, files) => {
                if(err) {
                    return nextPath(err);
                }

                async.each(files, (moduleName, nextModule) => {
                    const fullModulePath = paths.join(modulePath, moduleName);

                    try {
                        const mod = require(fullModulePath);

                        if(_.isFunction(mod.registerEvents)) {
                            //	:TODO: ... or just systemInit() / systemShutdown() & mods could call Events.on() / Events.removeListener() ?
                            mod.registerEvents(this);
                        }
                    } catch(e) {
                        Log.warn( { error : e }, 'Exception during module "registerEvents"');
                    }

                    return nextModule(null);
                }, err => {
                    return nextPath(err);
                });
            });
        }, err => {
            return cb(err);
        });
    }
};
