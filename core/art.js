/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const miscUtil = require('./misc_util.js');
const ansi = require('./ansi_term.js');
const aep = require('./ansi_escape_parser.js');
const sauce = require('./sauce.js');
const { Errors } = require('./enig_error.js');
const { emulationOf } = require('./term');
const { PetsciiArtParser, petsciiArtToText } = require('./term/petscii/art_parser.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const iconv = require('iconv-lite');
const _ = require('lodash');

exports.getArt = getArt;
exports.getArtFromPath = getArtFromPath;
exports.getArtTypePolicy = getArtTypePolicy;
exports.display = display;
exports.paginate = paginate;
exports.defaultEncodingFromExtension = defaultEncodingFromExtension;

//  :TODO: Return MCI code information
//  :TODO: process SAUCE comments
//  :TODO: return font + font mapped information from SAUCE

const SUPPORTED_ART_TYPES = {
    //  :TODO: the defualt encoding are really useless if they are all the same ...
    //  perhaps .ansamiga and .ascamiga could be supported as well as overrides via conf
    '.ans': { name: 'ANSI', defaultEncoding: 'cp437', eof: 0x1a },
    '.utf8ans': { name: 'ANSI/UTF-8', defaultEncoding: 'utf8', eof: 0x1a }, //  UTF-8 variant; preferred over .ans for UTF-8 terminals
    '.asc': { name: 'ASCII', defaultEncoding: 'cp437', eof: 0x1a },
    '.pcb': { name: 'PCBoard', defaultEncoding: 'cp437', eof: 0x1a },
    '.bbs': { name: 'Wildcat', defaultEncoding: 'cp437', eof: 0x1a },

    '.amiga': { name: 'Amiga', defaultEncoding: 'latin1', eof: 0x1a }, //  Amiga text is ISO-8859-1
    '.txt': { name: 'Amiga Text', defaultEncoding: 'cp437', eof: 0x1a },
    //  :TODO: extentions for wwiv, renegade, celerity, syncronet, ...
    //  :TODO: extension for atari
    //  :TODO: extension for topaz ansi/ascii.

    //
    //  Native art: bytes in a base emulation's own language, shown as they are
    //  to a session of that emulation and never offered to any other (#593).
    //  See NATIVE_ART below.
    //
    '.seq': { name: 'PETSCII', native: 'petscii' },
};

//
//  Per emulation, what native art needs:
//
//      charsetFor(encodedAs)   the character set the art is drawn in, from the
//                              art's |encodedAs| option
//      createParser(options)   the parser art.display() drives in place of
//                              ANSIEscapeParser (same events)
//      toText(bytes, options)  the art as plain Unicode text, for anything that
//                              cannot show it natively
//
//  PETSCII (.seq): lower/upper unless |encodedAs| is 'petscii_upper'
//  (upper/graphics); 'petscii' and 'petscii_lower' name the default. Any
//  other encoding name means nothing for these bytes and is ignored.
//
const PETSCII_CHARSETS = {
    petscii: 'lower',
    petscii_lower: 'lower',
    petscii_upper: 'upper',
};

const NATIVE_ART = {
    petscii: {
        charsetFor: encodedAs =>
            PETSCII_CHARSETS[_.isString(encodedAs) ? encodedAs.toLowerCase() : ''] ||
            'lower',
        createParser: options => new PetsciiArtParser(options),
        toText: (bytes, options) => petsciiArtToText(bytes, options),
    },
};

function isNativeArtEncoding(encoding) {
    return _.isString(encoding) && _.has(PETSCII_CHARSETS, encoding.toLowerCase());
}

//  the emulation |ext|'s art is native to, or undefined for ANSI-side types
function nativeEmulationOfType(ext) {
    const artType = SUPPORTED_ART_TYPES[ext];
    return artType ? artType.native : undefined;
}

function getFontNameFromSAUCE(sauce) {
    if (sauce && sauce.Character) {
        return sauce.Character.fontName;
    }
}

function getWidthFromSAUCE(sauce) {
    if (sauce && sauce.Character) {
        let sauceWidth = Number(sauce.Character.characterWidth);
        if (!Number.isNaN(sauceWidth) && sauceWidth > 0) {
            return sauceWidth;
        }
    }
    return null;
}

function sliceAtEOF(data, eofMarker) {
    let eof = data.length;
    const stopPos = Math.max(data.length - 256, 0); //  256 = 2 * sizeof(SAUCE)

    for (let i = eof - 1; i > stopPos; i--) {
        if (eofMarker === data[i]) {
            eof = i;
            break;
        }
    }

    if (eof === data.length) {
        return data; //  nothing to do
    }

    //  try to prevent goofs
    if (eof < 128 && 'SAUCE00' !== data.slice(eof + 1, eof + 8).toString()) {
        return data;
    }

    return data.slice(0, eof);
}

//
//  Native art's bytes without a SAUCE record (and its comment block and the
//  0x1A before it) and without trailing 0x1A padding. Native art carries no
//  SAUCE as a rule; one that does must not reach the terminal as art.
//
//  0x1A: in a PETSCII stream it is an unassigned control code that neither
//  character set draws (the 'Z' glyph is screen code 0x1A, not PETSCII byte
//  0x1A). A file that went through XMODEM is padded with it to a 128 byte
//  block, so a trailing run of it is padding and is dropped. One anywhere
//  else is not an end-of-file marker for this type: it goes out with the
//  rest, as the terminal ignores it.
//
function stripNativeTrailer(data) {
    let end = data.length;
    if (
        end >= sauce.SAUCE_SIZE &&
        'SAUCE00' ===
            data.slice(end - sauce.SAUCE_SIZE, end - sauce.SAUCE_SIZE + 7).toString()
    ) {
        const numComments = data[end - sauce.SAUCE_SIZE + 104];
        end -= sauce.SAUCE_SIZE;
        const commentStart = end - 5 - numComments * 64;
        if (
            numComments > 0 &&
            commentStart >= 0 &&
            'COMNT' === data.slice(commentStart, commentStart + 5).toString()
        ) {
            end = commentStart;
        }
    }
    while (end > 0 && 0x1a === data[end - 1]) {
        --end;
    }
    return end === data.length ? data : data.slice(0, end);
}

//
//  Native art as read from |path|. Raw bytes with |native| set when the
//  caller can show native art (|options.acceptNative|; art.display() decides
//  per session what to do with it); otherwise plain text, safe anywhere.
//
function getNativeArt(path, data, emulation, options) {
    const nativeArt = NATIVE_ART[emulation];
    const charset = nativeArt.charsetFor(options.encodedAs);
    const bytes = stripNativeTrailer(data);
    if (true === options.acceptNative) {
        return { data: bytes, fromPath: path, native: { emulation, charset } };
    }
    return { data: nativeArt.toText(bytes, { charset }), fromPath: path };
}

function getArtFromPath(path, options, cb) {
    fs.readFile(path, (err, data) => {
        if (err) {
            return cb(err);
        }

        //
        //  Convert from encodedAs -> j
        //
        const ext = paths.extname(path).toLowerCase();
        const nativeEmulation = nativeEmulationOfType(ext);
        if (nativeEmulation) {
            return cb(null, getNativeArt(path, data, nativeEmulation, options));
        }

        //  a native art encoding ('petscii_upper') says nothing about this type
        const encoding =
            (!isNativeArtEncoding(options.encodedAs) && options.encodedAs) ||
            defaultEncodingFromExtension(ext);

        //  :TODO: how are BOM's currently handled if present? Are they removed? Do we need to?

        function sliceOfData() {
            let decoded;
            if (options.fullFile === true) {
                decoded = iconv.decode(data, encoding);
            } else {
                const eofMarker = defaultEofFromExtension(ext);
                decoded = iconv.decode(
                    eofMarker ? sliceAtEOF(data, eofMarker) : data,
                    encoding
                );
            }
            //  Promote bare LF to CRLF. Strict-NVT clients (e.g. SyncTERM in
            //  telnet mode) treat bare LF as row+1 with column unchanged,
            //  producing a diagonal staircase. The lookbehind preserves any
            //  existing CRLF pair and leaves bare CR (used for cursor reset
            //  / overlay effects) untouched.
            return decoded.replace(/(?<!\r)\n/g, '\r\n');
        }

        function getResult(sauce) {
            const result = {
                data: sliceOfData(),
                fromPath: path,
            };

            if (sauce) {
                result.sauce = sauce;
            }

            return result;
        }

        if (options.readSauce === true) {
            sauce.readSAUCE(data, (err, sauce) => {
                if (err) {
                    return cb(null, getResult());
                }

                //
                //  If a encoding was not provided & we have a mapping from
                //  the information provided by SAUCE, use that.
                //
                if (!options.encodedAs) {
                    /*
                    if(sauce.Character && sauce.Character.fontName) {
                        var enc = SAUCE_FONT_TO_ENCODING_HINT[sauce.Character.fontName];
                        if(enc) {
                            encoding = enc;
                        }
                    }
                    */
                }
                return cb(null, getResult(sauce));
            });
        } else {
            return cb(null, getResult());
        }
    });
}

//
//  What the terminal itself says about art types, before the caller's request
//  is taken into account:
//
//      allowed     array of types the terminal can be sent at all, or
//                  undefined for "any type"
//      preferred   array of tiers (arrays of types), best first. Types not
//                  in any tier rank after all of them.
//      last        array of types that rank after everything else
//
//  |term.artTypes|, when present, supplies this as-is (an explicit override).
//  Otherwise it comes from the terminal's emulation (core/term/): ANSI derives
//  it from the output encoding, a UTF-8 terminal preferring '.utf8ans' and
//  every terminal accepting every type; PETSCII would allow only '.seq', and a
//  RIP layer would prefer '.rip' over '.ans'.
//
function termArtTypePreferences(term) {
    if (!term) {
        return { preferred: [] };
    }

    if (term.artTypes) {
        return term.artTypes;
    }

    return emulationOf(term).artTypes(term);
}

//
//  Resolve the art type policy for |client| (which may be absent) and the
//  requested |types| (in the caller's order of priority):
//
//      {
//          allowed:    [ ...types ],                   //  the only types that may be picked
//          preferred:  [ [ tier 1 ], [ tier 2 ], ... ] //  best first; non-empty; covers |allowed|
//      }
//
//  A candidate whose type is not in |allowed| is never chosen, whatever else is
//  missing. getArt() takes the first tier that has a matching file as its pool.
//  Within a tier, types keep the order the terminal gave them; types the
//  terminal did not rank form the next tier, in the caller's order; its 'last'
//  types come after everything, whatever order the caller asked for.
//
//  Native art types ('.seq') are allowed for a session of their own emulation
//  only, whatever else says otherwise: never for an ANSI session, a stand-in
//  term or no client at all.
//
function getArtTypePolicy(client, types) {
    const term = _.get(client, 'term');
    const prefs = termArtTypePreferences(term);

    const sessionEmulation = emulationOf(term).name;
    const allowed = (
        Array.isArray(prefs.allowed)
            ? types.filter(t => prefs.allowed.includes(t))
            : types.slice()
    ).filter(t => {
        const nativeTo = nativeEmulationOfType(t);
        return undefined === nativeTo || nativeTo === sessionEmulation;
    });

    const ranked = new Set();
    const preferred = [];
    (prefs.preferred || []).forEach(tier => {
        const t = [];
        tier.forEach(type => {
            if (allowed.includes(type) && !ranked.has(type)) {
                ranked.add(type);
                t.push(type);
            }
        });
        if (t.length > 0) {
            preferred.push(t);
        }
    });

    const last = (prefs.last || []).filter(t => !ranked.has(t));
    const rest = allowed.filter(t => !ranked.has(t) && !last.includes(t));
    if (rest.length > 0) {
        preferred.push(rest);
    }

    const lastTier = allowed.filter(t => last.includes(t));
    if (lastTier.length > 0) {
        preferred.push(lastTier);
    }

    return { allowed, preferred };
}

function getArt(name, options, cb) {
    const ext = paths.extname(name);

    //  Only consult Config when no base path was given.
    if (undefined === options.basePath) {
        options.basePath = Config().paths.art;
    }
    options.asAnsi = miscUtil.valueWithDefault(options.asAnsi, true);

    //  :TODO: make use of asAnsi option and convert from supported -> ansi

    if ('' !== ext) {
        options.types = [ext.toLowerCase()];
    } else {
        if (options.types === undefined) {
            options.types = Object.keys(SUPPORTED_ART_TYPES);
        } else if (_.isString(options.types)) {
            options.types = [options.types.toLowerCase()];
        }
    }

    //  If an extension is provided, just read the file now
    if ('' !== ext) {
        const directPath = paths.isAbsolute(name)
            ? name
            : paths.join(options.basePath, name);
        return getArtFromPath(directPath, options, cb);
    }

    fs.readdir(options.basePath, (err, files) => {
        if (err) {
            return cb(err);
        }

        //  native types only for a caller that can show native art
        const policy = getArtTypePolicy(
            options.client,
            true === options.acceptNative
                ? options.types
                : options.types.filter(t => !nativeEmulationOfType(t))
        );

        const filtered = files.filter(file => {
            //
            //  Ignore any type the policy does not allow.
            //
            //  Keep the original-case ext for paths.basename() (which is case-sensitive
            //  when stripping the suffix), and use the lowercase form only for the
            //  types membership check.
            //
            const fextOrig = paths.extname(file);
            const fext = fextOrig.toLowerCase();
            if (!policy.allowed.includes(fext)) {
                return false;
            }

            const bn = paths.basename(file, fextOrig).toLowerCase();
            if (options.random) {
                //
                //  For random mode we need to strip any known extension from the
                //  supplied name before comparing, since the file on disk may have
                //  a different extension than the bare name requested.
                //
                const suppliedBn = paths.basename(name).toLowerCase();

                //
                //  Random selection enabled. We'll allow for
                //  basename1.ext, basename2.ext, ...
                //
                if (!bn.startsWith(suppliedBn)) {
                    return false;
                }

                const num = bn.substr(suppliedBn.length);
                if (num.length > 0) {
                    if (isNaN(parseInt(num, 10))) {
                        return false;
                    }
                }
            } else {
                //
                //  We've already validated the extension (above). Must be an exact
                //  match to basename here
                //
                if (bn !== paths.basename(name).toLowerCase()) {
                    return false;
                }
            }

            return true;
        });

        //
        //  The pool is the candidates of the first preference tier that has any.
        //
        const typeOf = f => paths.extname(f).toLowerCase();
        let tier = [];
        let pool = [];
        for (tier of policy.preferred) {
            pool = filtered.filter(f => tier.includes(typeOf(f)));
            if (pool.length > 0) {
                break;
            }
        }

        if (0 === pool.length) {
            return cb(
                Errors.DoesNotExist(`No matching art for supplied criteria: ${name}`)
            );
        }

        let readPath;
        if (options.random) {
            readPath = paths.join(
                options.basePath,
                pool[Math.floor(Math.random() * pool.length)]
            );
        } else {
            //
            //  Non-random: pick by type order within the tier (earlier wins).
            //
            const best = pool.reduce((winner, file) => {
                return tier.indexOf(typeOf(file)) < tier.indexOf(typeOf(winner))
                    ? file
                    : winner;
            });
            readPath = paths.join(options.basePath, best);
        }

        return getArtFromPath(readPath, options, cb);
    });
}

function defaultEncodingFromExtension(ext) {
    const artType = SUPPORTED_ART_TYPES[ext.toLowerCase()];
    return (artType && artType.defaultEncoding) || 'utf8';
}

function defaultEofFromExtension(ext) {
    const artType = SUPPORTED_ART_TYPES[ext.toLowerCase()];
    if (artType) {
        return artType.eof;
    }
}

//
//  Can |client|'s session show |native| art ({ emulation, charset }, from
//  getArtFromPath()) as it is?
//
function canDisplayNative(client, native) {
    const term = client.term;
    return (
        _.has(NATIVE_ART, native.emulation) &&
        emulationOf(term).name === native.emulation &&
        _.isFunction(term.canWriteNative) &&
        term.canWriteNative()
    );
}

//  :TODO: Implement the following
//  * Pause (disabled | termHeight | keyPress )
//  * Cancel (disabled | <keys> )
//  * Resume from pause -> continous (disabled | <keys>)
//
//  |art| is a string of ANSI art, or with |options.native| set, the Buffer of
//  native art from getArtFromPath(). Native art goes to the wire as it is
//  for a session of its emulation, with MCI codes found by that emulation's
//  parser; any other session (an explicit 'NAME.seq', a forced theme) gets it
//  as plain text through the ANSI path, never its raw bytes.
//
function display(client, art, options, cb) {
    if (_.isFunction(options) && !cb) {
        cb = options;
        options = {};
    }

    if (!art || !art.length) {
        return cb(Errors.Invalid('No art supplied!'));
    }

    const native = options.native || null;
    if (native && !canDisplayNative(client, native)) {
        const toText = _.get(NATIVE_ART, [native.emulation, 'toText']);
        const textOptions = Object.assign({}, options);
        delete textOptions.native;
        const text = toText
            ? toText(art, { charset: native.charset, cols: client.term.termWidth })
            : '';
        return display(client, text, textOptions, cb);
    }

    options.mciReplaceChar = options.mciReplaceChar || ' ';

    //  :TODO: this is going to be broken into two approaches controlled via options:
    //  1) Standard - use internal tracking of locations for MCI -- no CPR's/etc.
    //  2) CPR driven

    if (!_.isBoolean(options.iceColors)) {
        //  try to detect from SAUCE
        if (_.has(options, 'sauce.ansiFlags') && options.sauce.ansiFlags & (1 << 0)) {
            options.iceColors = true;
        }
    }

    const parser = native
        ? NATIVE_ART[native.emulation].createParser({
              mciReplaceChar: options.mciReplaceChar,
              termHeight: client.term.termHeight,
              termWidth: client.term.termWidth,
              trailingLF: options.trailingLF,
              startRow: options.startRow,
              charset: native.charset,
          })
        : new aep.ANSIEscapeParser({
              mciReplaceChar: options.mciReplaceChar,
              termHeight: client.term.termHeight,
              termWidth: client.term.termWidth,
              artWidth: getWidthFromSAUCE(options.sauce),
              trailingLF: options.trailingLF,
              startRow: options.startRow,
          });

    const mciMap = {};
    let generatedId = 100;

    parser.on('mci', mciInfo => {
        //  :TODO: ensure generatedId's do not conflict with any existing |id|
        const id = _.isNumber(mciInfo.id) ? mciInfo.id : generatedId;
        const mapKey = `${mciInfo.mci}${id}`;
        const mapEntry = mciMap[mapKey];

        if (mapEntry) {
            mapEntry.focusSGR = mciInfo.SGR;
            mapEntry.focusArgs = mciInfo.args;
        } else {
            mciMap[mapKey] = {
                position: mciInfo.position,
                args: mciInfo.args,
                SGR: mciInfo.SGR,
                code: mciInfo.mci,
                id: id,
            };

            if (!mciInfo.id) {
                ++generatedId;
            }
        }
    });

    // Remove any MCI's that are in erased rows
    parser.on('erase row', (startRow, endRow) => {
        _.forEach(mciMap, (mciInfo, mapKey) => {
            if (mciInfo.position[0] >= startRow && mciInfo.position[0] <= endRow) {
                delete mciMap[mapKey];
            }
        });
    });

    // Remove any MCI's that are in erased columns
    parser.on('erase columns', (row, startCol, endCol) => {
        _.forEach(mciMap, (mciInfo, mapKey) => {
            if (
                mciInfo.position[0] === row &&
                mciInfo.position[1] >= startCol &&
                mciInfo.position[1] <= endCol
            ) {
                delete mciMap[mapKey];
            }
        });
    });

    parser.on('insert columns', (row, startCol, numCols) => {
        _.forEach(mciMap, (mciInfo, mapKey) => {
            if (mciInfo.position[0] === row && mciInfo.position[1] >= startCol) {
                mciInfo.position[1] += numCols;
                if (mciInfo.position[1] > client.term.termWidth) {
                    delete mciMap[mapKey];
                }
            }
        });
    });

    // Clear the screen, removing any MCI's
    parser.on('clear screen', () => {
        _.forEach(mciMap, (mciInfo, mapKey) => {
            delete mciMap[mapKey];
        });
    });

    parser.on('scroll', scrollY => {
        _.forEach(mciMap, mciInfo => {
            mciInfo.position[0] -= scrollY;
        });
    });

    parser.on('insert line', (row, numLines) => {
        _.forEach(mciMap, mciInfo => {
            if (mciInfo.position[0] >= row) {
                mciInfo.position[0] += numLines;
            }
        });
    });

    parser.on('delete line', (row, numLines) => {
        _.forEach(mciMap, (mciInfo, mapKey) => {
            if (mciInfo.position[0] >= row) {
                if (mciInfo.position[0] < row + numLines) {
                    // unlike scrolling, the rows are actually gone,
                    // so we need to delete any MCI's that are in them
                    delete mciMap[mapKey];
                } else {
                    mciInfo.position[0] -= numLines;
                }
            }
        });
    });

    //  Server-side baud emulation: collect all output into chunks, then drip at
    //  the target byte rate after parsing completes. Works for every terminal.
    //  baudRate / 10 = bytes/sec (standard 8N1: 8 data + 1 start + 1 stop bits).
    const bytesPerSec = options.baudRate > 0 ? Math.floor(options.baudRate / 10) : 0;
    const drip = bytesPerSec > 0;
    const dripChunks = drip ? [] : null;

    //  native art: every byte as it is, written in one piece on completion
    const nativeChunks = native ? [] : null;

    parser.on('literal', literal => {
        if (native) {
            return nativeChunks.push(literal);
        }
        const encoded = client.term.encode(literal, false);
        if (drip) {
            dripChunks.push(encoded);
        } else {
            client.term.rawWrite(encoded);
        }
    });

    parser.on('control', control => {
        if (native) {
            return nativeChunks.push(control);
        }
        if (drip) {
            dripChunks.push(Buffer.isBuffer(control) ? control : Buffer.from(control));
        } else {
            client.term.rawWrite(control);
        }
    });

    parser.on('complete', () => {
        parser.removeAllListeners();

        const extraInfo = {
            height: parser.row - 1,
        };

        if (native) {
            const nativeBytes = Buffer.concat(nativeChunks);
            const nativeOptions = { charset: native.charset };
            if (!drip) {
                client.term.nativeWrite(nativeBytes, nativeOptions);
                return cb(null, mciMap, extraInfo);
            }
            return client.term.nativeDripWrite(
                nativeBytes,
                nativeOptions,
                bytesPerSec,
                err => cb(err, mciMap, extraInfo)
            );
        }

        if (!drip) {
            return cb(null, mciMap, extraInfo);
        }

        client.term.dripWrite(Buffer.concat(dripChunks), bytesPerSec, err =>
            cb(err, mciMap, extraInfo)
        );
    });

    let initSeq = '';
    if (client.term.syncTermFontsEnabled && !native) {
        if (options.font) {
            initSeq = ansi.setSyncTermFontWithAlias(options.font);
        } else if (options.sauce) {
            let fontName = getFontNameFromSAUCE(options.sauce);
            if (fontName) {
                fontName = ansi.getSyncTermFontFromAlias(fontName);
            }

            //
            //  Set SyncTERM font if we're switching only. Most terminals
            //  that support this ESC sequence can only show *one* font
            //  at a time. This applies to detection only (e.g. SAUCE).
            //  If explicit, we'll set it no matter what (above)
            //
            if (fontName && client.term.currentSyncFont != fontName) {
                client.term.currentSyncFont = fontName;
                initSeq = ansi.setSyncTermFont(fontName);
            }
        }
    }

    if (options.iceColors && !native) {
        initSeq += ansi.blinkToBrightIntensity();
    }

    if (initSeq) {
        client.term.rawWrite(initSeq);
    }

    parser.reset(art);
    return parser.parse();
}

const _ABS_POS_RE = /\x1b\[\d+(?:;\d+)?[Hf]/;

function paginate(data, options) {
    const termHeight = (options && options.termHeight) || 25;
    const str = Buffer.isBuffer(data) ? data.toString('binary') : data;

    if (_ABS_POS_RE.test(str)) {
        return { pages: [str], hasAbsolutePositioning: true };
    }

    const pageSize = Math.max(1, termHeight - 1);
    const lines = str.split('\n');

    if (lines.length <= pageSize) {
        return { pages: [str], hasAbsolutePositioning: false };
    }

    const pages = [];
    for (let i = 0; i < lines.length; i += pageSize) {
        pages.push(lines.slice(i, i + pageSize).join('\n'));
    }

    return { pages, hasAbsolutePositioning: false };
}
