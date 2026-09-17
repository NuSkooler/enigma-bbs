/* jslint node: true */
'use strict';

//  ENiGMA½
const Art = require('./art.js');
const { getActiveConnections } = require('./client_connections.js');
const ANSI = require('./ansi_term.js');
const { pipeToAnsi } = require('./color_codes.js');

//  deps
const _ = require('lodash');

//
//  What *produced* an interrupt item, carried on the item as |type|.
//
//  Not to be confused with MenuModule.InterruptTypes, which is the unrelated
//  never/queued/realtime setting describing when a *menu* will show one.
//
//  Consumers may route on this -- the WFC, for example, wants to show a node
//  message and ignore a global achievement rather than paint either over the
//  dashboard. Items without a |type| are treated as System.
//
const InterruptType = {
    NodeMsg: 'nodeMsg',
    Achievement: 'achievement',
    AchievementGlobal: 'achievementGlobal',
    SysopPage: 'sysopPage',
    TimeWarning: 'timeWarning',
    System: 'system',
};

class UserInterruptQueue {
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
            const connOpts = {
                authUsersOnly: true,
                visibleOnly: true,
                availOnly: true,
            };
            opts.clients = getActiveConnections(connOpts).filter(
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

        //  Every producer funnels through here, so this is the one place that
        //  has to hold for an item to be routable by type.
        interruptItem.type = _.get(interruptItem, 'type', InterruptType.System);

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
        //  FIFO: pop() showed the newest item first, so a run of node messages
        //  was read back to front.
        const interruptItem = this.queue.shift();
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
                this.client.currentMenuModule.pausePrompt(
                    { row: this.client.term.termHeight },
                    () => cb(null)
                );
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
}

//  The class stays the module export so every existing
//  `require('./user_interrupt_queue.js')` call site is untouched; the type
//  enum rides along as a static.
module.exports = UserInterruptQueue;
module.exports.InterruptType = InterruptType;
