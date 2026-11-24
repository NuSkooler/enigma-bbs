/* jslint node: true */
'use strict';

//
//  The ANSI emulation's connect-time probes: what connectEntry() has always
//  sent an ANSI terminal before the first menu, in the same order. Each probe
//  is { name, run(client, cb) }; a probe never fails the connection, it only
//  leaves a capability undiscovered.
//
//  ENiGMA½
const ansi = require('../../ansi_term.js');
const Config = require('../../config.js').get;
const { Errors } = require('../../enig_error.js');
const Rip = require('../rip');

//
//  Clients whose DA reply already tells us they are CTerm-shaped: they answer
//  CTerm's CSI < c (CTDA) and CSI = Ps n queries, and implement its SyncTERM
//  font selection (CSI Ps1;Ps2 SP D). Only these are sent the CTerm queries;
//  an unknown terminal could show them as text.
//
const CtermCompatibleClients = new Set(['cterm', 'enig_term']);

const isCtermCompatible = client => CtermCompatibleClients.has(client.term.termClient);

//
//  Clients sent the CTerm capability queries without being CTerm-shaped: IcyTerm
//  answers CSI < c (CTDA), and drops CSI = 6 n without a reply. It is not
//  SyncTERM-font-by-name (it keeps the CPR font probe when CTDA is unanswered).
//
const CtermQueryClients = new Set([...CtermCompatibleClients, 'icy_term']);

const wantsCtermQueries = client => CtermQueryClients.has(client.term.termClient);

//  true once the terminal has answered CSI < c
const ctdaAnswered = client => Array.isArray(client.term.termCapabilities.ctda);

//
//  Telling replies to the CPR probes apart
//  ---------------------------------------
//  Every reply to a cursor position query (CSI 6 n, and the ANSI-BBS screen
//  size query CSI 255 n) is a CPR, CSI row ; col R, and nothing in it says
//  which query it answers. Terminals do answer in order, so a probe that
//  takes exactly the replies to its own queries leaves the next probe its
//  own. Two things broke that:
//
//  * A probe that gave up after its 2s left its reply on the way; when it
//    came, the next probe took it as its own answer. A late 1;1 taken by the
//    SyncTERM font probe (which decides on column 1) turns fonts on for a
//    terminal that prints the font sequence as text (Qmodem).
//  * A probe can get more replies than it asked for: the size query asks
//    two questions (CSI 255 n, CSI 6 n) and some terminals answer both
//    (SyncTERM), others one.
//
//  So:
//
//  * Once any CPR probe has gone unanswered, no later CPR probe is sent: on
//    a terminal that knows CPR every probe ends in a plain CSI 6 n, which it
//    answers at once, so a timeout means it does not answer CSI 6 n at all
//    (or not within 2s), and a later probe would only wait 2s more or take
//    the late reply for its own. This is what a terminal without CPR has
//    always got: the home position probe timed out and the remaining probes
//    were skipped. Now the size default (80x25) is still applied after it.
//  * A probe that can get a varying number of replies ends its queries with
//    a sentinel: a CSI 6 n at a position none of the other replies can have,
//    recognised by its column. Everything up to the sentinel is that
//    probe's (see ansiQueryTermSizeIfNeeded).
//
//  Replies are matched after core/client.js has applied a home position
//  offset (client.cprOffset), so all of this is in 1-based positions.
//
const cprUnanswered = new WeakSet(); //  clients with a CPR probe that timed out

const CPR_TIMEOUT_MS = 2000;

//
//  Wait for the replies to the cursor position queries that |sendQueries|
//  writes. |onReport(pos)| sees each one and returns true when it was the
//  last one wanted. |cb(err)|: err on a timeout, or when the probe is skipped
//  because an earlier one timed out (nothing is sent then).
//
const awaitCursorPositionReports = (client, onReport, failMessage, sendQueries, cb) => {
    if (cprUnanswered.has(client)) {
        return cb(
            Errors.General(`${failMessage}: skipped, an earlier CPR went unanswered`)
        );
    }

    let giveUpTimer;

    const done = function (err) {
        client.removeListener('cursor position report', cprListener);
        clearTimeout(giveUpTimer);
        return cb(err);
    };

    const cprListener = pos => {
        if (onReport(pos)) {
            return done(null);
        }
    };

    client.on('cursor position report', cprListener);

    giveUpTimer = setTimeout(() => {
        cprUnanswered.add(client);
        return done(Errors.General(failMessage));
    }, CPR_TIMEOUT_MS);

    sendQueries();
};

