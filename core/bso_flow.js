'use strict';

const fsp = require('fs/promises');
const paths = require('path');
const crypto = require('crypto');

//
//  Reading and rewriting BSO flow files (FTS-5005.003 sec. 3.1).
//
//  One parser and one rewrite for everything in ENiGMA that reads or edits a
//  flow file: the BinkP spool (queueing, the poller, marking lines sent), the
//  operator's "oputil bso" listing and prune, and the tosser's dequeue of a
//  superseded file. They used to carry five slightly different parsers and
//  three different ideas of when a flow file is finished with.
//
//  Flow files are bytes. Other software in a shared outbound may write paths
//  in CP437 or latin1, so a file is read as a Buffer and decoded latin1, one
//  byte to one character, and written back the same way: a line ENiGMA did
//  not change goes back exactly as it was, terminator included.
//
//  Line directives, as FTS-5005.003 and the mailers that implement it read
//  them:
//
//    ^  send, then delete the file        -  the same (optional alternate)
//    #  send, then truncate the file
//    @  send and keep (optional)          (none)  send and keep
//    ~  skip; already processed           !  the same (optional alternate)
//
//  Leading whitespace is dropped (BinkleyTerm wrote " path" for send and
//  keep), and so is trailing whitespace. Anything this does not understand
//  is left in the file untouched, is never sent, and keeps the flow file in
//  place: a flow file is only ever removed because of an edit ENiGMA made,
//  and only when nothing in it is still waiting.
//
//  Nothing here reads Config().
//

const DISPOSITIONS = {
    '^': 'delete',
    '-': 'delete',
    '#': 'truncate',
    '@': 'keep',
};

const SKIP_DIRECTIVES = ['~', '!'];

//  The directives that may be replaced by '~' with a single byte write.
const MARKABLE_IN_PLACE = ['^', '-', '#', '@'];

//  Longest line read as a path. binkd splits at MAXPATHLEN (4096); anything
//  longer is not a path any mailer agrees on.
const MAX_LINE_BYTES = 4096;

//  Temporary files for an atomic rewrite, in the flow file's own directory.
//  The leading dot and the extra dots keep them clear of every BSO name
//  pattern: binkd wants eight hex digits and one dot, ENiGMA's flow file and
//  point directory patterns do not match, and the name ends in none of .bsy,
//  .pkt, .tic, .req or a bundle day.
const TEMP_PREFIX = '.enigma-flow-';
const TEMP_SUFFIX = '.tmp';

//  Errors from creating the temporary file or renaming it over the original
//  that mean "not possible here" rather than "something is wrong": a
//  directory we may not create files in, or (Windows) a flow file another
//  program holds open. The rewrite is then done in place instead.
const IN_PLACE_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

//  Seams for tests.
const hooks = {
    getuid: () => ('function' === typeof process.getuid ? process.getuid() : undefined),
    getgid: () => ('function' === typeof process.getgid ? process.getgid() : undefined),
};

let cachedLog;
let cachedBase;
function log() {
    const base = require('./logger.js').log;
    if (base !== cachedBase) {
        cachedBase = base;
        cachedLog =
            base && 'function' === typeof base.child
                ? base.child({ subsystem: 'bso-flow' })
                : base;
    }
    return cachedLog;
}

//
//  A path as Node should see it: a string when the bytes are valid UTF-8
//  (Node's own encoding for file names), otherwise the bytes themselves.
//
function decodePath(latin1) {
    let ascii = true;
    for (let i = 0; i < latin1.length; i++) {
        if (latin1.charCodeAt(i) > 0x7f) {
            ascii = false;
            break;
        }
    }
    if (ascii) {
        return latin1;
    }
    const bytes = Buffer.from(latin1, 'latin1');
    const text = bytes.toString('utf8');
    return Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
}

function leadingSpace(s) {
    let i = 0;
    while (i < s.length && (' ' === s[i] || '\t' === s[i])) {
        i++;
    }
    return i;
}

function trailingSpaceStart(s) {
    let i = s.length;
    while (i > 0 && ' \t\r\v\f'.includes(s[i - 1])) {
        i--;
    }
    return i;
}

//
//  What the path part of a line is: absolute, a DOS path, a bare name
//  relative to the flow file's directory, or not something we take as a path.
//
function classifyBody(body) {
    if (0 === body.length) {
        return { kind: 'invalid', reason: 'no path' };
    }
    if ('/' === body[0]) {
        return { kind: 'send' };
    }
    if (/^[A-Za-z]:[\\/]/.test(body) || body.startsWith('\\\\')) {
        return { kind: 'send', dos: true };
    }
    if (/^[A-Za-z0-9._\x80-\xff]/.test(body)) {
        return { kind: 'send', relative: true };
    }
    return { kind: 'unknown', reason: 'unrecognised leading character' };
}

