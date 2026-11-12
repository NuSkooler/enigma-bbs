/* jslint node: true */
'use strict';

//
//  The RIPscrip output filter (#989): keeps RIP commands out of what ENiGMA
//  sends a RIP terminal, unless ENiGMA means to send them.
//
//  A RIP terminal runs commands it finds anywhere in the byte stream. Text
//  other people wrote (messages, user names, file descriptions, chat,
//  oneliners) could otherwise draw over the screen, define invisible click
//  regions, rebind keys, or make the terminal type text back to the board as
//  if the caller had (RIP_QUERY). Seen on real terminals (2026-11-12, SyncTERM
//  1.8rc2 and 1.10b, IcyTerm; SyncTERM's rules read in ripper.c,
//  cb_accept_introducer and cb_esc_feed):
//
//  * '!' '|' starts a command after a line break on all three; on SyncTERM
//    1.10b also mid-line, at the left margin, after an SGR sequence.
//  * 0x01 or 0x02 followed by '|' starts one anywhere in a line (SyncTERM).
//  * ESC [ <params> ! is a RIP control sequence: ESC[! and ESC[0! make the
//    terminal send its version as input, ESC[1! turns RIP off for good
//    (SyncTERM), ESC[2! on; SyncTERM also takes ESC [ <digits and ;> ! as
//    SkyPix commands (ESC[16! swallows text up to the next '!').
//
//  The filter works on the final outbound stream, after the codec, so a
//  character that encodes to 0x01 (CP437 maps U+263A there) is caught too.
//  It keeps its state across writes, so nothing slips through by being split
//  between two of them. It makes exactly these changes, and no others:
//
//  1. A '|' straight after '!', 0x01 or 0x02 on the wire gets INTRODUCER_BREAK
//     (NUL) in front of it. Captured as invisible, and as stopping the
//     command, on all three terminals. A NUL changes no terminal state (the
//     other candidates, ESC[s ESC[u and ESC[0m, overwrite a saved cursor
//     position or the colours). SyncTERM treats a '!' after a NUL as being at
//     the start of a line, but the inserted NUL is always followed by '|',
//     never by '!', so it cannot start a command itself.
//  2. 0x01 and 0x02 become INTRODUCER_REPLACEMENT ('*'): one byte for one,
//     so the line keeps its length.
//  3. ESC [ <digits and ;> ! is removed whole. A RIP terminal shows nothing
//     for it either, so the text around it looks the same, cell for cell.
//     To do that across writes, bytes that start such a sequence (ESC) or
//     carry on one the wire has open ('[', digits, ';') are held back until
//     a later byte shows what they are (a terminal waits for the rest of an
//     unfinished sequence too, so nothing looks different). If an
//     unfiltered write comes first, the held bytes are dropped, never sent:
//     unfiltered bytes (a door's '!|...') must not finish a sequence
//     ENiGMA's output began. When a '!' follows a sequence already on the
//     wire with nothing held (it came in an unfiltered write, or a control
//     byte came in between: terminals differ on whether C0 ends a sequence,
//     and the filter takes the stricter reading), only the '!' is removed.
//  4. After unfiltered output that leaves a RIP command open (a '|' after an
//     introducer, and no CR since that ends it), the next filtered output
//     starts with COMMAND_LINE_END, so the text that follows cannot be read
//     as the rest of that command. As SyncTERM reads it, a CR ends a command
//     unless an odd number of backslashes come before it (a continuation;
//     an LF in between is swallowed and does not count). When the open
//     command ends in such a backslash, an INTRODUCER_BREAK goes first so
//     that the CR ends it. Unfiltered '!|' is taken as opening a command
//     wherever it is, which is what SyncTERM 1.10b does.
//
//  5. When the filter sent a '!' last and an unfiltered write starts with
//     '|', an INTRODUCER_BREAK goes in front of that write.
//
//  The filter covers what ENiGMA itself sends. Output of doors and of
//  bridged systems (telnet bridge, BBSLink, DoorParty, Goldmine,
//  ArchaicNet), file transfers, and RIP the operator installed, go to the
//  caller as the door, remote system or file has them, unfiltered. The
//  filter is shown them (observe()) so that its state follows the wire,
//  and only ever adds the break in 5 in front of them.
//
//  Data is a Buffer, or a string for the few callers that still write one.
//  A string goes to the transport as a string, which turns it into bytes:
//  telnet (and WebSocket, which runs telnet) keeps the low byte of each
//  UTF-16 unit, SSH writes UTF-8. The filter therefore judges a string unit
//  by its low byte, which is exact for telnet and stricter than needed for
//  SSH, and gives back a string.
//
//  Node built-ins only; no ENiGMA imports.
//

