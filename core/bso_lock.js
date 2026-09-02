/* jslint node: true */
'use strict';

const Errors = require('./enig_error.js').Errors;

//  deps
const fsp = require('fs/promises');
const paths = require('path');

//
//  FTS-5005.003 §5.1 ".bsy" control files, shared by everything in this tree
//  that touches a BSO flow file.
//
//  The spec puts the requirement on *software*, not on mailers:
//
//      "A bsy is a main control file that must be used by any software
//       dealing with flow files in BSO. It is named the same way as the
//       flow file but with the extension '.bsy'.
//
//       Any software must check this file before doing any changes in flow
//       files. If a bsy file exists all changes are prohibited in any
//       corresponding flow files. [...] If a bsy file does not exist
//       software must create it, ensure that it was successfully created,
//       and then work with the flow files. After completing the job,
//       software must delete the bsy file."
//
//  Two subsystems here qualify, and both must use *this* module rather than
//  their own copy -- see issue #719 for what happens when the writer and the
//  reader each carry a private implementation of a BSO convention:
//
//    * core/scanner_tossers/ftn_bso.js -- appends refs to flow files
//    * core/binkp/bso_spool.js         -- rewrites them as entries are sent
//
//  Getting this right also buys interoperation with *external* mailers for
//  free. binkd and friends implement the same spec under the same filenames,
//  so a correct implementation interlocks with them without either side
//  knowing about the other. Note that the pre-existing "enigma.bsy" flag in
//  ftn_bso.js is NOT this: it is a non-FTS-5005 name in the outbound *root*,
//  so no external mailer has reason to interpret it.
//

//
//  Default age past which an unreleased lock is treated as orphaned.
//
//  FTS-5005.003 §5.1: "It is reasonable to ignore and delete bsy files with
//  an age more than the maximum estimated time of session multiplied on 2."
//  30 minutes is 6x our BinkP session timeout, which satisfies that with
//  room to spare.
//
const DEFAULT_STALE_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

//
//  How long a *writer* waits for a lock before giving up.
//
//  Contention is normally a sub-second flow file rewrite by a session that is
//  finishing an entry. It can also be a whole session, which may run minutes
//  -- and in that case deferring is the correct answer, not waiting: the spec
//  prohibits the change outright while the lock is held.
//
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
const ACQUIRE_RETRY_MS = 100;

//  Distinguishes "the node is busy, try later" from a real failure, so callers
//  can log it as a deferral rather than as corruption.
const ReasonCodes = {
    Busy: 'BSO_LOCK_BUSY',
};

//
//  The ".bsy" path for a flow file, per §5.1's "named the same way as the flow
//  file but with the extension '.bsy'".
//
//  This is deliberately derived from the flow file rather than rebuilt from an
//  address: it cannot drift from whatever naming the caller actually used, and
//  it lands in the same directory -- including a point's NNNNnnnn.pnt/
//  subdirectory, where the point's lock belongs.
//
function bsyPathForFlowFile(flowFilePath) {
    const ext = paths.extname(flowFilePath);
    const bsyExt =
        ext === ext.toUpperCase() && ext !== ext.toLowerCase() ? '.BSY' : '.bsy';
    return `${flowFilePath.slice(0, flowFilePath.length - ext.length)}${bsyExt}`;
}

//
//  The lock as it actually exists on disk, in whatever case it was written, or
//  null when there is none.
//
//  FTS-5005.003 §2 asks software to handle both upper and lower case BSO
//  filenames. An external mailer sharing this spool may have written the lock
//  under the other spelling; an exclusive create on our own spelling would not
//  collide with it and we would both believe we held it.
//
async function resolveExisting(bsyPath) {
    const dir = paths.dirname(bsyPath);
    const wanted = paths.basename(bsyPath).toLowerCase();

    let names;
    try {
        names = await fsp.readdir(dir);
    } catch (err) {
        if ('ENOENT' !== err.code) {
            throw err;
        }
        return null;
    }

    const actual = names.find(n => n.toLowerCase() === wanted);
    return actual ? paths.join(dir, actual) : null;
}

//
//  True when the lock at |bsyPath| was older than |staleMaxAgeMs| and has been
//  removed -- or was already gone, since either way the slot is now free.
//  False when it is still fresh, or when we could not confidently reap it.
//
async function reapIfStale(bsyPath, staleMaxAgeMs, log) {
    let stat;
    try {
        stat = await fsp.stat(bsyPath);
    } catch (err) {
        return 'ENOENT' === err.code;
    }

    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs <= staleMaxAgeMs) {
        return false;
    }

    try {
        await fsp.unlink(bsyPath);
        log && log.info({ path: bsyPath, ageMs }, 'Reaped stale .bsy lock');
        return true;
    } catch (err) {
        if ('ENOENT' === err.code) {
            return true;
        }
        log &&
            log.warn(
                { path: bsyPath, error: err.message },
                'Could not reap stale .bsy lock'
            );
        return false;
    }
}

