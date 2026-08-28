/* jslint node: true */
'use strict';

//  ENiGMA½
const Errors = require('./enig_error.js').Errors;

//  deps
const _ = require('lodash');

//
//  Shared parsing of FTN-style area/echo lists.
//
//  Used by `oputil mb import-areas` and by automatic area creation, so both
//  behave identically. Everything here is pure: no config, no I/O, no logging.
//
//  There is no FTSC document specifying the format of a `.na`, `AREAS.BBS` or
//  FILEBONE list -- FSC-0061 covers FileBone *policy*, not syntax. These are
//  de-facto conventions, and measured against real info packs from eight
//  networks (see test/fixtures/area_lists/) they diverge in ways that matter:
//
//  * The file extension does not indicate the format. Six of eight networks
//    ship two `.na` files, one message list and one file list, and the file
//    list may be FILEBONE ("Area TAG 0 ! Desc") *or* plain "TAG Desc".
//  * Comment lines start with ';' or '%' depending on network -- and fsxNet
//    changed from '%' to ';' between its 2018 and 2025 packs.
//  * At least one network (SpookNet) ships its list with the columns reversed
//    ("Description ... TAG"). Nothing on such a line is malformed enough to
//    reject on shape, and most first tokens pass a plausible-tag charset
//    check, so a parser that only validates characters returns confident
//    garbage. Detection therefore has to be a property of the *file*, not of
//    the line, and there has to be a path that refuses rather than guesses.
//

const AreaListFormat = {
    //  TAG<ws>Description -- the common ".na" message echo list
    NA: 'na',
    //  Area<ws>TAG<ws>level<ws>flags<ws>Description -- FILEBONE file echo list
    FileBone: 'filebone',
    //  [path]<ws>TAG<ws>uplink[ uplink...] -- AREAS.BBS
    AreasBbs: 'bbs',
    //  Description<ws...>TAG -- recognised, deliberately not parsed
    DescFirst: 'desc-first',
    //  Nothing we can identify
    Unknown: 'unknown',
};

const FormatDescriptions = {
    [AreaListFormat.NA]: 'area list (TAG followed by description)',
    [AreaListFormat.FileBone]: 'FILEBONE file echo list ("Area TAG 0 ! Description")',
    [AreaListFormat.AreasBbs]: 'AREAS.BBS list',
    [AreaListFormat.DescFirst]: 'reversed-column list (description first, area tag last)',
    [AreaListFormat.Unknown]: 'unrecognized format',
};

//  Comment characters seen in the wild. ';' and '%' are both used by real
//  networks; '#' is included as it is near universal and no FTN area tag
//  begins with it.
const CommentChars = [';', '%', '#'];

const MaxAreaTagLength = 64;

//
//  What an FTN area tag may contain when we *accept* an entry. Deliberately
//  permissive on case: tags are compared case-insensitively throughout
//  (see getLocalAreaTagByFtnAreaTag() in the FTN scanner/tosser).
//
const AreaTagRe = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

//
//  What an FTN area tag looks like when we are *sniffing* a file's layout.
//  Much stricter -- upper case only -- because by universal convention area
//  tags are written upper case in these lists. A false negative here costs
//  nothing worse than "unrecognized format"; a false positive would let a
//  reversed-column list through.
//
const StrictAreaTagRe = /^[A-Z0-9][A-Z0-9_.-]*$/;

//  A line is FILEBONE if it opens with the "Area" keyword
const FileBoneDetectRe = /^Area\b/i;
//
//  ...and parses as: Area TAG <level> <flags> Description
//
//  The level is required to be numeric. It keeps an English sentence that
//  happens to start with "Area" from parsing as an entry, and it is what the
//  format actually specifies. Unlike the regex this replaces, the level may
//  have more than one digit and the flags are not limited to "!" and "*&" --
//  both occur in real FileGate and FILEBONE lists.
//
const FileBoneParseRe = /^Area\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/i;

//  TAG Description
const NaParseRe = /^(\S+)\s+(.+)$/;

