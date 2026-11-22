'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const miscUtil = require('./misc_util.js');
const { pipeToAnsi } = require('./color_codes.js');
const formatString = require('./string_format');
const { renderStringLength, renderSplitPos } = require('./string_util.js');
const FrameClock = require('./frame_clock.js');
const {
    DEFAULT_FRAME_INTERVAL_MS,
    clientAnimates,
    frameClockFor,
    parseMs,
} = require('./animation_config.js');

//  deps
const assert = require('assert');
const _ = require('lodash');

//  Items are drawn already rendered: only ANSI escapes are codes.
const ANSI_ONLY = { dialect: 'ansi' };

//
//  Animated focused items (focusItemFrames)
//
//      focusItemFrames: [ "|15> {text}", "|11>> {text}", "|03>>>{text}" ]
//      focusItemFrameInterval: 120         //  ms each frame shows (default 100)
//      focusItemFrameDurations: [ 400 ]    //  per frame; frameInterval for the rest
//      focusItemFrameMode: loop            //  loop | pingpong
//
//  Each frame is a format used exactly as focusItemFormat is (the item's
//  members as tokens, pipe codes, padded to the item's width), for string
//  items too ({text}). Only the focused item animates, and only while the
//  view has focus: the cycle starts at frame 0 on setFocus(true) and each
//  time the focused index changes (that draw is immediate: navigation
//  never waits for a tick), and stops on blur and destroy(). Each tick
//  reads the focused index and the visible window again and draws only
//  the focused item, only if it is on screen, through the client's frame
//  clock (core/frame_clock.js): covers, pauseWhenInactive and the cursor
//  restore are as for %AV.
//
//  Not animating -- the view is blurred, animations are off (system
//  switch, the menu's config.animations: false), the session is not plain
//  ANSI -- the focused item shows one static format: focusItemFormat if
//  set, else frame 0. Nothing ticks.
//
//  A frame is drawn no wider than the view (cut at its right edge); the
//  layouts that size items (HM slots, FM columns) make room for the
//  widest frame.
//
//  Per-item focusItems win: with both set, focusItems are drawn and the
//  frames are ignored (warned once). The subclass draws; it opts in with
//  focusItemFramesSupported() (VM, HM, FM, SM; not TM or TableView).
//
const FOCUS_FRAME_MODES = ['loop', 'pingpong'];

class MenuView extends View {
    constructor(options) {
        options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

        super(options);

        this.disablePipe = options.disablePipe || false;

        if (options.items) {
            this.setItems(options.items);
        } else {
            this.items = [];
        }

        this.renderCache = {};

        this.caseInsensitiveHotKeys = miscUtil.valueWithDefault(
            options.caseInsensitiveHotKeys,
            true
        );

        this.setHotKeys(options.hotKeys);

        this.focusedItemIndex = options.focusedItemIndex || 0;
        this.focusedItemIndex =
            this.items.length > this.focusedItemIndex ? this.focusedItemIndex : 0;

        this.itemSpacing = _.isNumber(options.itemSpacing) ? options.itemSpacing : 0;
        this.itemHorizSpacing = _.isNumber(options.itemHorizSpacing)
            ? options.itemHorizSpacing
            : 0;

        //  :TODO: probably just replace this with owner draw / pipe codes / etc. more control, less specialization
        this.focusPrefix = options.focusPrefix || '';
        this.focusSuffix = options.focusSuffix || '';

        this.fillChar = miscUtil.valueWithDefault(options.fillChar, ' ').substr(0, 1);

        this.focusItemFrames = null; //  formats, or null: not set
        this.focusItemFrameInterval = DEFAULT_FRAME_INTERVAL_MS;
        this.focusItemFrameDurations = null;
        this.focusItemFrameMode = 'loop';
        this._focusFramesOn = false; //  focused, may animate: frames are drawn
        this._focusFrame = 0; //  the frame showing
        this._focusFrameDir = 1; //  pingpong
        this._focusFrameItem = null; //  the item index the cycle is on
        this._focusFrameWarned = {};
    }

    hasFocusItems() {
        return this.focusItems !== undefined;
    }

    //  ── Animated focused items ───────────────────────────────────────────────

