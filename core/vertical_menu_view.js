'use strict';

//  ENiGMA½
const { MenuView } = require('./menu_view.js');
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const { pipeToAnsi } = require('./color_codes.js');

//  deps
const _ = require('lodash');

class VerticalMenuView extends MenuView {
    constructor(options) {
        options.cursor = options.cursor || 'hide';
        options.justify = options.justify || 'left';

        super(options);

        this.focusItemAtTop = true;

        this.initDefaultWidth();

        //  we want page up/page down by default
        if (!_.isObject(options.specialKeyMap)) {
            Object.assign(this.specialKeyMap, {
                'page up': ['page up'],
                'page down': ['page down'],
            });
        }

        this.autoAdjustHeightIfEnabled();
    }

    autoAdjustHeightIfEnabled() {
        if (this.autoAdjustHeight) {
            this.dimens.height =
                this.items.length * (this.itemSpacing + 1) - this.itemSpacing;
            this.dimens.height = Math.min(
                this.dimens.height,
                this.client.term.termHeight - this.position.row
            );
        }
    }

    updateViewVisibleItems() {
        this.maxVisibleItems = Math.ceil(this.dimens.height / (this.itemSpacing + 1));

        const topIndex = (this.focusItemAtTop ? this.focusedItemIndex : 0) || 0;

        this.viewWindow = {
            top: topIndex,
            bottom: Math.min(topIndex + this.maxVisibleItems, this.items.length) - 1,
        };
    }

    drawItem(index) {
        const item = this.items[index];
        if (!item) {
            return;
        }

        const cached = this.getRenderCacheItem(index, item.focused);
        if (cached) {
            return this.client.term.write(
                `${ansi.goto(item.row, this.position.col)}${cached}`
            );
        }

        let text;
        let sgr;
        if (item.focused && this.hasFocusItems()) {
            const focusItem = this.focusItems[index];
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
                : index === this.focusedItemIndex
                  ? this.getFocusSGR()
                  : this.getSGR();
        } else {
            text = strUtil.stylizeString(
                item.text,
                item.focused ? this.focusTextStyle : this.textStyle
            );
            sgr = index === this.focusedItemIndex ? this.getFocusSGR() : this.getSGR();
        }

        if (this.hasTextOverflow()) {
            text = strUtil.renderTruncate(text, {
                length: this.dimens.width,
                omission: this.textOverflow,
            });
        }

        text = `${sgr}${strUtil.pad(
            `${text}${this.styleSGR1}`,
            this.dimens.width,
            this.fillChar,
            this.justify
        )}`;

        this.client.term.write(`${ansi.goto(item.row, this.position.col)}${text}`);
        this.setRenderCacheItem(index, text, item.focused);
    }

    drawRemovedItem(index) {
        if (index <= this.items.length - 1) {
            return;
        }
        const row = this.position.row + index;
        this.client.term.rawWrite(
            `${ansi.goto(row, this.position.col)}${ansi.normal()}${this.fillChar.repeat(
                this.dimens.width
            )}`
        );
    }

    redraw() {
        super.redraw();

        //  :TODO: rename positionCacheExpired to something that makese sense; combine methods for such
        if (this.positionCacheExpired) {
            this.autoAdjustHeightIfEnabled();
            this.updateViewVisibleItems();

            this.positionCacheExpired = false;
        }

        //  erase old items
        //  :TODO: optimize this: only needed if a item is removed or new max width < old.
        if (this.oldDimens) {
            const blank = ' '.repeat(Math.max(this.oldDimens.width, this.dimens.width));
            let row = this.position.row;
            const endRow = row + this.oldDimens.height - 2;

            while (row <= endRow) {
                this.client.term.write(
                    ansi.goto(row, this.position.col) + this.getSGR() + blank
                );
                row += 1;
            }
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
    }

    setHeight(height) {
        super.setHeight(height);

        this.positionCacheExpired = true;
        this.autoAdjustHeight = false;
    }

    setPosition(pos) {
        super.setPosition(pos);

        this.positionCacheExpired = true;
    }

    setFocus(focused) {
        super.setFocus(focused);

        this.redraw();
    }

    setFocusItemIndex(index) {
        super.setFocusItemIndex(index); //  sets this.focusedItemIndex

        const remainAfterFocus = this.focusItemAtTop
            ? this.items.length - index
            : this.items.length;
        if (remainAfterFocus >= this.maxVisibleItems) {
            const topIndex = (this.focusItemAtTop ? this.focusedItemIndex : 0) || 0;

            this.viewWindow = {
                top: topIndex,
                bottom: Math.min(topIndex + this.maxVisibleItems, this.items.length) - 1,
            };

            this.positionCacheExpired = false; //  skip standard behavior
            this.autoAdjustHeightIfEnabled();
        }

        this.redraw();
    }

    onKeyPress(ch, key) {
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

        super.onKeyPress(ch, key);
    }

    getData() {
        const item = this.getItem(this.focusedItemIndex);
        if (!item) {
            return this.focusedItemIndex;
        }
        return _.isString(item.data) ? item.data : this.focusedItemIndex;
    }

    setItems(items) {
        //  if we have items already, save off their drawing area so we don't leave fragments at redraw
        if (this.items && this.items.length) {
            this.oldDimens = Object.assign({}, this.dimens);
        }
        this.focusedItemIndex = 0;

        super.setItems(items);

        this.positionCacheExpired = true;
    }

    removeItem(index) {
        if (this.items && this.items.length) {
            this.oldDimens = Object.assign({}, this.dimens);
        }

        super.removeItem(index);
    }

    //  :TODO: Apply draw optimizaitons when only two items need drawn vs entire view!

    focusNext() {
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

        super.focusNext();
    }

    focusPrevious() {
        if (0 === this.focusedItemIndex) {
            this.focusedItemIndex = this.items.length - 1;

            this.viewWindow = {
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

        super.focusPrevious();
    }

    focusPreviousPageItem() {
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

        return super.focusPreviousPageItem();
    }

    focusNextPageItem() {
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

        return super.focusNextPageItem();
    }

    focusFirst() {
        if (0 < this.viewWindow.top) {
            this.oldDimens = Object.assign({}, this.dimens);
        }
        this.setFocusItemIndex(0);
        return super.focusFirst();
    }

    focusLast() {
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

        return super.focusLast();
    }

    setTextOverflow(overflow) {
        super.setTextOverflow(overflow);

        this.positionCacheExpired = true;
    }

    setFocusItems(items) {
        super.setFocusItems(items);

        this.positionCacheExpired = true;
    }

    setItemSpacing(itemSpacing) {
        super.setItemSpacing(itemSpacing);

        this.positionCacheExpired = true;
    }

    setPropertyValue(propName, value) {
        if (propName === 'focusItemAtTop' && _.isBoolean(value)) {
            this.focusItemAtTop = value;
        }

        super.setPropertyValue(propName, value);
    }
}

exports.VerticalMenuView = VerticalMenuView;
