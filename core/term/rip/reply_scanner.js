/* jslint node: true */
'use strict';

//
//  Takes the RIPscrip version reply out of what an ANSI terminal sends (#989).
//
//  A RIP terminal answers the version query (see ./index.js) on the input
//  stream as if it had been typed: RIPSCRIP and six digits, and from IcyTerm
//  a NUL after them. Nothing about it says "reply" the way ESC does for CPR,
//  so it is looked for in ordinary input -- but only for a short while, and
//  only once, so that what a caller types or pastes is left alone:
//
//      const scanner = createRipReplyScanner({
//          windowMs, holdMs, nulWindowMs, onError(err),
//      });
//      scanner.expectReply()              the query has just been sent
//      scanner.scan(data, { bytes(chunk), reply(version) })
//      scanner.dispose()
//
//  scan() calls the sink synchronously and in stream order: bytes() with
//  everything that is not the reply, reply() with the reply ('RIPSCRIP015410',
//  without the NUL).
//
//  WHEN IT LOOKS
//  -------------
//  Only from expectReply() until windowMs later (default DEFAULT_WINDOW_MS,
//  30 seconds), and only until the first reply has been taken. Real terminals
//  answer within a round trip of the query; 30 seconds covers a slow or
//  congested link (and the connect probes, which can take several seconds
//  when a terminal answers none of them) while the caller is still at the
//  matrix or the login prompt. Before expectReply(), after the window, after
//  the first reply (and its NUL, below) and after dispose(), scan() hands
//  every chunk to bytes() as the very same object: nothing is held, nothing
//  is removed, no timer is started. Inside the window, a chunk holding no
//  reply and ending in nothing that could start one is passed on the same
//  way.
//
//  The window is checked against a monotonic clock on each scan(); there is
//  no timer for it.
//
//  A REPLY SPLIT ACROSS CHUNKS
//  ---------------------------
//  Inside the window, when a chunk ends in what could be the start of the
//  reply (RI, RIPSC, RIPSCRIP01, ...), those bytes are held back and the next
//  chunk is read as if it had followed them directly. If nothing comes within
//  holdMs (default 100) they are handed on as they were, in order; the same
//  happens when the window has closed by the next chunk. Only a tail of two
//  bytes or more is held: a lone 'R' is a typed key or the end of a cursor
//  position report (ESC [ row ; col R), and neither may be delayed or cut
//  off. So a reply split right after its first byte gets through as keys.
//  Not seen in practice: the reply is 14 bytes in one write. The hold timer
//  is unref()ed and cleared by dispose(). Held bytes that turn out not to be
//  the reply go to bytes() on their own, and the chunk after them as the
//  object it arrived as, so the decoder sees the chunk boundaries it would
//  have seen anyway. When the timer hands held bytes on and the sink throws
//  (the sink runs the decoder and the menu's key handlers), the error goes
//  to options.onError, if given; a timer cannot throw it to anyone.
//
//  Held bytes go to the sink of the scan() that held them. If a module swaps
//  the client's data handler (setTemporaryDirectDataHandler, for a door or a
//  transfer) during those 100 ms, the held bytes still reach the menu side.
//  That needs a door started within the first 30 seconds of the connection
//  and within 100 ms of the caller typing something that starts like the
//  reply; the bytes are the caller's own keys, delivered late rather than
//  lost. Not worth a hook into the data handler swap.
//
//  THE NUL
//  -------
//  A NUL right after the reply is part of it. When the reply ends a chunk, a
//  NUL starting the next chunk is taken too, if it comes within nulWindowMs
//  (default 500). Either way, that next chunk is the last one looked at.
//
//  Node built-ins only.
//
const { REPLY_PREFIX, REPLY_DIGITS } = require('./index.js');

const DEFAULT_WINDOW_MS = 30 * 1000;
const DEFAULT_HOLD_MS = 100;
const DEFAULT_NUL_WINDOW_MS = 500;
//  setTimeout() treats a delay above 2^31-1 ms as 1 ms: keep within it
const MAX_TIMER_MS = 0x7fffffff;

const PREFIX = Buffer.from(REPLY_PREFIX, 'latin1');
const REPLY_LENGTH = PREFIX.length + REPLY_DIGITS;

const isDigit = byte => byte >= 0x30 && byte <= 0x39;

//  true when buf[from..] is a proper prefix of a reply (RIPSCRIP + digits)
function isReplyStart(buf, from) {
    const length = buf.length - from;
    if (length <= 0 || length >= REPLY_LENGTH) {
        return false;
    }
    for (let i = 0; i < length; ++i) {
        const byte = buf[from + i];
        if (i < PREFIX.length ? byte !== PREFIX[i] : !isDigit(byte)) {
            return false;
        }
    }
    return true;
}

//
//  Where the held-back tail of |buf| starts, or -1. Only bytes from |from| on
//  count (earlier ones are already spoken for), and only a tail of two bytes
//  or more.
//
function heldTailStart(buf, from) {
    const earliest = Math.max(from, buf.length - (REPLY_LENGTH - 1));
    for (let at = earliest; at <= buf.length - 2; ++at) {
        if (isReplyStart(buf, at)) {
            return at;
        }
    }
    return -1;
}

//  The first complete reply in |buf|: { at, end } (end past any NUL), or null
function findReply(buf) {
    let searchFrom = 0;
    for (;;) {
        const at = buf.indexOf(PREFIX, searchFrom);
        if (at < 0) {
            return null;
        }
        let digits = 0;
        while (
            digits < REPLY_DIGITS &&
            at + PREFIX.length + digits < buf.length &&
            isDigit(buf[at + PREFIX.length + digits])
        ) {
            ++digits;
        }
        if (REPLY_DIGITS === digits) {
            return { at, end: at + REPLY_LENGTH };
        }
        searchFrom = at + 1;
    }
}

