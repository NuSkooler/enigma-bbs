'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const { pipeToAnsi } = require('./color_codes.js');
const { pad: padStr, stylizeString, stripAllLineFeeds } = require('./string_util.js');
const stringFormat = require('./string_format');
const { getPredefinedMCIFormatObject } = require('./predefined_mci');

//  ── Constants ────────────────────────────────────────────────────────────────

//  All supported motion types
const MOTION = Object.freeze({
    LEFT: 'left',
    RIGHT: 'right',
    BOUNCE: 'bounce',
    REVEAL: 'reveal',
    TYPEWRITER: 'typewriter',
    FALL_LEFT: 'fallLeft',
    FALL_RIGHT: 'fallRight',
});

//  Bright ANSI rainbow sequence: red, yellow, green, cyan, blue, magenta
const RAINBOW_SGR = [91, 93, 92, 96, 94, 95];

//  Visually interesting CP437 chars used for scramble/glitch noise
const NOISE_CHARS = '!#$@%&?<>^~`\xb0\xb1\xb2\xdb\xdc\xde\xdf\xfe\xf9';

//  Text-style effects handled by stylizeString (baked into _plainText at setText time).
//  All other effect values are dynamic per-tick effects applied in _applyEffect().
const TEXT_STYLE_EFFECTS = new Set([
    'normal',
    'upper',
    'lower',
    'title',
    'firstLower',
    'smallVowels',
    'bigVowels',
    'smallI',
    'mixed',
    'l33t',
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

        this.fillChar = options.fillChar || ' ';
        this.motion = options.motion || options.scrollDir || MOTION.LEFT;
        this.effect = options.effect || options.textStyle || 'normal';
        this.tickInterval = parseInt(options.tickInterval, 10) || 100;
        this.holdTicks = parseInt(options.holdTicks, 10) || 20;

        this._rawText = '';
        this._plainText = '';
        this._scrollOffset = 0;
        this._colorPhase = 0; //  rainbow: phase counter (independent of scroll)
        this._bounceDir = 1; //  bounce: current direction (+1 / -1)
        this._motionPhase = 0; //  reveal/typewriter/fall: phase within the cycle
        this._motionTick = 0; //  reveal/typewriter/fall: ticks in current phase
        this._motionInitialized = false; //  deferred init so dimens.width is known
        this._charPos = []; //  fall: current x-position of each character
        this._finalPos = []; //  fall: target x-position of each character
        this._timer = null;
        this._lastRendered = null; //  redraw cache: skip write when output is unchanged

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

        const ansi = pipeToAnsi(stripAllLineFeeds(text), this.client);

        //  Build a per-character color map so pipe codes survive scrolling.
        //  Only populated when the text actually contains color sequences;
        //  empty array means "use view SGR" (no change to existing behavior).
        this._charColors = this._buildCharColorMap(ansi);

        //  Strip all ANSI / pipe markup to get raw visible characters, then
        //  apply any stylizeString text-style effect (l33t, upper, mixed, …).
        //  Dynamic effects (rainbow, scramble, glitch) operate on this plain
        //  text every tick rather than pre-processing it here.
        const stripped = stripAnsiCodes(ansi);
        this._plainText = TEXT_STYLE_EFFECTS.has(this.effect)
            ? stylizeString(stripped, this.effect)
            : stripped;

        this._resetMotion();
    }

    //  Parse ANSI escape sequences in |ansiText| and return an array whose
    //  i-th element is the SGR string that applies to the i-th visible character.
    //  Returns an empty array when no color codes are present (fast path).
    _buildCharColorMap(ansiText) {
        const sgrRe = /\x1b\[([0-9;]*)m/g; //  eslint-disable-line no-control-regex
        const colors = [];
        let currentColor = '';
        let lastEnd = 0;
        let match;

        while ((match = sgrRe.exec(ansiText)) !== null) {
            //  Visible characters between the previous escape and this one.
            for (let i = lastEnd; i < match.index; i++) {
                colors.push(currentColor);
            }
            currentColor = match[0]; //  full ESC[…m sequence
            lastEnd = match.index + match[0].length;
        }

        if (colors.length === 0) {
            return []; //  no escapes found — fast path, plain text
        }

        //  Remaining visible characters after the last escape.
        for (let i = lastEnd; i < ansiText.length; i++) {
            colors.push(currentColor);
        }

        return colors;
    }

    //  ── Motion state ─────────────────────────────────────────────────────────

    _resetMotion() {
        this._scrollOffset = 0;
        this._bounceDir = 1;
        this._motionPhase = 0;
        this._motionTick = 0;
        this._motionInitialized = false;
        this._charPos = [];
        this._finalPos = [];
        this._lastRendered = null; //  force redraw after any motion/text reset
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
            const cap = Math.min(this._plainText.length, this.dimens.width);
            const width = this.dimens.width;
            const isFallLeft = this.motion === MOTION.FALL_LEFT;
            const maxDist = width - cap; //  total available displacement
            const minDist = Math.max(1, Math.round(maxDist * 0.25)); //  25% as floor

            this._charPos = new Array(cap);
            this._finalPos = new Array(cap);

            if (cap <= 1) {
                //  Single character: start at the opposite edge.
                this._finalPos[0] = isFallLeft ? 0 : width - 1;
                this._charPos[0] = isFallLeft ? width - 1 : 0;
            } else {
                for (let i = 0; i < cap; i++) {
                    //  t goes 0→1 across the text; tMirror is flipped for fallRight.
                    const t = i / (cap - 1);
                    if (isFallLeft) {
                        //  dist[i] = minDist + (maxDist-minDist)*t² — quadratic growth.
                        //  char 0 travels minDist, char cap-1 travels maxDist.
                        this._finalPos[i] = i;
                        const dist = minDist + Math.round((maxDist - minDist) * t * t);
                        this._charPos[i] = i + dist;
                    } else {
                        //  Mirror: char cap-1 travels minDist, char 0 travels maxDist.
                        const tMirror = (cap - 1 - i) / (cap - 1);
                        this._finalPos[i] = width - cap + i;
                        const dist =
                            minDist + Math.round((maxDist - minDist) * tMirror * tMirror);
                        this._charPos[i] = width - cap + i - dist;
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

        const len = this._plainText.length;
        const width = this.dimens.width;

        switch (this.motion) {
            case MOTION.RIGHT: {
                const src = len + Math.min(width, 10);
                this._scrollOffset = (this._scrollOffset - 1 + src) % src;
                break;
            }

            case MOTION.BOUNCE: {
                if (len <= width) {
                    break;
                } //  text fits — nothing to bounce
                const max = len - width;
                this._scrollOffset += this._bounceDir;
                if (this._scrollOffset >= max) {
                    this._scrollOffset = max;
                    this._bounceDir = -1;
                } else if (this._scrollOffset <= 0) {
                    this._scrollOffset = 0;
                    this._bounceDir = 1;
                }
                break;
            }

            case MOTION.REVEAL:
                switch (this._motionPhase) {
                    case 0: //  sliding in: leading fill chars decrease toward 0
                        this._scrollOffset = Math.max(0, this._scrollOffset - 1);
                        if (this._scrollOffset === 0) {
                            this._motionPhase = 1;
                            this._motionTick = 0;
                        }
                        break;
                    case 1: //  holding
                        if (++this._motionTick >= this.holdTicks) {
                            this._motionPhase = 2;
                            this._motionTick = 0;
                        }
                        break;
                    case 2: //  sliding out: leading fill chars increase toward width
                        if (++this._scrollOffset >= width) {
                            this._scrollOffset = width;
                            this._motionPhase = 0;
                        }
                        break;
                }
                break;

            case MOTION.TYPEWRITER:
                switch (this._motionPhase) {
                    case 0: {
                        //  type one character per tick
                        const cap = Math.min(len, width);
                        this._scrollOffset = Math.min(this._scrollOffset + 1, cap);
                        if (this._scrollOffset >= cap) {
                            this._motionPhase = 1;
                            this._motionTick = 0;
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
                        this._motionPhase = 0;
                        break;
                }
                break;

            case MOTION.FALL_LEFT:
            case MOTION.FALL_RIGHT:
                switch (this._motionPhase) {
                    case 0: {
                        //  falling: each char moves one step toward its final position
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
                            this._motionTick = 0;
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

            default: {
                //  MOTION.LEFT
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

    //  Returns { plain, offset } where plain is exactly dimens.width visible
    //  characters for this tick and offset is the index into _plainText/_charColors
    //  of the first character in plain (for color map alignment).
    _getVisiblePlain() {
        const plain = this._plainText;
        const len = plain.length;
        const width = this.dimens.width;
        const fill = this.fillChar;

        if (len === 0) {
            return { plain: fill.repeat(width), offset: 0 };
        }

        switch (this.motion) {
            case MOTION.REVEAL: {
                const lead = Math.min(this._scrollOffset, width);
                const avail = width - lead;
                const slice = plain.slice(0, avail);
                return {
                    plain: fill.repeat(lead) + slice + fill.repeat(avail - slice.length),
                    offset: 0,
                };
            }

            case MOTION.TYPEWRITER:
                return {
                    plain: plain.slice(0, this._scrollOffset).padEnd(width, fill),
                    offset: 0,
                };

            case MOTION.BOUNCE: {
                if (len <= width) {
                    return { plain: plain.padEnd(width, fill), offset: 0 };
                }
                const off = Math.max(0, Math.min(this._scrollOffset, len - width));
                return { plain: plain.slice(off, off + width), offset: off };
            }

            case MOTION.FALL_LEFT:
            case MOTION.FALL_RIGHT: {
                if (this._charPos.length === 0) {
                    return { plain: fill.repeat(width), offset: 0, colorIndices: null };
                }
                const arr = new Array(width).fill(fill);
                //  colorIndices[displayCol] = source text index for that column
                const colorIndices = new Array(width).fill(-1);
                for (let i = 0; i < this._charPos.length; i++) {
                    const x = this._charPos[i];
                    if (x >= 0 && x < width) {
                        arr[x] = plain[i];
                        colorIndices[x] = i;
                    }
                }
                return { plain: arr.join(''), offset: 0, colorIndices };
            }

            default: {
                //  left / right: circular scroll with gap
                const gap = fill.repeat(Math.min(width, 10));
                const source = plain + gap;
                const srcLen = source.length;
                const off = ((this._scrollOffset % srcLen) + srcLen) % srcLen;
                return {
                    plain: (source + source).slice(off, off + width).padEnd(width, fill),
                    offset: off < len ? off : 0,
                };
            }
        }
    }

    //  ── Effects ───────────────────────────────────────────────────────────────

    //  Transforms the plain visible text into a terminal-ready string by
    //  applying per-character ANSI where needed.  For text-style effects the
    //  plain text is already correctly transformed; this just wraps it in the
    //  view's normal SGR (or per-character pipe colors if present).
    _applyEffect(plain, visibleOffset = 0, colorIndices = null) {
        switch (this.effect) {
            case 'rainbow':
                return this._rainbowEffect(plain);
            case 'scramble':
                return this._scrambleEffect(plain, visibleOffset, colorIndices);
            case 'glitch':
                return this._glitchEffect(plain, visibleOffset, colorIndices);
            default:
                //  If the text had pipe/ANSI color codes, apply per-char colors.
                if (this._charColors.length > 0) {
                    return this._coloredEffect(plain, visibleOffset, colorIndices);
                }
                //  stylizeString text styles are already baked into _plainText
                return this.getSGR() + plain;
        }
    }

    //  Emit each visible character with its original pipe-derived color,
    //  collapsing consecutive same-color runs to minimise escape output.
    //  colorIndices, when provided (fall motions), maps display position → source index.
    _coloredEffect(plain, visibleOffset, colorIndices = null) {
        const colors = this._charColors;
        let out = '';
        let lastColor = null;

        for (let i = 0; i < plain.length; i++) {
            const srcIdx = colorIndices ? colorIndices[i] : visibleOffset + i;
            const color = srcIdx >= 0 && srcIdx < colors.length ? colors[srcIdx] : '';
            if (color !== lastColor) {
                out += color || this.getSGR();
                lastColor = color;
            }
            out += plain[i];
        }
        out += this.getSGR();
        return out;
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

    //  ~30% of non-fill characters are replaced with noise rendered in reverse-video
    //  relative to that character's current color (pipe or theme SGR).
    _scrambleEffect(plain, visibleOffset = 0, colorIndices = null) {
        const colors = this._charColors;
        let out = this.getSGR();
        let lastColor = '';

        for (let i = 0; i < plain.length; i++) {
            const srcIdx = colorIndices ? colorIndices[i] : visibleOffset + i;
            const charColor =
                colors.length > 0 && srcIdx >= 0 && srcIdx < colors.length
                    ? colors[srcIdx]
                    : '';

            if (plain[i] !== this.fillChar && Math.random() < 0.3) {
                //  Reverse-video relative to this character's color, then restore.
                out +=
                    (charColor || this.getSGR()) +
                    '\x1b[7m' +
                    randomNoise() +
                    this.getSGR();
                lastColor = '';
            } else {
                if (charColor !== lastColor) {
                    out += charColor || this.getSGR();
                    lastColor = charColor;
                }
                out += plain[i];
            }
        }
        return out;
    }

    //  1–3 random characters corrupted to noise per tick, colored with styleSGR2
    //  (the view's focus/highlight SGR) so glitch color is fully theme-controlled.
    _glitchEffect(plain, visibleOffset = 0, colorIndices = null) {
        const colors = this._charColors;
        const glitchSGR = this.getStyleSGR(2) || this.getSGR();
        const arr = plain.split('').map((ch, i) => {
            const srcIdx = colorIndices ? colorIndices[i] : visibleOffset + i;
            return {
                ch,
                color:
                    colors.length > 0 && srcIdx >= 0 && srcIdx < colors.length
                        ? colors[srcIdx]
                        : '',
            };
        });

        const count = 1 + Math.floor(Math.random() * 3);
        for (let n = 0; n < count; n++) {
            const i = Math.floor(Math.random() * arr.length);
            if (arr[i].ch !== this.fillChar) {
                arr[i] = { ch: randomNoise(), color: glitchSGR, _restore: true };
            }
        }

        let out = this.getSGR();
        let lastColor = '';
        for (const { ch, color, _restore } of arr) {
            if (color !== lastColor) {
                out += color || this.getSGR();
                lastColor = color;
            }
            out += ch;
            if (_restore) {
                out += this.getSGR();
                lastColor = '';
            }
        }
        return out;
    }

    //  ── Rendering ─────────────────────────────────────────────────────────────

    _startTicker() {
        if (this._timer) {
            return;
        }
        this._timer = setInterval(() => {
            this._advanceMotion();
            this.redraw();
        }, this.tickInterval);
    }

    redraw() {
        const { plain, offset, colorIndices } = this._getVisiblePlain();
        const rendered = this._applyEffect(plain, offset, colorIndices);

        //  Skip the write (and cursor movement from super.redraw) when the
        //  terminal output hasn't changed since the last tick.  This matters for
        //  bounce when text fits the window, reveal/typewriter hold phases, and
        //  any other static period — it prevents the cursor from bouncing around.
        //  Dynamic effects (rainbow, scramble, glitch) produce different output
        //  every tick so they are unaffected.
        if (rendered === this._lastRendered) {
            return;
        }
        this._lastRendered = rendered;

        super.redraw();
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
