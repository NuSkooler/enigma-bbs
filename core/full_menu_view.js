'use strict';

//  ENiGMA½
const { MenuView } = require('./menu_view.js');
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const { pipeToAnsi } = require('./color_codes.js');

//  deps
const _ = require('lodash');

class FullMenuView extends MenuView {
    constructor(options) {
        options.cursor = options.cursor || 'hide';
        options.justify = options.justify || 'left';

        super(options);

        // Initialize paging
        this.pages = [];
        this.currentPage = 0;

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

        this.positionCacheExpired = true;
    }

    clearPage() {
        let width = this.dimens.width;
        if (this.oldDimens) {
            if (this.oldDimens.width > width) {
                width = this.oldDimens.width;
            }
            delete this.oldDimens;
        }

        for (let i = 0; i < this.dimens.height; i++) {
            const text = strUtil.pad('', width, this.fillChar);
            this.client.term.write(
                `${ansi.goto(
                    this.position.row + i,
                    this.position.col
                )}${this.getSGR()}${text}`
            );
        }
    }

    cachePositions() {
        if (this.positionCacheExpired) {
            // first, clear the page
            this.clearPage();

            this.autoAdjustHeightIfEnabled();

            this.pages = []; // reset
            this.currentPage = 0; // reset currentPage when pages reset

            // Calculate number of items visible per column
            this.itemsPerRow = Math.floor(this.dimens.height / (this.itemSpacing + 1));
            // handle case where one can fit at the end
            if (this.dimens.height > this.itemsPerRow * (this.itemSpacing + 1)) {
                this.itemsPerRow++;
            }

            // Final check to make sure we don't try to display more than we have
            if (this.itemsPerRow > this.items.length) {
                this.itemsPerRow = this.items.length;
            }

            let col = this.position.col;
            let row = this.position.row;
            const spacer = new Array(this.itemHorizSpacing + 1).join(this.fillChar);

            let itemInRow = 0;
            let itemInCol = 0;

            let pageStart = 0;

            for (let i = 0; i < this.items.length; ++i) {
                itemInRow++;
                this.items[i].row = row;
                this.items[i].col = col;
                this.items[i].itemInRow = itemInRow;

                row += this.itemSpacing + 1;

                // have to calculate the max length on the last entry
                if (i == this.items.length - 1) {
                    let maxLength = 0;
                    for (let j = 0; j < this.itemsPerRow; j++) {
                        if (this.items[i - j].col != this.items[i].col) {
                            break;
                        }
                        const itemLength = this.items[i - j].text.length;
                        if (itemLength > maxLength) {
                            maxLength = itemLength;
                        }
                    }

                    // set length on each item in the column
                    for (let j = 0; j < this.itemsPerRow; j++) {
                        if (this.items[i - j].col != this.items[i].col) {
                            break;
                        }
                        this.items[i - j].fixedLength = maxLength;
                    }

                    // Check if we have room for this column
                    // skip for column 0, we need at least one
                    if (itemInCol != 0 && col + maxLength > this.dimens.width) {
                        // save previous page
                        this.pages.push({ start: pageStart, end: i - itemInRow });

                        // fix the last column processed
                        for (let j = 0; j < this.itemsPerRow; j++) {
                            if (this.items[i - j].col != col) {
                                break;
                            }
                            this.items[i - j].col = this.position.col;
                            pageStart = i - j;
                        }
                    }

                    // Since this is the last page, save the current page as well
                    this.pages.push({ start: pageStart, end: i });
                }
                // also handle going to next column
                else if (itemInRow == this.itemsPerRow) {
                    itemInRow = 0;

                    // restart row for next column
                    row = this.position.row;
                    let maxLength = 0;
                    for (let j = 0; j < this.itemsPerRow; j++) {
                        // TODO: handle complex items
                        const itemLength = this.items[i - j].text.length;
                        if (itemLength > maxLength) {
                            maxLength = itemLength;
                        }
                    }

                    // set length on each item in the column
                    for (let j = 0; j < this.itemsPerRow; j++) {
                        this.items[i - j].fixedLength = maxLength;
                    }

                    // Check if we have room for this column in the current page
                    // skip for first column, we need at least one
                    if (itemInCol != 0 && col + maxLength > this.dimens.width) {
                        // save previous page
                        this.pages.push({ start: pageStart, end: i - this.itemsPerRow });

                        // restart page start for next page
                        pageStart = i - this.itemsPerRow + 1;

                        // reset
                        col = this.position.col;
                        itemInRow = 0;

                        // fix the last column processed
                        for (let j = 0; j < this.itemsPerRow; j++) {
                            this.items[i - j].col = col;
                        }
                    }

                    // increment the column
                    col += maxLength + spacer.length;
                    itemInCol++;
                }

                // Set the current page if the current item is focused.
                if (this.focusedItemIndex === i) {
                    this.currentPage = this.pages.length;
                }
            }
        }

        this.positionCacheExpired = false;
    }

