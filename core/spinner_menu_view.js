/* jslint node: true */
'use strict';

const MenuView = require('./menu_view.js').MenuView;
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const { pipeToAnsi } = require('./color_codes.js');
const formatString = require('./string_format');

const util = require('util');
const assert = require('assert');
const _ = require('lodash');

exports.SpinnerMenuView = SpinnerMenuView;

function SpinnerMenuView(options) {
    options.justify = options.justify || 'left';
    options.cursor = options.cursor || 'hide';

    MenuView.call(this, options);

    this.initDefaultWidth();

    var self = this;

    /*
    this.cachePositions = function() {
        self.positionCacheExpired = false;
    };
    */

    this.updateSelection = function () {
        //assert(!self.positionCacheExpired);

        assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= self.items.length);

        this.drawItem(this.focusedItemIndex);
        this.emit('index update', this.focusedItemIndex);
    };

    this.drawItem = function (index) {
        const item = this.items[index];
        if (!item) {
            return;
        }

        const cached = this.getRenderCacheItem(index, this.hasFocus);
        if (cached) {
            return this.client.term.write(
                `${ansi.goto(this.position.row, this.position.col)}${cached}`
            );
        }

        let text;
        let sgr;
        if (this.complexItems) {
            text = pipeToAnsi(
                formatString(
                    this.hasFocus && this.focusItemFormat
                        ? this.focusItemFormat
                        : this.itemFormat,
                    item
                )
            );
            sgr = this.focusItemFormat
                ? ''
                : this.hasFocus
                ? this.getFocusSGR()
                : self.getSGR();
        } else {
            text = strUtil.stylizeString(
                item.text,
                this.hasFocus ? self.focusTextStyle : self.textStyle
            );
            sgr = this.hasFocus ? this.getFocusSGR() : this.getSGR();
        }

        text = `${sgr}${strUtil.pad(
            text,
            this.dimens.width,
            this.fillChar,
            this.justify
        )}`;
        this.client.term.write(
            `${ansi.goto(this.position.row, this.position.col)}${text}`
        );
        this.setRenderCacheItem(index, text, this.hasFocus);
    };
}

util.inherits(SpinnerMenuView, MenuView);

SpinnerMenuView.prototype.redraw = function () {
    SpinnerMenuView.super_.prototype.redraw.call(this);
    this.drawItem(this.focusedItemIndex);
};

SpinnerMenuView.prototype.setFocus = function (focused) {
    SpinnerMenuView.super_.prototype.setFocus.call(this, focused);
    this.redraw();
};

SpinnerMenuView.prototype.setFocusItemIndex = function (index) {
    SpinnerMenuView.super_.prototype.setFocusItemIndex.call(this, index); //  sets this.focusedItemIndex
    this.updateSelection(); //  will redraw
};

SpinnerMenuView.prototype.onKeyPress = function (ch, key) {
    if (key) {
        if (this.isKeyMapped('up', key.name)) {
            if (0 === this.focusedItemIndex) {
                this.focusedItemIndex = this.items.length - 1;
            } else {
                this.focusedItemIndex--;
            }

            this.updateSelection();
            return;
        } else if (this.isKeyMapped('down', key.name)) {
            if (this.items.length - 1 === this.focusedItemIndex) {
                this.focusedItemIndex = 0;
            } else {
                this.focusedItemIndex++;
            }

            this.updateSelection();
            return;
        }
    }

    SpinnerMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

SpinnerMenuView.prototype.getData = function () {
    const item = this.getItem(this.focusedItemIndex);
    return _.isString(item.data) ? item.data : this.focusedItemIndex;
};
