'use strict';

const { MenuView } = require('./menu_view.js');
const strUtil = require('./string_util.js');

const assert = require('assert');

class ToggleMenuView extends MenuView {
    constructor(options) {
        options.cursor = options.cursor || 'hide';

        super(options);

        this.initDefaultWidth();
    }

    updateSelection() {
        assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= this.items.length);
        this.redraw();
    }

    redraw() {
        super.redraw();

        if (0 === this.items.length) {
            return;
        }

        this.client.term.write(this.hasFocus ? this.getFocusSGR() : this.getSGR());

        assert(this.items.length === 2, 'ToggleMenuView must contain exactly (2) items');

        for (let i = 0; i < 2; i++) {
            const item = this.items[i];
            const text = strUtil.stylizeString(
                item.text,
                i === this.focusedItemIndex && this.hasFocus
                    ? this.focusTextStyle
                    : this.textStyle
            );

            if (1 === i) {
                //  :TODO: sepChar needs to be configurable!!!
                this.client.term.write(this.styleSGR1 + ' / ');
            }

            this.client.term.write(
                i === this.focusedItemIndex ? this.getFocusSGR() : this.getSGR()
            );
            this.client.term.write(text);
        }
    }

    setFocusItemIndex(index) {
        super.setFocusItemIndex(index); //  sets this.focusedItemIndex

        this.updateSelection();
    }

    setTrue() {
        this.setFocusItemIndex(1);
        this.updateSelection();
    }

    setFalse() {
        this.setFocusItemIndex(0);
        this.updateSelection();
    }

    isTrue() {
        return this.focusedItemIndex === 1;
    }

    setFromBoolean(bool) {
        return bool ? this.setTrue() : this.setFalse();
    }

    setYes() {
        return this.setTrue();
    }

    setNo() {
        return this.setFalse();
    }

    setFocus(focused) {
        super.setFocus(focused);

        this.redraw();
    }

    focusNext() {
        if (this.items.length - 1 === this.focusedItemIndex) {
            this.focusedItemIndex = 0;
        } else {
            this.focusedItemIndex++;
        }

        this.updateSelection();

        super.focusNext();
    }

    focusPrevious() {
        if (0 === this.focusedItemIndex) {
            this.focusedItemIndex = this.items.length - 1;
        } else {
            this.focusedItemIndex--;
        }

        this.updateSelection();

        super.focusPrevious();
    }

    onKeyPress(ch, key) {
        if (key) {
            if (
                this.isKeyMapped('right', key.name) ||
                this.isKeyMapped('down', key.name)
            ) {
                this.focusNext();
            } else if (
                this.isKeyMapped('left', key.name) ||
                this.isKeyMapped('up', key.name)
            ) {
                this.focusPrevious();
            }
        }

        super.onKeyPress(ch, key);
    }

    getData() {
        return this.focusedItemIndex;
    }

    setItems(items) {
        items = items.slice(0, 2); //  switch/toggle only works with two elements

        super.setItems(items);

        this.dimens.width = items.join(' / ').length; //  :TODO: allow configurable seperator... string & color, e.g. styleColor1 (same as fillChar color)
    }
}

exports.ToggleMenuView = ToggleMenuView;
