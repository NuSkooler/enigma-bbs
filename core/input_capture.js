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
//  once matters both ways:
//  - a capture whose handler releases itself (waitForKeyPress()) has gone
//    before the forms' handlers run for that same key, and they must still
//    leave it alone;
//  - a capture opened while the key is being delivered (a form's action
//    starts a pause) is for the next key: every later listener still sees
//    this one, as all 'key press' listeners did before captures existed.
//
//  Kept in a WeakMap, like View's input focus, so a client (or a test's
//  mock client) that goes away takes its state with it. No other
//  requires: client.js loads this early.
//

//
//  client -> {
//      stack       [ token ], newest last
//      claimed     the key being delivered went to a capture
//      keySeq      counts the keys dispatched; a token records the value
//                  when it was taken, so a capture taken while key N is
//                  being delivered (token.keySeq === N) is not counted for N
//      dispatcher  the 'key press' listener
//  }
//
const captureStates = new WeakMap();

function getState(client) {
    let state = captureStates.get(client);
    if (state) {
        return state;
    }

    state = { stack: [], claimed: false, keySeq: 0 };
    captureStates.set(client, state);

    //  Installed once and kept, so it is still first for every key after
    //  the stack empties: it resets |claimed| for keys nobody captures.
    const dispatcher = (ch, key) => {
        ++state.keySeq;
        //  Captures left over from a menu that has gone hear the next key
        //  without taking it, as a plain once('key press') did: see
        //  menuChanged()
        const stale = state.stack.filter(t => t.passThrough);
        const receivers = keyReceivers(state);
        state.claimed = receivers.length > 0;
        //  A handler may release (or drop) another token, or the menu may
        //  change, while the key is delivered: only tokens still held get it
        for (const token of stale) {
            if (state.stack.includes(token)) {
                token.handler(ch, key);
            }
        }
        for (const token of receivers) {
            if (state.stack.includes(token)) {
                token.handler(ch, key);
            }
        }
    };
    state.dispatcher = dispatcher;
    //  (a stand-in client that emits no keys has nothing to listen on)
    if (typeof client.prependListener === 'function') {
        client.prependListener('key press', dispatcher);
    }

    return state;
}

//  The capture that takes keys: the newest not left over from a menu gone
function topCapture(state) {
    for (let i = state.stack.length - 1; i >= 0; --i) {
        if (!state.stack[i].passThrough) {
            return state.stack[i];
        }
    }
    return null;
}

//
//  Who gets this key: the top capture. When that is a plain wait
//  (waitForKeyPress()), every plain wait directly under it gets the same
//  key too, oldest first, as several once('key press') waits did before
//  waits were captures; each releases itself. A general captureInput()
//  handler stops the run: it, and whatever is under it, wait.
//
function keyReceivers(state) {
    const top = topCapture(state);
    if (!top || !top.isWait) {
        return top ? [top] : [];
    }
    const run = [];
    for (let i = state.stack.length - 1; i >= 0; --i) {
        const token = state.stack[i];
        if (token.passThrough) {
            continue; //  heard the key already, as a leftover
        }
        if (!token.isWait) {
            break;
        }
        run.unshift(token);
    }
    return run;
}

//
//  Something removed every 'key press' listener (a mod calling
//  client.removeAllListeners('key press')): without the dispatcher no
//  capture would get a key, and a pause would wait forever. Put it back,
//  first again.
//
function ensureDispatcher(client, state) {
    if (
        typeof client.listeners !== 'function' ||
        typeof client.prependListener !== 'function'
    ) {
        return;
    }
    if (!client.listeners('key press').includes(state.dispatcher)) {
        //  whatever it decided last is about a key long gone
        state.claimed = false;
        client.prependListener('key press', state.dispatcher);
    }
}

//  True when |client|'s dispatcher is listening (a mock client may have
//  none: then every capture held counts for every key)
function isDispatcherInstalled(client, state) {
    return (
        typeof client.listeners === 'function' &&
        client.listeners('key press').includes(state.dispatcher)
    );
}

//
//  A ViewController is attaching its 'key press' handler: make sure the
//  dispatcher is still there, first, for a client that has used captures
//  (see ensureDispatcher()).
//
function ensureKeyDispatch(client) {
    const state = captureStates.get(client);
    if (state) {
        ensureDispatcher(client, state);
    }
}

