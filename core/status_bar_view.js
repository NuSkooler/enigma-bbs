'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');
const ansi = require('./ansi_term.js');
const { pipeToAnsi } = require('./color_codes.js');
const {
    pad: padStr,
    stylizeString,
    renderSubstr,
    renderStringLength,
    stripAllLineFeeds,
} = require('./string_util.js');
const { getPredefinedMCIFormatObject } = require('./predefined_mci');
const stringFormat = require('./string_format');

const _ = require('lodash');

//
//  StatusBarView (%SB) — a text view with two modes:
//
//  Single mode (no `panels` option):
//      Behaves like a TextView with an optional timed auto-refresh.
//      Useful for clocks, counters, and other self-updating labels.
//
//  Panel mode (`panels` array in options):
//      The view is divided into independently-addressable slots.
//      Each panel has its own width, alignment, color (styleSGR1), fill
//      character, and optional auto-refresh text template.
//
//      SB-level options:
//        anchor    - 'left' (default) | 'right'
//                    Which end panel[0] sits on.  'right' reverses draw order
//                    so the first panel in the config is the rightmost one.
//        justify   - 'left' (default) | 'center' | 'right'
//                    How the panel group sits within the total view width.
//        separator - pipe-code string drawn between panels (default: '').
//
//      Per-panel options (all use existing ENiGMA property names/semantics):
//        name            - string key for setPanel('name', value); falls back to index
//        width           - fixed number, or 'fill' (one fill panel allowed per SB)
//        justify         - 'left' (default) | 'center' | 'right'  within the panel slot
//        styleSGR1       - pipe-code string for value color (e.g. '|09')
//        textStyle       - 'normal' | 'bold' | 'reverse' | 'blink' (stylizeString)
//        fillChar        - pipe-code string for pad character (e.g. '|08 ')
//        overflow        - 'clip' (default) | 'clip-left'
//        text            - pipe-code format string for auto-refresh panels (e.g. '{CT}')
//        refreshInterval - ms; overrides SB-level default; 0 = event-driven only
//
//      Theming: sysops override per-panel properties (by index) in theme.hjson via
//      the standard MCI customization path.  Named panels are for code use only.
//
class StatusBarView extends TextView {
    constructor(options) {
        super(options);

        //  Keep the raw format template for the single-mode auto-refresh tick.
        this._format         = options.text || '';
        this.refreshInterval = parseInt(options.refreshInterval, 10) || 0;
        this._timer          = null;

        if (Array.isArray(options.panels)) {
            //  Panel mode: anchor and separator are SB-level; justify is inherited
            //  from View (already set by super() via options.justify).
            this._anchor    = options.anchor    || 'left';
            this._separator = options.separator || '';
            this._initPanels(options.panels);
        } else if (this.refreshInterval > 0) {
            this._startRefresh();
        }
    }

    //  ── Panel initialization ─────────────────────────────────────────────────

    _initPanels(panelConfigs) {
        this._panels = panelConfigs.map((cfg, idx) => {
            const panel = {
                name:            cfg.name || String(idx),
                width:           cfg.width,   //  number or 'fill'
                justify:         cfg.justify  || 'left',
                styleSGR1:       cfg.styleSGR1  ? pipeToAnsi(String(cfg.styleSGR1))  : null,
                textStyle:       cfg.textStyle  || 'normal',
                _fillChar:       pipeToAnsi(cfg.fillChar != null ? String(cfg.fillChar) : ' '),
                overflow:        cfg.overflow   || 'clip',
                text:            cfg.text       || '',
                refreshInterval: parseInt(cfg.refreshInterval, 10) || this.refreshInterval || 0,
                value:           '',
                _timer:          null,
            };

            //  Panels with a text template always get an initial evaluated value.
            //  Those with a refreshInterval also auto-refresh on a timer.
            if (panel.text) {
                panel.value = this._evalPanelText(panel.text);
            }
            if (panel.text && panel.refreshInterval > 0) {
                panel._timer = setInterval(() => {
                    const val = this._evalPanelText(panel.text);
                    if (val !== panel.value) {
                        panel.value = val;
                        this.redraw();
                    }
                }, panel.refreshInterval);
            }

            return panel;
        });
    }

    //  Evaluate a panel's text template through predefined MCI format + pipe codes.
    _evalPanelText(text) {
        const formatObj = getPredefinedMCIFormatObject(this.client, text);
        let result = text;
        if (formatObj) {
            result = stringFormat(text, formatObj);
        }
        return pipeToAnsi(stripAllLineFeeds(result), this.client);
    }

    //  ── Public panel API ─────────────────────────────────────────────────────

    //  Update a single panel by name or index and redraw.
    setPanel(nameOrIndex, value) {
        if (!this._panels) {
            return;
        }

        const panel = _.isNumber(nameOrIndex)
            ? this._panels[nameOrIndex]
            : this._panels.find(p => p.name === nameOrIndex);

        if (!panel) {
            return;
        }

        panel.value = this._processPanelValue(value, panel.textStyle);
        this.redraw();
    }

