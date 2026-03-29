'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const { pipeToAnsi } = require('./color_codes.js');
const {
    pad: padStr,
    stylizeString,
    stripAllLineFeeds,
} = require('./string_util.js');
const stringFormat = require('./string_format');
const { getPredefinedMCIFormatObject } = require('./predefined_mci');

//  ── Constants ────────────────────────────────────────────────────────────────

//  All supported motion types
const MOTION = Object.freeze({
    LEFT:       'left',
    RIGHT:      'right',
    BOUNCE:     'bounce',
    REVEAL:     'reveal',
    TYPEWRITER: 'typewriter',
    FALL_LEFT:  'fallLeft',
    FALL_RIGHT: 'fallRight',
});

//  Bright ANSI rainbow sequence: red, yellow, green, cyan, blue, magenta
const RAINBOW_SGR = [91, 93, 92, 96, 94, 95];

//  Visually interesting CP437 chars used for scramble/glitch noise
const NOISE_CHARS = '!#$@%&?<>^~`\xb0\xb1\xb2\xdb\xdc\xde\xdf\xfe\xf9';

//  Text-style effects handled by stylizeString (baked into _plainText at setText time).
//  All other effect values are dynamic per-tick effects applied in _applyEffect().
const TEXT_STYLE_EFFECTS = new Set([
    'normal', 'upper', 'lower', 'title', 'firstLower',
    'smallVowels', 'bigVowels', 'smallI', 'mixed', 'l33t',
]);

//  ── Helpers ──────────────────────────────────────────────────────────────────