//
//  Parse one flow file line.
//
//  |raw| is the line as a latin1 string without its LF; a trailing CR is
//  taken to be part of the terminator. |eol| is the terminator that followed
//  it ('\n', or '' for a last line without one).
//
//  Returns:
//    raw, eol      the line and its terminator, exactly as read
//    text          the line without surrounding whitespace (latin1)
//    kind          'blank' | 'send' | 'skip' | 'unknown' | 'invalid'
//    directive     '^' '-' '#' '@' '~' '!' or '' (none)
//    disposition   'delete' | 'truncate' | 'keep', for 'send' lines
//    body          the text after the directive (latin1)
//    path          |body| for the filesystem: a string, or a Buffer when it
//                  is not valid UTF-8. Informational only for 'skip': a line
//                  binkd marked '~' over a leading '/' has lost it
//    relative      a bare name, meant relative to the flow file's directory
//    dos           a DOS path (C:\..., \\server\...)
//    reason        why a line is 'unknown' or 'invalid'
//    lead          offset of |text| within |raw|
//
function parseFlowLine(raw, eol = '') {
    if (raw.endsWith('\r')) {
        raw = raw.slice(0, -1);
        eol = `\r${eol}`;
    }

    const lead = leadingSpace(raw);
    const text = raw.slice(lead, Math.max(lead, trailingSpaceStart(raw)));

    const line = {
        raw,
        eol,
        text,
        kind: 'blank',
        directive: '',
        disposition: null,
        body: '',
        path: null,
        relative: false,
        dos: false,
        reason: null,
        lead,
    };

    if (0 === text.length) {
        return line;
    }

    if (text.length > MAX_LINE_BYTES) {
        line.kind = 'invalid';
        line.reason = `longer than ${MAX_LINE_BYTES} bytes`;
        return line;
    }

    if (/[\x00-\x1f]/.test(text)) {
        line.kind = 'invalid';
        line.reason = 'control character';
        return line;
    }

    const first = text[0];

    if (SKIP_DIRECTIVES.includes(first)) {
        line.kind = 'skip';
        line.directive = first;
        line.body = text.slice(1);
        line.path = line.body ? decodePath(line.body) : null;
        return line;
    }

    if (DISPOSITIONS[first]) {
        line.directive = first;
        line.body = text.slice(1);
    } else {
        line.body = text;
    }

    const classified = classifyBody(line.body);
    line.kind = classified.kind;
    line.reason = classified.reason || null;
    if ('send' === line.kind) {
        line.disposition = DISPOSITIONS[line.directive] || 'keep';
        line.path = decodePath(line.body);
        line.relative = Boolean(classified.relative);
        line.dos = Boolean(classified.dos);
    }

    return line;
}

//
//  Every line of a flow file, from its bytes. Blank lines are kept, so a
//  line's index is its position in the file. Each line also carries
//  |offset|, its first byte in |buf|.
//
function parseFlowBuffer(buf) {
    const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
    const lines = [];
    let pos = 0;
    while (pos < s.length) {
        const nl = s.indexOf('\n', pos);
        const end = nl < 0 ? s.length : nl;
        const line = parseFlowLine(s.slice(pos, end), nl < 0 ? '' : '\n');
        line.offset = pos;
        lines.push(line);
        pos = nl < 0 ? s.length : nl + 1;
    }
    return lines;
}

function serializeFlowLines(lines) {
    return Buffer.from(lines.map(l => `${l.raw}${l.eol}`).join(''), 'latin1');
}

//
//  |line| marked as processed: '~' and the path, the directive (if any)
//  dropped. The terminator is the line's own. Only a 'send' line changes.
//
function markedLine(line) {
    if ('send' !== line.kind) {
        return line;
    }
    return parseFlowLine(`~${line.body}`, line.eol);
}

//
//  Is anything in |lines| still waiting? A line to send is, and so is
//  anything not understood: content we cannot read is never thrown away.
//  Blank and skipped lines are not.
//
function flowHasLive(lines) {
    return lines.some(
        l => 'send' === l.kind || 'unknown' === l.kind || 'invalid' === l.kind
    );
}

function unreadableError(flowPath) {
    const err = new Error(
        `Flow file ${paths.basename(flowPath)} read back empty while it is not; treating it as unreadable`
    );
    err.code = 'EFLOWUNREADABLE';
    return err;
}

//
//  Read and parse |flowPath|: { st, buf, lines }. Throws as fs does (ENOENT
//  for no flow file). A file that reads back empty while its size says
//  otherwise is a read that raced a rewrite done in place by someone else,
//  and is reported as unreadable rather than as a flow file with nothing in
//  it -- the second answer lets a caller conclude nothing is owed.
//
async function readFlowFile(flowPath) {
    const fh = await fsp.open(flowPath, 'r');
    try {
        const st = await fh.stat();
        const buf = await fh.readFile();
        if (0 === buf.length && st.size > 0) {
            throw unreadableError(flowPath);
        }
        return { st, buf, lines: parseFlowBuffer(buf) };
    } finally {
        await fh.close().catch(() => {});
    }
}