    drawItem(index) {
        const item = this.items[index];
        if (!item) {
            return;
        }

        const cached = this.getRenderCacheItem(index, item.focused);
        if (cached) {
            return this.client.term.write(`${ansi.goto(item.row, item.col)}${cached}`);
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

        const renderLength = strUtil.renderStringLength(text);

        let relativeColumn = item.col - this.position.col;
        if (relativeColumn < 0) {
            relativeColumn = 0;
            this.client.log.warn(
                { itemCol: item.col, positionColumn: this.position.col },
                'Invalid item column detected in full menu'
            );
        }

        if (relativeColumn + renderLength > this.dimens.width) {
            if (this.hasTextOverflow()) {
                text = strUtil.renderTruncate(text, {
                    length:
                        this.dimens.width - (relativeColumn + this.textOverflow.length),
                    omission: this.textOverflow,
                });
            }
        }

        const padLength = Math.min(item.fixedLength + 1, this.dimens.width);

        text = `${sgr}${strUtil.pad(
            text,
            padLength,
            this.fillChar,
            this.justify
        )}${this.getSGR()}`;
        this.client.term.write(`${ansi.goto(item.row, item.col)}${text}`);
        this.setRenderCacheItem(index, text, item.focused);
    }

    redraw() {
        super.redraw();

        this.cachePositions();

        // In case we get in a bad state, try to recover
        if (this.currentPage < 0) {
            this.currentPage = 0;
        }

        if (this.items.length) {
            if (
                this.currentPage > this.pages.length ||
                !_.isObject(this.pages[this.currentPage])
            ) {
                this.client.log.warn(
                    { currentPage: this.currentPage, pagesLength: this.pages.length },
                    'Invalid state! in full menu redraw'
                );
            } else {
                for (
                    let i = this.pages[this.currentPage].start;
                    i <= this.pages[this.currentPage].end;
                    ++i
                ) {
                    this.items[i].focused = this.focusedItemIndex === i;
                    this.drawItem(i);
                }
            }
        }
    }

    setHeight(height) {
        this.oldDimens = Object.assign({}, this.dimens);

        super.setHeight(height);

        this.positionCacheExpired = true;
        this.autoAdjustHeight = false;
    }

    setWidth(width) {
        this.oldDimens = Object.assign({}, this.dimens);

        super.setWidth(width);

        this.positionCacheExpired = true;
    }

    setTextOverflow(overflow) {
        super.setTextOverflow(overflow);

        this.positionCacheExpired = true;
    }

    setPosition(pos) {
        super.setPosition(pos);

        this.positionCacheExpired = true;
    }

    setFocus(focused) {
        super.setFocus(focused);
        this.positionCacheExpired = true;
        this.autoAdjustHeight = false;

        this.redraw();
    }

    setFocusItemIndex(index) {
        super.setFocusItemIndex(index); //  sets this.focusedItemIndex
    }

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('up', key.name)) {
                this.focusPrevious();
            } else if (this.isKeyMapped('down', key.name)) {
                this.focusNext();
            } else if (this.isKeyMapped('left', key.name)) {
                this.focusPreviousColumn();
            } else if (this.isKeyMapped('right', key.name)) {
                this.focusNextColumn();
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
        return _.isString(item.data) ? item.data : this.focusedItemIndex;
    }

    setItems(items) {
        //  if we have items already, save off their drawing area so we don't leave fragments at redraw
        if (this.items && this.items.length) {
            this.oldDimens = Object.assign({}, this.dimens);
        }

        // Reset the page on new items
        this.currentPage = 0;
        this.focusedItemIndex = 0;

        super.setItems(items);

        this.positionCacheExpired = true;
    }

    removeItem(index) {
        if (this.items && this.items.length) {
            this.oldDimens = Object.assign({}, this.dimens);
        }

        super.removeItem(index);
        this.positionCacheExpired = true;
    }

