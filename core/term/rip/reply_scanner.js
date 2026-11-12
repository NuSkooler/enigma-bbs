/* jslint node: true */
'use strict';

//
//  Takes RIPscrip version replies out of what an ANSI terminal sends (#989).
//
//  A RIP terminal answers the version query (see ./index.js) on the input
//  stream as if it had been typed: RIPSCRIP and six digits, and from IcyTerm
//  a NUL after them. Nothing about it says "reply" the way ESC does for CPR,
//  and it can arrive at any time: after the connect probes are done, or
//  while the caller is typing a user name. So it is looked for in every
//  chunk, for the whole session, and never passed on as keys.
//
//      const scanner = createRipReplyScanner({ holdMs, nulWindowMs });
//      scanner.scan(data, { bytes(chunk), reply(version) })
//      scanner.dispose()
//
//  scan() calls the sink synchronously and in stream order: bytes() with
//  everything that is not a reply, reply() with each reply ('RIPSCRIP015410',
//  without the NUL). A chunk holding no reply and ending in nothing that
//  could start one is handed to bytes() as the very same object, untouched,
//  so for any other input this is not there.
//
//  A REPLY SPLIT ACROSS CHUNKS
//  ---------------------------
//  A terminal writes the reply in one go and it nearly always arrives in one
//  chunk. When a chunk ends in what could be the start of one (RI, RIPSC,
//  RIPSCRIP01, ...), those bytes are held back, and the next chunk is read as
//  if it had followed them directly. If nothing comes within holdMs (default
//  100) they are handed on as they were. Only a tail of two bytes or more is
//  held: a lone 'R' is a typed key or the end of a cursor position report
//  (ESC [ row ; col R), and neither may be delayed or cut off. So a reply
//  split right after its first byte is the one split that gets through: the
//  'R' and the rest reach the menu as keys. Not seen in practice: the reply
//  is 14 bytes in one write.
//
//  THE NUL
//  -------
//  A NUL right after a reply is part of it. When the reply ends a chunk,
//  a NUL starting the next one is taken too, if it comes within nulWindowMs
//  (default 500).
//
//  Node built-ins only.
//
const { REPLY_PREFIX, REPLY_DIGITS } = require('./index.js');

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

function createRipReplyScanner(options = {}) {
    const boundedMs = (value, fallback) =>
        Number.isFinite(value) ? Math.min(MAX_TIMER_MS, Math.max(0, value)) : fallback;
    const holdMs = boundedMs(options.holdMs, DEFAULT_HOLD_MS);
    const nulWindowMs = boundedMs(options.nulWindowMs, DEFAULT_NUL_WINDOW_MS);

    //  elapsed time that cannot run backwards
    const now = () => Number(process.hrtime.bigint() / 1000000n);

    let held = null; //  Buffer: a tail that could start a reply
    let heldSink = null;
    let timer = null;
    let nulUntil = 0; //  a NUL starting the next chunk belongs to a reply
    let disposed = false;

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
                //  nobody to report to; a timer must never throw
            }
        }
    }

    function dispose() {
        disposed = true;
        cancelTimer();
        held = null;
        heldSink = null;
        nulUntil = 0;
    }

    function scan(data, sink) {
        //  after the session is over: no state, no timers
        if (disposed) {
            return sink.bytes(data);
        }

        cancelTimer();

        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        let buf = chunk;
        let changed = false;

        if (held) {
            buf = Buffer.concat([held, chunk]);
            held = null;
            heldSink = null;
            changed = true;
        }

        if (nulUntil) {
            if (buf.length > 0 && 0x00 === buf[0] && now() <= nulUntil) {
                buf = buf.subarray(1);
                changed = true;
            }
            nulUntil = 0;
        }

        //  [ 'bytes', Buffer ] | [ 'reply', string ], in stream order
        const parts = [];
        let start = 0;
        let searchFrom = 0;
        for (;;) {
            const at = buf.indexOf(PREFIX, searchFrom);
            if (at < 0) {
                break;
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
                if (at > start) {
                    parts.push(['bytes', buf.subarray(start, at)]);
                }
                let end = at + REPLY_LENGTH;
                parts.push(['reply', buf.toString('latin1', at, end)]);
                if (end < buf.length) {
                    if (0x00 === buf[end]) {
                        ++end;
                    }
                } else {
                    nulUntil = now() + nulWindowMs;
                }
                start = searchFrom = end;
                continue;
            }

            if (at + PREFIX.length + digits >= buf.length) {
                break; //  runs off the end: maybe a split reply, see below
            }

            //  RIPSCRIP followed by something else: ordinary input
            searchFrom = at + 1;
        }

        const holdAt = heldTailStart(buf, start);

        if (0 === parts.length && -1 === holdAt && !changed) {
            return sink.bytes(data);
        }

        const tailEnd = -1 === holdAt ? buf.length : holdAt;
        if (tailEnd > start) {
            parts.push(['bytes', buf.subarray(start, tailEnd)]);
        }

        if (-1 !== holdAt) {
            held = Buffer.from(buf.subarray(holdAt));
            heldSink = sink;
            timer = setTimeout(flushHeld, holdMs);
            timer.unref();
        }

        for (const [kind, value] of parts) {
            if ('reply' === kind) {
                sink.reply(value);
            } else {
                sink.bytes(value);
            }
        }
    }

    return { scan, dispose };
}

module.exports = {
    createRipReplyScanner,
    DEFAULT_HOLD_MS,
    DEFAULT_NUL_WINDOW_MS,
};