    //  Subclasses that draw focusItemFrames say so
    focusItemFramesSupported() {
        return false;
    }

    //  True if the focused item is drawn from focusItemFrames (animated, or
    //  their static format)
    hasFocusItemFrames() {
        return (
            null !== this.focusItemFrames &&
            !this.hasFocusItems() &&
            this.focusItemFramesSupported()
        );
    }

    //  The format the focused item is drawn with now
    focusItemFrameFormat() {
        if (this._focusFramesOn) {
            return this.focusItemFrames[this._focusFrame] || this.focusItemFrames[0];
        }
        return this.focusItemFormat || this.focusItemFrames[0];
    }

    //  Every format the focused item may be drawn with (for a fixed width)
    focusItemFrameFormats() {
        const formats = this.focusItemFrames.slice();
        if (this.focusItemFormat) {
            formats.push(this.focusItemFormat);
        }
        return formats;
    }

    //  |item| rendered with |format| (default: the one drawn now)
    renderFocusItemFrame(item, format = this.focusItemFrameFormat()) {
        return pipeToAnsi(formatString(format, item));
    }

    //  The widest of every format |item| may show while focused
    focusItemFrameWidth(item) {
        return this.focusItemFrameFormats().reduce(
            (w, format) =>
                Math.max(
                    w,
                    renderStringLength(this.renderFocusItemFrame(item, format), ANSI_ONLY)
                ),
            0
        );
    }

    //  A rendered frame cut to |width| columns: one wider than the view
    //  would leave its tail past the view's edge, which nothing covers
    clipFocusItemFrame(text, width) {
        if (!(width > 0) || renderStringLength(text, ANSI_ONLY) <= width) {
            return text;
        }
        return text.slice(0, renderSplitPos(text, width, false));
    }

    //  The render cache slot for |index|: one per frame for the focused item
    //  while it animates. Drawing the focused item at an index the cycle is
    //  not on (navigation) starts the cycle again from frame 0.
    _renderCacheSlot(index, focusItem) {
        if (!focusItem) {
            return 'standard';
        }
        if (!this._focusFramesOn || !this.hasFocusItemFrames()) {
            return 'focus';
        }
        if (index !== this._focusFrameItem) {
            this._restartFocusFrames(index);
        }
        return `focus#${this._focusFrame}`;
    }

    //  The subclass's check, each tick: is item |index| on screen now, drawn
    //  as the focused item?
    isFocusItemFrameVisible() {
        return false;
    }

    //  Focus gained or lost (or the frames changed): animate or not
    _updateFocusFrames() {
        const on =
            !!this.hasFocus &&
            this.hasFocusItemFrames() &&
            !View.isDestroyed(this) &&
            clientAnimates(this.client);
        if (!on) {
            if (this._focusFramesOn) {
                this._stopFocusFrames();
            }
            return;
        }
        this._focusFramesOn = true;
        this._restartFocusFrames(this.focusedItemIndex);
    }

    _stopFocusFrames() {
        this._focusFramesOn = false;
        this._focusFrame = 0;
        this._focusFrameDir = 1;
        this._focusFrameItem = null;
        FrameClock.unregister(this);
    }

    //  The cycle from frame 0 at item |index|; on the clock if there is
    //  more than one frame
    _restartFocusFrames(index) {
        this._focusFrameItem = index;
        this._focusFrame = 0;
        this._focusFrameDir = 1;
        if (this.focusItemFrames.length < 2) {
            FrameClock.unregister(this);
            return;
        }
        frameClockFor(this.client).register(this, {
            tick: () => this._tickFocusFrames(),
            interval: this.focusItemFrameInterval,
            delay: this._focusFrameWait(0),
        });
    }

    //  ms frame |i| shows for (the clock applies the floor)
    _focusFrameWait(i) {
        const d = this.focusItemFrameDurations && this.focusItemFrameDurations[i];
        return Number.isFinite(d) && d >= 0 ? d : this.focusItemFrameInterval;
    }

    _advanceFocusFrame() {
        const n = this.focusItemFrames.length;
        const i = this._focusFrame;
        if ('pingpong' === this.focusItemFrameMode) {
            if (i + this._focusFrameDir < 0 || i + this._focusFrameDir >= n) {
                this._focusFrameDir = -this._focusFrameDir;
            }
            this._focusFrame = Math.min(Math.max(i + this._focusFrameDir, 0), n - 1);
        } else {
            this._focusFrame = (i + 1) % n;
        }
    }