//
//  Serialize work on one flow file within this process.
//
//  Marking a line is a whole-file read-modify-write, and a session that
//  ships several files for a node marks them concurrently. Without this the
//  last write wins and the other lines lose their '~': a payload kept in the
//  file base then looks unsent and is offered again every session. The .bsy
//  cannot help -- the session holds it throughout -- so this is an
//  in-process lock, keyed by path.
//
const flowWrites = new Map();

function withFlowFileWrite(flowPath, work) {
    const prev = flowWrites.get(flowPath) || Promise.resolve();
    const next = prev.then(work, work);

    flowWrites.set(flowPath, next);

    //  Drop the chain once it drains so a long-lived process does not keep an
    //  entry per flow file it ever touched.
    next.finally(() => {
        if (flowWrites.get(flowPath) === next) {
            flowWrites.delete(flowPath);
        }
    }).catch(() => {});

    return next;
}

//  Owned by someone else, and we are not root: renaming a new file over it
//  would hand it to us, and the owner (another mailer, as its own user) could
//  then no longer open it for writing.
function ownedByOther(st) {
    const uid = hooks.getuid();
    return 'number' === typeof uid && 0 !== uid && st.uid !== uid;
}

async function syncDir(dir) {
    let fh;
    try {
        fh = await fsp.open(dir, 'r');
        await fh.sync();
    } catch {
        //  Best effort; not every platform can open or sync a directory.
    } finally {
        if (fh) {
            await fh.close().catch(() => {});
        }
    }
}

//
//  Write |buf| to a new file beside |flowPath| and rename it over the
//  original, so a reader sees the old flow file or the new one and never a
//  half-written one. The new file gets the original's permissions and group.
//
async function replaceAtomically(flowPath, st, buf) {
    const dir = paths.dirname(flowPath);
    const tmpPath = paths.join(
        dir,
        `${TEMP_PREFIX}${paths.basename(flowPath)}.${process.pid}.${crypto
            .randomBytes(4)
            .toString('hex')}${TEMP_SUFFIX}`
    );
    const mode = st.mode & 0o7777;

    const fh = await fsp.open(tmpPath, 'wx', mode);
    try {
        await fh.writeFile(buf);
        //  open()'s mode is filtered through the umask; the original's is not.
        await fh.chmod(mode);

        const uid = hooks.getuid();
        if (0 === uid) {
            await fh.chown(st.uid, st.gid);
        } else if ('number' === typeof uid && st.gid !== hooks.getgid()) {
            //  Keeps a group-shared outbound's group, for a group we are in.
            await fh
                .chown(uid, st.gid)
                .catch(err =>
                    log().debug(
                        { path: flowPath, gid: st.gid, error: err.message },
                        'Could not give the rewritten flow file its group'
                    )
                );
        }

        await fh.sync();
    } catch (err) {
        await fh.close().catch(() => {});
        await fsp.unlink(tmpPath).catch(() => {});
        throw err;
    }
    await fh.close();

    try {
        await fsp.rename(tmpPath, flowPath);
    } catch (err) {
        await fsp.unlink(tmpPath).catch(() => {});
        throw err;
    }

    await syncDir(dir);
}

//
//  Rewrite the file where it is, keeping its inode, owner and mode. Not
//  atomic: written over the top and then cut to length, so a reader catching
//  it part way sees too much rather than too little.
//
async function rewriteInPlace(flowPath, buf) {
    const fh = await fsp.open(flowPath, 'r+');
    try {
        await fh.write(buf, 0, buf.length, 0);
        await fh.truncate(buf.length);
        await fh.sync();
    } finally {
        await fh.close().catch(() => {});
    }
}

//
//  Mark lines as binkd does: overwrite each directive byte with '~'. One
//  byte per line, in place, nothing else touched.
//
async function markInPlace(flowPath, lines, indices) {
    const fh = await fsp.open(flowPath, 'r+');
    try {
        const tilde = Buffer.from('~', 'latin1');
        for (const idx of indices) {
            const line = lines[idx];
            await fh.write(tilde, 0, 1, line.offset + line.lead);
        }
        await fh.sync();
    } finally {
        await fh.close().catch(() => {});
    }
}

const warnedInPlace = new Set();

function noteInPlace(flowPath, why) {
    if (warnedInPlace.has(flowPath)) {
        return;
    }
    if (warnedInPlace.size >= 1024) {
        warnedInPlace.clear();
    }
    warnedInPlace.add(flowPath);
    log().warn(
        { path: flowPath, reason: why },
        'Flow file rewritten in place rather than replaced; it belongs to another user or cannot be replaced here'
    );
}