//  A probe asking for one CPR
const withCursorPositionReport = (client, cprHandler, failMessage, sendQuery, cb) => {
    return awaitCursorPositionReports(
        client,
        pos => {
            cprHandler(pos);
            return true;
        },
        failMessage,
        sendQuery,
        cb
    );
};

function ansiDiscoverHomePosition(client, cb) {
    //
    //  We want to find the home position. ANSI-BBS and most terminals
    //  utilize 1,1 as home. However, some terminals such as ConnectBot
    //  think of home as 0,0. If this is the case, we need to offset
    //  our positioning to accommodate for such.
    //
    if (!Config().term.checkAnsiHomePosition) {
        // Skip (and assume 1,1) if the home position check is disabled.
        return cb(null);
    }

    withCursorPositionReport(
        client,
        pos => {
            const [h, w] = pos;

            //
            //  We expect either 0,0, or 1,1. Anything else will be filed as bad data
            //
            if (h > 1 || w > 1) {
                return client.log.warn(
                    { height: h, width: w },
                    'Ignoring ANSI home position CPR due to unexpected values'
                );
            }

            if ((0 === h) & (0 === w)) {
                //
                //  Store a CPR offset in the client. All CPR's from this point on will offset by this amount
                //
                client.log.info('Setting CPR offset to 1');
                client.cprOffset = 1;
            }
        },
        'ANSI query home position timed out',
        () => client.term.write(`${ansi.goHome()}${ansi.queryPos()}`), //  go home, query pos
        cb
    );
}

function ansiAttemptDetectUTF8(client, cb) {
    //
    //  Trick to attempt and detect UTF-8. While there is a lot more than
    //  just UTF-8 and CP437, many those are the main concerns, when it comes
    //  terminals that for example tell us they are "xterm" but still want CP437.
    //
    //  Try to detect UTF-8 by discovering the cursor position, writing some
    //  multi-byte UTF-8, and checking the position again. If the term is really
    //  UTF-8, we should get a proper position, otherwise we'll be further out.
    //
    //  We currently only do this if the term hasn't already been ID'd as a
    //  "*nix" terminal -- that is, xterm, etc.
    //  Also skip this check if checkUtf8Encoding is disabled in the config

    if (!client.term.isNixTerm() || !Config().term.checkUtf8Encoding) {
        return cb(null);
    }

    let initialPosition;
    const ASCIIPortion = ' Character encoding detection ';

    withCursorPositionReport(
        client,
        pos => {
            initialPosition = pos;

            withCursorPositionReport(
                client,
                pos => {
                    const [, w] = pos;
                    const len = w - initialPosition[1];
                    if (!isNaN(len) && len >= ASCIIPortion.length + 6) {
                        //  CP437 displays 3 chars each U+9760 (CJK wide character)
                        client.log.info(
                            'Terminal identified as UTF-8 but does not appear to be. Overriding to "ansi".'
                        );
                        client.setTermType('ansi');
                    }
                },
                'Detect UTF-8 stage 2 timed out',
                () => {
                    client.term.rawWrite(`\u9760${ASCIIPortion}\u9760`); //  U+9760 (CJK 靠, a wide character) on each side
                    client.term.rawWrite(ansi.queryPos());
                },
                cb
            );
        },
        'Detect UTF-8 stage 1 timed out',
        () => client.term.rawWrite(`${ansi.goHome()}${ansi.queryPos()}`),
        err => {
            if (err) {
                //  bailing early
                return cb(err);
            }
        }
    );
}

