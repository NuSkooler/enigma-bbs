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
const { LAYER_NAME: RIP_LAYER } = require('./term/rip');
const { PetsciiArtParser, petsciiArtToText } = require('./term/petscii/art_parser.js');
const { AtasciiArtParser, atasciiArtToText } = require('./term/atascii/art_parser.js');

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
exports.nameHasPath = nameHasPath;

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
    //  :TODO: extension for topaz ansi/ascii.

    //
    //  Native art: bytes in a base emulation's own language, shown as they are
    //  to a session of that emulation and never offered to any other (#593).
    //  See NATIVE_ART below.
    //
    '.seq': { name: 'PETSCII', native: 'petscii' },
    '.ata': { name: 'ATASCII', native: 'atascii' },

    //
    //  RIPscrip art (#989): RIP command lines mixed with ANSI text, for a
    //  session with the RIP layer only, and only from callers that ask for
    //  it (|acceptRip|). See RIP ART below. |rip| holds what applies when it
    //  is shown as RIP; anywhere else a .rip file is read exactly as before
    //  the type existed (an unknown extension: UTF-8, no EOF marker).
    //
    '.rip': { name: 'RIPscrip', rip: { defaultEncoding: 'cp437', eof: 0x1a } },
};

//
//  RIP ART
//  -------
//  A .rip file is operator-installed and trusted: its RIP commands go to the
//  terminal unfiltered (ClientTerminal's writeUnfilteredRip()), around the
//  RIP output filter that keeps RIP out of everything else ENiGMA sends.
//  That is only safe for a file the operator put in place AND chose, so:
//
//  * getArtFromPath() marks art as RIP (|rip|: TRUSTED_RIP_ART) only when
//    the file's extension is .rip, the caller passed |acceptRip| true, and
//    the session has the RIP layer. Without the mark, a .rip file is text,
//    and goes through the filter like any other.
//  * Only theme art passes |acceptRip| (core/theme.js: displayThemeArt()
//    and the menu module's paged art), and theme.js never passes it for an
//    art name holding a path, nor for a caller that says its name may come
//    from a user (|acceptRip| false; show_art's extraArgs).
//  * display() takes the RIP path only for the mark itself, which is a
//    Symbol: no configuration, form data or other value can carry it.
//
const TRUSTED_RIP_ART = Symbol('trusted .rip art');

//
//  Per emulation, what native art needs:
//
//      encodings               |encodedAs| names that belong to this art (on
//                              an ANSI type they mean nothing and are ignored)
//      describe(data, options) what getArtFromPath() records about the art
//                              beside |emulation| in |native| (|data| is the
//                              file as read, |options| the caller's)
//      stripTrailer(data)      the art's bytes without SAUCE and padding
//      createParser(options)   the parser art.display() drives in place of
//                              ANSIEscapeParser (same events)
//      writeOptions(native, displayOptions)
//                              options for the terminal's nativeWrite()
//      toText(bytes, native, cols)
//                              the art as plain Unicode text, for anything
//                              that cannot show it natively (|cols|: the
//                              session's width, when there is a session)
//
//  PETSCII (.seq): lower/upper unless |encodedAs| is 'petscii_upper'
//  (upper/graphics); 'petscii' and 'petscii_lower' name the default. Any
//  other encoding name means nothing for these bytes and is ignored.
//
//  ATASCII (.ata): one character set, so |encodedAs| has nothing to choose
//  ('atascii' is accepted and ignored). |native.artWidth| is the art's own
//  width when a SAUCE record gives one (80 for an XEP80 screen); it is used
//  only for the plain text conversion: a session showing the art natively
//  draws it at the session's width, as the terminal would.
//
const PETSCII_CHARSETS = {
    petscii: 'lower',
    petscii_lower: 'lower',
    petscii_upper: 'upper',
};

const ATASCII_DEFAULT_WIDTH = 40;

