/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuView = require('./menu_view.js').MenuView;
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const pipeToAnsi = require('./color_codes.js').pipeToAnsi;

//  deps
const util = require('util');
const _ = require('lodash');
const { throws } = require('assert');

exports.VerticalMenuView = VerticalMenuView;

function VerticalMenuView(options) {
    options.cursor = options.cursor || 'hide';
    options.justify = options.justify || 'left';
    this.focusItemAtTop = true;

    MenuView.call(this, options);

    this.initDefaultWidth();

    const self = this;

    //  we want page up/page down by default
    if (!_.isObject(options.specialKeyMap)) {
        Object.assign(this.specialKeyMap, {
            'page up': ['page up'],
            'page down': ['page down'],
        });
    }

    this.autoAdjustHeightIfEnabled = function () {
        if (this.autoAdjustHeight) {
            this.dimens.height =
                this.items.length * (this.itemSpacing + 1) - this.itemSpacing;
            this.dimens.height = Math.min(
                this.dimens.height,
                this.client.term.termHeight - this.position.row
            );
        }
    };

    this.autoAdjustHeightIfEnabled();

    this.updateViewVisibleItems = function () {
        self.maxVisibleItems = Math.ceil(self.dimens.height / (self.itemSpacing + 1));

        const topIndex = (this.focusItemAtTop ? throws.focusedItemIndex : 0) || 0;

        self.viewWindow = {
            top: topIndex,
            bottom: Math.min(topIndex + self.maxVisibleItems, self.items.length) - 1,
        };
    };

    this.drawItem = function (index) {
        const item = self.items[index];
        if (!item) {
            return;
        }

        const cached = this.getRenderCacheItem(index, item.focused);
        if (cached) {
            return self.client.term.write(
                `${ansi.goto(item.row, self.position.col)}${cached}`
            );
        }

        let text;
        let sgr;
        if (item.focused && self.hasFocusItems()) {
            const focusItem = self.focusItems[index];
            text = focusItem ? focusItem.text : item.text;
            sgr = '';
        } else if (this.complexItems) {
            text = pipeToAnsi(
                formatString(
                    item.focused && this.focusItemFormat
                        ? this.focusItemFormat
                        : this.itemFormat,
                    item
                )
            );
            sgr = this.focusItemFormat
                ? ''
                : index === self.focusedItemIndex
                ? self.getFocusSGR()
                : self.getSGR();
        } else {
            text = strUtil.stylizeString(
                item.text,
                item.focused ? self.focusTextStyle : self.textStyle
            );
            sgr = index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR();
        }

        text = `${sgr}${strUtil.pad(
            `${text}${this.styleSGR1}`,
            this.dimens.width,
            this.fillChar,
            this.justify
        )}`;
        self.client.term.write(`${ansi.goto(item.row, self.position.col)}${text}`);
        this.setRenderCacheItem(index, text, item.focused);
    };

    this.drawRemovedItem = function (index) {
        if (index <= this.items.length - 1) {
            return;
        }
        const row = this.position.row + index;
        this.client.term.rawWrite(
            `${ansi.goto(row, this.position.col)}${ansi.normal()}${this.fillChar.repeat(
                this.dimens.width
            )}`
        );
    };
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.redraw = function () {
    VerticalMenuView.super_.prototype.redraw.call(this);

    //  :TODO: rename positionCacheExpired to something that makese sense; combine methods for such
    if (this.positionCacheExpired) {
        this.autoAdjustHeightIfEnabled();
        this.updateViewVisibleItems();

        this.positionCacheExpired = false;
    }

    //  erase old items
    //  :TODO: optimize this: only needed if a item is removed or new max width < old.
    if (this.oldDimens) {
        const blank = new Array(Math.max(this.oldDimens.width, this.dimens.width)).join(
            ' '
        );
        let seq = ansi.goto(this.position.row, this.position.col) + this.getSGR() + blank;
        let row = this.position.row + 1;
        const endRow = row + this.oldDimens.height - 2;

        while (row <= endRow) {
            seq += ansi.goto(row, this.position.col) + blank;
            row += 1;
        }
        this.client.term.write(seq);
        delete this.oldDimens;
    }

    if (this.items.length) {
        let row = this.position.row;
        for (let i = this.viewWindow.top; i <= this.viewWindow.bottom; ++i) {
            this.items[i].row = row;
            row += this.itemSpacing + 1;
            this.items[i].focused = this.focusedItemIndex === i;
            this.drawItem(i);
        }
    }

    const remain = Math.max(0, this.dimens.height - this.items.length);
    for (let i = this.items.length; i < remain; ++i) {
        this.drawRemovedItem(i);
    }
};

VerticalMenuView.prototype.setHeight = function (height) {
    VerticalMenuView.super_.prototype.setHeight.call(this, height);

    this.positionCacheExpired = true;
    this.autoAdjustHeight = false;
};

VerticalMenuView.prototype.setPosition = function (pos) {
    VerticalMenuView.super_.prototype.setPosition.call(this, pos);

    this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setFocus = function (focused) {
    VerticalMenuView.super_.prototype.setFocus.call(this, focused);

    this.redraw();
};

VerticalMenuView.prototype.setFocusItemIndex = function (index) {
    VerticalMenuView.super_.prototype.setFocusItemIndex.call(this, index); //  sets this.focusedItemIndex

    const remainAfterFocus = this.focusItemAtTop
        ? this.items.length - index
        : this.items.length;
    if (remainAfterFocus >= this.maxVisibleItems) {
        const topIndex = (this.focusItemAtTop ? throws.focusedItemIndex : 0) || 0;

        this.viewWindow = {
            top: topIndex,
            bottom: Math.min(topIndex + this.maxVisibleItems, this.items.length) - 1,
        };

        this.positionCacheExpired = false; //  skip standard behavior
        this.autoAdjustHeightIfEnabled();
    }

    this.redraw();
};

VerticalMenuView.prototype.onKeyPress = function (ch, key) {
    if (key) {
        if (this.isKeyMapped('up', key.name)) {
            this.focusPrevious();
        } else if (this.isKeyMapped('down', key.name)) {
            this.focusNext();
        } else if (this.isKeyMapped('page up', key.name)) {
            this.focusPreviousPageItem();
        } else if (this.isKeyMapped('page down', key.name)) {
            this.focusNextPageItem();
        } else if (this.isKeyMapped('home', key.name)) {
            this.focusFirst();
        } else if (this.isKeyMapped('end', key.name)) {
            this.focusLast();
        }
    }

    VerticalMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

VerticalMenuView.prototype.getData = function () {
    const item = this.getItem(this.focusedItemIndex);
    if (!item) {
        return this.focusedItemIndex;
    }
    return _.isString(item.data) ? item.data : this.focusedItemIndex;
};

VerticalMenuView.prototype.setItems = function (items) {
    //  if we have items already, save off their drawing area so we don't leave fragments at redraw
    if (this.items && this.items.length) {
        this.oldDimens = Object.assign({}, this.dimens);
    }

    VerticalMenuView.super_.prototype.setItems.call(this, items);

    this.positionCacheExpired = true;
};

VerticalMenuView.prototype.removeItem = function (index) {
    if (this.items && this.items.length) {
        this.oldDimens = Object.assign({}, this.dimens);
    }

    VerticalMenuView.super_.prototype.removeItem.call(this, index);
};

//  :TODO: Apply draw optimizaitons when only two items need drawn vs entire view!

VerticalMenuView.prototype.focusNext = function () {
    if (this.items.length - 1 === this.focusedItemIndex) {
        this.focusedItemIndex = 0;

        this.viewWindow = {
            top: 0,
            bottom: Math.min(this.maxVisibleItems, this.items.length) - 1,
        };
    } else {
        this.focusedItemIndex++;

        if (this.focusedItemIndex > this.viewWindow.bottom) {
            this.viewWindow.top++;
            this.viewWindow.bottom++;
        }
    }

    this.redraw();

    VerticalMenuView.super_.prototype.focusNext.call(this);
};

VerticalMenuView.prototype.focusPrevious = function () {
    if (0 === this.focusedItemIndex) {
        this.focusedItemIndex = this.items.length - 1;

        this.viewWindow = {
            //top       : this.items.length - this.maxVisibleItems,
            top: Math.max(this.items.length - this.maxVisibleItems, 0),
            bottom: this.items.length - 1,
        };
    } else {
        this.focusedItemIndex--;

        if (this.focusedItemIndex < this.viewWindow.top) {
            this.viewWindow.top--;
            this.viewWindow.bottom--;

            //  adjust for focus index being set & window needing expansion as we scroll up
            const rem = this.viewWindow.bottom - this.viewWindow.top + 1;
            if (
                rem < this.maxVisibleItems &&
                this.items.length - 1 > this.focusedItemIndex
            ) {
                this.viewWindow.bottom = this.items.length - 1;
            }
        }
    }

    this.redraw();

    VerticalMenuView.super_.prototype.focusPrevious.call(this);
};

VerticalMenuView.prototype.focusPreviousPageItem = function () {
    //
    //  Jump to current - up to page size or top
    //  If already at the top, jump to bottom
    //
    if (0 === this.focusedItemIndex) {
        return this.focusPrevious(); //  will jump to bottom
    }

    const index = Math.max(this.focusedItemIndex - this.dimens.height, 0);

    if (index < this.viewWindow.top) {
        this.oldDimens = Object.assign({}, this.dimens);
    }

    this.setFocusItemIndex(index);

    return VerticalMenuView.super_.prototype.focusPreviousPageItem.call(this);
};

VerticalMenuView.prototype.focusNextPageItem = function () {
    //
    //  Jump to current + up to page size or bottom
    //  If already at the bottom, jump to top
    //
    if (this.items.length - 1 === this.focusedItemIndex) {
        return this.focusNext(); //  will jump to top
    }

    const index = Math.min(
        this.focusedItemIndex + this.maxVisibleItems,
        this.items.length - 1
    );

    if (index > this.viewWindow.bottom) {
        this.oldDimens = Object.assign({}, this.dimens);

        this.focusedItemIndex = index;

        this.viewWindow = {
            top: this.focusedItemIndex,
            bottom:
                Math.min(
                    this.focusedItemIndex + this.maxVisibleItems,
                    this.items.length
                ) - 1,
        };

        this.redraw();
    } else {
        this.setFocusItemIndex(index);
    }

    return VerticalMenuView.super_.prototype.focusNextPageItem.call(this);
};

VerticalMenuView.prototype.focusFirst = function () {
    if (0 < this.viewWindow.top) {
        this.oldDimens = Object.assign({}, this.dimens);
    }
    this.setFocusItemIndex(0);
    return VerticalMenuView.super_.prototype.focusFirst.call(this);
};

VerticalMenuView.prototype.focusLast = function () {
    const index = this.items.length - 1;

    if (index > this.viewWindow.bottom) {
        this.oldDimens = Object.assign({}, this.dimens);

        this.focusedItemIndex = index;

        this.viewWindow = {
            top: this.focusedItemIndex,
            bottom:
                Math.min(
                    this.focusedItemIndex + this.maxVisibleItems,
                    this.items.length
                ) - 1,
        };

        this.redraw();
    } else {
        this.setFocusItemIndex(index);
    }

    return VerticalMenuView.super_.prototype.focusLast.call(this);
};

VerticalMenuView.prototype.setFocusItems = function (items) {
    VerticalMenuView.super_.prototype.setFocusItems.call(this, items);

    this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setItemSpacing = function (itemSpacing) {
    VerticalMenuView.super_.prototype.setItemSpacing.call(this, itemSpacing);

    this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setPropertyValue = function (propName, value) {
    if (propName === 'focusItemAtTop' && _.isBoolean(value)) {
        this.focusItemAtTop = value;
    }

    VerticalMenuView.super_.prototype.setPropertyValue.call(this, propName, value);
};