function ansiProbeUTF8Upward(client, cb) {
    //
    //  Opt-in upward UTF-8 probe for terminals that self-identify as CP437
    //  (e.g. ansi, syncterm) but may actually support UTF-8 output.
    //
    //  Uses the same CPR technique as ansiAttemptDetectUTF8 but in the
    //  opposite direction: if the cursor advance matches the expected UTF-8
    //  display width we upgrade outputEncoding to utf8.
    //
    //  Gated by term.probeUtf8Encoding (default: false) to keep the default
    //  connect experience stable.  forceOutputEncoding takes priority.
    //
    if (
        !Config().term.probeUtf8Encoding ||
        client.term.isNixTerm() ||
        Config().term.forceOutputEncoding
    ) {
        return cb(null);
    }

    let initialPosition;
    const ASCIIPortion = ' Character encoding detection ';

    withCursorPositionReport(
        client,
        pos => {
            initialPosition = pos;

            withCursorPositionReport(
                client,
                pos => {
                    const [, w] = pos;
                    const len = w - initialPosition[1];
                    //
                    //  UTF-8: each U+9760 character occupies 1 or 2 display columns
                    //  (narrow or wide), giving len < ASCIIPortion.length + 6.
                    //  CP437: each is 3 separate bytes = 3 columns each,
                    //  giving len >= ASCIIPortion.length + 6 (mirrors the
                    //  downgrade check in ansiAttemptDetectUTF8).
                    //
                    if (!isNaN(len) && len > 0 && len < ASCIIPortion.length + 6) {
                        client.log.info(
                            { len },
                            'CP437-identified terminal passed UTF-8 probe; upgrading output encoding to utf8'
                        );
                        client.term.outputEncoding = 'utf8';
                    }
                },
                'UTF-8 upward probe stage 2 timed out',
                () => {
                    client.term.rawWrite(`\u9760${ASCIIPortion}\u9760`);
                    client.term.rawWrite(ansi.queryPos());
                },
                cb
            );
        },
        'UTF-8 upward probe stage 1 timed out',
        () => client.term.rawWrite(`${ansi.goHome()}${ansi.queryPos()}`),
        err => {
            if (err) {
                return cb(err);
            }
        }
    );
}

function ansiQuerySyncTermFontSupport(client, cb) {
    //  A CTDA reply says whether font selection is there right now, e.g.
    //  SyncTERM leaves it out in its curses output mode: that decides it
    if (ctdaAnswered(client)) {
        const fontSelect = true === client.term.termCapabilities.fontSelect;
        client.log.info(
            { termClient: client.term.termClient, fontSelect },
            `SyncTERM font support ${
                fontSelect ? 'enabled' : 'disabled'
            } on node ${client.node} (CTDA)`
        );
        client.term.syncTermFontsEnabled = fontSelect;
        return cb(null);
    }

    //  If DA told us it's SyncTERM (or another CTerm-shaped client) that did
    //  not answer CTDA, we're good to go without the CPR probe
    if (isCtermCompatible(client)) {
        client.log.info(
            { termClient: client.term.termClient },
            `SyncTERM font support enabled on node ${client.node} (known client)`
        );
        client.term.syncTermFontsEnabled = true;
        return cb(null);
    }

    //  Some terminals do not properly ignore an unknown ESC sequence for
    //  setting SyncTERM style fonts. Some draw only a 'D' while others
    //  show more of the sequence
    //
    //  If the cursor remains at 1,1, they are at least ignoring it, if not
    //  supporting it.
    //
    //  We also need CPR support. Since all known terminals that support
    //  SyncTERM fonts also support CPR, this works out.
    //
    withCursorPositionReport(
        client,
        pos => {
            const [, w] = pos;
            if (w === 1) {
                // cursor didn't move
                client.log.info(`SyncTERM font support enabled on node ${client.node}`);
                client.term.syncTermFontsEnabled = true;
            }
        },
        'SyncTERM font detection timed out',
        () =>
            client.term.rawWrite(
                `${ansi.goto(1, 1)}${ansi.setSyncTermFont('cp437')}${ansi.queryPos()}`
            ),
        cb
    );
}

const CTERM_CAP_OSC8 = 6; //  CSI = 6 n: OSC 8 hyperlink support

