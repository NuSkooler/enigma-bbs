'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const { captureInput, releaseInput } = require('./input_capture.js');

//  deps
const _ = require('lodash');

//
//  coverScreen(client, [options,] fn, cb) -- show something over the
//  current screen (an interrupt, a help page, a message) and then give the
//  screen back.
//
//  While fn runs:
//  - input is captured: keys typed while the cover draws are dropped
//    instead of reaching a form under it. A wait inside fn
//    (client.waitForKeyPress()) captures on top and gets its key.
//  - background drawing is suspended: a ticker or status bar under the
//    cover does not draw over it.
//
//  fn(done) draws the cover and calls done(err, ...results) when it is
//  finished with the screen. Then options.restore(cb), if given, repaints
//  what was covered, still with input captured and background drawing
//  suspended, so it is not interleaved with a tick. Last, input is released
//  and background drawing resumed: a view that missed a draw gets one full
//  redraw. cb(err, ...results) is called after that.
//
//  options:
//    captureInput      (default true)  capture and drop keys while covered
//    suspendBackground (default true)  suspend background drawing
//    restore(cb)                       repaint the covered screen; skipped
//                                      when fn failed
//    redrawMissed      (default true)  redraw the background views that
//                                      missed a draw; false when the caller
//                                      replaces the screen next (a reload)
//
//  Only views that exist when the cover starts are suspended: views the
//  cover itself creates (a ticker in its pause prompt) draw as usual.
//
//  Release and resume happen once, also when fn throws or calls done twice.
//  An exception thrown by cb itself is not caught.
//
function coverScreen(client, options, fn, cb) {
    if (_.isFunction(options)) {
        cb = fn;
        fn = options;
        options = {};
    }
    options = options || {};

    const inputToken =
        false !== options.captureInput ? captureInput(client, () => {}) : null;
    const drawToken =
        false !== options.suspendBackground ? View.suspendBackgroundDraw(client) : null;

    let finished = false;
    const finish = (err, ...results) => {
        if (finished) {
            return;
        }
        finished = true;

        let uncovered = false;
        const uncover = restoreErr => {
            if (uncovered) {
                return;
            }
            uncovered = true;

            if (inputToken) {
                releaseInput(client, inputToken);
            }
            if (drawToken) {
                View.resumeBackgroundDraw(client, drawToken, {
                    redrawMissed: false !== options.redrawMissed,
                });
            }
            if (_.isFunction(cb)) {
                return cb(err || restoreErr || null, ...results);
            }
        };

        if (!err && _.isFunction(options.restore)) {
            try {
                return options.restore(uncover);
            } catch (e) {
                if (uncovered) {
                    throw e; //  thrown by cb, after the uncover: not ours
                }
                return uncover(e);
            }
        }
        return uncover();
    };

    try {
        fn(finish);
    } catch (e) {
        if (finished) {
            throw e; //  thrown after done() (by restore or cb): not fn's
        }
        finish(e);
    }
}

module.exports = { coverScreen };