//  States
const Idle = 'idle'; //  query not sent yet: pass-through
const Looking = 'looking'; //  inside the window
const AfterReply = 'afterReply'; //  reply ended a chunk: the next may start with its NUL
const Done = 'done'; //  pass-through for good

function createRipReplyScanner(options = {}) {
    const boundedMs = (value, fallback) =>
        Number.isFinite(value) ? Math.min(MAX_TIMER_MS, Math.max(0, value)) : fallback;
    const windowMs = boundedMs(options.windowMs, DEFAULT_WINDOW_MS);
    const holdMs = boundedMs(options.holdMs, DEFAULT_HOLD_MS);
    const nulWindowMs = boundedMs(options.nulWindowMs, DEFAULT_NUL_WINDOW_MS);
    const onError = 'function' === typeof options.onError ? options.onError : null;

    //  elapsed time that cannot run backwards
    const now = () => Number(process.hrtime.bigint() / 1000000n);

    let state = Idle;
    let windowEnd = 0;
    let nulUntil = 0;
    let held = null; //  Buffer: a tail that could start the reply
    let heldSink = null;
    let timer = null;

    const cancelTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    function flushHeld() {
        timer = null;
        const bytes = held;
        const sink = heldSink;
        held = null;
        heldSink = null;
        if (bytes && sink) {
            try {
                sink.bytes(bytes);
            } catch (e) {
                //  a timer must never throw: report it, if anyone listens
                if (onError) {
                    try {
                        onError(e);
                    } catch (ignored) {
                        //  nothing more to be done
                    }
                }
            }
        }
    }

    function expectReply() {
        if (Idle === state) {
            state = Looking;
            windowEnd = now() + windowMs;
        }
    }

    function dispose() {
        state = Done;
        cancelTimer();
        held = null;
        heldSink = null;
    }

    function hold(bytes, sink) {
        held = Buffer.from(bytes);
        heldSink = sink;
        timer = setTimeout(flushHeld, holdMs);
        timer.unref();
    }

    //  |buf| holds |found|: hand on what is around it, report it, and stop
    //  looking (but for the NUL in the next chunk, when the reply ends this one)
    function takeReply(buf, found, sink) {
        let end = found.end;
        if (end < buf.length) {
            if (0x00 === buf[end]) {
                ++end;
            }
            state = Done;
        } else {
            state = AfterReply;
            nulUntil = now() + nulWindowMs;
        }
        if (found.at > 0) {
            sink.bytes(buf.subarray(0, found.at));
        }
        sink.reply(buf.toString('latin1', found.at, found.at + REPLY_LENGTH));
        if (end < buf.length) {
            sink.bytes(buf.subarray(end));
        }
    }

    //  A chunk, nothing held before it, inside the window. |data| is what
    //  scan() was given, passed on as is when there is nothing to take or hold.
    function lookIn(buf, data, sink) {
        const found = findReply(buf);
        if (found) {
            return takeReply(buf, found, sink);
        }
        const holdAt = heldTailStart(buf, 0);
        if (-1 === holdAt) {
            return sink.bytes(data);
        }
        hold(buf.subarray(holdAt), sink);
        if (holdAt > 0) {
            sink.bytes(buf.subarray(0, holdAt));
        }
    }

    function scan(data, sink) {
        if (Idle === state || Done === state) {
            return sink.bytes(data);
        }

        cancelTimer();

        const prior = held;
        held = null;
        heldSink = null;

        if (AfterReply === state) {
            //  nothing is ever held after a reply
            state = Done;
            const chunk = Buffer.isBuffer(data)
                ? data
                : Buffer.from(String(data), 'utf8');
            if (chunk.length > 0 && 0x00 === chunk[0] && now() <= nulUntil) {
                return chunk.length > 1 ? sink.bytes(chunk.subarray(1)) : undefined;
            }
            return sink.bytes(data);
        }

        //  Looking. Held bytes go on as a piece of their own, ahead of the
        //  new chunk, unless a reply carries on across the join: the new
        //  chunk then reaches the decoder as the very object it arrived as,
        //  so it is decoded exactly as it would have been without the hold
        //  (a lone byte above 0x7F is a meta key only as a chunk of its own).
        if (now() > windowEnd) {
            state = Done;
            if (prior) {
                sink.bytes(prior);
            }
            return sink.bytes(data);
        }

        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');

        if (prior) {
            const joined = Buffer.concat([prior, chunk]);

            //  a reply that starts in the held bytes and ends in this chunk
            const found = findReply(joined);
            if (found && found.at < prior.length) {
                return takeReply(joined, found, sink);
            }

            //  or one that starts there and is still not complete: keep
            //  holding. What is held is only reply characters (letters and
            //  digits), so handing it on later in one piece instead of the
            //  pieces it came in decodes the same.
            const holdAt = heldTailStart(joined, 0);
            if (-1 !== holdAt && holdAt < prior.length) {
                hold(joined.subarray(holdAt), sink);
                if (holdAt > 0) {
                    sink.bytes(joined.subarray(0, holdAt));
                }
                return;
            }

            sink.bytes(prior);
        }

        return lookIn(chunk, data, sink);
    }

    return { expectReply, scan, dispose };
}

module.exports = {
    createRipReplyScanner,
    DEFAULT_WINDOW_MS,
    DEFAULT_HOLD_MS,
    DEFAULT_NUL_WINDOW_MS,
};
