/* jslint node: true */
'use strict';

const events            = require('events');
const Log               = require('./logger.js').log;
const SystemEvents      = require('./system_events.js');

module.exports = new class Events extends events.EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(64);   //  :TODO: play with this...
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

    addListenerMultipleEvents(events, listener) {
        Log.trace( { events }, 'Registring event listeners');
        events.forEach(eventName => {
            this.on(eventName, event => {
                listener(eventName, event);
            });
        });
    }

    removeListener(event, listener) {
        Log.trace( { event : event }, 'Removing listener');
        return super.removeListener(event, listener);
    }

    startup(cb) {
        return cb(null);
    }
};