//  [path|code] TAG uplink[ uplink...] -- second token is the tag, remainder uplinks
const AreasBbsParseRe = /^\S+\s+(\S+)\s+(.+)$/;

//
//  Fraction of data lines that must agree on a layout before we will name it.
//  Real lists are homogeneous; anything mixed enough to fall below this is
//  something we should not be guessing about.
//
const FormatConfidenceThreshold = 0.6;

const SkipReasons = {
    InvalidTag: 'area tag contains unexpected characters',
    NoDescription: 'no description',
    FileBoneLine: 'FILEBONE-style line in a plain area list',
    Unparsable: 'does not match the detected format',
    UnrecognizedFormat: 'file format not recognized',
    UnusableRecord: 'does not produce a usable area or storage tag',
};

//  Accepting an entry: permissive, case-insensitive
function isValidAreaTag(tag) {
    return (
        'string' === typeof tag &&
        tag.length > 0 &&
        tag.length <= MaxAreaTagLength &&
        AreaTagRe.test(tag)
    );
}

//  Sniffing a layout: strict, and must contain at least one letter so a
//  numeric column can never be mistaken for a tag.
function looksLikeAreaTag(token) {
    return (
        token.length >= 2 &&
        token.length <= MaxAreaTagLength &&
        StrictAreaTagRe.test(token) &&
        /[A-Z]/.test(token)
    );
}

function describeFormat(format) {
    return FormatDescriptions[format] || FormatDescriptions[AreaListFormat.Unknown];
}

//  A format we are willing to turn into area records
function isParsableFormat(format) {
    return [AreaListFormat.NA, AreaListFormat.FileBone, AreaListFormat.AreasBbs].includes(
        format
    );
}

//
//  Split into lines and separate comments/blanks from data. Tolerates CRLF,
//  LF and CR endings, a missing final newline, a leading BOM, and tabs or
//  runs of spaces as separators -- all of which occur in the fixtures.
//
function scanLines(data) {
    if (data.charCodeAt(0) === 0xfeff) {
        data = data.slice(1);
    }

    const result = { dataLines: [], commentCount: 0, blankCount: 0, lineCount: 0 };

    data.split(/\r\n|\n|\r/).forEach((raw, index) => {
        result.lineCount += 1;

        const text = raw.trim();
        if (0 === text.length) {
            result.blankCount += 1;
            return;
        }

        if (CommentChars.includes(text.charAt(0))) {
            result.commentCount += 1;
            return;
        }

        result.dataLines.push({ text, lineNumber: index + 1 });
    });

    return result;
}

//
//  Decide what a file *is* from its content. Returns { format, stats }.
//
//  AreasBbs is never sniffed: it cannot be told apart from a `.na` list by
//  shape alone (both are "token whitespace token..."), so it is only ever
//  used when the caller asks for it explicitly via extension or --type.
//
function sniffAreaListFormat(data) {
    const scan = scanLines(data);

    const stats = {
        lineCount: scan.lineCount,
        commentLines: scan.commentCount,
        blankLines: scan.blankCount,
        dataLines: scan.dataLines.length,
        //  data lines carrying enough tokens to say anything about layout
        classifiableLines: 0,
        fileBoneLines: 0,
        tagFirstLines: 0,
        tagLastLines: 0,
    };

    scan.dataLines.forEach(({ text }) => {
        const tokens = text.split(/\s+/);

        //
        //  A single-token line cannot be "TAG description" nor
        //  "description ... TAG", so it says nothing about which layout this
        //  is. Leaving it out of the denominator keeps a stray separator or
        //  truncated line from dragging a perfectly clear file below the
        //  confidence threshold; it is still reported as skipped at parse
        //  time.
        //
        if (tokens.length < 2) {
            return;
        }

        stats.classifiableLines += 1;

        if (FileBoneDetectRe.test(text)) {
            stats.fileBoneLines += 1;
            return;
        }

        if (looksLikeAreaTag(tokens[0])) {
            stats.tagFirstLines += 1;
        }
        if (looksLikeAreaTag(tokens[tokens.length - 1])) {
            stats.tagLastLines += 1;
        }
    });

    const total = stats.classifiableLines;
    if (0 === total) {
        return { format: AreaListFormat.Unknown, stats };
    }

    if (stats.fileBoneLines / total >= FormatConfidenceThreshold) {
        return { format: AreaListFormat.FileBone, stats };
    }

    //
    //  More lines end with something tag-shaped than begin with one: the
    //  columns are the other way around. Strictly greater, so a file where
    //  both hold (all-upper-case descriptions) still reads as a normal list.
    //
    if (stats.tagLastLines > stats.tagFirstLines) {
        return { format: AreaListFormat.DescFirst, stats };
    }

    if (stats.tagFirstLines / total >= FormatConfidenceThreshold) {
        return { format: AreaListFormat.NA, stats };
    }

    return { format: AreaListFormat.Unknown, stats };
}

