/* jslint node: true */
'use strict';

const MenuView = require('./menu_view.js').MenuView;
const strUtil = require('./string_util.js');

const util = require('util');
const assert = require('assert');

exports.ToggleMenuView = ToggleMenuView;

function ToggleMenuView(options) {
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
        assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= self.items.length);
        self.redraw();
    };
}

util.inherits(ToggleMenuView, MenuView);

ToggleMenuView.prototype.redraw = function () {
    ToggleMenuView.super_.prototype.redraw.call(this);

    if (0 === this.items.length) {
        return;
    }

    //this.cachePositions();

    this.client.term.write(this.hasFocus ? this.getFocusSGR() : this.getSGR());

    assert(this.items.length === 2, 'ToggleMenuView must contain exactly (2) items');

    for (var i = 0; i < 2; i++) {
        var item = this.items[i];
        var text = strUtil.stylizeString(
            item.text,
            i === this.focusedItemIndex && this.hasFocus
                ? this.focusTextStyle
                : this.textStyle
        );

        if (1 === i) {
            //console.log(this.styleColor1)
            //var sepColor = this.getANSIColor(this.styleColor1 || this.getColor());
            //console.log(sepColor.substr(1))
            //var sepColor = '\u001b[0m\u001b[1;30m';   //  :TODO: FIX ME!!!
            //  :TODO: sepChar needs to be configurable!!!
            this.client.term.write(this.styleSGR1 + ' / ');
            //this.client.term.write(sepColor + ' / ');
        }

        this.client.term.write(
            i === this.focusedItemIndex ? this.getFocusSGR() : this.getSGR()
        );
        this.client.term.write(text);
    }
};

ToggleMenuView.prototype.setFocusItemIndex = function (index) {
    ToggleMenuView.super_.prototype.setFocusItemIndex.call(this, index); //  sets this.focusedItemIndex

    this.updateSelection();
};

ToggleMenuView.prototype.setFocus = function (focused) {
    ToggleMenuView.super_.prototype.setFocus.call(this, focused);

    this.redraw();
};

ToggleMenuView.prototype.focusNext = function () {
    if (this.items.length - 1 === this.focusedItemIndex) {
        this.focusedItemIndex = 0;
    } else {
        this.focusedItemIndex++;
    }

    this.updateSelection();

    ToggleMenuView.super_.prototype.focusNext.call(this);
};

ToggleMenuView.prototype.focusPrevious = function () {
    if (0 === this.focusedItemIndex) {
        this.focusedItemIndex = this.items.length - 1;
    } else {
        this.focusedItemIndex--;
    }

    this.updateSelection();

    ToggleMenuView.super_.prototype.focusPrevious.call(this);
};

ToggleMenuView.prototype.onKeyPress = function (ch, key) {
    if (key) {
        if (this.isKeyMapped('right', key.name) || this.isKeyMapped('down', key.name)) {
            this.focusNext();
        } else if (
            this.isKeyMapped('left', key.name) ||
            this.isKeyMapped('up', key.name)
        ) {
            this.focusPrevious();
        }
    }

    ToggleMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

ToggleMenuView.prototype.getData = function () {
    return this.focusedItemIndex;
};

ToggleMenuView.prototype.setItems = function (items) {
    items = items.slice(0, 2); //  switch/toggle only works with two elements

    ToggleMenuView.super_.prototype.setItems.call(this, items);

    this.dimens.width = items.join(' / ').length; //  :TODO: allow configurable seperator... string & color, e.g. styleColor1 (same as fillChar color)
};