    //  Update multiple panels at once with a single redraw.
    //  `updates` is an object keyed by panel name or index: { mode: 'INS', pos: '01,01' }
    setPanels(updates) {
        if (!this._panels) {
            return;
        }

        for (const [key, value] of Object.entries(updates)) {
            const idx   = _.isFinite(+key) ? +key : null;
            const panel = idx !== null
                ? this._panels[idx]
                : this._panels.find(p => p.name === key);

            if (panel) {
                panel.value = this._processPanelValue(value, panel.textStyle);
            }
        }

        this.redraw();
    }

    //  Process a value string the same way TextView.setText() would:
    //  pipeToAnsi → stripAllLineFeeds → stylizeString with panel textStyle.
    _processPanelValue(value, textStyle) {
        value = String(value == null ? '' : value);
        value = pipeToAnsi(stripAllLineFeeds(value), this.client);
        return stylizeString(value, textStyle);
    }

    //  ── Render ───────────────────────────────────────────────────────────────

    redraw() {
        if (!this._panels) {
            return super.redraw();
        }

        //  Short-circuit the very first draw if we have nothing yet (mirrors TextView).
        if (!this.hasDrawnOnce && _.isUndefined(this.text)) {
            return;
        }
        this.hasDrawnOnce = true;

        //  Go to the view position directly — do NOT call super.redraw() here because
        //  that resolves to TextView.redraw() which calls drawText(''), overwriting the
        //  slot with empty-padded text and advancing the cursor past the view area
        //  before we get a chance to write panel content.
        this.client.term.write(ansi.goto(this.position.row, this.position.col));
        this.client.term.write(this._buildPanelString(), false);
    }

    _buildPanelString() {
        //  anchor: 'right' reverses draw order so panel[0] is rightmost.
        const panels = 'right' === this._anchor
            ? [...this._panels].reverse()
            : this._panels;

        //  Compute the width of the fill panel (if any).
        const sepRendered = pipeToAnsi(this._separator);
        const sepLen      = renderStringLength(sepRendered);
        const totalSepLen = panels.length > 1 ? sepLen * (panels.length - 1) : 0;
        const fixedWidth  = panels.reduce(
            (sum, p) => ('fill' !== p.width ? sum + p.width : sum), 0
        );
        const fillWidth = Math.max(0, this.dimens.width - fixedWidth - totalSepLen);

        //  Render each panel slot.
        const parts = panels.map(panel => {
            const w   = 'fill' === panel.width ? fillWidth : panel.width;
            const sgr = panel.styleSGR1 || this.getSGR();

            let val    = panel.value;
            const vLen = renderStringLength(val);
            if (vLen > w) {
                val = 'clip-left' === panel.overflow
                    ? renderSubstr(val, vLen - w, w)
                    : renderSubstr(val, 0, w);
            }

            //  pad(s, len, padChar, justify, stringSGR, padSGR, useRenderLen)
            //  padSGR = sgr so padding matches value color; fillChar may contain
            //  its own pipe-code SGR which overrides padSGR for each pad char.
            return padStr(val, w, panel._fillChar, panel.justify, sgr, sgr, true);
        });

        //  Join panels.  Each panel's own styleSGR1 self-declares its color, so
        //  no explicit SGR restore is needed after the separator (option 3).
        const content    = parts.join(sepRendered);
        const contentLen = renderStringLength(content);
        const padLen     = Math.max(0, this.dimens.width - contentLen);
        const baseSGR    = this.getSGR();

        //  Apply group justify within the total view width.
        if (0 === padLen || 'left' === this.justify) {
            return content;
        }
        if ('right' === this.justify) {
            return `${baseSGR}${' '.repeat(padLen)}${content}`;
        }
        //  center
        const leftPad  = Math.floor(padLen / 2);
        const rightPad = padLen - leftPad;
        return `${baseSGR}${' '.repeat(leftPad)}${content}${baseSGR}${' '.repeat(rightPad)}`;
    }

    //  ── Single-mode auto-refresh (no panels) ─────────────────────────────────

    _startRefresh() {
        this._timer = setInterval(() => {
            //  Process the format template without triggering a redraw yet,
            //  so we can compare the result against the last rendered value.
            this.setText(this._format, false);
            if (this.text !== this._lastRendered) {
                this._lastRendered = this.text;
                this.redraw();
            }
        }, this.refreshInterval);
    }

    //  ── Property system ──────────────────────────────────────────────────────

    setPropertyValue(propName, value) {
        if ('text' === propName) {
            //  Keep _format in sync with text for single-mode auto-refresh.
            this._format = value || '';
        } else if ('refreshInterval' === propName) {
            if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
            this.refreshInterval = parseInt(value, 10) || 0;
            if (!this._panels && this.refreshInterval > 0) {
                this._startRefresh();
            }
        } else if ('panels' === propName && Array.isArray(value)) {
            //  Full panel replacement (e.g. from theme.hjson override).
            if (this._panels) {
                this._panels.forEach(p => {
                    if (p._timer) {
                        clearInterval(p._timer);
                    }
                });
            }
            this._initPanels(value);
        } else if ('anchor' === propName) {
            this._anchor = value;
        } else if ('separator' === propName) {
            this._separator = value;
        }

        super.setPropertyValue(propName, value);
    }

    //  ── Lifecycle ────────────────────────────────────────────────────────────

    destroy() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._panels) {
            this._panels.forEach(p => {
                if (p._timer) {
                    clearInterval(p._timer);
                    p._timer = null;
                }
            });
        }
    }
}

exports.StatusBarView = StatusBarView;
