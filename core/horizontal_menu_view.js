'use strict';

const { MenuView } = require('./menu_view.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const { pipeToAnsi } = require('./color_codes.js');
const PipeCodes = require('./pipe_codes.js');
const { goto } = require('./ansi_term.js');

//  Items are drawn already rendered: only ANSI escapes are codes.
const ANSI_ONLY = { dialect: 'ansi' };

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

                let itemWidth;
                if (this.complexItems && this.itemFormat) {
                    //  Measure the visual (rendered) width of the format string so
                    //  extra characters added by the format (e.g. brackets, pipe codes)
                    //  are accounted for and items don't overlap.
                    itemWidth = PipeCodes.renderWithWidth(
                        formatString(this.itemFormat, this.items[i])
                    ).width;
                } else {
                    itemWidth = strUtil.renderStringLength(this.items[i].text, ANSI_ONLY);
                }

                //  with focusItemFrames: room for the widest look of the item
                //  (see drawFocusItemFrame())
                if (this.hasFocusItemFrames()) {
                    itemWidth = this.items[i].frameSlotWidth = Math.max(
                        itemWidth,
                        this.focusItemFrameWidth(this.items[i])
                    );
                }

                col += spacer.length + itemWidth + spacer.length;
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

        if (item.focused && this.hasFocusItemFrames()) {
            return this.drawFocusItemFrame(index, item);
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

        const textWidth = strUtil.renderStringLength(text, ANSI_ONLY);
        //  with focusItemFrames, every item fills its slot, so it covers the
        //  wider frame drawn there while it was focused
        const drawWidth =
            (this.hasFocusItemFrames() && item.frameSlotWidth > textWidth
                ? item.frameSlotWidth
                : textWidth) +
            this.getSpacer().length * 2;

        this.client.term.write(
            `${goto(this.position.row, item.col)}${sgr}${strUtil.pad(
                text,
                drawWidth,
                this.fillChar,
                'center',
                '',
                '',
                textWidth
            )}`
        );
    }

    //
    //  The focused item from focusItemFrames, centred in its slot, which is
    //  as wide as the widest look of the item (cachePositions()), so no
    //  frame overlaps the next item and a narrow frame covers a wide one.
    //  The rendered frame is cached per frame. Drawn from the normal SGR,
    //  so a tick never inherits another animation's. HM lays its items out
    //  without regard to its width, so the edge a frame is cut at is the
    //  terminal's; an item starting past it draws nothing (its cycle still
    //  starts again, as for any draw of the focused item).
    //
    drawFocusItemFrame(index, item) {
        let cached = this.getRenderCacheItem(index, true);
        if (item.col > this.client.term.termWidth) {
            return;
        }
        if (!cached) {
            const text = this.renderFocusItemFrame(item);
            cached = { text, textWidth: strUtil.renderStringLength(text, ANSI_ONLY) };
            this.setRenderCacheItem(index, cached, true);
        }
        const slotWidth = Math.max(item.frameSlotWidth || 0, cached.textWidth);
        const text = strUtil.pad(
            cached.text,
            slotWidth + this.getSpacer().length * 2,
            this.fillChar,
            'center',
            '',
            '',
            cached.textWidth
        );
        this.client.term.write(
            `${goto(this.position.row, item.col)}${this.getSGR()}${this.clipToTerminalWidth(
                text,
                item.col
            )}`
        );
    }

    focusItemFramesSupported() {
        return true;
    }

    //  Laid out, on the terminal, and drawn as the focused item
    isFocusItemFrameVisible(index) {
        const item = this.items[index];
        return (
            !!item &&
            !!item.focused &&
            !this.positionCacheExpired &&
            null != item.col &&
            item.col <= this.client.term.termWidth
        );
    }

    setPropertyValue(propName, value) {
        super.setPropertyValue(propName, value);

        //  the slots are as wide as the frames (cachePositions())
        if (
            'focusItemFrames' === propName ||
            ('focusItemFormat' === propName && this.hasFocusItemFrames())
        ) {
            this.positionCacheExpired = true;
        }
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