function parseNaLine(line, entries, skipped) {
    if (FileBoneDetectRe.test(line.text)) {
        skipped.push(Object.assign({ reason: SkipReasons.FileBoneLine }, line));
        return;
    }

    const m = NaParseRe.exec(line.text);
    if (!m) {
        skipped.push(Object.assign({ reason: SkipReasons.NoDescription }, line));
        return;
    }

    const ftnTag = m[1].trim();
    if (!isValidAreaTag(ftnTag)) {
        skipped.push(Object.assign({ reason: SkipReasons.InvalidTag }, line));
        return;
    }

    entries.push({ ftnTag, name: m[2].trim(), lineNumber: line.lineNumber });
}

function parseFileBoneLine(line, entries, skipped) {
    const m = FileBoneParseRe.exec(line.text);
    if (!m) {
        skipped.push(Object.assign({ reason: SkipReasons.Unparsable }, line));
        return;
    }

    const ftnTag = m[1].trim();
    if (!isValidAreaTag(ftnTag)) {
        skipped.push(Object.assign({ reason: SkipReasons.InvalidTag }, line));
        return;
    }

    entries.push({ ftnTag, name: m[4].trim(), lineNumber: line.lineNumber });
}

function parseAreasBbsLine(line, entries, skipped) {
    //
    //  Various formats for AREAS.BBS exist; we support as much as possible.
    //
    //  SBBS http://www.synchro.net/docs/sbbsecho.html#AREAS.BBS
    //  CODE    TAG     UPLINKS
    //
    //  VADV https://www.vadvbbs.com/products/vadv/support/docs/docs_vfido.php#AREAS.BBS
    //  TAG     UPLINKS
    //
    //  Misc
    //  PATH|OTHER  TAG     UPLINKS
    //
    //  Assume the second item is TAG and 1:n UPLINKS (space and/or comma sep) after.
    //
    const m = AreasBbsParseRe.exec(line.text);
    if (!m) {
        skipped.push(Object.assign({ reason: SkipReasons.Unparsable }, line));
        return;
    }

    const ftnTag = m[1].trim();
    if (!isValidAreaTag(ftnTag)) {
        skipped.push(Object.assign({ reason: SkipReasons.InvalidTag }, line));
        return;
    }

    entries.push({
        ftnTag,
        name: `Area: ${ftnTag}`,
        uplinks: m[2].trim().split(/[\s,]+/),
        lineNumber: line.lineNumber,
    });
}