function stripAnsiCodes(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function randomNoise() {
    return NOISE_CHARS[Math.floor(Math.random() * NOISE_CHARS.length)];
}

//  ── TickerView ───────────────────────────────────────────────────────────────

class TickerView extends View {
    constructor(options) {
        if (options.dimens) {
            options.dimens.height = 1;
        }

        super(options);

        this.initDefaultWidth();

        this.fillChar     = options.fillChar                    || ' ';
        this.motion       = options.motion || options.scrollDir || MOTION.LEFT;
        this.effect       = options.effect || options.textStyle || 'normal';
        this.tickInterval = parseInt(options.tickInterval, 10)  || 100;
        this.holdTicks    = parseInt(options.holdTicks,    10)  || 20;

        this._rawText           = '';
        this._plainText         = '';
        this._scrollOffset      = 0;
        this._colorPhase        = 0;    //  rainbow: phase counter (independent of scroll)
        this._bounceDir         = 1;    //  bounce: current direction (+1 / -1)
        this._motionPhase       = 0;    //  reveal/typewriter/fall: phase within the cycle
        this._motionTick        = 0;    //  reveal/typewriter/fall: ticks in current phase
        this._motionInitialized = false;//  deferred init so dimens.width is known
        this._charPos           = [];   //  fall: current x-position of each character
        this._finalPos          = [];   //  fall: target x-position of each character
        this._timer             = null;

        this.setText(options.text || '');
        this._startTicker();
    }

    //  ── Text ─────────────────────────────────────────────────────────────────

    getText() {
        return this._rawText;
    }

    setText(text) {
        if (!text) {
            text = '';
        }

        const formatObj = getPredefinedMCIFormatObject(this.client, text);
        if (formatObj) {
            text = stringFormat(text, formatObj);
        }

        this._rawText = text;

        //  Strip all ANSI / pipe markup to get raw visible characters, then
        //  apply any stylizeString text-style effect (l33t, upper, mixed, …).
        //  Dynamic effects (rainbow, scramble, glitch) operate on this plain
        //  text every tick rather than pre-processing it here.
        const stripped = stripAnsiCodes(
            pipeToAnsi(stripAllLineFeeds(text), this.client)
        );
        this._plainText = TEXT_STYLE_EFFECTS.has(this.effect)
            ? stylizeString(stripped, this.effect)
            : stripped;

        this._resetMotion();
    }

    //  ── Motion state ─────────────────────────────────────────────────────────

    _resetMotion() {
        this._scrollOffset      = 0;
        this._bounceDir         = 1;
        this._motionPhase       = 0;
        this._motionTick        = 0;
        this._motionInitialized = false;
        this._charPos           = [];
        this._finalPos          = [];
    }

    //  Called once on the first tick so that dimens.width is guaranteed set.
    _initMotion() {
        if (this.motion === MOTION.REVEAL) {
            //  Start with text fully off-screen to the right.
            this._scrollOffset = this.dimens.width;
        }
        if (this.motion === MOTION.FALL_LEFT || this.motion === MOTION.FALL_RIGHT) {
            //  Quadratic spread: gaps between adjacent chars INCREASE toward the far
            //  (source) edge of the window.  Every char has at least minDist columns
            //  to travel, so nothing shows up instantly.  All chars move at 1 col/tick,
            //  so the tight-left / spread-right look is visible throughout the fall:
            //
            //    fallLeft  — starts on the RIGHT, stacks at the LEFT.
            //                char 0 (leftmost final) lands first; char cap-1 lands last.
            //                Gap sequence: small near i=0, large near i=cap-1.
            //
            //    fallRight — mirror: starts on the LEFT, stacks at the RIGHT.
            //
            //  Shorter texts produce a more dramatic effect because each char has more
            //  room to spread across the window.
            const cap        = Math.min(this._plainText.length, this.dimens.width);
            const width      = this.dimens.width;
            const isFallLeft = this.motion === MOTION.FALL_LEFT;
            const maxDist    = width - cap;       //  total available displacement
            const minDist    = Math.max(1, Math.round(maxDist * 0.25));  //  25% as floor

            this._charPos  = new Array(cap);
            this._finalPos = new Array(cap);

            if (cap <= 1) {
                //  Single character: start at the opposite edge.
                this._finalPos[0] = isFallLeft ? 0 : width - 1;
                this._charPos[0]  = isFallLeft ? width - 1 : 0;
            } else {
                for (let i = 0; i < cap; i++) {
                    //  t goes 0→1 across the text; tMirror is flipped for fallRight.
                    const t = i / (cap - 1);
                    if (isFallLeft) {
                        //  dist[i] = minDist + (maxDist-minDist)*t² — quadratic growth.
                        //  char 0 travels minDist, char cap-1 travels maxDist.
                        this._finalPos[i] = i;
                        const dist = minDist + Math.round((maxDist - minDist) * t * t);
                        this._charPos[i]  = i + dist;
                    } else {
                        //  Mirror: char cap-1 travels minDist, char 0 travels maxDist.
                        const tMirror = (cap - 1 - i) / (cap - 1);
                        this._finalPos[i] = width - cap + i;
                        const dist = minDist + Math.round((maxDist - minDist) * tMirror * tMirror);
                        this._charPos[i]  = (width - cap + i) - dist;
                    }
                }
            }
        }
        this._motionInitialized = true;
    }

    _advanceMotion() {
        if (!this._motionInitialized) {
            this._initMotion();
        }

        const len   = this._plainText.length;
        const width = this.dimens.width;

        switch (this.motion) {
            case MOTION.RIGHT: {
                const src = len + Math.min(width, 10);
                this._scrollOffset = (this._scrollOffset - 1 + src) % src;
                break;
            }

            case MOTION.BOUNCE: {
                if (len <= width) { break; }  //  text fits — nothing to bounce
                const max = len - width;
                this._scrollOffset += this._bounceDir;
                if (this._scrollOffset >= max) {
                    this._scrollOffset = max;
                    this._bounceDir    = -1;
                } else if (this._scrollOffset <= 0) {
                    this._scrollOffset = 0;
                    this._bounceDir    = 1;
                }
                break;
            }

            case MOTION.REVEAL:
                switch (this._motionPhase) {
                    case 0: //  sliding in: leading fill chars decrease toward 0
                        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
                        if (this._scrollOffset === 0) {
                            this._motionPhase = 1;
                            this._motionTick  = 0;
                        }
                        break;
                    case 1: //  holding
                        if (++this._motionTick >= this.holdTicks) {
                            this._motionPhase = 2;
                            this._motionTick  = 0;
                        }
                        break;
                    case 2: //  sliding out: leading fill chars increase toward width
                        if (++this._scrollOffset >= width) {
                            this._scrollOffset = width;
                            this._motionPhase  = 0;
                        }
                        break;
                }
                break;

            case MOTION.TYPEWRITER:
                switch (this._motionPhase) {
                    case 0: { //  type one character per tick
                        const cap = Math.min(len, width);
                        this._scrollOffset = Math.min(this._scrollOffset + 1, cap);
                        if (this._scrollOffset >= cap) {
                            this._motionPhase = 1;
                            this._motionTick  = 0;
                        }
                        break;
                    }
                    case 1: //  holding at full text
                        if (++this._motionTick >= this.holdTicks) {
                            this._motionPhase = 2;
                        }
                        break;
                    case 2: //  instant clear → restart
                        this._scrollOffset = 0;
                        this._motionPhase  = 0;
                        break;
                }
                break;

            case MOTION.FALL_LEFT:
            case MOTION.FALL_RIGHT:
                switch (this._motionPhase) {
                    case 0: { //  falling: each char moves one step toward its final position
                        const isFallLeft = this.motion === MOTION.FALL_LEFT;
                        let allLanded = true;
                        for (let i = 0; i < this._charPos.length; i++) {
                            if (this._charPos[i] !== this._finalPos[i]) {
                                allLanded = false;
                                this._charPos[i] += isFallLeft ? -1 : 1;
                                //  Clamp to final in case of overshoot.
                                if (isFallLeft) {
                                    if (this._charPos[i] < this._finalPos[i]) {
                                        this._charPos[i] = this._finalPos[i];
                                    }
                                } else {
                                    if (this._charPos[i] > this._finalPos[i]) {
                                        this._charPos[i] = this._finalPos[i];
                                    }
                                }
                            }
                        }
                        if (allLanded) {
                            this._motionPhase = 1;
                            this._motionTick  = 0;
                        }
                        break;
                    }
                    case 1: //  holding at full landed display
                        if (++this._motionTick >= this.holdTicks) {
                            this._motionPhase = 2;
                        }
                        break;
                    case 2: //  re-spread and restart
                        this._motionInitialized = false;
                        this._motionPhase = 0;
                        this._initMotion();
                        break;
                }
                break;

            default: //  MOTION.LEFT
            {
                const src = len + Math.min(width, 10);
                if (src > 0) {
                    this._scrollOffset = (this._scrollOffset + 1) % src;
                }
                break;
            }
        }

        //  Color phase increments every tick for a smooth rainbow swim.
        this._colorPhase = (this._colorPhase + 1) % RAINBOW_SGR.length;
    }

    //  ── Visible window ────────────────────────────────────────────────────────

    //  Returns a plain-text string of exactly dimens.width visible characters
    //  representing what should be shown this tick, before any effect is applied.
    _getVisiblePlain() {
        const plain = this._plainText;
        const len   = plain.length;
        const width = this.dimens.width;
        const fill  = this.fillChar;

        if (len === 0) {
            return fill.repeat(width);
        }

        switch (this.motion) {
            case MOTION.REVEAL: {
                //  _scrollOffset = number of fill chars leading the text
                const lead  = Math.min(this._scrollOffset, width);
                const avail = width - lead;
                const slice = plain.slice(0, avail);
                return fill.repeat(lead) + slice + fill.repeat(avail - slice.length);
            }

            case MOTION.TYPEWRITER:
                //  _scrollOffset = number of chars currently revealed
                return plain.slice(0, this._scrollOffset).padEnd(width, fill);

            case MOTION.BOUNCE: {
                if (len <= width) {
                    return plain.padEnd(width, fill);
                }
                const off = Math.max(0, Math.min(this._scrollOffset, len - width));
                return plain.slice(off, off + width);
            }

            case MOTION.FALL_LEFT:
            case MOTION.FALL_RIGHT: {
                //  Before first tick _charPos hasn't been initialized — show blank.
                if (this._charPos.length === 0) {
                    return fill.repeat(width);
                }
                //  Place each character at its current x-position; everything else is fill.
                const arr = new Array(width).fill(fill);
                for (let i = 0; i < this._charPos.length; i++) {
                    const x = this._charPos[i];
                    if (x >= 0 && x < width) {
                        arr[x] = plain[i];
                    }
                }
                return arr.join('');
            }

            default: { //  left / right: circular scroll with gap
                const gap    = fill.repeat(Math.min(width, 10));
                const source = plain + gap;
                const srcLen = source.length;
                const off    = ((this._scrollOffset % srcLen) + srcLen) % srcLen;
                return (source + source).slice(off, off + width).padEnd(width, fill);
            }
        }
    }

    //  ── Effects ───────────────────────────────────────────────────────────────

    //  Transforms the plain visible text into a terminal-ready string by
    //  applying per-character ANSI where needed.  For text-style effects the
    //  plain text is already correctly transformed; this just wraps it in the
    //  view's normal SGR.
    _applyEffect(plain) {
        switch (this.effect) {
            case 'rainbow':   return this._rainbowEffect(plain);
            case 'scramble':  return this._scrambleEffect(plain);
            case 'glitch':    return this._glitchEffect(plain);
            default:
                //  stylizeString text styles are already baked into _plainText
                return this.getSGR() + plain;
        }
    }

    //  Each character cycles through RAINBOW_SGR; the phase shifts with
    //  _colorPhase so the whole spectrum appears to swim through the text.
    _rainbowEffect(plain) {
        let out = '';
        for (let i = 0; i < plain.length; i++) {
            const code = RAINBOW_SGR[(i + this._colorPhase) % RAINBOW_SGR.length];
            out += `\x1b[${code}m${plain[i]}`;
        }
        return out + this.getSGR();
    }

    //  ~30% of non-fill characters are replaced with green noise each tick.
    _scrambleEffect(plain) {
        let out = this.getSGR();
        for (let i = 0; i < plain.length; i++) {
            if (plain[i] !== this.fillChar && Math.random() < 0.30) {
                out += `\x1b[1;32m${randomNoise()}${this.getSGR()}`;
            } else {
                out += plain[i];
            }
        }
        return out;
    }

    //  Real text with 1-3 random characters corrupted to red noise per tick.
    _glitchEffect(plain) {
        const arr   = plain.split('');
        const count = 1 + Math.floor(Math.random() * 3);
        for (let n = 0; n < count; n++) {
            const i = Math.floor(Math.random() * arr.length);
            if (arr[i] !== this.fillChar) {
                arr[i] = `\x1b[1;31m${randomNoise()}${this.getSGR()}`;
            }
        }
        return this.getSGR() + arr.join('');
    }

    //  ── Rendering ─────────────────────────────────────────────────────────────

    _startTicker() {
        if (this._timer) { return; }
        this._timer = setInterval(() => {
            this._advanceMotion();
            this.redraw();
        }, this.tickInterval);
    }

    redraw() {
        super.redraw();
        const plain    = this._getVisiblePlain();
        const rendered = this._applyEffect(plain);
        this.client.term.write(
            padStr(
                rendered,
                this.dimens.width,
                this.fillChar,
                'left',
                this.getSGR(),
                this.getSGR(),
                true //  use render len
            ),
            false
        );
    }

    destroy() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    //  ── Properties ───────────────────────────────────────────────────────────

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'text':
                this.setText(value);
                break;
            case 'motion':
                this.motion = value;
                this._resetMotion();
                break;
            case 'scrollDir': //  legacy alias → motion
                this.motion = value;
                this._resetMotion();
                break;
            case 'effect':
            case 'textStyle': //  textStyle treated as alias for effect
                this.effect = value;
                //  Re-bake plain text if switching to a stylizeString style
                if (TEXT_STYLE_EFFECTS.has(value) && this._rawText) {
                    const stripped = stripAnsiCodes(
                        pipeToAnsi(stripAllLineFeeds(this._rawText), this.client)
                    );
                    this._plainText = stylizeString(stripped, value);
                }
                break;
            case 'tickInterval':
                this.tickInterval = parseInt(value, 10) || 100;
                if (this._timer) {
                    clearInterval(this._timer);
                    this._timer = null;
                    this._startTicker();
                }
                break;
            case 'holdTicks':
                this.holdTicks = parseInt(value, 10) || 20;
                break;
            case 'fillChar':
                this.fillChar = String(value).charAt(0) || ' ';
                break;
        }

        super.setPropertyValue(propName, value);
    }
}

exports.TickerView = TickerView;
exports.TICKER_MOTION = MOTION;
