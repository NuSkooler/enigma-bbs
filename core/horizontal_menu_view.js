'use strict';

const { MenuView } = require('./menu_view.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const { pipeToAnsi } = require('./color_codes.js');
const { goto } = require('./ansi_term.js');

const assert = require('assert');
const _ = require('lodash');

//  :TODO: Update this to allow scrolling if number of items cannot fit in width (similar to VerticalMenuView)

class HorizontalMenuView extends MenuView {
    constructor(options) {
        options.cursor = options.cursor || 'hide';

        if (!_.isNumber(options.itemSpacing)) {
            options.itemSpacing = 1;
        }

        super(options);

        this.dimens.height = 1; //  always the case
    }

    getSpacer() {
        return new Array(this.itemSpacing + 1).join(' ');
    }

    cachePositions() {
        if (this.positionCacheExpired) {
            let col = this.position.col;
            const spacer = this.getSpacer();

            for (let i = 0; i < this.items.length; ++i) {
                this.items[i].col = col;
                col += spacer.length + this.items[i].text.length + spacer.length;
            }
        }

        this.positionCacheExpired = false;
    }

    drawItem(index) {
        assert(!this.positionCacheExpired);

        const item = this.items[index];
        if (!item) {
            return;
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

        const drawWidth = strUtil.renderStringLength(text) + this.getSpacer().length * 2;

        this.client.term.write(
            `${goto(this.position.row, item.col)}${sgr}${strUtil.pad(
                text,
                drawWidth,
                this.fillChar,
                'center'
            )}`
        );
    }

    setHeight(height) {
        height = parseInt(height, 10);
        assert(1 === height); //  nothing else allowed here
        super.setHeight(height);
    }

    redraw() {
        super.redraw();

        this.cachePositions();

        for (let i = 0; i < this.items.length; ++i) {
            this.items[i].focused = this.focusedItemIndex === i;
            this.drawItem(i);
        }
    }

    setPosition(pos) {
        super.setPosition(pos);

        this.positionCacheExpired = true;
    }

    setFocus(focused) {
        super.setFocus(focused);

        this.redraw();
    }

    setItems(items) {
        super.setItems(items);

        this.positionCacheExpired = true;
    }

    focusNext() {
        if (this.items.length - 1 === this.focusedItemIndex) {
            this.focusedItemIndex = 0;
        } else {
            this.focusedItemIndex++;
        }

        //  :TODO: Optimize this in cases where we only need to redraw two items. Always the case now, somtimes
        this.redraw();

        super.focusNext();
    }

    focusPrevious() {
        if (0 === this.focusedItemIndex) {
            this.focusedItemIndex = this.items.length - 1;
        } else {
            this.focusedItemIndex--;
        }

        //  :TODO: Optimize this in cases where we only need to redraw two items. Always the case now, somtimes
        this.redraw();

        super.focusPrevious();
    }

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('left', key.name)) {
                this.focusPrevious();
            } else if (this.isKeyMapped('right', key.name)) {
                this.focusNext();
            }
        }

        super.onKeyPress(ch, key);
    }

    getData() {
        const item = this.getItem(this.focusedItemIndex);
        return _.isString(item.data) ? item.data : this.focusedItemIndex;
    }
}

exports.HorizontalMenuView = HorizontalMenuView;
