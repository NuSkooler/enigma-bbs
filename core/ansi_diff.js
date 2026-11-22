'use strict';

//  ENiGMA½
const ansi = require('./ansi_term.js');

//
//  The diff writer: what to write to turn one canvas on screen
//  (core/ansi_canvas.js) into the next, as little as possible.
//
//  - Only runs of changed cells are written; a cell masked as transparent
//    (applyTransparency()) never is.
//  - A run starts with a goto. Two runs on one row are joined when
//    redrawing the unchanged cells between them costs less than the goto
//    (about GOTO_COST bytes) would.
//  - SGR is written only where it changes. Every attr starts from a reset,
//    so the first one written does not depend on what the terminal was
//    set to.
//
//  A transition (transition()) holds the runs, positioned within the
//  canvas: render() turns it into a string for a screen position, so one
//  transition, computed once, draws an animation at any origin, for any
//  client. Write the string with client.term.write(str, false): it is
//  encoded for the session there.
//

//  what a goto (ESC [ row ; col H) is taken to cost, in bytes
const GOTO_COST = 8;

//  Bytes a cell's character is taken to cost. One: CP437 sessions, the
//  usual case. A UTF-8 session pays more for a non-ASCII character, which
//  only makes joining across a gap a little less of a bargain there.
const CHAR_COST = 1;

function isMasked(mask, width, row, col) {
    return Boolean(mask && mask[row * width + col]);
}

//
//  The runs that turn |prev| into |next| (canvases of one size), or that
//  draw all of |next| when |prev| is null or |options.full| is set.
//  |options.mask|: cells never drawn (applyTransparency()).
//
//  Returns { full, width, height, runs: [ { row, col, chars, attrs, body } ] }.
//  |body| is the run's characters with the SGR it needs, given the runs
//  before it in the same transition (render() uses it when nothing is
//  clipped).
//
function transition(prev, next, options = {}) {
    const mask = options.mask || null;
    const full = !prev || true === options.full;
    if (!full && (prev.width !== next.width || prev.height !== next.height)) {
        throw new Error('Canvases differ in size');
    }

    const { width, height } = next;
    const runs = [];
    let attrNow = null; //  the SGR the output leaves set, as it is built

    const changed = (r, c) =>
        full ||
        prev.chars[r][c] !== next.chars[r][c] ||
        prev.attrs[r][c] !== next.attrs[r][c];

    for (let r = 0; r < height; ++r) {
        let run = null;
        let runAttr = null; //  SGR set after the run's last cell
        let gapStart = -1; //  first unchanged cell after the run, if any

        const close = () => {
            if (run) {
                runs.push(run);
                attrNow = runAttr;
            }
            run = null;
            gapStart = -1;
        };

        for (let c = 0; c < width; ++c) {
            if (isMasked(mask, width, r, c)) {
                close(); //  never drawn: a run cannot cross it
                continue;
            }
            if (!changed(r, c)) {
                if (run && gapStart < 0) {
                    gapStart = c;
                }
                continue;
            }

            const attr = next.attrs[r][c];
            if (run && gapStart >= 0) {
                //  join over the gap, or go to |c|?
                let joinCost = 0;
                let a = runAttr;
                for (let g = gapStart; g < c; ++g) {
                    const ga = next.attrs[r][g];
                    if (ga !== a) {
                        joinCost += ga.length;
                        a = ga;
                    }
                    joinCost += CHAR_COST;
                }
                joinCost += attr !== a ? attr.length : 0;
                const gotoCost = GOTO_COST + (attr !== runAttr ? attr.length : 0);

                if (joinCost < gotoCost) {
                    for (let g = gapStart; g < c; ++g) {
                        run.chars.push(next.chars[r][g]);
                        run.attrs.push(next.attrs[r][g]);
                    }
                    runAttr = a;
                    gapStart = -1;
                } else {
                    close();
                }
            }

            if (!run) {
                run = { row: r, col: c, chars: [], attrs: [] };
                runAttr = attrNow;
            }
            run.chars.push(next.chars[r][c]);
            run.attrs.push(attr);
            runAttr = attr;
            gapStart = -1;
        }
        close();
    }

    //  bodies, in output order
    let a = null;
    runs.forEach(run => {
        let body = '';
        for (let i = 0; i < run.chars.length; ++i) {
            if (run.attrs[i] !== a) {
                a = run.attrs[i];
                body += a;
            }
            body += run.chars[i];
        }
        run.body = body;
    });

    return { full, width, height, runs };
}