const NATIVE_ART = {
    petscii: {
        encodings: Object.keys(PETSCII_CHARSETS),
        describe: (data, options) => ({
            charset:
                PETSCII_CHARSETS[
                    _.isString(options.encodedAs) ? options.encodedAs.toLowerCase() : ''
                ] || 'lower',
        }),
        stripTrailer: data => stripNativeTrailer(data, { padding: true }),
        createParser: options => new PetsciiArtParser(options),
        writeOptions: native => ({ charset: native.charset }),
        toText: (bytes, native, cols) =>
            petsciiArtToText(bytes, { charset: native.charset, cols }),
    },
    atascii: {
        encodings: ['atascii'],
        describe: data => {
            const artWidth = sauceCharacterWidth(data);
            return artWidth ? { artWidth } : {};
        },
        stripTrailer: data => stripNativeTrailer(data, { padding: false }),
        createParser: options => new AtasciiArtParser(options),
        //  |anchor|: see writeNative() in core/term/atascii/output_translator.js
        writeOptions: (native, displayOptions) => ({
            anchor: true,
            startRow: displayOptions.startRow,
        }),
        //  the art's width, not the session's: rows that fill the Atari screen
        //  rely on its wrap and must break there
        toText: (bytes, native) =>
            atasciiArtToText(bytes, {
                cols: native.artWidth || ATASCII_DEFAULT_WIDTH,
            }),
    },
};

function isNativeArtEncoding(encoding) {
    return (
        _.isString(encoding) &&
        _.some(NATIVE_ART, nativeArt =>
            nativeArt.encodings.includes(encoding.toLowerCase())
        )
    );
}

//  the emulation |ext|'s art is native to, or undefined for ANSI-side types
function nativeEmulationOfType(ext) {
    const artType = SUPPORTED_ART_TYPES[ext];
    return artType ? artType.native : undefined;
}

//  is |ext| RIP art (shown only to a session with the RIP layer)?
function isRipArtType(ext) {
    const artType = SUPPORTED_ART_TYPES[ext];
    return Boolean(artType && artType.rip);
}

//  does |name| hold a path (a separator, or an absolute name)? RIP art is
//  never trusted by such a name: see RIP ART
function nameHasPath(name) {
    return _.isString(name) && (/[\\/]/.test(name) || paths.isAbsolute(name));
}

//  does |term|'s session have the RIP layer?
function termHasRip(term) {
    const emulation = emulationOf(term);
    return _.isFunction(emulation.hasLayer) && emulation.hasLayer(RIP_LAYER);
}

