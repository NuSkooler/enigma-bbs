/* jslint node: true */
'use strict';

//  ENiGMA½
const Art = require('./art.js');
const { getActiveConnections } = require('./client_connections.js');
const ANSI = require('./ansi_term.js');
const { pipeToAnsi } = require('./color_codes.js');

//  deps
const _ = require('lodash');

module.exports = class UserInterruptQueue {
    constructor(client) {
        this.client = client;
        this.queue = [];
    }

    static queue(interruptItem, opts) {
        opts = opts || {};
        if (!opts.clients) {
            let omitNodes = [];
            if (Array.isArray(opts.omit)) {
                omitNodes = opts.omit;
            } else if (opts.omit) {
                omitNodes = [opts.omit];
            }
            omitNodes = omitNodes.map(n => (_.isNumber(n) ? n : n.node));
            opts.clients = getActiveConnections(true).filter(
                ac => !omitNodes.includes(ac.node)
            );
        }
        if (!Array.isArray(opts.clients)) {
            opts.clients = [opts.clients];
        }
        opts.clients.forEach(c => {
            c.interruptQueue.queueItem(interruptItem);
        });
    }

    queueItem(interruptItem) {
        if (!_.isString(interruptItem.contents) && !_.isString(interruptItem.text)) {
            return;
        }

        //  pause defaulted on
        interruptItem.pause = _.get(interruptItem, 'pause', true);

        try {
            this.client.currentMenuModule.attemptInterruptNow(
                interruptItem,
                (err, ateIt) => {
                    if (err) {
                        //  :TODO: Log me
                    } else if (true !== ateIt) {
                        this.queue.push(interruptItem);
                    }
                }
            );
        } catch (e) {
            this.queue.push(interruptItem);
        }
    }

    hasItems() {
        return this.queue.length > 0;
    }

    displayNext(options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }
        const interruptItem = this.queue.pop();
        if (!interruptItem) {
            return cb(null);
        }

        Object.assign(interruptItem, options);
        return interruptItem ? this.displayWithItem(interruptItem, cb) : cb(null);
    }

    displayWithItem(interruptItem, cb) {
        if (interruptItem.cls) {
            this.client.term.rawWrite(ANSI.resetScreen());
        } else {
            this.client.term.rawWrite('\r\n\r\n');
        }

        const maybePauseAndFinish = () => {
            if (interruptItem.pause) {
                this.client.currentMenuModule.pausePrompt(() => {
                    return cb(null);
                });
            } else {
                return cb(null);
            }
        };

        if (interruptItem.contents) {
            Art.display(this.client, interruptItem.contents, err => {
                if (err) {
                    return cb(err);
                }
                //this.client.term.rawWrite('\r\n\r\n');  //  :TODO: Prob optional based on contents vs text
                maybePauseAndFinish();
            });
        } else {
            this.client.term.write(
                pipeToAnsi(`${interruptItem.text}\r\n\r\n`, this.client),
                true,
                () => {
                    maybePauseAndFinish();
                }
            );
        }
    }
};
