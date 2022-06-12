/* jslint node: true */
'use strict';

const events = require('events');
const Log = require('./logger.js').log;
const SystemEvents = require('./system_events.js');

//  deps
const _ = require('lodash');

module.exports = new (class Events extends events.EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(64); //  :TODO: play with this...
    }

    getSystemEvents() {
        return SystemEvents;
    }

    addListener(event, listener) {
        Log.trace({ event: event }, 'Registering event listener');
        return super.addListener(event, listener);
    }

    emit(event, ...args) {
        Log.trace({ event: event }, 'Emitting event');
        return super.emit(event, ...args);
    }

    on(event, listener) {
        Log.trace({ event: event }, 'Registering event listener');
        return super.on(event, listener);
    }

    once(event, listener) {
        Log.trace({ event: event }, 'Registering single use event listener');
        return super.once(event, listener);
    }

    //
    //  Listen to multiple events for a single listener.
    //  Called with: listener(event, eventName)
    //
    //  The returned object must be used with removeMultipleEventListener()
    //
    addMultipleEventListener(events, listener) {
        Log.trace({ events }, 'Registering event listeners');

        const listeners = [];

        events.forEach(eventName => {
            const listenWrapper = _.partial(listener, _, eventName);
            this.on(eventName, listenWrapper);
            listeners.push({ eventName, listenWrapper });
        });

        return listeners;
    }

    removeMultipleEventListener(listeners) {
        Log.trace({ events }, 'Removing listeners');
        listeners.forEach(listener => {
            this.removeListener(listener.eventName, listener.listenWrapper);
        });
    }

    removeListener(event, listener) {
        Log.trace({ event: event }, 'Removing listener');
        return super.removeListener(event, listener);
    }

    startup(cb) {
        return cb(null);
    }
})();