//
//  |t| as a string for the screen. |options|:
//
//  origin          1-based screen position of the canvas' top left
//                  (default { row: 1, col: 1 })
//  termWidth,
//  termHeight      the screen: cells past it are not written (clipped, as
//                  views clip to the terminal)
//  iceColors       a full redraw starts by setting iCE (blink is a bright
//                  background), for frames drawn from iCE art
//
function render(t, options = {}) {
    const origin = options.origin || { row: 1, col: 1 };
    const termWidth = options.termWidth > 0 ? options.termWidth : Infinity;
    const termHeight = options.termHeight > 0 ? options.termHeight : Infinity;

    let out = t.full && options.iceColors ? ansi.blinkToBrightIntensity() : '';

    const fits =
        origin.row >= 1 &&
        origin.col >= 1 &&
        origin.row + t.height - 1 <= termHeight &&
        origin.col + t.width - 1 <= termWidth;

    if (fits) {
        for (const run of t.runs) {
            out += ansi.goto(origin.row + run.row, origin.col + run.col) + run.body;
        }
        return out;
    }

    //  clipped: each run cut to the screen, SGR tracked as written
    let a = null;
    for (const run of t.runs) {
        const row = origin.row + run.row;
        if (row < 1 || row > termHeight) {
            continue;
        }
        let first = -1;
        let body = '';
        for (let i = 0; i < run.chars.length; ++i) {
            const col = origin.col + run.col + i;
            if (col < 1 || col > termWidth) {
                continue;
            }
            if (first < 0) {
                first = col;
            }
            if (run.attrs[i] !== a) {
                a = run.attrs[i];
                body += a;
            }
            body += run.chars[i];
        }
        if (first > 0) {
            out += ansi.goto(row, first) + body;
        }
    }
    return out;
}

//
//  render() |t| and write it to |term| (client.term), encoded for the
//  session. Returns the string written ('' writes nothing).
//
function write(term, t, options) {
    const out = render(t, options);
    if (out) {
        term.write(out, false);
    }
    return out;
}

//
//  Transitions between the frames of a static list (canvases of one
//  size). Each step forward (i -> i + 1) and the wrap (last -> 0) is worked
//  out when this is built, so a tick in loop order costs a lookup; any
//  other pair (pingpong, random) is worked out on first use and kept.
//  full(i) draws frame i whole (the first draw, a redraw).
//
class FrameTransitions {
    constructor(frames, options = {}) {
        this.frames = frames;
        this.mask = options.mask || null;
        this._full = new Map();
        this._steps = new Map();
        if (frames.length > 1) {
            for (let i = 0; i < frames.length; ++i) {
                this.get(i, (i + 1) % frames.length);
            }
        }
    }

    get size() {
        return this.frames.length;
    }

    full(i) {
        let t = this._full.get(i);
        if (!t) {
            t = transition(null, this.frames[i], { mask: this.mask });
            this._full.set(i, t);
        }
        return t;
    }

    //  |from| -> |to|; |from| null (nothing known on screen) is full(to)
    get(from, to) {
        if (null === from || undefined === from) {
            return this.full(to);
        }
        const key = from * this.frames.length + to;
        let t = this._steps.get(key);
        if (!t) {
            t = transition(this.frames[from], this.frames[to], { mask: this.mask });
            this._steps.set(key, t);
        }
        return t;
    }
}

exports.GOTO_COST = GOTO_COST;
exports.transition = transition;
exports.render = render;
exports.write = write;
exports.FrameTransitions = FrameTransitions;
