'use strict';

//
//  Per-client input capture stack.
//
//  Something that owns the screen for a while -- a pause waiting for its
//  key, an interrupt, a help page -- captures the client's input: while any
//  capture is active only the top capture's handler gets a key, and every
//  ViewController's key handler does nothing. The forms under the cover
//  stay attached, so nothing has to find "every form" and put it back.
//
//  Direct 'key press' listeners on the client (a door's or WFC's own key
//  handling) still see every key, as they always have.
//
//  Dispatch is one 'key press' listener per client, prepended so that it
//  runs before any ViewController's. It decides once per key whether the key
//  is captured; ViewController handlers ask isKeyPressCaptured(). Deciding
//  once matters: a capture whose handler releases itself (waitForKeyPress())
//  has gone before the forms' handlers run for that same key, and they must
//  still leave it alone.
//
//  Kept in a WeakMap, like View's input focus, so a client (or a test's
//  mock client) that goes away takes its state with it. No other
//  requires: client.js loads this early.
//

//  client -> { stack: [ token ], claimed: bool }
const captureStates = new WeakMap();

function getState(client) {
    let state = captureStates.get(client);
    if (state) {
        return state;
    }

    state = { stack: [], claimed: false };
    captureStates.set(client, state);

    //  Installed once and kept, so it is still first for every key after
    //  the stack empties: it resets |claimed| for keys nobody captures.
    const dispatcher = (ch, key) => {
        const top = state.stack[state.stack.length - 1];
        state.claimed = !!top;
        if (top) {
            top.handler(ch, key);
        }
    };
    client.prependListener('key press', dispatcher);

    return state;
}

//
//  Make |handler(ch, key)| the receiver of every key until releaseInput()
//  is called with the token returned, or a later capture covers it.
//
function captureInput(client, handler) {
    if (typeof handler !== 'function') {
        throw new TypeError('captureInput() requires a handler function');
    }
    const token = { handler };
    getState(client).stack.push(token);
    return token;
}

//
//  Remove the capture |token|, wherever it is in the stack: a cover that
//  ends while a later one is still open must not take the later one down.
//  Returns false for a token that is not (or no longer) captured.
//
function releaseInput(client, token) {
    const state = captureStates.get(client);
    if (!state || !token) {
        return false;
    }
    const i = state.stack.indexOf(token);
    if (i < 0) {
        return false;
    }
    state.stack.splice(i, 1);
    return true;
}

//  Drop every capture: the client has ended, and no handler will be called
function releaseAllInput(client) {
    const state = captureStates.get(client);
    if (state) {
        state.stack.length = 0;
    }
}

function hasInputCapture(client) {
    const state = captureStates.get(client);
    return !!state && state.stack.length > 0;
}

//
//  For a ViewController's 'key press' handler: true when the key being
//  delivered went to a capture, or a capture is active now. Read during
//  'key press' delivery; |claimed| describes the key in flight.
//
function isKeyPressCaptured(client) {
    const state = captureStates.get(client);
    return !!state && (state.claimed || state.stack.length > 0);
}

module.exports = {
    captureInput,
    releaseInput,
    releaseAllInput,
    hasInputCapture,
    isKeyPressCaptured,
};
