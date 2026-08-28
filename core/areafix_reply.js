/* jslint node: true */
'use strict';

//
//  Parsing of inbound AreaFix (conference manager) replies.
//
//  Pure: no config, no I/O.  See docs/_docs/messageareas/ftn.md for how this
//  is wired up.
//
//  The point of this module is *not* to extract descriptions.  A confirmation
//  line and a %LIST entry are structurally identical --
//
//      FSX_GEN ........................... added             <- confirmation
//      FSX_GEN ........................... General chatter   <- %LIST entry
//
//  -- so no regex can tell them apart, and a parser that returned free text
//  would eventually set an area's description to "added".  The protection is
//  the return type: this yields a status enum and nothing else.  A total
//  mis-parse produces a wrong *status*, which is a log line, not a corrupted
//  config.
//
//  Three implementations were read directly.  Their line *structure*
//  converges on "[flags] TAG [fill] STATUS":
//
//      husky      areafix.c   " FSX_GEN ........................... added"
//      SBBSecho   sbbsecho.c  "FSX_GEN added."
//      CrashMail  areafix.c   "+FSX_GEN                       Attached"
//
//  Their *vocabulary* does not.  husky says "unlinked" where SBBSecho says
//  "removed."; CrashMail says "Attached"/"Detached"/"Unknown area".  So the
//  phrase list below is seeded data rather than a constant, and callers may
//  extend it -- anything unseeded degrades to Unknown, which is reported to
//  the operator with the raw line rather than acted on.
//

const AreaFixStatus = {
    Added: 'added',
    Removed: 'removed',
    AlreadyLinked: 'already_linked',
    NotLinked: 'not_linked',
    NotFound: 'not_found',
    NoAccess: 'no_access',
    Forwarded: 'forwarded',
    Rescanned: 'rescanned',
    Unknown: 'unknown',
};

//
//  Seeded from husky, SBBSecho and CrashMail II.  Keys are the normalized
//  status text: lower case, internal whitespace collapsed, dot-fill and any
//  trailing period removed.
//
const DefaultStatusPhrases = {
    added: AreaFixStatus.Added,
    created: AreaFixStatus.Added,
    attached: AreaFixStatus.Added,
    'attached as read-only': AreaFixStatus.Added,

    removed: AreaFixStatus.Removed,
    deleted: AreaFixStatus.Removed,
    unlinked: AreaFixStatus.Removed,
    detached: AreaFixStatus.Removed,
    disconnected: AreaFixStatus.Removed,

    'already linked': AreaFixStatus.AlreadyLinked,
    'already connected': AreaFixStatus.AlreadyLinked,
    'already attached': AreaFixStatus.AlreadyLinked,
    'you are already attached to that area': AreaFixStatus.AlreadyLinked,

    'not linked': AreaFixStatus.NotLinked,
    'not connected': AreaFixStatus.NotLinked,
    'not subscribed': AreaFixStatus.NotLinked,

    'not found': AreaFixStatus.NotFound,
    'unknown area': AreaFixStatus.NotFound,
    'unknown echo': AreaFixStatus.NotFound,
    'no such area': AreaFixStatus.NotFound,

    'no access': AreaFixStatus.NoAccess,
    'access denied': AreaFixStatus.NoAccess,

    forwarded: AreaFixStatus.Forwarded,
    'request forwarded': AreaFixStatus.Forwarded,
};

//
//  Statuses that carry a variable tail and so cannot be matched exactly.
//  SBBSecho reports "TAG rescanned and 123 messages exported."
//
const StatusPrefixes = [{ prefix: 'rescanned', status: AreaFixStatus.Rescanned }];

//  Leading command/flag characters echoed back by some managers
const LeadingFlagsRe = /^[-+=%*!~]+/;

const LineRe = /^(\S+)\s+(.+)$/;

function normalizeStatusText(text) {
    return text
        .replace(/^[.\s]+/, '') //  dot-fill (husky pads with dots)
        .replace(/[.\s]+$/, '') //  trailing period (SBBSecho) and space
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

//
//  Tokenize one reply line into { tag, statusText } or null.
//
function tokenizeReplyLine(line) {
    const text = line.replace(LeadingFlagsRe, '').trim();
    if (0 === text.length) {
        return null;
    }

    const m = LineRe.exec(text);
    if (!m) {
        return null;
    }

    const statusText = normalizeStatusText(m[2]);
    if (0 === statusText.length) {
        return null;
    }

    return { tag: m[1], statusText };
}

function statusForText(statusText, phrases) {
    const exact = phrases[statusText];
    if (exact) {
        return exact;
    }

    const prefixed = StatusPrefixes.find(p => statusText.startsWith(p.prefix));
    if (prefixed) {
        return prefixed.status;
    }

    return AreaFixStatus.Unknown;
}

//
//  Parse an AreaFix reply body.
//
//  options.tags          area tags we asked about.  REQUIRED.  Only lines
//                        naming one of these are considered; a stray %LIST
//                        entry for an area we never mentioned is discarded.
//                        This is what makes it safe that husky appends its
//                        full linked-areas list to the same netmail as the
//                        confirmations when queryReports is on.
//  options.extraPhrases  additional { normalizedText: AreaFixStatus } for a
//                        manager whose vocabulary is not seeded above.
//
//  Returns { results: [ { tag, status, statusText, raw } ], unknownCount }
//  with one entry per requested tag that was mentioned.  A tag mentioned more
//  than once keeps the first recognized status.
//
function parseAreaFixReply(body, { tags, extraPhrases } = {}) {
    const requested = new Set(Array.from(tags || []).map(t => String(t).toUpperCase()));

    const phrases = Object.assign({}, DefaultStatusPhrases, extraPhrases || {});

    const byTag = new Map();
    let unknownCount = 0;

    String(body || '')
        .split(/\r\n|\n|\r/)
        .forEach(line => {
            const token = tokenizeReplyLine(line);
            if (!token) {
                return;
            }

            const upperTag = token.tag.toUpperCase();
            if (!requested.has(upperTag)) {
                return;
            }

            const status = statusForText(token.statusText, phrases);

            const existing = byTag.get(upperTag);
            if (existing && existing.status !== AreaFixStatus.Unknown) {
                return; //  keep the first recognized status for a tag
            }

            if (status === AreaFixStatus.Unknown && !existing) {
                unknownCount += 1;
            } else if (status !== AreaFixStatus.Unknown && existing) {
                unknownCount -= 1; //  upgraded from a previous Unknown
            }

            byTag.set(upperTag, {
                tag: upperTag,
                status,
                statusText: token.statusText,
                raw: line.trim(),
            });
        });

    return { results: Array.from(byTag.values()), unknownCount };
}

module.exports = {
    AreaFixStatus,
    DefaultStatusPhrases,
    tokenizeReplyLine,
    parseAreaFixReply,
};
