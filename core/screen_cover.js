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
//  - input is captured: no form under the cover gets a key, including the
//    key that ends it. A wait inside fn (client.waitForKeyPress(), a
//    pausePrompt()) is a plain listener and gets its key as usual.
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
//    scope             (default none)  which views are suspended; see
//                                      View.suspendBackgroundDraw()
//
//  By default (no scope) only views that exist when the cover starts are
//  suspended: views the cover itself creates (a ticker in its pause
//  prompt, a form built inside fn) draw as usual. With scope { menu },
//  views on that menu's forms are suspended too, whenever they were
//  created; the interrupt cover (UserInterruptQueue) uses it, so a form
//  the interrupted menu builds under it does not draw over it.
//
//  A cover cut short: if the caller is moved to another menu while the
//  cover is up (a sysop break-in, a time-up) or the client ends, the cover
//  is abandoned. Its capture and suspend are dropped then (see
//  MenuStack._settleCovers()); when fn later calls done (a pause inside it
//  hears the next key), restore and cb are skipped, so the menu that has
//  gone neither repaints over the new one nor carries on (a prevMenu() that
//  would pop the new menu). Anything still held is released. Only a cover
//  that captures input (the default) can tell it was cut short. A fn that
//  never calls done holds the cover (keys dropped, background drawing
//  suspended) until then: the menu change or the disconnect lets it go.
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

    let abandoned = false;
    const inputToken =
        false !== options.captureInput
            ? captureInput(client, () => {}, {
                  onMenuChange: 'drop',
                  onDrop: () => {
                      abandoned = true;
                  },
              })
            : null;
    const drawToken =
        false !== options.suspendBackground
            ? View.suspendBackgroundDraw(client, options.scope)
            : null;

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
                    redrawMissed: false !== options.redrawMissed && !abandoned,
                });
            }
            if (abandoned) {
                if (client.log) {
                    client.log.debug(
                        {
                            restoreSkipped: !restoreRan,
                            error: (err || restoreErr || {}).message,
                        },
                        'Screen cover was cut short by a menu change or disconnect; not continuing it'
                    );
                }
                return;
            }
            if (_.isFunction(cb)) {
                return cb(err || restoreErr || null, ...results);
            }
        };

        let restoreRan = false;
        if (!abandoned && !err && _.isFunction(options.restore)) {
            restoreRan = true;
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