const BANG = 0x21;
const PIPE = 0x7c;
const ESC = 0x1b;
const LEFT_BRACKET = 0x5b;
const SEMICOLON = 0x3b;
const BACKSLASH = 0x5c;
const CR = 0x0d;
const DEL = 0x7f;
const SOH = 0x01;
const STX = 0x02;

//  Put between an introducer and a '|' (change 1)
const INTRODUCER_BREAK = 0x00;

//  What 0x01 and 0x02 become (change 2): '*'
const INTRODUCER_REPLACEMENT = 0x2a;

//  Ends a RIP command left open by unfiltered output (change 4)
const COMMAND_LINE_END = Object.freeze([0x0d, 0x0a]); //  CR LF
const LF = 0x0a;

//  Nothing is known about what went before: a '|' as the first filtered byte
//  gets a break, in case the byte before it on the wire was an introducer
const UNKNOWN = -1;

//  Where the wire is in a possible ESC [ <params> ! sequence
const CSI_NONE = 0;
const CSI_ESC = 1; //  just after ESC
const CSI_PARAMS = 2; //  after ESC [ and any digits and semicolons

const isIntroducer = v => BANG === v || SOH === v || STX === v;

//  does a '|' after |prev| need a break?
const needsBreak = prev => UNKNOWN === prev || isIntroducer(prev);

const isParamByte = v => (v >= 0x30 && v <= 0x39) || SEMICOLON === v;

//  C0 controls other than ESC, and DEL
const isControl = v => (v < 0x20 && ESC !== v) || DEL === v;

function nextCsiState(csi, v) {
    if (ESC === v) {
        return CSI_ESC;
    }
    if (isControl(v)) {
        return csi;
    }
    if (CSI_ESC === csi) {
        return LEFT_BRACKET === v ? CSI_PARAMS : CSI_NONE;
    }
    if (CSI_PARAMS === csi) {
        return isParamByte(v) ? CSI_PARAMS : CSI_NONE;
    }
    return CSI_NONE;
}

//  The unit at |i|: the byte, or a string unit's low byte (see above)
const unitAt = (data, i) =>
    'string' === typeof data ? data.charCodeAt(i) & 0xff : data[i];