//
//  Ask a CTerm-shaped client what it can do, in one round trip:
//
//  * CSI < c (CTDA): its feature list, which the client parser stores in
//    termCapabilities (ctda, fontSelect, ...)
//  * CSI = 6 n: OSC 8 hyperlinks, enabled only on a yes, never on the name
//  * CSI 6 n (CPR): a sentinel. Terminals answer in order, so once the
//    cursor position comes back, any answer to the two queries before it
//    has too; a terminal that knows neither (SyncTERM before 1.1 has no
//    CTDA, before 1.8 no CSI = 6 n) costs that round trip, not a timeout.
//
//  Gives up after the usual 2s if even the CPR never comes.
//
function ansiQueryCtermCapabilities(client, cb) {
    if (!wantsCtermQueries(client)) {
        return cb(null);
    }

    const capListener = ({ id, value }) => {
        if (id === CTERM_CAP_OSC8 && value === 1) {
            client.log.info(
                `CTerm OSC 8 hyperlink support enabled on node ${client.node}`
            );
            client.term.termCapabilities.osc8 = true;
        }
    };

    client.on('cterm capability response', capListener);

    withCursorPositionReport(
        client,
        () => {},
        'CTerm capability query timed out',
        () => {
            client.log.debug(
                { termClient: client.term.termClient },
                'Querying CTerm capabilities (CSI < c, CSI = 6 n)'
            );
            client.term.rawWrite(`\x1b[<c\x1b[=${CTERM_CAP_OSC8}n${ansi.queryPos()}`);
        },
        err => {
            client.removeListener('cterm capability response', capListener);
            client.log.info(
                {
                    termClient: client.term.termClient,
                    termCapabilities: client.term.termCapabilities,
                    timedOut: !!err,
                },
                ctdaAnswered(client)
                    ? 'CTerm capabilities (CTDA answered)'
                    : 'CTerm capabilities (no CTDA answer)'
            );
            return cb(null);
        }
    );
}

//
//  The size query ends with a sentinel CPR at row 1 of this column. No other
//  reply in the size step can be in it: a size is only taken from a reply of
//  10 columns or more, and the junk answers seen (a home position reply
//  arriving late, 1;1 from terminals that ignore the 999;999 move or answer
//  every query with it) are in column 1. The sentinel is never in column 1,
//  which a terminal that cannot move the cursor at all would report.
//
const SIZE_SENTINEL_COL = 5;
//  CSI 255 n, CSI 6 n, the sentinel: a terminal answers each once at most
const SIZE_QUERY_COUNT = 3;

const isKnownDimension = value => value > 0;

//
//  Values that are obviously no screen size. NetRunner, Qmodem and others
//  answer 1;1 here; 999 is the 999;999 we moved to, from a terminal that
//  does not clamp.
//
const isSaneSizeReply = ([h, w]) => !(h < 10 || h === 999 || w < 10 || w === 999);

function ansiQueryTermSizeIfNeeded(client, cb) {
    const term = client.term;

    //  only when NAWS/ENV did not already give both dimensions
    if (isKnownDimension(term.termHeight) && isKnownDimension(term.termWidth)) {
        return cb(null);
    }

    //
    //  The query:
    //  1 - Go to 999,999 -- a very much "bottom right" (generally 80x25 for
    //      example is the real size)
    //  2 - CSI 255 n, the bansi.txt style screen size query, answered with
    //      the screen size by terminals that know it
    //  3 - CSI 6 n, an ordinary cursor position query: since we moved to the
    //      bottom right, its answer is the screen size too, from terminals
    //      that ignore CSI 255 n (modern VT terminals, Procomm Plus, Telix)
    //  4 - The sentinel: go to 1,SIZE_SENTINEL_COL and CSI 6 n again
    //
    //  A terminal may answer both 2 and 3 (SyncTERM does), either, or neither.
    //  Answers come in order, so every reply up to the sentinel's is ours,
    //  and none is left over for the next probe to take as its own (the CTerm
    //  capability query uses a CPR to know it has everything). Nor can three
    //  replies be followed by another, which also ends the wait for a
    //  terminal that answers the sentinel in some other column.
    //
    //  The first sane reply is the size. A terminal that reports every row
    //  one too high (Telix, whose home position is 2;1) reports the sentinel
    //  in row 2: the size is corrected by the same amount.
    //
    const replies = [];
    let sentinel;

    awaitCursorPositionReports(
        client,
        pos => {
            if (SIZE_SENTINEL_COL === pos[1]) {
                sentinel = pos;
                return true;
            }
            replies.push(pos);
            return replies.length >= SIZE_QUERY_COUNT;
        },
        'No term size established by CPR within timeout',
        () =>
            term.rawWrite(
                `${ansi.goto(999, 999)}${ansi.queryScreenSize()}${ansi.queryPos()}` +
                    `${ansi.goto(1, SIZE_SENTINEL_COL)}${ansi.queryPos()}`
            ),
        err => {
            const rowShift = sentinel && sentinel[0] > 1 ? sentinel[0] - 1 : 0;

            let size;
            replies.forEach(([h, w]) => {
                const reply = [h - rowShift, w];
                if (size) {
                    return;
                }
                if (!isSaneSizeReply(reply)) {
                    return client.log.warn(
                        { height: reply[0], width: reply[1] },
                        'Ignoring ANSI CPR screen size query response due to non-sane values'
                    );
                }
                size = reply;
            });

            //  fill in only what NAWS/ENV (even while we waited) did not give
            const fillHeight = size && !isKnownDimension(term.termHeight);
            const fillWidth = size && !isKnownDimension(term.termWidth);
            if (fillHeight) {
                term.termHeight = size[0];
            }
            if (fillWidth) {
                term.termWidth = size[1];
            }
            if (fillHeight || fillWidth) {
                client.log.debug(
                    {
                        termWidth: term.termWidth,
                        termHeight: term.termHeight,
                        rowShift,
                        source: 'ANSI CPR',
                    },
                    'Window size updated'
                );
            }

            return cb(err);
        }
    );
}

