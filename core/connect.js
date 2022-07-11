/* jslint node: true */
'use strict';

//  ENiGMA½
const ansi = require('./ansi_term.js');
const Events = require('./events.js');
const Config = require('./config.js').get;
const { Errors } = require('./enig_error.js');

//  deps
const async = require('async');

exports.connectEntry = connectEntry;

const withCursorPositionReport = (client, cprHandler, failMessage, cb) => {
    let giveUpTimer;

    const done = function (err) {
        client.removeListener('cursor position report', cprListener);
        clearTimeout(giveUpTimer);
        return cb(err);
    };

    const cprListener = pos => {
        cprHandler(pos);
        return done(null);
    };

    client.once('cursor position report', cprListener);

    //  give up after 2s
    giveUpTimer = setTimeout(() => {
        return done(Errors.General(failMessage));
    }, 2000);
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
        cb
    );

    client.term.write(`${ansi.goHome()}${ansi.queryPos()}`); //  go home, query pos
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
                    const [_, w] = pos;
                    const len = w - initialPosition[1];
                    if (!isNaN(len) && len >= ASCIIPortion.length + 6) {
                        //  CP437 displays 3 chars each Unicode skull
                        client.log.info(
                            'Terminal identified as UTF-8 but does not appear to be. Overriding to "ansi".'
                        );
                        client.setTermType('ansi');
                    }
                },
                'Detect UTF-8 stage 2 timed out',
                cb
            );

            client.term.rawWrite(`\u9760${ASCIIPortion}\u9760`); //  Unicode skulls on each side
            client.term.rawWrite(ansi.queryPos());
        },
        'Detect UTF-8 stage 1 timed out',
        err => {
            if (err) {
                //  bailing early
                return cb(err);
            }
        }
    );

    client.term.rawWrite(`${ansi.goHome()}${ansi.queryPos()}`);
}

const ansiQuerySyncTermFontSupport = (client, cb) => {
    // If we know it's SyncTERM, then good to go
    if (client.term.termClient === 'cterm') {
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
            const [_, w] = pos;
            if (w === 1) {
                // cursor didn't move
                client.log.info(
                    'Client supports SyncTERM fonts or properly ignores unknown ESC sequence'
                );
                client.term.syncTermFontsEnabled = true;
            }
        },
        'SyncTERM font detection timed out',
        cb
    );

    client.term.rawWrite(
        `${ansi.goto(1, 1)}${ansi.setSyncTermFont('cp437')}${ansi.queryPos()}`
    );
};

function ansiQueryTermSizeIfNeeded(client, cb) {
    if (client.term.termHeight > 0 || client.term.termWidth > 0) {
        return cb(null);
    }

    withCursorPositionReport(
        client,
        pos => {
            //
            //  If we've already found out, disregard
            //
            if (client.term.termHeight > 0 || client.term.termWidth > 0) {
                return;
            }

            //
            //  NetRunner for example gives us 1x1 here. Not really useful. Ignore
            //  values that seem obviously bad. Included in the set is the explicit
            //  999x999 values we asked to move to.
            //
            const [h, w] = pos;
            if (h < 10 || h === 999 || w < 10 || w === 999) {
                return client.log.warn(
                    { height: h, width: w },
                    'Ignoring ANSI CPR screen size query response due to non-sane values'
                );
            }

            client.term.termHeight = h;
            client.term.termWidth = w;

            client.log.debug(
                {
                    termWidth: client.term.termWidth,
                    termHeight: client.term.termHeight,
                    source: 'ANSI CPR',
                },
                'Window size updated'
            );
        },
        'No term size established by CPR within timeout',
        cb
    );

    //  Start the process:
    //  1 - Ask to goto 999,999 -- a very much "bottom right" (generally 80x25 for example
    //      is the real size)
    //  2 - Query for screen size with bansi.txt style specialized Device Status Report (DSR)
    //      request. We expect a CPR of:
    //      a - Terms that support bansi.txt style: Screen size
    //      b - Terms that do not support bansi.txt style: Since we moved to the bottom right
    //          we should still be able to determine a screen size.
    //
    client.term.rawWrite(`${ansi.goto(999, 999)}${ansi.queryScreenSize()}`);
}

function prepareTerminal(term) {
    term.rawWrite(`${ansi.normal()}${ansi.clearScreen()}`);
}

function displayBanner(term) {
    //  note: intentional formatting:
    term.pipeWrite(`
|06Connected to |02EN|10i|02GMA|10½ |06BBS version |12|VN
|06Copyright (c) 2014-2022 Bryan Ashby |14- |12http://l33t.codes/
|06Updates & source |14- |12https://github.com/NuSkooler/enigma-bbs/
|00`);
}

function connectEntry(client, nextMenu) {
    const term = client.term;

    async.series(
        [
            function basicPrepWork(callback) {
                term.rawWrite(ansi.queryDeviceAttributes(0));
                term.write('\nDetecting client features...');
                return callback(null);
            },
            function discoverHomePosition(callback) {
                return ansiDiscoverHomePosition(client, callback);
            },
            function queryTermSizeByNonStandardAnsi(callback) {
                ansiQueryTermSizeIfNeeded(client, err => {
                    if (err) {
                        //
                        //  Check again; We may have got via NAWS/similar before CPR completed.
                        //
                        if (0 === term.termHeight || 0 === term.termWidth) {
                            //
                            //  We still don't have something good for term height/width.
                            //  Default to DOS size 80x25.
                            //
                            //  :TODO: Netrunner is currently hitting this and it feels wrong. Why is NAWS/ENV/CPR all failing???
                            client.log.warn(
                                { reason: err.message },
                                'Failed to negotiate term size; Defaulting to 80x25!'
                            );

                            term.termHeight = 25;
                            term.termWidth = 80;
                        }
                    }

                    return callback(null);
                });
            },
            function checkUtf8IfNeeded(callback) {
                return ansiAttemptDetectUTF8(client, callback);
            },
            function querySyncTERMFontSupport(callback) {
                return ansiQuerySyncTermFontSupport(client, callback);
            },
        ],
        () => {
            prepareTerminal(term);

            //
            //  Always show an ENiGMA½ banner
            //
            displayBanner(term);

            // fire event
            Events.emit(Events.getSystemEvents().TermDetected, { client: client });

            setTimeout(() => {
                return client.menuStack.goto(nextMenu);
            }, 500);
        }
    );
}
