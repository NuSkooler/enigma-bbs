/* jslint node: true */
'use strict';

const MenuView = require('./menu_view.js').MenuView;
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const { pipeToAnsi } = require('./color_codes.js');
const { goto } = require('./ansi_term.js');

const assert = require('assert');
const _ = require('lodash');

exports.HorizontalMenuView = HorizontalMenuView;

//  :TODO: Update this to allow scrolling if number of items cannot fit in width (similar to VerticalMenuView)

function HorizontalMenuView(options) {
    options.cursor = options.cursor || 'hide';

    if (!_.isNumber(options.itemSpacing)) {
        options.itemSpacing = 1;
    }

    MenuView.call(this, options);

    this.dimens.height = 1; //  always the case

    var self = this;

    this.getSpacer = function () {
        return new Array(self.itemSpacing + 1).join(' ');
    };

    this.cachePositions = function () {
        if (this.positionCacheExpired) {
            var col = self.position.col;
            var spacer = self.getSpacer();

            for (var i = 0; i < self.items.length; ++i) {
                self.items[i].col = col;
                col += spacer.length + self.items[i].text.length + spacer.length;
            }
        }

        this.positionCacheExpired = false;
    };

    this.drawItem = function (index) {
        assert(!this.positionCacheExpired);

        const item = self.items[index];
        if (!item) {
            return;
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

        const drawWidth = strUtil.renderStringLength(text) + self.getSpacer().length * 2;

        self.client.term.write(
            `${goto(self.position.row, item.col)}${sgr}${strUtil.pad(
                text,
                drawWidth,
                self.fillChar,
                'center'
            )}`
        );
    };
}

require('util').inherits(HorizontalMenuView, MenuView);

HorizontalMenuView.prototype.setHeight = function (height) {
    height = parseInt(height, 10);
    assert(1 === height); //  nothing else allowed here
    HorizontalMenuView.super_.prototype.setHeight(this, height);
};

HorizontalMenuView.prototype.redraw = function () {
    HorizontalMenuView.super_.prototype.redraw.call(this);

    this.cachePositions();

    for (var i = 0; i < this.items.length; ++i) {
        this.items[i].focused = this.focusedItemIndex === i;
        this.drawItem(i);
    }
};

HorizontalMenuView.prototype.setPosition = function (pos) {
    HorizontalMenuView.super_.prototype.setPosition.call(this, pos);

    this.positionCacheExpired = true;
};

HorizontalMenuView.prototype.setFocus = function (focused) {
    HorizontalMenuView.super_.prototype.setFocus.call(this, focused);

    this.redraw();
};

HorizontalMenuView.prototype.setItems = function (items) {
    HorizontalMenuView.super_.prototype.setItems.call(this, items);

    this.positionCacheExpired = true;
};

HorizontalMenuView.prototype.focusNext = function () {
    if (this.items.length - 1 === this.focusedItemIndex) {
        this.focusedItemIndex = 0;
    } else {
        this.focusedItemIndex++;
    }

    //  :TODO: Optimize this in cases where we only need to redraw two items. Always the case now, somtimes
    this.redraw();

    HorizontalMenuView.super_.prototype.focusNext.call(this);
};

HorizontalMenuView.prototype.focusPrevious = function () {
    if (0 === this.focusedItemIndex) {
        this.focusedItemIndex = this.items.length - 1;
    } else {
        this.focusedItemIndex--;
    }

    //  :TODO: Optimize this in cases where we only need to redraw two items. Always the case now, somtimes
    this.redraw();

    HorizontalMenuView.super_.prototype.focusPrevious.call(this);
};

HorizontalMenuView.prototype.onKeyPress = function (ch, key) {
    if (key) {
        if (this.isKeyMapped('left', key.name)) {
            this.focusPrevious();
        } else if (this.isKeyMapped('right', key.name)) {
            this.focusNext();
        }
    }

    HorizontalMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

HorizontalMenuView.prototype.getData = function () {
    const item = this.getItem(this.focusedItemIndex);
    return _.isString(item.data) ? item.data : this.focusedItemIndex;
};