    //  The clock's tick: the next frame of the focused item, drawn if it is
    //  on screen. The index and window are read now, never kept from an
    //  earlier tick: a key handler's redraw always finishes before a tick.
    _tickFocusFrames() {
        if (
            View.isDestroyed(this) ||
            !this._focusFramesOn ||
            !this.hasFocusItemFrames() ||
            this.focusItemFrames.length < 2
        ) {
            return { stop: true };
        }
        const index = this.focusedItemIndex;
        if (index !== this._focusFrameItem) {
            //  moved without a draw of the new item: start it at frame 0
            this._focusFrameItem = index;
            this._focusFrame = 0;
            this._focusFrameDir = 1;
        } else {
            this._advanceFocusFrame();
        }
        const next = this._focusFrameWait(this._focusFrame);
        if (!this.isFocusItemFrameVisible(index)) {
            return { next };
        }
        return {
            draw: () => {
                if (
                    index === this.focusedItemIndex &&
                    this.isFocusItemFrameVisible(index)
                ) {
                    this.drawItem(index);
                }
            },
            next,
        };
    }

    _warnFocusFrames(key, obj, msg) {
        if (this._focusFrameWarned[key]) {
            return;
        }
        this._focusFrameWarned[key] = true;
        const log = this.client && this.client.log;
        if (log && _.isFunction(log.warn)) {
            log.warn(
                Object.assign(
                    {
                        viewId: this.id,
                        menuName: _.get(this.client, 'currentMenuModule.menuName'),
                    },
                    obj
                ),
                msg
            );
        }
    }

    _setFocusItemFrames(value) {
        let frames = null;
        if (Array.isArray(value)) {
            frames = value.filter(f => _.isString(f));
            if (frames.length !== value.length) {
                this._warnFocusFrames(
                    'frames',
                    { focusItemFrames: value },
                    '"focusItemFrames" holds something that is not a format string; ignored'
                );
            }
        } else if (_.isString(value)) {
            frames = [value];
        } else if (undefined !== value && null !== value && false !== value) {
            this._warnFocusFrames(
                'frames',
                { focusItemFrames: value },
                '"focusItemFrames" is not a list of formats; ignored'
            );
        }
        this.focusItemFrames = frames && frames.length > 0 ? frames : null;
        if (this.focusItemFrames && !this.focusItemFramesSupported()) {
            this._warnFocusFrames(
                'unsupported',
                {},
                '"focusItemFrames" is not supported by this view; ignored'
            );
        }
    }

    //  With per-item focusItems as well, focusItems are drawn (warned once)
    _checkFocusFramesAndItems() {
        if (
            null !== this.focusItemFrames &&
            this.hasFocusItems() &&
            this.focusItemFramesSupported()
        ) {
            this._warnFocusFrames(
                'focusItems',
                {},
                '"focusItemFrames" and "focusItems" are both set; focusItems are drawn, the frames ignored'
            );
        }
    }

    setFocus(focused) {
        super.setFocus(focused);

        //  nothing to do (nor undo) for a view without frames: as before
        if (this._focusFramesOn || this.hasFocusItemFrames()) {
            this._updateFocusFrames();
        }
    }

