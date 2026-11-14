'use strict';

//
//  File names as they travel in M_FILE, M_GET, M_GOT and M_SKIP.
//
//  FTS-1026 sends a file name as a single space-free token, so anything that
//  would not survive that -- whitespace, control characters, the backslash
//  itself -- goes on the wire as a "\xHH" escape of the byte. binkd encodes
//  this way when sending (prothlp.c netname_() -> strquote(SQ_CNTRL |
//  SQ_SPACE)) and decodes with strdequote() before it compares a name or
//  builds a path from it, accepting the older bare "\HH" form as well.
//
//  The wire form is what the protocol speaks: a receiver answers M_GOT,
//  M_SKIP and M_GET with the name exactly as the sender wrote it. The
//  decoded form is what reaches the file system.
//

//  Most file systems cap a single name at 255 bytes. A longer one cannot be
//  created, so there is no point accepting the file only to fail the move.
const MAX_NAME_BYTES = 255;

const HEX = '[0-9A-Fa-f]';
const ESCAPE_RE = new RegExp(`\\\\x(${HEX}{2})|\\\\(${HEX}{2})`, 'g');

//
//  Decode the "\xHH" (and bare "\HH") escapes in a wire name, as binkd's
//  strdequote() does. A backslash that does not start an escape is kept.
//
//  The escapes name bytes, not characters, so the result is assembled as
//  bytes and read back as UTF-8. A name whose bytes are not valid UTF-8 --
//  a DOS mailer escaping a code page 437 character, say -- is read as
//  Latin-1 instead, which keeps every byte distinct rather than collapsing
//  them all into U+FFFD.
//
function decodeWireName(wireName) {
    if ('string' !== typeof wireName) {
        return '';
    }
    if (-1 === wireName.indexOf('\\')) {
        return wireName;
    }

    const parts = [];
    let last = 0;
    ESCAPE_RE.lastIndex = 0;
    let m;
    while ((m = ESCAPE_RE.exec(wireName)) !== null) {
        if (m.index > last) {
            parts.push(Buffer.from(wireName.slice(last, m.index), 'utf8'));
        }
        parts.push(Buffer.from([parseInt(m[1] || m[2], 16)]));
        last = ESCAPE_RE.lastIndex;
    }
    if (last < wireName.length) {
        parts.push(Buffer.from(wireName.slice(last), 'utf8'));
    }

    const bytes = Buffer.concat(parts);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
        return bytes.toString('latin1');
    }
}

//
//  Is |name| (already decoded) a plain file name -- one that names a file
//  directly inside whatever directory it is joined to?
//
//  Refused:
//    * empty, or longer than MAX_NAME_BYTES
//    * a path separator of either kind, '/' or '\', or ':' (a drive or
//      stream separator on Windows). binkd's strwipe() treats exactly this
//      set, plus control characters, as unsafe in a stored name.
//    * NUL or any other C0 control character, or DEL
//    * a leading '.', which takes in '.' and '..' as well as hidden files
//
function isPlainFileName(name) {
    if ('string' !== typeof name || 0 === name.length) {
        return false;
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
        return false;
    }
    if ('.' === name[0]) {
        return false;
    }
    // eslint-disable-next-line no-control-regex
    return !/[/\\:\x00-\x1f\x7f]/.test(name);
}

//
//  A file name from the peer, reduced to a plain file name, or null when it
//  is not one. Decoding comes first, so an escaped separator is caught the
//  same as a literal one.
//
//  Refusing rather than rewriting (binkd replaces the unsafe characters
//  with '_') is deliberate: a conforming sender never produces such a name
//  -- binkd sends only the last component of its own path -- so there is no
//  real file name to recover, and a rewritten one could land on, or be
//  confused with, a different file.
//
function plainFileName(wireName) {
    const name = decodeWireName(wireName);
    return isPlainFileName(name) ? name : null;
}

module.exports = {
    MAX_NAME_BYTES,
    decodeWireName,
    isPlainFileName,
    plainFileName,
};
