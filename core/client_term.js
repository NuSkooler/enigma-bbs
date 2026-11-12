/* jslint node: true */
'use strict';

//  ENiGMA½
const Log = require('./logger.js').log;
const renegadeToAnsi = require('./color_codes.js').renegadeToAnsi;
const Config = require('./config.js').get;
const { createEmulation } = require('./term');
const assert = require('assert');
const _ = require('lodash');

exports.ClientTerminal = ClientTerminal;

function ClientTerminal(output) {
    this.output = output;

    //
    //  The terminal emulation: how this terminal is probed, what its input
    //  means, which codec encodes text for it and what (if anything) has to
    //  happen to the outbound stream. Every terminal is ANSI unless something
    //  selects otherwise before the session starts. See core/term/.
    //
    this.emulation = createEmulation();

    let outputEncoding = 'cp437';
    assert(this.emulation.codec.encodingExists(outputEncoding));

    //  convert line feeds such as \n -> \r\n
    this.convertLF = true;

    this.syncTermFontsEnabled = false;

    //  What the terminal reported it can do, by query rather than by name:
    //  * osc8: true once CSI = 6 n is answered yes
    //  * ctda: the CTerm Device Attributes (CSI < c) feature numbers, plus a
    //    boolean per known feature (loadableFonts, brightBackground,
    //    paletteOsc, pixelOps, fontSelect, extendedPalette, mouse,
    //    keyEvents); absent until a CTDA reply arrives
    //  They are held by the emulation; this is the same object.
    Object.defineProperty(this, 'termCapabilities', {
        enumerable: true,
        get: function () {
            return this.emulation.capabilities;
        },
        set: function (capabilities) {
            this.emulation.capabilities = capabilities;
        },
    });

    //
    //  Some terminal we handle specially
    //  They can also be found in this.env{}
    //
    let termType = 'unknown';
    let termHeight = 0;
    let termWidth = 0;
    let termClient = 'unknown';

    this.currentSyncFont = 'not_set';

    //  CTerm revision, e.g. '1.332', set from the DA response; null until a
    //  terminal identifies itself as CTerm
    this.ctermVersion = null;

    //  Version of whichever client the DA response identified, e.g. '1.332'
    //  for CTerm or '0.1.0' for enig-term; null when the reply carries none
    this.termClientVersion = null;

    //  Raw values set by e.g. telnet NAWS, ENVIRONMENT, etc.
    this.env = {};

    Object.defineProperty(this, 'outputEncoding', {
        get: function () {
            return outputEncoding;
        },
        set: function (enc) {
            //  Store one canonical name: 'utf-8', 'UTF8' etc. all become 'utf8',
            //  which is what ACS "EC1" and art selection compare against.
            if (_.isString(enc) && /^utf-?8$/i.test(enc.trim())) {
                enc = 'utf8';
            }
            if (this.emulation.codec.encodingExists(enc)) {
                Log.info(
                    { encoding: enc, currentEncoding: outputEncoding },
                    `Output encoding changed to ${enc}`
                );
                outputEncoding = enc;
            } else {
                Log.warn({ encoding: enc }, 'Unknown encoding');
            }
        },
    });

    Object.defineProperty(this, 'termType', {
        get: function () {
            return termType;
        },
        set: function (ttype) {
            termType = ttype.toLowerCase();

            Log.debug(
                { encoding: this.outputEncoding },
                `Terminal type changed to ${termType}; Adjusting output encoding`
            );

            if (this.isNixTerm()) {
                this.outputEncoding = 'utf8';
            } else {
                this.outputEncoding = 'cp437';
            }

            //  Allow sysop to override auto-detection with a forced encoding for all
            //  connections (e.g. forceOutputEncoding: utf8 in system config for a
            //  UTF-8-only BBS environment).
            const forced = Config().term.forceOutputEncoding;
            if (forced) {
                this.outputEncoding = forced;
            }

            //  :TODO: according to this: http://mud-dev.wikidot.com/article:telnet-client-identification
            //  Windows telnet will send "VTNT". If so, set termClient='windows'
            //  there are some others on the page as well
        },
    });

    Object.defineProperty(this, 'termWidth', {
        get: function () {
            return termWidth;
        },
        set: function (width) {
            if (width > 0) {
                termWidth = width;
            }
        },
    });

    Object.defineProperty(this, 'termHeight', {
        get: function () {
            return termHeight;
        },
        set: function (height) {
            if (height > 0) {
                termHeight = height;
            }
        },
    });

    Object.defineProperty(this, 'termClient', {
        get: function () {
            return termClient;
        },
        set: function (tc) {
            termClient = tc;

            Log.debug(
                { termClient: this.termClient, version: this.termClientVersion },
                'Set known terminal client'
            );
        },
    });
}

