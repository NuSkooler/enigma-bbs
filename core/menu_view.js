'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const miscUtil = require('./misc_util.js');
const { pipeToAnsi } = require('./color_codes.js');

//  deps
const assert = require('assert');
const _ = require('lodash');

class MenuView extends View {
    constructor(options) {
        options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

        super(options);

        this.disablePipe = options.disablePipe || false;

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
            this.items.length > this.focusedItemIndex ? this.focusedItemIndex : 0;

        this.itemSpacing = _.isNumber(options.itemSpacing) ? options.itemSpacing : 0;
        this.itemHorizSpacing = _.isNumber(options.itemHorizSpacing)
            ? options.itemHorizSpacing
            : 0;

        //  :TODO: probably just replace this with owner draw / pipe codes / etc. more control, less specialization
        this.focusPrefix = options.focusPrefix || '';
        this.focusSuffix = options.focusSuffix || '';

        this.fillChar = miscUtil.valueWithDefault(options.fillChar, ' ').substr(0, 1);
    }

    hasFocusItems() {
        return !_.isUndefined(this.focusItems);
    }

    getHotKeyItemIndex(ch) {
        if (ch && this.hotKeys) {
            const keyIndex =
                this.hotKeys[this.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
            if (_.isNumber(keyIndex)) {
                return keyIndex;
            }
        }
        return -1;
    }

    emitIndexUpdate() {
        this.emit('index update', this.focusedItemIndex);
    }

    setTextOverflow(overflow) {
        this.textOverflow = overflow;
        this.invalidateRenderCache();
    }

    hasTextOverflow() {
        return this.textOverflow != undefined;
    }

    setItems(items) {
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
            this.items = items.map(item => {
                const stringItem = _.isString(item);
                const text = stringItem
                    ? item
                    : (() => {
                          if (!stringItem) this.complexItems = true;
                          return item.text || '';
                      })();

                const displayText = this.disablePipe
                    ? text
                    : pipeToAnsi(text, this.client);
                return Object.assign({}, { text: displayText }, stringItem ? {} : item);
            });

            if (this.complexItems) {
                this.itemFormat = this.itemFormat || '{text}';
            }

            this.invalidateRenderCache();
        }
    }

    getRenderCacheItem(index, focusItem = false) {
        const item = this.renderCache[index];
        return item && item[focusItem ? 'focus' : 'standard'];
    }

    removeRenderCacheItem(index) {
        delete this.renderCache[index];
    }

    setRenderCacheItem(index, rendered, focusItem = false) {
        this.renderCache[index] = this.renderCache[index] || {};
        this.renderCache[index][focusItem ? 'focus' : 'standard'] = rendered;
    }

    invalidateRenderCache() {
        this.renderCache = {};
    }

    setSort(sort) {
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
            return a1.localeCompare(b1, undefined, {
                sensitivity: 'base',
                numeric: true,
            });
        });

        this.sorted = true;
    }

    removeItem(index) {
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
    }

    getCount() {
        return this.items.length;
    }

    getItems() {
        if (this.complexItems) {
            return this.items;
        }

        return this.items.map(item => item.text);
    }

    getItem(index) {
        if (index > this.items.length - 1) {
            return null;
        }

        if (this.complexItems) {
            return this.items[index];
        }

        return this.items[index].text;
    }

    focusNext() {
        this.emitIndexUpdate();
    }

    focusPrevious() {
        this.emitIndexUpdate();
    }

    focusNextPageItem() {
        this.emitIndexUpdate();
    }

    focusPreviousPageItem() {
        this.emitIndexUpdate();
    }

    focusFirst() {
        this.emitIndexUpdate();
    }

    focusLast() {
        this.emitIndexUpdate();
    }

    setFocusItemIndex(index) {
        this.focusedItemIndex = index;
    }

    getFocusItemIndex() {
        return this.focusedItemIndex;
    }

    onKeyPress(ch, key) {
        const itemIndex = this.getHotKeyItemIndex(ch);
        if (itemIndex >= 0) {
            this.setFocusItemIndex(itemIndex);

            if (true === this.hotKeySubmit) {
                this.emit('action', 'accept');
            }
        }

        super.onKeyPress(ch, key);
    }

    setFocusItems(items) {
        if (items) {
            this.focusItems = [];
            items.forEach(itemText => {
                this.focusItems.push({
                    text: this.disablePipe ? itemText : pipeToAnsi(itemText, this.client),
                });
            });
        }
    }

    setItemSpacing(itemSpacing) {
        itemSpacing = parseInt(itemSpacing);
        assert(_.isNumber(itemSpacing));

        this.itemSpacing = itemSpacing;
        this.positionCacheExpired = true;
    }

    setItemHorizSpacing(itemHorizSpacing) {
        itemHorizSpacing = parseInt(itemHorizSpacing);
        assert(_.isNumber(itemHorizSpacing));

        this.itemHorizSpacing = itemHorizSpacing;
        this.positionCacheExpired = true;
    }

    setPropertyValue(propName, value) {
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
                this.invalidateRenderCache();
                break;

            case 'sort':
                this.setSort(value);
                break;
        }

        super.setPropertyValue(propName, value);
    }

    setFillChar(fillChar) {
        this.fillChar = miscUtil.valueWithDefault(fillChar, ' ').substr(0, 1);
        this.invalidateRenderCache();
    }

    setJustify(justify) {
        this.justify = justify;
        this.invalidateRenderCache();
        this.positionCacheExpired = true;
    }

    setHotKeys(hotKeys) {
        if (_.isObject(hotKeys)) {
            if (this.caseInsensitiveHotKeys) {
                this.hotKeys = {};
                for (const key in hotKeys) {
                    this.hotKeys[key.toLowerCase()] = hotKeys[key];
                }
            } else {
                this.hotKeys = hotKeys;
            }
        }
    }
}

exports.MenuView = MenuView;
