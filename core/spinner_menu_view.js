'use strict';

const { MenuView } = require('./menu_view.js');
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const { pipeToAnsi } = require('./color_codes.js');

//  Items are drawn already rendered: only ANSI escapes are codes.
const ANSI_ONLY = { dialect: 'ansi' };
const formatString = require('./string_format');

const assert = require('assert');
const _ = require('lodash');

class SpinnerMenuView extends MenuView {
    constructor(options) {
        options.justify = options.justify || 'left';
        options.cursor = options.cursor || 'hide';

        super(options);

        this.initDefaultWidth();
    }

    updateSelection() {
        assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= this.items.length);

        this.drawItem(this.focusedItemIndex);
        this.emit('index update', this.focusedItemIndex);
    }

    drawItem(index) {
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
        if (this.hasFocus && this.hasFocusItemFrames()) {
            //  from the normal SGR: a tick draws after whatever was last
            //  written (another animation), a frame never inherits it;
            //  it stops at the view's right edge
            text = this.clipFocusItemFrame(
                this.renderFocusItemFrame(item),
                this.dimens.width
            );
            sgr = this.getSGR();
        } else if (this.complexItems) {
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
                  : this.getSGR();
        } else {
            text = strUtil.stylizeString(
                item.text,
                this.hasFocus ? this.focusTextStyle : this.textStyle
            );
            sgr = this.hasFocus ? this.getFocusSGR() : this.getSGR();
        }

        text = `${sgr}${strUtil.pad(
            text,
            this.dimens.width,
            this.fillChar,
            this.justify,
            '',
            '',
            ANSI_ONLY
        )}`;
        this.client.term.write(
            `${ansi.goto(this.position.row, this.position.col)}${text}`
        );
        this.setRenderCacheItem(index, text, this.hasFocus);
    }

    redraw() {
        super.redraw();
        this.drawItem(this.focusedItemIndex);
    }

    focusItemFramesSupported() {
        return true;
    }

    //  The one item shown, while the view has focus
    isFocusItemFrameVisible(index) {
        return !!this.hasFocus && index === this.focusedItemIndex && !!this.items[index];
    }

    setFocus(focused) {
        super.setFocus(focused);
        this.redraw();
    }

    setFocusItemIndex(index) {
        super.setFocusItemIndex(index); //  sets this.focusedItemIndex
        this.updateSelection(); //  will redraw
    }

    onKeyPress(ch, key) {
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

        super.onKeyPress(ch, key);
    }

    getData() {
        const item = this.getItem(this.focusedItemIndex);
        return _.isString(item.data) ? item.data : this.focusedItemIndex;
    }
}

exports.SpinnerMenuView = SpinnerMenuView;
