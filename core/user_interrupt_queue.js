/* jslint node: true */
'use strict';

//  ENiGMA½
const Art = require('./art.js');
const { getActiveConnections } = require('./client_connections.js');
const ANSI = require('./ansi_term.js');
const { pipeToAnsi } = require('./color_codes.js');
const { coverScreen } = require('./screen_cover.js');

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

    //
    //  An interrupt is shown over whatever is on screen, and the menu under
    //  it may still have its forms attached (a realtime interrupt): it is a
    //  cover (core/screen_cover.js). Keys go to the interrupt's pause, not
    //  the forms, and the menu's tickers and status bars do not draw over
    //  it; a ticker in the pause prompt itself does. Nothing is restored
    //  here: the caller repaints next (MenuModule.attemptInterruptNow()
    //  reloads the menu, a queued drain is followed by the menu's own
    //  draw), so the background views are not redrawn on the way out
    //  either -- that would only flash before the repaint.
    //
    displayWithItem(interruptItem, cb) {
        //  by ownership: also a form the interrupted menu builds while this
        //  is up (its art finished loading) does not draw over it
        const menu = this.client.currentMenuModule;
        coverScreen(
            this.client,
            { redrawMissed: false, scope: menu ? { menu } : undefined },
            done => {
                if (interruptItem.cls) {
                    this.client.term.rawWrite(ANSI.resetScreen());
                } else {
                    this.client.term.rawWrite('\r\n\r\n');
                }

                const maybePauseAndFinish = () => {
                    if (interruptItem.pause) {
                        this.client.currentMenuModule.pausePrompt(
                            { row: this.client.term.termHeight },
                            () => done(null)
                        );
                    } else {
                        return done(null);
                    }
                };

                if (interruptItem.contents) {
                    Art.display(this.client, interruptItem.contents, err => {
                        if (err) {
                            return done(err);
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
            },
            err => cb(err)
        );
    }
}

//  The class stays the module export so every existing
//  `require('./user_interrupt_queue.js')` call site is untouched; the type
//  enum rides along as a static.
module.exports = UserInterruptQueue;
module.exports.InterruptType = InterruptType;