    focusNext() {
        if (this.items.length - 1 === this.focusedItemIndex) {
            this.clearPage();
            this.focusedItemIndex = 0;
            this.currentPage = 0;
        } else {
            if (
                this.currentPage > this.pages.length ||
                !_.isObject(this.pages[this.currentPage])
            ) {
                this.client.log.warn(
                    { currentPage: this.currentPage, pagesLength: this.pages.length },
                    'Invalid state in focusNext for full menu view'
                );
            } else {
                this.focusedItemIndex++;
                if (this.focusedItemIndex > this.pages[this.currentPage].end) {
                    this.clearPage();
                    this.currentPage++;
                }
            }
        }

        this.redraw();

        super.focusNext();
    }

    focusPrevious() {
        if (0 === this.focusedItemIndex) {
            this.clearPage();
            this.focusedItemIndex = this.items.length - 1;
            this.currentPage = this.pages.length - 1;
        } else {
            this.focusedItemIndex--;
            if (
                this.currentPage > this.pages.length ||
                !_.isObject(this.pages[this.currentPage])
            ) {
                this.client.log.warn(
                    { currentPage: this.currentPage, pagesLength: this.pages.length },
                    'Bad focus state, ignoring call to focusPrevious.'
                );
            } else {
                if (this.focusedItemIndex < this.pages[this.currentPage].start) {
                    this.clearPage();
                    this.currentPage--;
                }
            }
        }

        this.redraw();

        super.focusPrevious();
    }

    focusPreviousColumn() {
        const currentRow = this.items[this.focusedItemIndex].itemInRow;
        this.focusedItemIndex = this.focusedItemIndex - this.itemsPerRow;
        if (this.focusedItemIndex < 0) {
            this.clearPage();
            const lastItemRow = this.items[this.items.length - 1].itemInRow;
            if (lastItemRow > currentRow) {
                this.focusedItemIndex = this.items.length - (lastItemRow - currentRow) - 1;
            } else {
                // can't go to same column, so go to last item
                this.focusedItemIndex = this.items.length - 1;
            }
            // set to last page
            this.currentPage = this.pages.length - 1;
        } else {
            if (this.focusedItemIndex < this.pages[this.currentPage].start) {
                this.clearPage();
                this.currentPage--;
            }
        }

        this.redraw();

        // TODO: This isn't specific to Previous, may want to replace in the future
        super.focusPrevious();
    }

    focusNextColumn() {
        const currentRow = this.items[this.focusedItemIndex].itemInRow;
        this.focusedItemIndex = this.focusedItemIndex + this.itemsPerRow;
        if (this.focusedItemIndex > this.items.length - 1) {
            this.focusedItemIndex = currentRow - 1;
            this.currentPage = 0;
            this.clearPage();
        } else if (this.focusedItemIndex > this.pages[this.currentPage].end) {
            this.clearPage();
            this.currentPage++;
        }

        this.redraw();

        // TODO: This isn't specific to Next, may want to replace in the future
        super.focusNext();
    }

    focusPreviousPageItem() {
        // handle first page
        if (this.currentPage == 0) {
            // Do nothing, page up shouldn't go down on last page
            return;
        }

        this.currentPage--;
        this.focusedItemIndex = this.pages[this.currentPage].start;
        this.clearPage();

        this.redraw();

        return super.focusPreviousPageItem();
    }

    focusNextPageItem() {
        // handle last page
        if (this.currentPage == this.pages.length - 1) {
            // Do nothing, page up shouldn't go down on last page
            return;
        }

        this.currentPage++;
        this.focusedItemIndex = this.pages[this.currentPage].start;
        this.clearPage();

        this.redraw();

        return super.focusNextPageItem();
    }

    focusFirst() {
        this.currentPage = 0;
        this.focusedItemIndex = 0;
        this.clearPage();

        this.redraw();
        return super.focusFirst();
    }

    focusLast() {
        this.currentPage = this.pages.length - 1;
        this.focusedItemIndex = this.pages[this.currentPage].end;
        this.clearPage();

        this.redraw();
        return super.focusLast();
    }

    setFocusItems(items) {
        super.setFocusItems(items);

        this.positionCacheExpired = true;
    }

    setItemSpacing(itemSpacing) {
        super.setItemSpacing(itemSpacing);

        this.positionCacheExpired = true;
    }

    setJustify(justify) {
        super.setJustify(justify);
        this.positionCacheExpired = true;
    }

    setItemHorizSpacing(itemHorizSpacing) {
        super.setItemHorizSpacing(itemHorizSpacing);

        this.positionCacheExpired = true;
    }
}

exports.FullMenuView = FullMenuView;
