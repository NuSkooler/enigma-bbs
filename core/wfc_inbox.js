/* jslint node: true */
'use strict';

//  deps
const _ = require('lodash');

//
//  Notifications an +op has been handed at the WFC but has not read yet.
//
//  This hangs off the *client*, not off the WFC module instance, and that is
//  the whole point: MenuStack.prev() discards the module and builds a fresh one
//  on the way back in, so an inbox living on the instance would lose anything
//  unread the moment the op stepped away to look at something else. The
//  interrupt queue it takes delivery from is per-connection
//  (client.js, `new UserInterruptQueue(this)`), and this matches that lifetime.
//
//  Reach it through UserInterruptQueue-style access rather than constructing
//  one per menu visit:
//
//      const inbox = WfcInbox.forClient(client);
//
const DefaultMaxItems = 50;

class WfcInbox {
    constructor(maxItems = DefaultMaxItems) {
        this.items = [];
        this.maxItems = maxItems;
        this._nextId = 1;
    }

    //  One inbox per connection, created on first use so a caller who never
    //  visits the WFC pays nothing for it.
    static forClient(client, maxItems) {
        if (!client.wfcInbox) {
            client.wfcInbox = new WfcInbox(maxItems);
        }
        return client.wfcInbox;
    }

    static hasInbox(client) {
        return !!client.wfcInbox;
    }

    //  Oldest first, matching the order the interrupt queue drains in.
    add(interruptItem) {
        const entry = {
            id: this._nextId++,
            type: interruptItem.type,
            from: interruptItem.from || {},
            text: interruptItem.text || '',
            contents: interruptItem.contents,
            timestamp: Date.now(),
            read: false,
        };

        this.items.push(entry);

        //  Bounded: drop the oldest *read* item first, and only fall back to
        //  dropping unread when everything is unread. Losing something the op
        //  has not seen is the worst outcome here.
        while (this.items.length > this.maxItems) {
            const idx = this.items.findIndex(i => i.read);
            this.items.splice(idx > -1 ? idx : 0, 1);
        }

        return entry;
    }

    get(id) {
        return this.items.find(i => i.id === id);
    }

    all() {
        return this.items;
    }

    unread() {
        return this.items.filter(i => !i.read);
    }

    count() {
        return this.items.length;
    }

    unreadCount() {
        return this.unread().length;
    }

    markRead(id) {
        const item = this.get(id);
        if (item) {
            item.read = true;
        }
        return item;
    }

    markAllRead() {
        this.items.forEach(i => (i.read = true));
    }

    remove(id) {
        const idx = this.items.findIndex(i => i.id === id);
        if (idx > -1) {
            return this.items.splice(idx, 1)[0];
        }
    }

    clear() {
        this.items = [];
    }

    //  Newest unread, for the single-line "you have mail" indicators.
    latestUnread() {
        return _.findLast(this.items, i => !i.read);
    }
}

module.exports = WfcInbox;
module.exports.DefaultMaxItems = DefaultMaxItems;
