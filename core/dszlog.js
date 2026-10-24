/* jslint node: true */
'use strict';

//  deps
const paths = require('path');
const fs = require('graceful-fs');
const async = require('async');

//
//  DSZLOG: the per-file result log DSZ introduced and other X/Y/ZModem
//  programs copied. When the DSZLOG environment variable names a file, the
//  protocol program writes one line to it for every file it finishes, good or
//  bad, so a caller can tell which files of a batch actually arrived.
//
//  ENiGMA uses it to salvage uploads. A protocol program's exit code covers
//  the whole session, and some senders end a batch badly after the last file
//  has already been received and saved: VTX's YModem sender, for one, answers
//  the final ACK with CAN bytes instead of the end-of-batch block, and sexyz
//  exits 1 with the file complete on disk. The log says which files made it.
//
//  Line format, as written by SEXYZ (sexyz.c receive_files()):
//
//      "%c %6lld %5u bps %4lld cps %3u errors %5u %4u %s %ld\n"
//       code bytes 115200   cps      errors   flows block filename serial
//
//  e.g. "R  12345 115200 bps 6172 cps   0 errors     0 1024 /tmp/enigul-x/FOO.ZIP -1"
//
//  The filename is the path the file was written to: the receive directory as
//  given on the command line plus the sender's name with any directory
//  stripped. sexyz.ini can instead ask for the bare name ([DSZLOG] Path=false)
//  or for the name in double quotes ([DSZLOG] Quotes=true, or -quotes). It is
//  never escaped, so it may contain spaces; the serial number is always the
//  last field.
//
//  Debian and Ubuntu patch lrzsz to write the same format (upstream lrzsz has
//  no DSZLOG support). Their rz logs the name relative to its working
//  directory, and ends lines with CRLF.
//
const LINE_RE =
    /^(\S)\s+(\d+)\s+(\d+)\s+bps\s+(\d+)\s+cps\s+(\d+)\s+errors\s+(\d+)\s+(\d+)\s+(.+?)\s+(-?\d+)\s*$/;

//
//  Codes that mean "this file was received". Only receive logs are read, so
//  the set is what receivers write on success:
//
//      R   X/YModem, sexyz and lrzsz rz
//      Z   ZModem, sexyz
//      z   ZModem, Debian lrzsz rz
//
//  Everything else is not a success: E (error, both), L (rz killed by a
//  signal), and anything unrecognised. (sexyz's S/z/s are send-side codes.)
//
const ReceivedOkCodes = ['R', 'Z', 'z'];

function isReceivedOk(code) {
    return ReceivedOkCodes.includes(code);
}

//
//  Parse DSZLOG text into entries. Lines that do not match the format are
//  skipped rather than guessed at.
//
function parseDszLog(text) {
    if (!text) {
        return [];
    }

    const entries = [];
    String(text)
        .split(/\r?\n/)
        .forEach(line => {
            const m = LINE_RE.exec(line);
            if (!m) {
                return;
            }

            let fileName = m[8];
            if (
                fileName.length > 1 &&
                fileName.startsWith('"') &&
                fileName.endsWith('"')
            ) {
                fileName = fileName.slice(1, -1);
            }

            entries.push({
                code: m[1],
                ok: isReceivedOk(m[1]),
                bytes: parseInt(m[2], 10),
                cps: parseInt(m[4], 10),
                errors: parseInt(m[5], 10),
                blockSize: parseInt(m[7], 10),
                fileName,
                serial: parseInt(m[9], 10),
            });
        });

    return entries;
}

//
//  Which files does the log say were received into |recvDirectory|?
//
//  The filename in the log ultimately comes from the remote sender, so it is
//  never trusted to name a path: a relative name is resolved against
//  |recvDirectory| (the program's working directory), and the result must be
//  a direct child of |recvDirectory|. Anything else -- "..", a subdirectory,
//  an absolute path elsewhere -- is rejected.
//
//  A file that appears more than once is judged by its last entry: a file
//  received and then sent again over the top, unsuccessfully, is not good.
//
//  Returns { received: [ { path, bytes } ], rejected: [ { fileName, reason } ] }.
//
function receivedFilesFromEntries(entries, recvDirectory) {
    const recvDir = paths.resolve(recvDirectory);
    const byPath = new Map();
    const rejected = [];

    (entries || []).forEach(entry => {
        const fileName = entry.fileName;
        if (!fileName || fileName.includes('\0')) {
            return rejected.push({ fileName, reason: 'invalid name' });
        }

        const fullPath = paths.resolve(recvDir, fileName);
        if (paths.dirname(fullPath) !== recvDir) {
            return rejected.push({ fileName, reason: 'outside receive directory' });
        }

        //  delete first so a re-entry moves to the end, keeping log order
        byPath.delete(fullPath);
        byPath.set(fullPath, entry);
    });

    const received = [];
    byPath.forEach((entry, fullPath) => {
        if (entry.ok) {
            received.push({ path: fullPath, bytes: entry.bytes });
        } else {
            rejected.push({ fileName: entry.fileName, reason: `status ${entry.code}` });
        }
    });

    return { received, rejected };
}

//
//  Confirm candidates from receivedFilesFromEntries() against the disk: each
//  must be a regular file (not a symlink) of exactly the size the log
//  recorded. Calls back (err, { confirmed: [ path ], rejected: [ ... ] }).
//
function confirmReceivedFiles(candidates, cb) {
    const confirmed = [];
    const rejected = [];

    async.eachSeries(
        candidates || [],
        (candidate, next) => {
            fs.lstat(candidate.path, (err, stats) => {
                if (err) {
                    rejected.push({
                        fileName: candidate.path,
                        reason: err.code || 'stat failed',
                    });
                } else if (!stats.isFile()) {
                    rejected.push({
                        fileName: candidate.path,
                        reason: 'not a regular file',
                    });
                } else if (stats.size !== candidate.bytes) {
                    rejected.push({
                        fileName: candidate.path,
                        reason: `size ${stats.size} does not match logged ${candidate.bytes}`,
                    });
                } else {
                    confirmed.push(candidate.path);
                }
                return next(null);
            });
        },
        () => {
            return cb(null, { confirmed, rejected });
        }
    );
}

//
//  The environment for a protocol program that should write a DSZLOG.
//
//  node-pty uses process.env when given no |env|, minus a few variables that
//  would mislead a program about its terminal -- but it only strips them when
//  handed process.env itself. Passing a copy skips that, so it is repeated
//  here (node-pty lib/unixTerminal.js, _sanitizeEnv()).
//
const PtySanitizedEnvVars = [
    'TMUX',
    'TMUX_PANE',
    'STY',
    'WINDOW',
    'WINDOWID',
    'TERMCAP',
    'COLUMNS',
    'LINES',
];

function buildProtocolEnv(baseEnv, dszLogPath) {
    const env = Object.assign({}, baseEnv);
    PtySanitizedEnvVars.forEach(name => delete env[name]);
    env.DSZLOG = dszLogPath;
    return env;
}

module.exports = {
    ReceivedOkCodes,
    isReceivedOk,
    parseDszLog,
    receivedFilesFromEntries,
    confirmReceivedFiles,
    buildProtocolEnv,
};
