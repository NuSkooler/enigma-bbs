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

        //  pause defaulted on
        interruptItem.pause = _.get(interruptItem, 'pause', true);

        this.client.currentMenuModule.attemptInterruptNow(interruptItem, (err, ateIt) => {
            if(err) {
                //  :TODO: Log me
            } else if(true !== ateIt) {
                this.queue.push(interruptItem);
            }
        });
    }

    hasItems() {
        return this.queue.length > 0;
    }

    displayNext(cb) {
        const interruptItem = this.queue.pop();
        if(!interruptItem) {
            return cb(null);
        }

        return interruptItem ? this.displayWithItem(interruptItem, cb) : cb(null);
    }

    displayWithItem(interruptItem, cb) {
        if(interruptItem.cls) {
            this.client.term.rawWrite(ANSI.clearScreen());
        } else {
            this.client.term.rawWrite('\r\n\r\n');
        }

        if(interruptItem.contents) {
            Art.display(this.client, interruptItem.contents, err => {
                if(err) {
                    return cb(err);
                }
                //this.client.term.rawWrite('\r\n\r\n');  //  :TODO: Prob optional based on contents vs text
                this.client.currentMenuModule.pausePrompt( () => {
                    return cb(null);
                });
            });
        } else {
            return this.client.term.write(pipeToAnsi(`${interruptItem.text}\r\n\r\n`, this.client), cb);
        }
    }
};