//
//  A filter for one session. Its state is what went to the wire last:
//
//      filter(data)    |data| as it may go to the wire; the same object when
//                      nothing had to change
//      observe(data)   |data| went to the wire as it is (pass-through, or RIP
//                      the operator installed)
//
function createRipOutputFilter() {
    let prev = UNKNOWN; //  the last unit sent
    let csi = CSI_NONE; //  where the wire is, as sent
    let commandOpen = false; //  an unfiltered RIP command not yet ended
    let backslashes = 0; //  how many end the open command (LF aside)

    //  Units held back from the end of the last filtered write: a possible
    //  start of ESC [ <params> ! (ESC, ESC [, ESC [ params), not yet sent
    let carried = [];
    let carriedState = CSI_NONE; //  where |carried| would leave the wire

    //  the last unit sent came from filter() (not from an unfiltered write)
    let prevFromFilter = false;

    function step(v) {
        if (!commandOpen) {
            commandOpen = PIPE === v && isIntroducer(prev);
            backslashes = 0;
        } else if (BACKSLASH === v) {
            ++backslashes;
        } else if (CR === v) {
            if (backslashes & 1) {
                --backslashes; //  a continuation: the terminal drops one
            } else {
                commandOpen = false;
            }
        } else if (LF !== v) {
            backslashes = 0;
        }
        csi = nextCsiState(csi, v);
        prev = v;
        prevFromFilter = false;
    }

    //  |units| (numbers) as |data|'s type: code units, or bytes
    const asType = (units, isString) =>
        isString ? String.fromCharCode(...units) : Buffer.from(units.map(u => u & 0xff));

    //
    //  |data| goes to the wire as it is. Returns what to send:
    //
    //  * bytes held back from the last filtered write (a possible start of
    //    ESC [ <params> !) are dropped, never sent: unfiltered bytes must not
    //    finish a sequence ENiGMA's own output began. An unfinished sequence
    //    at such a boundary is broken output anyway.
    //  * when the filter sent the '!' just before, and |data| starts with
    //    '|', a NUL goes in front, so that the two do not meet on the wire.
    //    |data| itself is never changed.
    //
    function observe(data) {
        if (null === data || undefined === data) {
            return data;
        }
        carried = [];
        let out = data;
        if (
            prevFromFilter &&
            BANG === prev &&
            data.length > 0 &&
            PIPE === unitAt(data, 0)
        ) {
            out =
                'string' === typeof data
                    ? String.fromCharCode(INTRODUCER_BREAK) + data
                    : Buffer.concat([Buffer.from([INTRODUCER_BREAK]), data]);
        }
        for (let i = 0; i < out.length; ++i) {
            step(unitAt(out, i));
        }
        return out;
    }

    function filter(data) {
        if (!data || 0 === data.length) {
            return data;
        }

        const isString = 'string' === typeof data;
        const unitOf = i => (isString ? data.charCodeAt(i) : data[i]);

        //  The output, as pieces, built only once something has to change;
        //  |from| is where the next unchanged run of |data| starts
        let pieces = null;
        let from = 0;
        const insert = (at, units, skip) => {
            if (!pieces) {
                pieces = [];
            }
            if (at > from) {
                pieces.push(data.slice(from, at));
            }
            if (units.length > 0) {
                pieces.push(asType(units, isString));
            }
            from = at + skip;
        };
        const sent = v => {
            prev = v;
            csi = nextCsiState(csi, v);
            prevFromFilter = true;
        };

        //  A possible ESC [ <params> ! being held back: bytes that start one
        //  (ESC) or carry on one the wire has open. |heldFrom| is where they
        //  start in |data| (0 when they began in an earlier write, whose part
        //  is |carried|), or -1 when nothing is held
        let heldFrom = carried.length > 0 ? 0 : -1;
        let heldState = carriedState;

        //  What is held goes on as it is: sent, in place
        const release = at => {
            if (carried.length > 0) {
                insert(0, carried, 0); //  before data[0]
                carried.forEach(u => sent(u & 0xff));
                carried = [];
            }
            for (let k = heldFrom; k < at; ++k) {
                sent(unitAt(data, k));
            }
            heldFrom = -1;
        };

        if (commandOpen) {
            //  change 4 (nothing is held while a command is open)
            const end =
                backslashes & 1
                    ? [INTRODUCER_BREAK, ...COMMAND_LINE_END]
                    : COMMAND_LINE_END;
            commandOpen = false;
            backslashes = 0;
            insert(0, end, 0);
            end.forEach(sent);
        }

        for (let i = 0; i < data.length; ++i) {
            const v = unitAt(data, i);

            if (heldFrom >= 0) {
                if (CSI_ESC === heldState && LEFT_BRACKET === v) {
                    heldState = CSI_PARAMS;
                    continue;
                }
                if (CSI_PARAMS === heldState && isParamByte(v)) {
                    continue;
                }
                if (CSI_PARAMS === heldState && BANG === v) {
                    //  change 3: none of ESC [ <params> ! is sent
                    carried = [];
                    insert(heldFrom, [], i + 1 - heldFrom);
                    heldFrom = -1;
                    continue;
                }
                release(i);
            }

            if (
                ESC === v ||
                (CSI_ESC === csi && LEFT_BRACKET === v) ||
                (CSI_PARAMS === csi && isParamByte(v))
            ) {
                //  hold it: the next byte decides
                heldFrom = i;
                heldState = nextCsiState(csi, v);
            } else if (BANG === v && CSI_PARAMS === csi) {
                //  change 3, for a sequence already sent (unfiltered, or
                //  broken off by a control byte): only the '!' is removed
                insert(i, [], 1);
            } else if (SOH === v || STX === v) {
                //  change 2
                insert(i, [INTRODUCER_REPLACEMENT], 1);
                sent(INTRODUCER_REPLACEMENT);
            } else if (PIPE === v && needsBreak(prev)) {
                //  change 1
                insert(i, [INTRODUCER_BREAK, PIPE], 1);
                sent(INTRODUCER_BREAK);
                sent(PIPE);
            } else {
                sent(v);
            }
        }

        if (heldFrom >= 0) {
            //  still possibly ESC [ <params> !: hold it for the next write
            carriedState = heldState;
            carried = carried.concat(
                Array.from({ length: data.length - heldFrom }, (_, k) =>
                    unitOf(heldFrom + k)
                )
            );
            insert(heldFrom, [], data.length - heldFrom);
        }

        if (!pieces) {
            return data;
        }
        if (from < data.length) {
            pieces.push(data.slice(from));
        }
        if (0 === pieces.length) {
            return isString ? '' : Buffer.alloc(0);
        }
        return isString ? pieces.join('') : Buffer.concat(pieces);
    }

    return {
        filter,
        observe,
        //  for tests and logs
        get state() {
            return { prev, csi, commandOpen, backslashes, held: carried.length };
        },
    };
}

module.exports = {
    INTRODUCER_BREAK,
    INTRODUCER_REPLACEMENT,
    COMMAND_LINE_END,
    createRipOutputFilter,
};