//
//  Parse an area list.
//
//  options.format   force a format instead of sniffing. Required for
//                   AreaListFormat.AreasBbs, which is never sniffed.
//
//  Returns:
//  {
//      format,     what the file was taken to be
//      stats,      line counts used to reach that decision
//      entries,    [ { ftnTag, name, uplinks?, lineNumber } ]
//      skipped,    [ { text, lineNumber, reason } ]
//  }
//
//  A format we do not recognize -- or recognize but will not guess at, such
//  as a reversed-column list -- yields zero entries and every data line in
//  |skipped|. Callers are expected to check |format| and say something useful
//  rather than treating an empty result as an empty file.
//
function parseAreaList(data, options = {}) {
    if ('string' !== typeof data) {
        throw Errors.Invalid('Area list data must be a string');
    }

    let format = options.format;
    let stats;

    if (format) {
        stats = sniffAreaListFormat(data).stats;
    } else {
        ({ format, stats } = sniffAreaListFormat(data));
    }

    const entries = [];
    const skipped = [];
    const scan = scanLines(data);

    if (!isParsableFormat(format)) {
        scan.dataLines.forEach(line => {
            skipped.push(Object.assign({ reason: SkipReasons.UnrecognizedFormat }, line));
        });
        return { format, stats, entries, skipped };
    }

    const lineParser = {
        [AreaListFormat.NA]: parseNaLine,
        [AreaListFormat.FileBone]: parseFileBoneLine,
        [AreaListFormat.AreasBbs]: parseAreasBbsLine,
    }[format];

    scan.dataLines.forEach(line => lineParser(line, entries, skipped));

    return { format, stats, entries, skipped };
}

function validateUplinks(uplinks) {
    if (!Array.isArray(uplinks) || 0 === uplinks.length) {
        return false;
    }

    const Address = require('./ftn_address.js');
    return uplinks.every(ul => Address.fromString(ul) !== undefined);
}

//  Local area tag for a given FTN area tag; must match the FTN
//  scanner/tosser's own case-insensitive comparison.
function localAreaTagFor(ftnTag) {
    return ftnTag.toLowerCase();
}

//
//  Turn parsed entries into the two config fragments an imported area needs:
//  the conference area record, and the FTN network area record.
//
//  |uplinks| is the fallback for entries that do not carry their own (only
//  AREAS.BBS does). When |networkName| is not supplied no FTN records are
//  produced -- the areas become purely local.
//
function buildAreaImportRecords(entries, { confTag, networkName, uplinks } = {}) {
    const confAreas = {};
    const ftnAreas = {};

    entries.forEach(entry => {
        const areaTag = entry.areaTag || localAreaTagFor(entry.ftnTag);

        confAreas[areaTag] = {
            name: entry.name,
            desc: entry.name,
        };

        if (networkName) {
            ftnAreas[areaTag] = {
                network: networkName,
                tag: entry.ftnTag,
                uplinks: entry.uplinks || uplinks,
            };
        }
    });

    return {
        messageConferences: {
            [confTag]: { areas: confAreas },
        },
        messageNetworks: {
            ftn: { areas: ftnAreas },
        },
    };
}

//
//  Turn parsed entries into file base area + storage tag records.
//
//  The area tag comes from the *description*, not the FTN tag, and the
//  storage tag combines both. That is long standing `oputil fb import-areas`
//  behaviour and is preserved exactly: changing it would orphan the storage
//  directories of anyone who has already imported.
//
function buildFileAreaImportRecords(entries) {
    const sanitizeFilename = require('sanitize-filename');

    const result = { storageTags: {}, areas: {}, count: 0, skipped: [] };

    entries.forEach(entry => {
        const dir = entry.ftnTag.trim();
        const name = entry.name.trim();
        const safeName = sanitizeFilename(name);

        const stPrefix = _.snakeCase(sanitizeFilename(safeName));
        const storageTag = `${stPrefix}__${_.snakeCase(sanitizeFilename(dir))}`;
        const areaTag = _.snakeCase(safeName);

        if (!dir || !name || !storageTag || !areaTag) {
            result.skipped.push({
                lineNumber: entry.lineNumber,
                text: `${entry.ftnTag} ${entry.name}`,
                reason: SkipReasons.UnusableRecord,
            });
            return;
        }

        result.storageTags[storageTag] = dir;
        result.areas[areaTag] = {
            name: name,
            desc: name,
            storageTags: [storageTag],
        };
        result.count += 1;
    });

    return result;
}

module.exports = {
    AreaListFormat,
    SkipReasons,
    MaxAreaTagLength,

    sniffAreaListFormat,
    parseAreaList,
    describeFormat,
    isParsableFormat,
    isValidAreaTag,

    validateUplinks,
    localAreaTagFor,
    buildAreaImportRecords,
    buildFileAreaImportRecords,
};