    getHotKeyItemIndex(ch) {
        if (ch && this.hotKeys) {
            const keyIndex =
                this.hotKeys[this.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
            if (_.isNumber(keyIndex)) {
                return keyIndex;
            }
        }
        return -1;
    }

    emitIndexUpdate() {
        this.emit('index update', this.focusedItemIndex);
    }

    setTextOverflow(overflow) {
        this.textOverflow = overflow;
        this.invalidateRenderCache();
    }

    hasTextOverflow() {
        return this.textOverflow != undefined;
    }

    setItems(items) {
        if (Array.isArray(items)) {
            this.sorted = false;
            this.renderCache = {};

            //
            //  Items can be an array of strings or an array of objects.
            //
            //  In the case of objects, items are considered complex and
            //  may have one or more members that can later be formatted
            //  against. The default member is 'text'. The member 'data'
            //  may be overridden to provide a form value other than the
            //  item's index.
            //
            //  Items can be formatted with 'itemFormat' and 'focusItemFormat'
            //
            this.items = items.map(item => {
                const stringItem = _.isString(item);
                const text = stringItem
                    ? item
                    : (() => {
                          if (!stringItem) this.complexItems = true;
                          return item.text || '';
                      })();

                let displayText;
                if (this.disablePipe) {
                    displayText = text;
                } else {
                    try {
                        displayText = pipeToAnsi(text, this.client);
                    } catch (e) {
                        displayText = text;
                    }
                }
                return Object.assign({}, { text: displayText }, stringItem ? {} : item);
            });

            if (this.complexItems) {
                this.itemFormat = this.itemFormat || '{text}';
            }

            this.invalidateRenderCache();
        }
    }

    getRenderCacheItem(index, focusItem = false) {
        //  first, even on a miss: it may start the focus frames again
        const slot = this._renderCacheSlot(index, focusItem);
        const item = this.renderCache[index];
        return item && item[slot];
    }

    removeRenderCacheItem(index) {
        delete this.renderCache[index];
    }

    setRenderCacheItem(index, rendered, focusItem = false) {
        this.renderCache[index] = this.renderCache[index] || {};
        this.renderCache[index][this._renderCacheSlot(index, focusItem)] = rendered;
    }

    invalidateRenderCache() {
        this.renderCache = {};
    }

    setSort(sort) {
        if (this.sorted || !Array.isArray(this.items) || 0 === this.items.length) {
            return;
        }

        const key = true === sort ? 'text' : sort;
        if ('text' !== sort && !this.complexItems) {
            return; //  need a valid sort key
        }

        this.items.sort((a, b) => {
            const a1 = a[key];
            const b1 = b[key];
            if (!a1) {
                return -1;
            }
            if (!b1) {
                return 1;
            }
            return a1.localeCompare(b1, undefined, {
                sensitivity: 'base',
                numeric: true,
            });
        });

        this.sorted = true;
    }

    removeItem(index) {
        this.sorted = false;
        this.items.splice(index, 1);

        if (this.focusItems) {
            this.focusItems.splice(index, 1);
        }

        if (this.focusedItemIndex >= index) {
            this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
        }

        this.removeRenderCacheItem(index);

        this.positionCacheExpired = true;
    }

    getCount() {
        return this.items.length;
    }

    getItems() {
        if (this.complexItems) {
            return this.items;
        }

        return this.items.map(item => item.text);
    }

    getItem(index) {
        if (index < 0 || index > this.items.length - 1) {
            return null;
        }

        if (this.complexItems) {
            return this.items[index];
        }

        return this.items[index].text;
    }

    focusNext() {
        this.emitIndexUpdate();
    }

    focusPrevious() {
        this.emitIndexUpdate();
    }

    focusNextPageItem() {
        this.emitIndexUpdate();
    }

    focusPreviousPageItem() {
        this.emitIndexUpdate();
    }

    focusFirst() {
        this.emitIndexUpdate();
    }

    focusLast() {
        this.emitIndexUpdate();
    }

    //  Clamp to a valid index; an empty list has none, so park at 0 where
    //  getItem() and the draw paths already no-op.
    setFocusItemIndex(index) {
        this.focusedItemIndex = this.items.length
            ? Math.min(Math.max(index, 0), this.items.length - 1)
            : 0;
    }

    getFocusItemIndex() {
        return this.focusedItemIndex;
    }

    onKeyPress(ch, key) {
        const itemIndex = this.getHotKeyItemIndex(ch);
        if (itemIndex >= 0) {
            this.setFocusItemIndex(itemIndex);

            if (true === this.hotKeySubmit) {
                this.emit('action', 'accept');
            }
        }

        super.onKeyPress(ch, key);
    }

    setFocusItems(items) {
        if (items) {
            this.focusItems = [];
            items.forEach(itemText => {
                let text;
                if (this.disablePipe) {
                    text = itemText;
                } else {
                    try {
                        text = pipeToAnsi(itemText, this.client);
                    } catch (e) {
                        text = itemText;
                    }
                }
                this.focusItems.push({ text });
            });
        }
    }

    setItemSpacing(itemSpacing) {
        itemSpacing = parseInt(itemSpacing);
        assert(_.isNumber(itemSpacing));

        this.itemSpacing = itemSpacing;
        this.positionCacheExpired = true;
    }

    setItemHorizSpacing(itemHorizSpacing) {
        itemHorizSpacing = parseInt(itemHorizSpacing);
        assert(_.isNumber(itemHorizSpacing));

        this.itemHorizSpacing = itemHorizSpacing;
        this.positionCacheExpired = true;
    }

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'itemSpacing':
                this.setItemSpacing(value);
                break;
            case 'itemHorizSpacing':
                this.setItemHorizSpacing(value);
                break;
            case 'items':
                this.setItems(value);
                break;
            case 'focusItems':
                this.setFocusItems(value);
                //  with frames: they no longer draw the focused item
                if (null !== this.focusItemFrames) {
                    this._checkFocusFramesAndItems();
                    this.invalidateRenderCache();
                    this._updateFocusFrames();
                }
                break;
            case 'focusItemFrames':
                this._setFocusItemFrames(value);
                this._checkFocusFramesAndItems();
                this.invalidateRenderCache();
                if (this.hasFocus) {
                    this._updateFocusFrames();
                }
                break;
            case 'focusItemFrameInterval': {
                const ms = parseMs(value);
                if (undefined === ms) {
                    this.focusItemFrameInterval = DEFAULT_FRAME_INTERVAL_MS;
                } else if (Number.isNaN(ms)) {
                    this._warnFocusFrames(
                        'interval',
                        { focusItemFrameInterval: value },
                        `"focusItemFrameInterval" is not a number of ms >= 0; using ${this.focusItemFrameInterval}`
                    );
                } else {
                    this.focusItemFrameInterval = ms;
                }
                break;
            }
            case 'focusItemFrameDurations': {
                //  an entry not set, or not a duration: the interval
                const durations = Array.isArray(value) ? value.map(parseMs) : null;
                if (
                    (null === durations && undefined !== parseMs(value)) ||
                    (durations && durations.some(d => Number.isNaN(d)))
                ) {
                    this._warnFocusFrames(
                        'durations',
                        { focusItemFrameDurations: value },
                        '"focusItemFrameDurations" holds something that is not a number of ms >= 0; focusItemFrameInterval used for it'
                    );
                }
                this.focusItemFrameDurations = durations;
                break;
            }
            case 'focusItemFrameMode':
                if (FOCUS_FRAME_MODES.includes(value)) {
                    this.focusItemFrameMode = value;
                } else {
                    this._warnFocusFrames(
                        'mode',
                        { focusItemFrameMode: value },
                        `Unknown "focusItemFrameMode"; using "${this.focusItemFrameMode}"`
                    );
                }
                break;
            case 'hotKeys':
                this.setHotKeys(value);
                break;
            case 'textOverflow':
                this.setTextOverflow(value);
                break;
            case 'hotKeySubmit':
                this.hotKeySubmit = value;
                break;
            case 'justify':
                this.setJustify(value);
                break;
            case 'fillChar':
                this.setFillChar(value);
                break;
            case 'focusItemIndex':
                this.focusedItemIndex = value;
                this.invalidateRenderCache();
                break;

            case 'itemFormat':
            case 'focusItemFormat':
                this[propName] = value;
                this.invalidateRenderCache();
                break;

            case 'sort':
                this.setSort(value);
                break;
        }

        super.setPropertyValue(propName, value);
    }

    setFillChar(fillChar) {
        this.fillChar = miscUtil.valueWithDefault(fillChar, ' ').substr(0, 1);
        this.invalidateRenderCache();
    }

    setJustify(justify) {
        this.justify = justify;
        this.invalidateRenderCache();
        this.positionCacheExpired = true;
    }

    setHotKeys(hotKeys) {
        if (_.isObject(hotKeys)) {
            if (this.caseInsensitiveHotKeys) {
                this.hotKeys = {};
                for (const key in hotKeys) {
                    this.hotKeys[key.toLowerCase()] = hotKeys[key];
                }
            } else {
                this.hotKeys = hotKeys;
            }
        }
    }
}

exports.MenuView = MenuView;