ClientTerminal.prototype.disconnect = function () {
    this.output = null;

    //
    //  An input decoder that holds a pending decision on a timer (ATASCII's
    //  Escape, ANSI's possible start of a RIPscrip reply) is told the session
    //  is over, so nothing is reported after it. The PETSCII decoder holds
    //  nothing and has no dispose().
    //
    const decoder = this.emulation && this.emulation.inputDecoder;
    if (decoder && 'function' === typeof decoder.dispose) {
        decoder.dispose();
    }
};

ClientTerminal.prototype.isNixTerm = function () {
    //
    //  Standard *nix type terminals
    //
    if (this.termType.startsWith('xterm')) {
        return true;
    }

    const utf8TermList = Config().term.utf8TermList;
    return utf8TermList.includes(this.termType);
};

ClientTerminal.prototype.isANSI = function () {
    //
    //  ANSI terminals should be encoded to CP437
    //
    //  Some terminal types provided by Mercyful Fate / Enthral:
    //      ANSI-BBS
    //      PC-ANSI
    //      QANSI
    //      SCOANSI
    //      VT100
    //      QNX
    //
    //  Reports from various terminals
    //
    //  NetRunner v2.00beta 20
    //      * This version adds 256 colors and reports as "ansi-256color"
    //
    //  syncterm:
    //      * SyncTERM
    //
    //  xterm:
    //      * PuTTY
    //
    //  ansi-bbs:
    //      * fTelnet
    //
    //  pcansi:
    //      * ZOC
    //
    //  screen:
    //      * ConnectBot (Android)
    //
    //  linux:
    //      * JuiceSSH (note: TERM=linux also)
    //
    const cp437TermList = Config().term.cp437TermList;
    return cp437TermList.includes(this.termType);
};

//  :TODO: probably need to update these to convert IAC (0xff) -> IACIAC (escape it)

ClientTerminal.prototype.write = function (s, convertLineFeeds, cb) {
    this.rawWrite(this.encode(s, convertLineFeeds), cb);
};

ClientTerminal.prototype.rawWrite = function (s, cb) {
    return this._write(s, false, cb);
};

//
//  passThroughWrite() -- bytes that are not ENiGMA's own output and must reach
//  the terminal exactly as given: file transfer protocol data, the far end of
//  a telnet or rlogin bridge, a raw door's output. They go around the
//  emulation's output translator (which is told, so that one keeping cursor
//  state knows it has gone stale).
//
//  Everything else, rawWrite() included, is ENiGMA speaking ANSI and goes
//  through the translator. For an ANSI terminal the two are the same thing.
//
ClientTerminal.prototype.passThroughWrite = function (data, cb) {
    return this._write(data, true, cb);
};

//
//  nativeWrite() -- bytes already in the terminal's own language, ENiGMA's
//  output all the same: native art (a PETSCII .seq or ATASCII .ata file) for
//  a terminal of that emulation. They go to the wire as they are, through the
//  output translator's writeNative(), which follows them so that the ANSI
//  written after (views at MCI positions) lands where it should. |options|
//  goes to writeNative() (PETSCII: { charset }; ATASCII: { anchor, startRow }).
//
//  Only an emulation whose translator has writeNative() takes native bytes;
//  anything else (ANSI) gets an error and nothing is written. art.js never
//  sends native art to such a session: it shows it as text instead.
//
ClientTerminal.prototype.canWriteNative = function () {
    const translator = this.emulation.outputTranslator;
    return Boolean(translator) && 'function' === typeof translator.writeNative;
};

ClientTerminal.prototype.nativeWrite = function (data, options, cb) {
    if (!cb && 'function' === typeof options) {
        cb = options;
        options = {};
    }
    if (!this.canWriteNative()) {
        const err = new Error(
            `The ${this.emulation.name} emulation does not take native output`
        );
        if (cb) {
            return cb(err);
        }
        throw err;
    }
    return this._write(data, { native: options || {} }, cb);
};

//
//  The one place outbound data meets the emulation's output translator, used
//  by every path that writes the socket: immediate writes, a committed batch
//  and dripWrite().
//
ClientTerminal.prototype.translateOutput = function (data) {
    return this.emulation.outputTranslator.translate(data);
};

//
//  |how| is false for ENiGMA's own (ANSI) output, true for pass-through, or
//  { native: options } for nativeWrite().
//
ClientTerminal.prototype._write = function (s, how, cb) {
    if (this._writeBuf) {
        //  Batch mode: accumulate instead of sending immediately.
        this._writeBuf.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
        if (how) {
            //  remembered by position in the batch
            if (!this._writeBufPassThrough) {
                this._writeBufPassThrough = new Map();
            }
            this._writeBufPassThrough.set(this._writeBuf.length - 1, how);
        }
        if (cb) {
            cb(null);
        }
        return;
    }
    if (this.output && this.output.writable) {
        if (true === how) {
            this.emulation.outputTranslator.passThrough(s);
        } else if (how) {
            s = this.emulation.outputTranslator.writeNative(s, how.native);
        } else {
            s = this.translateOutput(s);
        }
        this.output.write(s, err => {
            if (cb) {
                return cb(err);
            }

            if (err) {
                Log.warn({ error: err.message }, 'Failed writing to socket');
            }
        });
    }
};