//
//  Make |handler(ch, key)| the receiver of every key until releaseInput()
//  is called with the token returned, or a later capture covers it.
//
//  options:
//    onMenuChange  what happens to the capture if the menu it was taken for
//                  goes while it is still held (see menuChanged()):
//                  'passThrough' (default) -- its handler still gets the next
//                  key, which reaches the new menu as well, as a plain
//                  once('key press') wait did; 'drop' -- it is dropped, the
//                  handler is never called (a cover's own capture).
//    onDrop()      called if the capture is dropped rather than released
//                  (the client ended, or 'drop' above). The handler will
//                  never be called; clean up here.
//
function captureInput(client, handler, options) {
    if (typeof handler !== 'function') {
        throw new TypeError('captureInput() requires a handler function');
    }
    const state = getState(client);
    const token = { handler, keySeq: state.keySeq };
    if (options && typeof options.onDrop === 'function') {
        token.onDrop = options.onDrop;
    }
    if (options && 'drop' === options.onMenuChange) {
        token.dropOnMenuChange = true;
    }
    ensureDispatcher(client, state);
    state.stack.push(token);
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
    ensureDispatcher(client, state);
    return true;
}

//
//  Drop every capture, calling each one's onDrop(), top first: the menu
//  they were taken for has gone (a sysop break-in, a time-up while a pause
//  waited). Unlike release, the handlers are never called, so nothing
//  continues on behalf of the menu that has gone. Returns how many there
//  were.
//
function dropAllInput(client) {
    const state = captureStates.get(client);
    if (!state || 0 === state.stack.length) {
        return 0;
    }
    return dropTokens(client, state.stack.splice(0).reverse());
}

//
//  The menu stack has moved to another menu while captures were held (a
//  sysop break-in, a time-up, an idle logoff while a pause waited). A
//  capture taken with onMenuChange: 'drop' is dropped. Any other is left
//  as a plain wait was before captures existed: its handler gets the next
//  key, which no longer stops there but reaches the new menu's forms too.
//  Returns { dropped, passThrough } counts.
//
function menuChanged(client) {
    const state = captureStates.get(client);
    if (!state || 0 === state.stack.length) {
        return { dropped: 0, passThrough: 0 };
    }
    const drop = state.stack.filter(t => t.dropOnMenuChange);
    state.stack = state.stack.filter(t => !t.dropOnMenuChange);
    let passThrough = 0;
    for (const token of state.stack) {
        if (!token.passThrough) {
            token.passThrough = true;
            ++passThrough;
        }
    }
    return { dropped: dropTokens(client, drop.reverse()), passThrough };
}

function dropTokens(client, dropped) {
    for (const token of dropped) {
        if (token.onDrop) {
            try {
                token.onDrop();
            } catch (e) {
                if (client.log) {
                    client.log.warn(
                        { error: e.message },
                        'Input capture cleanup failed while dropping it'
                    );
                }
            }
        }
    }
    return dropped.length;
}

//  True while a capture takes keys (one left over from a menu gone does not)
function hasInputCapture(client) {
    const state = captureStates.get(client);
    return !!state && !!topCapture(state);
}

//
//  For a ViewController's 'key press' handler: true when the key being
//  delivered went to a capture, or a capture taken before this key's
//  delivery began is still held. A capture taken during the delivery (a
//  form's action opened a pause) is for the next key. Read only during
//  'key press' delivery: |claimed| and |keySeq| describe the key in flight.
//  Without a dispatcher listening (a mock client), every capture held
//  counts.
//
function isKeyPressCaptured(client) {
    const state = captureStates.get(client);
    if (!state) {
        return false;
    }
    if (!isDispatcherInstalled(client, state)) {
        return !!topCapture(state);
    }
    return (
        state.claimed || state.stack.some(t => !t.passThrough && t.keySeq < state.keySeq)
    );
}

module.exports = {
    captureInput,
    releaseInput,
    dropAllInput,
    menuChanged,
    hasInputCapture,
    isKeyPressCaptured,
    ensureKeyDispatch,
};