//  may |options| (for getArt() / getArtFromPath()) be given RIP art?
function acceptsRipArt(options) {
    return true === options.acceptRip && termHasRip(_.get(options, 'client.term'));
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

function hasSauceRecord(data) {
    const at = data.length - sauce.SAUCE_SIZE;
    return at >= 0 && 'SAUCE00' === data.slice(at, at + 7).toString();
}

//
//  Native art's bytes without a SAUCE record (and its comment block and the
//  0x1A before it). Native art carries no SAUCE as a rule; one that does must
//  not reach the terminal as art.
//
//  |padding| (PETSCII): every trailing 0x1A is dropped too. In a PETSCII
//  stream 0x1A is an unassigned control code that neither character set
//  draws (the 'Z' glyph is screen code 0x1A, not PETSCII byte 0x1A). A file
//  that went through XMODEM is padded with it to a 128 byte block, so a
//  trailing run of it is padding. One anywhere else is not an end-of-file
//  marker for this type: it goes out with the rest, as the terminal ignores
//  it.
//
//  Without |padding| (ATASCII): 0x1A draws a glyph (a line corner), so only
//  the one 0x1A in front of a SAUCE record is dropped, as Icy Draw does when
//  it loads the file. Nothing in the bytes tells XMODEM padding from art
//  that ends in that glyph, so a trailing run is kept: the art shows as it
//  does in the editor.
//
function stripNativeTrailer(data, { padding }) {
    let end = data.length;
    const sauced = hasSauceRecord(data);
    if (sauced) {
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
    if (padding) {
        while (end > 0 && 0x1a === data[end - 1]) {
            --end;
        }
    } else if (sauced && end > 0 && 0x1a === data[end - 1]) {
        --end;
    }
    return end === data.length ? data : data.slice(0, end);
}

//  The character width (TInfo1) of |data|'s SAUCE record, or null
function sauceCharacterWidth(data) {
    if (!hasSauceRecord(data)) {
        return null;
    }
    const width = data.readUInt16LE(data.length - sauce.SAUCE_SIZE + 96);
    return width >= 2 && width <= 255 ? width : null;
}

//
//  Native art as read from |path|. Raw bytes with |native| set when the
//  caller can show native art (|options.acceptNative|; art.display() decides
//  per session what to do with it); otherwise plain text, safe anywhere.
//
function getNativeArt(path, data, emulation, options) {
    const nativeArt = NATIVE_ART[emulation];
    const native = Object.assign({ emulation }, nativeArt.describe(data, options));
    const bytes = nativeArt.stripTrailer(data);
    if (true === options.acceptNative) {
        return { data: bytes, fromPath: path, native };
    }
    return { data: nativeArt.toText(bytes, native), fromPath: path };
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

        //  RIP art, to be shown as RIP (see RIP ART above); otherwise, a .rip
        //  file is read as any file of an unknown type is
        const ripArt =
            isRipArtType(ext) && acceptsRipArt(options)
                ? SUPPORTED_ART_TYPES[ext].rip
                : null;

        //  a native art encoding ('petscii_upper', 'atascii') says nothing about this type
        const encoding =
            (!isNativeArtEncoding(options.encodedAs) && options.encodedAs) ||
            (ripArt ? ripArt.defaultEncoding : defaultEncodingFromExtension(ext));

        //  :TODO: how are BOM's currently handled if present? Are they removed? Do we need to?

        function sliceOfData() {
            let decoded;
            if (options.fullFile === true) {
                decoded = iconv.decode(data, encoding);
            } else {
                const eofMarker = ripArt ? ripArt.eof : defaultEofFromExtension(ext);
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

            if (ripArt) {
                result.rip = TRUSTED_RIP_ART;
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
//  every terminal accepting every type; PETSCII and ATASCII prefer their own
//  native type ('.seq', '.ata'), and a RIP layer would prefer '.rip' over
//  '.ans'.
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
//  Native art types ('.seq', '.ata') are allowed for a session of their own emulation
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

//  |options.types| lists getArt() made up itself (every supported type), as
//  opposed to ones a caller asked for
const defaultTypeLists = new WeakSet();

function getArt(name, options, cb) {
    const ext = paths.extname(name);

    //  defence in depth (core/theme.js does this too): a name holding a path
    //  is never trusted RIP art. Theme lookups give a bare name and a base
    //  path, which is unaffected.
    if (nameHasPath(name)) {
        options.acceptRip = false;
    }

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
            defaultTypeLists.add(options.types);
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

        //  native types only for a caller that can show native art, and RIP
        //  art only for one that shows it as such (see RIP ART above). A
        //  caller that names '.rip' among its |types| gets what it did before
        //  the type existed: the file, as text.
        const ripTypeAllowed =
            acceptsRipArt(options) || !defaultTypeLists.has(options.types);
        const policy = getArtTypePolicy(
            options.client,
            options.types.filter(
                t =>
                    (true === options.acceptNative || !nativeEmulationOfType(t)) &&
                    (ripTypeAllowed || !isRipArtType(t))
            )
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
//  Can |client|'s session show |native| art ({ emulation, ... }, from
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

//
//  Can |client|'s session show art marked |rip| as RIP? Only the mark
//  getArtFromPath() sets, and only for a session with the RIP layer.
//
function canDisplayRip(client, rip) {
    const term = client.term;
    return (
        TRUSTED_RIP_ART === rip &&
        termHasRip(term) &&
        _.isFunction(term.writeUnfilteredRip) &&
        _.isFunction(term.ripDripWrite) &&
        _.isFunction(term.ripScreenShown)
    );
}

//  a RIP command at the very start of |art| (see RIP_COMMAND_RE_SOURCE in
//  core/ansi_escape_parser.js)
const RIP_COMMAND_FIRST_RE = /^[\x21\x01\x02]\|/; //  eslint-disable-line no-control-regex

//  :TODO: Implement the following
//  * Pause (disabled | termHeight | keyPress )
//  * Cancel (disabled | <keys> )
//  * Resume from pause -> continous (disabled | <keys>)
//
//  |art| is a string of ANSI art, or with |options.native| set, the Buffer of
//  native art from getArtFromPath(). Native art goes to the wire as it is
//  for a session of its emulation, with MCI codes found by that emulation's
//  parser; any other session (an explicit 'NAME.seq' or 'NAME.ata', a forced
//  theme) gets it as plain text through the ANSI path, never its raw bytes.
//
//  With |options.rip| set to the mark getArtFromPath() gives RIP art (see RIP
//  ART above), and a session with the RIP layer, |art| is shown as RIP: all
//  of it goes out unfiltered (writeUnfilteredRip(), ripDripWrite()), and the
//  parser takes its RIP command lines as zero-width, so that MCI codes in
//  its text parts land where the terminal draws them. Anything else in
//  |options.rip| is ignored: the art is shown as ANSI text, filtered for a
//  RIP session.
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
        const text = toText ? toText(art, native, client.term.termWidth) : '';
        return display(client, text, textOptions, cb);
    }

    //  RIP art: native art never is, and the mark is the only way in
    const rip = !native && canDisplayRip(client, options.rip);

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
              ripCommands: rip,
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

    //  native ATASCII art only (DELETE CHARACTER): the rest of the row moves left
    parser.on('delete columns', (row, startCol, numCols) => {
        _.forEach(mciMap, mciInfo => {
            if (mciInfo.position[0] === row && mciInfo.position[1] > startCol) {
                mciInfo.position[1] = Math.max(startCol, mciInfo.position[1] - numCols);
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

    //  RIP art goes out unfiltered, all of it; anything else is ENiGMA's
    //  ANSI output as usual
    const write = rip
        ? data => client.term.writeUnfilteredRip(data)
        : data => client.term.rawWrite(data);

    parser.on('literal', literal => {
        if (native) {
            return nativeChunks.push(literal);
        }
        const encoded = client.term.encode(literal, false);
        if (drip) {
            dripChunks.push(encoded);
        } else {
            write(encoded);
        }
    });

    parser.on('control', control => {
        if (native) {
            return nativeChunks.push(control);
        }
        if (drip) {
            dripChunks.push(Buffer.isBuffer(control) ? control : Buffer.from(control));
        } else {
            write(rip && !Buffer.isBuffer(control) ? Buffer.from(control) : control);
        }
    });

    //
    //  RIP art only: a command line, as it is (line breaks too). RIP is bytes
    //  (CP437 as the art was read), whatever the session's encoding is.
    //
    parser.on('rip', command => {
        const encoded = iconv.encode(command, 'cp437');
        if (drip) {
            dripChunks.push(encoded);
        } else {
            write(encoded);
        }
    });

    //  set once the parser is done: from there on, what is thrown comes from
    //  |cb|, which has been called
    let completed = false;

    parser.on('complete', () => {
        completed = true;
        parser.removeAllListeners();

        const extraInfo = {
            height: parser.row - 1,
        };

        if (native) {
            const nativeBytes = Buffer.concat(nativeChunks);
            const nativeOptions = NATIVE_ART[native.emulation].writeOptions(
                native,
                options
            );
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

        if (rip) {
            if (!drip) {
                return cb(null, mciMap, extraInfo);
            }
            return client.term.ripDripWrite(
                Buffer.concat(dripChunks),
                bytesPerSec,
                err => cb(err, mciMap, extraInfo),
                true
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

    //
    //  A RIP command runs only at the start of a line (after a CR or LF on
    //  the wire; SyncTERM 1.8 and IcyTerm do not take the left margin as
    //  one), and what came before is unknown: often a clear screen and
    //  cursor home. A CR in front of art that starts with a command makes
    //  sure it runs, and moves nothing: the parser takes the art as starting
    //  at column 1 anyway.
    //
    if (rip && RIP_COMMAND_FIRST_RE.test(art)) {
        if (drip) {
            dripChunks.push(Buffer.from('\r'));
        } else {
            write(Buffer.from('\r'));
        }
    }

    //
    //  Anything shown as RIP art may have left mouse fields behind, whether
    //  or not a command line was recognised in it: a terminal can run a
    //  command the parser took as text (mid-line on SyncTERM 1.10, say). The
    //  session is marked before any of the art goes, so leaving the screen
    //  clears them even if the display fails part way.
    //
    if (rip && !drip) {
        client.term.ripScreenShown();
    }

    parser.reset(art);
    if (!rip) {
        return parser.parse();
    }

    //  one command line of many megabytes overflows the stack in the
    //  parser's expression; that is a bad file, not a reason to bring the
    //  board down
    try {
        return parser.parse();
    } catch (e) {
        if (completed || !(e instanceof RangeError)) {
            throw e;
        }
        parser.removeAllListeners();
        return cb(Errors.Invalid(`RIP art cannot be parsed: ${e.message}`));
    }
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