//  beginWrite() / commitWrite() — batch all terminal output into a single socket
//  write so intermediate cursor positions are never rendered by the client.
//  Calls may be nested; only the outermost commitWrite() flushes.
ClientTerminal.prototype.beginWrite = function () {
    if (!this._writeBuf) {
        this._writeBuf = [];
        this._writeBufDepth = 0;
    }
    this._writeBufDepth += 1;
};

ClientTerminal.prototype.commitWrite = function (cb) {
    if (!this._writeBuf) {
        if (cb) {
            cb(null);
        }
        return;
    }
    this._writeBufDepth -= 1;
    if (this._writeBufDepth > 0) {
        //  Still inside an outer batch — wait for the outermost commitWrite.
        if (cb) {
            cb(null);
        }
        return;
    }
    const chunks = this._writeBuf;
    const passThroughChunks = this._writeBufPassThrough;
    this._writeBuf = null;
    this._writeBufPassThrough = null;
    this._writeBufDepth = 0;
    if (chunks.length === 0) {
        if (cb) {
            cb(null);
        }
        return;
    }
    if (!this.output || !this.output.writable) {
        return;
    }

    //
    //  The batch goes through the output translator as one piece, so a
    //  sequence split across writes is whole again by the time it is seen.
    //  Pass-through and native chunks in the batch keep their place but are
    //  not translated.
    //
    let combined;
    if (!passThroughChunks || 0 === passThroughChunks.size) {
        combined = this.translateOutput(Buffer.concat(chunks));
    } else {
        const out = [];
        let run = [];
        const flushRun = () => {
            if (run.length > 0) {
                out.push(this.translateOutput(Buffer.concat(run)));
                run = [];
            }
        };
        chunks.forEach((chunk, i) => {
            const how = passThroughChunks.get(i);
            if (true === how) {
                flushRun();
                this.emulation.outputTranslator.passThrough(chunk);
                out.push(chunk);
            } else if (how) {
                flushRun();
                out.push(this.emulation.outputTranslator.writeNative(chunk, how.native));
            } else {
                run.push(chunk);
            }
        });
        flushRun();
        combined = Buffer.concat(out);
    }

    this.output.write(combined, err => {
        if (cb) {
            return cb(err);
        }
        if (err) {
            Log.warn({ error: err.message }, 'Failed writing to socket');
        }
    });
};

ClientTerminal.prototype.pipeWrite = function (s, cb) {
    this.write(renegadeToAnsi(s, this), null, cb); //  null = use default for |convertLineFeeds|
};

//  dripWrite() — send |buf| to the socket at |bytesPerSec|, calling |cb| when done.
//  Goes directly to this.output, intentionally bypassing _writeBuf batching (the two
//  are mutually exclusive: batch = instant display; drip = throttled display).
//  |buf| is translated for the terminal's emulation up front, as a whole, so
//  what is dripped is what goes on the wire.
ClientTerminal.prototype.dripWrite = function (buf, bytesPerSec, cb) {
    if (!buf || buf.length === 0) {
        return cb(null);
    }

    return this._drip(this.translateOutput(buf), bytesPerSec, cb);
};

//  nativeDripWrite() -- dripWrite() for nativeWrite() bytes (see both)
ClientTerminal.prototype.nativeDripWrite = function (buf, options, bytesPerSec, cb) {
    if (!this.canWriteNative()) {
        return cb(
            new Error(`The ${this.emulation.name} emulation does not take native output`)
        );
    }
    if (!buf || buf.length === 0) {
        return cb(null);
    }

    return this._drip(
        this.emulation.outputTranslator.writeNative(buf, options),
        bytesPerSec,
        cb
    );
};

//  |buf| as it goes on the wire, at |bytesPerSec|
ClientTerminal.prototype._drip = function (buf, bytesPerSec, cb) {
    if (!buf || buf.length === 0) {
        return cb(null);
    }

    const INTERVAL_MS = 16; //  ~60fps
    const bytesPerInterval = Math.max(1, Math.round((bytesPerSec * INTERVAL_MS) / 1000));
    let offset = 0;

    const sendChunk = () => {
        if (!this.output || !this.output.writable) {
            return cb(new Error('Connection closed during baud emulation'));
        }
        const end = Math.min(offset + bytesPerInterval, buf.length);
        const chunk = buf.slice(offset, end);
        offset = end;
        this.output.write(chunk, err => {
            if (err) {
                return cb(err);
            }
            if (offset >= buf.length) {
                return cb(null);
            }
            setTimeout(sendChunk, INTERVAL_MS);
        });
    };

    sendChunk();
};

ClientTerminal.prototype.encode = function (s, convertLineFeeds) {
    convertLineFeeds = _.isBoolean(convertLineFeeds) ? convertLineFeeds : this.convertLF;

    if (convertLineFeeds && _.isString(s)) {
        s = s.replace(/\n/g, '\r\n');
    }
    return this.emulation.codec.encode(s, this.outputEncoding);
};