async function writeEdited(flowPath, read, out, marked, removed) {
    const buf = serializeFlowLines(out);

    let why;
    if (ownedByOther(read.st)) {
        why = 'owned by another user';
    } else {
        try {
            await replaceAtomically(flowPath, read.st, buf);
            return 'replaced';
        } catch (err) {
            if (!IN_PLACE_FALLBACK_CODES.has(err.code)) {
                throw err;
            }
            why = err.code;
        }
    }

    noteInPlace(flowPath, why);

    //  Marking only, and every marked line has a directive byte to overwrite:
    //  binkd's way, one byte each. A line with no directive cannot be marked
    //  like that without losing the first character of its path.
    if (
        0 === removed.length &&
        marked.every(idx => MARKABLE_IN_PLACE.includes(read.lines[idx].directive))
    ) {
        await markInPlace(flowPath, read.lines, marked);
        return 'marked-in-place';
    }

    await rewriteInPlace(flowPath, buf);
    return 'rewritten-in-place';
}

async function rewriteLocked(flowPath, edit) {
    let read;
    try {
        read = await readFlowFile(flowPath);
    } catch (err) {
        if ('ENOENT' === err.code) {
            return { changed: false, missing: true, marked: [], removed: [] };
        }
        throw err;
    }

    const plan = edit(read.lines) || {};
    const valid = idx => Number.isInteger(idx) && idx >= 0 && idx < read.lines.length;

    const removedSet = new Set((plan.remove || []).filter(valid));
    const marked = Array.from(new Set(plan.mark || []))
        .filter(valid)
        .filter(idx => !removedSet.has(idx) && 'send' === read.lines[idx].kind)
        .sort((a, b) => a - b);
    const removed = Array.from(removedSet).sort((a, b) => a - b);

    if (0 === marked.length && 0 === removed.length) {
        return { changed: false, marked, removed, lines: read.lines };
    }

    const markedSet = new Set(marked);
    const out = [];
    read.lines.forEach((line, idx) => {
        if (removedSet.has(idx)) {
            return;
        }
        out.push(markedSet.has(idx) ? markedLine(line) : line);
    });

    if (!flowHasLive(out)) {
        try {
            await fsp.unlink(flowPath);
        } catch (err) {
            if ('ENOENT' !== err.code) {
                log().warn(
                    { path: flowPath, error: err.message },
                    'Could not remove a flow file with nothing left to send'
                );
                return { changed: false, marked: [], removed: [], lines: read.lines };
            }
        }
        log().debug(
            { path: flowPath, marked: marked.length, removed: removed.length },
            'Flow file finished with; removed'
        );
        return { changed: true, deleted: true, marked, removed, lines: read.lines };
    }

    const how = await writeEdited(flowPath, read, out, marked, removed);
    log().debug(
        { path: flowPath, marked: marked.length, removed: removed.length, how },
        'Flow file updated'
    );
    return { changed: true, deleted: false, how, marked, removed, lines: read.lines };
}

//
//  Edit |flowPath| under the caller's .bsy lock.
//
//  |edit(lines)| gets the file as it stands now, parsed, and returns
//  { mark: [index...], remove: [index...] } (or nothing, for no change). It
//  must check that what it meant to change is still there: the file may
//  have changed since the caller last looked.
//
//  Marked lines become '~' + path; removed lines go; every other line is
//  written back byte for byte. If nothing is waiting afterwards the flow file
//  is removed. Otherwise it is replaced atomically, or -- when it belongs to
//  another user, or cannot be replaced -- rewritten in place, by single byte
//  '~' overwrites when only marking.
//
//  Resolves { changed, deleted, missing, marked, removed, lines } with
//  |lines| as read (so callers can report what they removed).
//
function rewriteFlowFile(flowPath, edit) {
    return withFlowFileWrite(flowPath, () => rewriteLocked(flowPath, edit));
}

function isFlowTempFileName(name) {
    return String(name).startsWith(TEMP_PREFIX) && String(name).endsWith(TEMP_SUFFIX);
}

//
//  A path that is printable on an operator's terminal: control characters
//  shown as \xNN.
//
function printablePath(p) {
    const s = Buffer.isBuffer(p) ? p.toString('latin1') : String(p);
    return s.replace(
        /[\x00-\x1f\x7f]/g,
        c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
    );
}

module.exports = {
    MAX_LINE_BYTES,
    parseFlowLine,
    parseFlowBuffer,
    serializeFlowLines,
    markedLine,
    flowHasLive,
    readFlowFile,
    rewriteFlowFile,
    withFlowFileWrite,
    isFlowTempFileName,
    printablePath,
    //  for tests
    _hooks: hooks,
    _flowWrites: flowWrites,
};
