/* jslint node: true */
'use strict';

//  ENiGMA½
const View = require('./view.js').View;
const miscUtil = require('./misc_util.js');
const pipeToAnsi = require('./color_codes.js').pipeToAnsi;

//  deps
const util = require('util');
const assert = require('assert');
const _ = require('lodash');

exports.MenuView = MenuView;

function MenuView(options) {
    options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
    options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

    View.call(this, options);

    this.disablePipe = options.disablePipe || false;

    const self = this;

    if (options.items) {
        this.setItems(options.items);
    } else {
        this.items = [];
    }

    this.renderCache = {};

    this.caseInsensitiveHotKeys = miscUtil.valueWithDefault(
        options.caseInsensitiveHotKeys,
        true
    );

    this.setHotKeys(options.hotKeys);

    this.focusedItemIndex = options.focusedItemIndex || 0;
    this.focusedItemIndex =
        this.items.length >= this.focusedItemIndex ? this.focusedItemIndex : 0;

    this.itemSpacing = _.isNumber(options.itemSpacing) ? options.itemSpacing : 0;
    this.itemHorizSpacing = _.isNumber(options.itemHorizSpacing)
        ? options.itemHorizSpacing
        : 0;

    //  :TODO: probably just replace this with owner draw / pipe codes / etc. more control, less specialization
    this.focusPrefix = options.focusPrefix || '';
    this.focusSuffix = options.focusSuffix || '';

    this.fillChar = miscUtil.valueWithDefault(options.fillChar, ' ').substr(0, 1);

    this.hasFocusItems = function () {
        return !_.isUndefined(self.focusItems);
    };

    this.getHotKeyItemIndex = function (ch) {
        if (ch && self.hotKeys) {
            const keyIndex =
                self.hotKeys[self.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
            if (_.isNumber(keyIndex)) {
                return keyIndex;
            }
        }
        return -1;
    };

    this.emitIndexUpdate = function () {
        self.emit('index update', self.focusedItemIndex);
    };
}

util.inherits(MenuView, View);

MenuView.prototype.setTextOverflow = function (overflow) {
    this.textOverflow = overflow;
    this.invalidateRenderCache();
};

MenuView.prototype.hasTextOverflow = function () {
    return this.textOverflow != undefined;
};

MenuView.prototype.setItems = function (items) {
    if (Array.isArray(items)) {
        this.sorted = false;
        this.renderCache = {};

        //
        //  Items can be an array of strings or an array of objects.
        //
        //  In the case of objects, items are considered complex and
        //  may have one or more members that can later be formatted
        //  against. The default member is 'text'. The member 'data'
        //  may be overridden to provide a form value other than the
        //  item's index.
        //
        //  Items can be formatted with 'itemFormat' and 'focusItemFormat'
        //
        let text;
        let stringItem;
        this.items = items.map(item => {
            stringItem = _.isString(item);
            if (stringItem) {
                text = item;
            } else {
                text = item.text || '';
                this.complexItems = true;
            }

            text = this.disablePipe ? text : pipeToAnsi(text, this.client);
            return Object.assign({}, { text }, stringItem ? {} : item); //  ensure we have a text member, plus any others
        });

        if (this.complexItems) {
            this.itemFormat = this.itemFormat || '{text}';
        }

        this.invalidateRenderCache();
    }
};

MenuView.prototype.getRenderCacheItem = function (index, focusItem = false) {
    const item = this.renderCache[index];
    return item && item[focusItem ? 'focus' : 'standard'];
};

MenuView.prototype.removeRenderCacheItem = function (index) {
    delete this.renderCache[index];
};

MenuView.prototype.setRenderCacheItem = function (index, rendered, focusItem = false) {
    this.renderCache[index] = this.renderCache[index] || {};
    this.renderCache[index][focusItem ? 'focus' : 'standard'] = rendered;
};

MenuView.prototype.invalidateRenderCache = function () {
    this.renderCache = {};
};

MenuView.prototype.setSort = function (sort) {
    if (this.sorted || !Array.isArray(this.items) || 0 === this.items.length) {
        return;
    }

    const key = true === sort ? 'text' : sort;
    if ('text' !== sort && !this.complexItems) {
        return; //  need a valid sort key
    }

    this.items.sort((a, b) => {
        const a1 = a[key];
        const b1 = b[key];
        if (!a1) {
            return -1;
        }
        if (!b1) {
            return 1;
        }
        return a1.localeCompare(b1, { sensitivity: false, numeric: true });
    });

    this.sorted = true;
};

MenuView.prototype.removeItem = function (index) {
    this.sorted = false;
    this.items.splice(index, 1);

    if (this.focusItems) {
        this.focusItems.splice(index, 1);
    }

    if (this.focusedItemIndex >= index) {
        this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
    }

    this.removeRenderCacheItem(index);

    this.positionCacheExpired = true;
};

MenuView.prototype.getCount = function () {
    return this.items.length;
};

MenuView.prototype.getItems = function () {
    if (this.complexItems) {
        return this.items;
    }

    return this.items.map(item => {
        return item.text;
    });
};

MenuView.prototype.getItem = function (index) {
    if (index > this.items.length - 1) {
        return null;
    }

    if (this.complexItems) {
        return this.items[index];
    }

    return this.items[index].text;
};

MenuView.prototype.focusNext = function () {
    this.emitIndexUpdate();
};

MenuView.prototype.focusPrevious = function () {
    this.emitIndexUpdate();
};

MenuView.prototype.focusNextPageItem = function () {
    this.emitIndexUpdate();
};

MenuView.prototype.focusPreviousPageItem = function () {
    this.emitIndexUpdate();
};

MenuView.prototype.focusFirst = function () {
    this.emitIndexUpdate();
};

MenuView.prototype.focusLast = function () {
    this.emitIndexUpdate();
};

MenuView.prototype.setFocusItemIndex = function (index) {
    this.focusedItemIndex = index;
};

MenuView.prototype.getFocusItemIndex = function () {
    return this.focusedItemIndex;
};

MenuView.prototype.onKeyPress = function (ch, key) {
    const itemIndex = this.getHotKeyItemIndex(ch);
    if (itemIndex >= 0) {
        this.setFocusItemIndex(itemIndex);

        if (true === this.hotKeySubmit) {
            this.emit('action', 'accept');
        }
    }

    MenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

MenuView.prototype.setFocusItems = function (items) {
    const self = this;

    if (items) {
        this.focusItems = [];
        items.forEach(itemText => {
            this.focusItems.push({
                text: self.disablePipe ? itemText : pipeToAnsi(itemText, self.client),
            });
        });
    }
};

MenuView.prototype.setItemSpacing = function (itemSpacing) {
    itemSpacing = parseInt(itemSpacing);
    assert(_.isNumber(itemSpacing));

    this.itemSpacing = itemSpacing;
    this.positionCacheExpired = true;
};

MenuView.prototype.setItemHorizSpacing = function (itemHorizSpacing) {
    itemHorizSpacing = parseInt(itemHorizSpacing);
    assert(_.isNumber(itemHorizSpacing));

    this.itemHorizSpacing = itemHorizSpacing;
    this.positionCacheExpired = true;
};

MenuView.prototype.setPropertyValue = function (propName, value) {
    switch (propName) {
        case 'itemSpacing':
            this.setItemSpacing(value);
            break;
        case 'itemHorizSpacing':
            this.setItemHorizSpacing(value);
            break;
        case 'items':
            this.setItems(value);
            break;
        case 'focusItems':
            this.setFocusItems(value);
            break;
        case 'hotKeys':
            this.setHotKeys(value);
            break;
        case 'textOverflow':
            this.setTextOverflow(value);
            break;
        case 'hotKeySubmit':
            this.hotKeySubmit = value;
            break;
        case 'justify':
            this.setJustify(value);
            break;
        case 'fillChar':
            this.setFillChar(value);
            break;
        case 'focusItemIndex':
            this.focusedItemIndex = value;
            break;

        case 'itemFormat':
        case 'focusItemFormat':
            this[propName] = value;
            // if there is a cache currently, invalidate it
            this.invalidateRenderCache();
            break;

        case 'sort':
            this.setSort(value);
            break;
    }

    MenuView.super_.prototype.setPropertyValue.call(this, propName, value);
};

MenuView.prototype.setFillChar = function (fillChar) {
    this.fillChar = miscUtil.valueWithDefault(fillChar, ' ').substr(0, 1);
    this.invalidateRenderCache();
};

MenuView.prototype.setJustify = function (justify) {
    this.justify = justify;
    this.invalidateRenderCache();
    this.positionCacheExpired = true;
};

MenuView.prototype.setHotKeys = function (hotKeys) {
    if (_.isObject(hotKeys)) {
        if (this.caseInsensitiveHotKeys) {
            this.hotKeys = {};
            for (var key in hotKeys) {
                this.hotKeys[key.toLowerCase()] = hotKeys[key];
            }
        } else {
            this.hotKeys = hotKeys;
        }
    }
};
