/* jslint node: true */
'use strict';

//  ENiGMA½
const Art                   = require('./art.js');
const {
    getActiveConnections
}                           = require('./client_connections.js');
const ANSI                  = require('./ansi_term.js');
const { pipeToAnsi }        = require('./color_codes.js');

//  deps
const _     = require('lodash');

module.exports = class UserInterruptQueue
{
    constructor(client) {
        this.client         = client;
        this.queue          = [];
    }

    static queueGlobal(interruptItem, connections) {
        connections.forEach(conn => {
            conn.interruptQueue.queueItem(interruptItem);
        });
    }

    //  common shortcut: queue global, all active clients minus |client|
    static queueGlobalOtherActive(interruptItem, client) {
        const otherConnections = getActiveConnections(true).filter(ac => ac.node !== client.node);
        return UserInterruptQueue.queueGlobal(interruptItem, otherConnections );
    }

    queueItem(interruptItem) {
        if(!_.isString(interruptItem.contents) && !_.isString(interruptItem.text)) {
            return;
        }
        interruptItem.pause = _.get(interruptItem, 'pause', true);
        this.queue.push(interruptItem);
    }

    hasItems() {
        return this.queue.length > 0;
    }

    display(cb) {
        const interruptItem = this.queue.pop();
        if(!interruptItem) {
            return cb(null);
        }

        if(interruptItem.cls) {
            this.client.term.rawWrite(ANSI.clearScreen());
        } else {
            this.client.term.rawWrite('\r\n\r\n');
        }

        if(interruptItem.contents) {
            Art.display(this.client, interruptItem.contents, err => {
                this.client.term.rawWrite('\r\n\r\n');
                return cb(err, interruptItem);
            });
        } else {
            return this.client.term.write(pipeToAnsi(`${interruptItem.text}\r\n\r\n`, this.client), cb);
        }
    }
};