//  The size assumed when neither NAWS/ENV nor CPR produced one
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 25;

//
//  Whatever happened in the size step (a reply that was no size, a timeout, a
//  skipped probe, a NAWS of 80x0), each dimension still unknown gets the DOS
//  default on its own: a size of 0 puts every view at row 0 / column 0.
//
function defaultUnknownTermSize(client, reason) {
    const term = client.term;
    const noHeight = !isKnownDimension(term.termHeight);
    const noWidth = !isKnownDimension(term.termWidth);

    if (noHeight && noWidth) {
        client.log.warn(
            { reason },
            'Failed to negotiate term size; Defaulting to 80x25!'
        );
    } else if (noHeight) {
        client.log.warn(
            { reason, termWidth: term.termWidth },
            `Failed to negotiate term height; Defaulting to ${DEFAULT_ROWS} rows`
        );
    } else if (noWidth) {
        client.log.warn(
            { reason, termHeight: term.termHeight },
            `Failed to negotiate term width; Defaulting to ${DEFAULT_COLS} columns`
        );
    }

    if (noHeight) {
        term.termHeight = DEFAULT_ROWS;
    }
    if (noWidth) {
        term.termWidth = DEFAULT_COLS;
    }

    client.log.debug(
        { termWidth: term.termWidth, termHeight: term.termHeight },
        'Terminal size settled'
    );
}

const probes = [
    {
        name: 'basicPrepWork',
        run(client, callback) {
            const term = client.term;
            term.rawWrite(ansi.queryDeviceAttributes(0));

            //
            //  The RIPscrip version query (#989), see core/term/rip. It waits
            //  for nothing: a RIP terminal answers while the probes below
            //  wait on their own replies. The input decoder is told to look
            //  for the answer from now, for a limited time (core/client.js
            //  attaches the layer). Other terminals do not answer.
            //
            //  A terminal that announced itself as RIP (IcyTerm) already has
            //  the layer, and with it the RIP output filter, which would
            //  take the query apart: it goes around the filter. For any
            //  other session writeUnfilteredRip() is rawWrite().
            //
            const decoder = term.emulation && term.emulation.inputDecoder;
            if (decoder && 'function' === typeof decoder.expectRipReply) {
                decoder.expectRipReply();
            }
            term.writeUnfilteredRip(Rip.VERSION_PROBE);

            term.write('\nDetecting client features...');
            return callback(null);
        },
    },
    {
        name: 'discoverHomePosition',
        run(client, callback) {
            return ansiDiscoverHomePosition(client, () => callback(null));
        },
    },
    {
        name: 'queryTermSizeByNonStandardAnsi',
        run(client, callback) {
            ansiQueryTermSizeIfNeeded(client, err => {
                defaultUnknownTermSize(
                    client,
                    err ? err.message : 'no sane size in the CPR replies'
                );
                return callback(null);
            });
        },
    },
    {
        name: 'checkUtf8IfNeeded',
        run(client, callback) {
            return ansiAttemptDetectUTF8(client, () => callback(null));
        },
    },
    {
        name: 'probeUtf8IfOptedIn',
        run(client, callback) {
            return ansiProbeUTF8Upward(client, () => callback(null));
        },
    },
    {
        name: 'queryCtermCapabilities',
        run(client, callback) {
            return ansiQueryCtermCapabilities(client, callback);
        },
    },
    {
        name: 'querySyncTERMFontSupport',
        run(client, callback) {
            return ansiQuerySyncTermFontSupport(client, () => callback(null));
        },
    },
];

module.exports = {
    probes,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    ansiQuerySyncTermFontSupport,
    ansiQueryCtermCapabilities,
};
