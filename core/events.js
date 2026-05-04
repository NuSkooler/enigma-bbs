/* jslint node: true */
'use strict';

const events = require('events');
const loggerModule = require('./logger.js');
const SystemEvents = require('./system_events.js');

//  Trace log helper — looks up logger.log on each call rather than capturing
//  it once at module-load time. logger.log is set by Log.init() at runtime,
//  which means a load-time capture would freeze it as `undefined` until init
//  happens (and unit tests, which never call init, would crash on the first
//  Events.addListener / once call).
function _trace(...args) {
    const log = loggerModule.log;
    if (log && typeof log.trace === 'function') {
        log.trace(...args);
    }
}

module.exports = new (class Events extends events.EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(64); //  :TODO: play with this...
    }

    getSystemEvents() {
        return SystemEvents;
    }

    addListener(event, listener) {
        _trace({ event: event }, 'Registering event listener');
        return super.addListener(event, listener);
    }

    listenerCount(event, listener) {
        return super.listenerCount(event, listener);
    }

    emit(event, ...args) {
        _trace({ event: event }, 'Emitting event');
        return super.emit(event, ...args);
    }

    on(event, listener) {
        _trace({ event: event }, 'Registering event listener');
        return super.on(event, listener);
    }

    once(event, listener) {
        _trace({ event: event }, 'Registering single use event listener');
        return super.once(event, listener);
    }

    //
    //  Listen to multiple events for a single listener.
    //  Called with: listener(event, eventName)
    //
    //  The returned object must be used with removeMultipleEventListener()
    //
    addMultipleEventListener(events, listener) {
        _trace({ events }, 'Registering event listeners');

        const listeners = [];

        events.forEach(eventName => {
            const listenWrapper = (...args) => listener(...args, eventName);
            this.on(eventName, listenWrapper);
            listeners.push({ eventName, listenWrapper });
        });

        return listeners;
    }

    removeMultipleEventListener(listeners) {
        _trace({ events }, 'Removing listeners');
        listeners.forEach(listener => {
            this.removeListener(listener.eventName, listener.listenWrapper);
        });
    }

    removeListener(event, listener) {
        _trace({ event: event }, 'Removing listener');
        return super.removeListener(event, listener);
    }

    startup(cb) {
        return cb(null);
    }
})();