//
//  Take the lock at |bsyPath|. Resolves true on success, false when it is held
//  by someone else; rejects only on unexpected filesystem errors.
//
//  §5.1 warns specifically about this:
//
//      "The most common way to create a file in many languages (eg. ReWrite,
//       fopen) also quietly overwrites an existing file, so there's a race
//       condition between checking, creating and checking. Care must be taken
//       to use the right function and/or the right options."
//
//  Hence 'wx' -- exclusive create -- and never a plain write.
//
async function acquire(bsyPath, options = {}) {
    const staleMaxAgeMs = _staleMaxAgeMs(options);
    const log = options.log;

    await fsp.mkdir(paths.dirname(bsyPath), { recursive: true });

    const tryCreate = async () => {
        const fh = await fsp.open(bsyPath, 'wx');
        await fh.writeFile(String(process.pid)); //  §5.1: "may contain one line of PID information"
        await fh.close();
    };

    //  Someone else's spelling of the same lock counts as held.
    const existing = await resolveExisting(bsyPath);
    if (
        existing &&
        existing !== bsyPath &&
        !(await reapIfStale(existing, staleMaxAgeMs, log))
    ) {
        return false;
    }

    try {
        await tryCreate();
        return true;
    } catch (err) {
        if ('EEXIST' !== err.code) {
            throw err;
        }
    }

    //  Present. Reap if it looks orphaned, then retry once.
    if (!(await reapIfStale(bsyPath, staleMaxAgeMs, log))) {
        return false;
    }

    try {
        await tryCreate();
        return true;
    } catch (err) {
        if ('EEXIST' === err.code) {
            return false;
        }
        throw err;
    }
}

//  Release the lock. Never throws: a lock we cannot remove is reaped later by
//  age, and failing a completed job over it would be worse.
async function release(bsyPath) {
    await fsp.unlink(bsyPath).catch(() => {});
}

//
//  Acquire with bounded retry, for callers that want to *do* something rather
//  than poll. Resolves true if taken, false if still held when time ran out.
//
async function acquireWithRetry(bsyPath, options = {}) {
    const timeoutMs = _finite(options.timeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        if (await acquire(bsyPath, options)) {
            return true;
        }

        if (Date.now() >= deadline) {
            return false;
        }

        await new Promise(r => setTimeout(r, ACQUIRE_RETRY_MS));
    }
}

//
//  Callback-style "do this while holding the flow file's lock", for ftn_bso.
//
//  |work| is called as work(done). The lock is released on every path,
//  including a throw out of |work|.
//
//  Calls back Errors.General(..., ReasonCodes.Busy) when the lock could not be
//  taken in time. That is a deferral, not corruption: the caller's refs were
//  not written and the spec says they must not be.
//
function withFlowFileLock(flowFilePath, options, work, cb) {
    if ('function' === typeof options) {
        cb = work;
        work = options;
        options = {};
    }

    const bsyPath = bsyPathForFlowFile(flowFilePath);

    acquireWithRetry(bsyPath, options).then(
        got => {
            if (!got) {
                return cb(
                    Errors.General(
                        `Flow file ${paths.basename(flowFilePath)} is locked by another session`,
                        ReasonCodes.Busy
                    )
                );
            }

            let finished = false;
            const done = err => {
                if (finished) {
                    return; //  |work| called back twice; ignore the second
                }
                finished = true;
                release(bsyPath).then(() => cb(err));
            };

            try {
                work(done);
            } catch (err) {
                done(err);
            }
        },
        err => cb(err)
    );
}

function isBusyError(err) {
    return !!err && ReasonCodes.Busy === err.reasonCode;
}

function _finite(value, fallback) {
    return 'number' === typeof value && isFinite(value) && value >= 0 ? value : fallback;
}

function _staleMaxAgeMs(options) {
    return _finite(options.staleMaxAgeMs, DEFAULT_STALE_LOCK_MAX_AGE_MS);
}

module.exports = {
    DEFAULT_STALE_LOCK_MAX_AGE_MS,
    DEFAULT_ACQUIRE_TIMEOUT_MS,
    ReasonCodes,
    bsyPathForFlowFile,
    resolveExisting,
    reapIfStale,
    acquire,
    acquireWithRetry,
    release,
    withFlowFileLock,
    isBusyError,
};
