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

    //  Build a viewWindow anchored at topIndex, clamped to items.length
    _windowFromTop(topIndex) {
        return {
            top: topIndex,
            bottom: Math.min(topIndex + this.maxVisibleItems, this.items.length) - 1,
        };
    }

    //  Build a viewWindow anchored to the bottom of the list (used near end / wrap-around)
    _windowToBottom() {
        const bottom = this.items.length - 1;
        return {
            top: Math.max(0, bottom - this.maxVisibleItems + 1),
            bottom,
        };
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

        this.viewWindow = this._windowFromTop(topIndex);
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
        const row = this.position.row + index * (this.itemSpacing + 1);
        this.client.term.rawWrite(
            `${ansi.goto(row, this.position.col)}${ansi.normal()}${this.fillChar.repeat(
                this.dimens.width
            )}`
        );
    }

    redraw() {
        super.redraw();

        //  :TODO: rename positionCacheExpired to something that makes sense; combine methods for such
        if (this.positionCacheExpired) {
            this.autoAdjustHeightIfEnabled();
            this.updateViewVisibleItems();

            this.positionCacheExpired = false;
        }

        //  erase previous drawing area; only set when the item list changes
        //  (e.g. setItems / removeItem) where the footprint may shrink
        if (this.oldDimens) {
            const blank = ' '.repeat(Math.max(this.oldDimens.width, this.dimens.width));
            let row = this.position.row;
            const endRow = row + this.oldDimens.height - 1;

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

        //  blank any rows below the last drawn item within the view footprint;
        //  handles partial last pages and lists shorter than the view height
        const numDrawn = this.items.length
            ? this.viewWindow.bottom - this.viewWindow.top + 1
            : 0;
        const firstUnusedRow = this.position.row + numDrawn * (this.itemSpacing + 1);
        const viewBottomRow = this.position.row + this.dimens.height - 1;

        if (firstUnusedRow <= viewBottomRow) {
            const blank = this.getSGR() + this.fillChar.repeat(this.dimens.width);
            for (let row = firstUnusedRow; row <= viewBottomRow; row++) {
                this.client.term.write(ansi.goto(row, this.position.col) + blank);
            }
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
            //  enough items below focus to fill a full window — anchor at focus
            const topIndex = (this.focusItemAtTop ? this.focusedItemIndex : 0) || 0;
            this.viewWindow = this._windowFromTop(topIndex);
        } else {
            //  near the end of the list — anchor window to show as many items as possible
            this.viewWindow = this._windowToBottom();
        }

        this.autoAdjustHeightIfEnabled();
        this.positionCacheExpired = false; //  window already set; suppress recalc in redraw()

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
        //  save current drawing area so redraw() can erase any leftover rows
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

    //  Redraws only the two items whose focus state changed.
    //  item.row is guaranteed valid from the last full redraw() since this is only
    //  called when the viewWindow has not scrolled.
    _focusRedraw(prevFocusedIndex) {
        if (this.items[prevFocusedIndex] && this.items[prevFocusedIndex].row == null) {
            //  item.row not yet set — fall back to a full redraw
            return this.redraw();
        }

        if (
            prevFocusedIndex !== this.focusedItemIndex &&
            prevFocusedIndex >= this.viewWindow.top &&
            prevFocusedIndex <= this.viewWindow.bottom
        ) {
            this.items[prevFocusedIndex].focused = false;
            this.drawItem(prevFocusedIndex);
        }

        this.items[this.focusedItemIndex].focused = true;
        this.drawItem(this.focusedItemIndex);
    }

    focusNext() {
        if (this.items.length - 1 === this.focusedItemIndex) {
            //  wrap-around: viewWindow changes — full redraw
            this.focusedItemIndex = 0;
            this.viewWindow = this._windowFromTop(0);
            this.redraw();
        } else {
            const prevIndex = this.focusedItemIndex;
            this.focusedItemIndex++;

            if (this.focusedItemIndex > this.viewWindow.bottom) {
                //  scrolled — full redraw
                this.viewWindow.top++;
                this.viewWindow.bottom++;
                this.redraw();
            } else {
                //  focus moved within the visible window — redraw only the two changed items
                this._focusRedraw(prevIndex);
            }
        }

        super.focusNext();
    }

    focusPrevious() {
        if (0 === this.focusedItemIndex) {
            //  wrap-around: viewWindow changes — full redraw
            this.focusedItemIndex = this.items.length - 1;
            this.viewWindow = this._windowToBottom();
            this.redraw();
        } else {
            const prevIndex = this.focusedItemIndex;
            this.focusedItemIndex--;

            if (this.focusedItemIndex < this.viewWindow.top) {
                //  scrolled — full redraw
                this.viewWindow.top--;
                this.viewWindow.bottom--;

                //  when scrolling up from a partial last page, expand the window
                //  to show as many items as possible below the new top
                const windowSize = this.viewWindow.bottom - this.viewWindow.top + 1;
                if (
                    windowSize < this.maxVisibleItems &&
                    this.items.length - 1 > this.focusedItemIndex
                ) {
                    this.viewWindow.bottom = this.items.length - 1;
                }
                this.redraw();
            } else {
                //  focus moved within the visible window — redraw only the two changed items
                this._focusRedraw(prevIndex);
            }
        }

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

        const index = Math.max(this.focusedItemIndex - this.maxVisibleItems, 0);

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

        this.setFocusItemIndex(index);

        return super.focusNextPageItem();
    }

    focusFirst() {
        this.setFocusItemIndex(0);
        return super.focusFirst();
    }

    focusLast() {
        this.setFocusItemIndex(this.items.length - 1);
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
