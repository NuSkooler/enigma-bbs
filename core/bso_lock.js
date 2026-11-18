/* jslint node: true */
'use strict';

const Errors = require('./enig_error.js').Errors;

//  deps
const crypto = require('crypto');
const fs = require('fs');
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
    //  A flow file edit was attempted without holding its .bsy. A bug in the
    //  caller, not a condition to retry: see assertFlowFileLockHeld().
    NotHeld: 'BSO_LOCK_NOT_HELD',
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
//  What a lock says, and who wrote it.
//
//  FTS-5005.003 §5.1: a bsy "may contain one line of PID information". Ours
//  is one line that starts with the PID, so anything reading it as a number
//  still gets the PID:
//
//      <pid> ENiGMA <hostId> <token>
//
//  |token| is new for every lock taken, so a holder can tell its own lock
//  from one that replaced it at the same path (release() and the refresh
//  check it). |hostId| names this kernel boot and this PID namespace, the
//  only scope in which the PID can be checked: see lockHostId().
//
//  binkd and other mailers only test whether a bsy exists; none of them
//  reads what is in it. A lock that is not in exactly this form -- an older
//  ENiGMA's bare PID, binkd's, an empty file -- is a foreign lock, and is
//  only ever reaped by age.
//
const LOCK_CONTENT_RE = /^(\d+) ENiGMA ([0-9a-f]{12}|-) ([0-9a-f]{16})\r?\n?$/;

//  The longest content worth reading: §5.1 keeps the line short.
const LOCK_CONTENT_MAX_BYTES = 256;

//
//  A lock in our form is touched at least this often while held (more often
//  with a short stale age), and is treated as orphaned once it has gone
//  untouched for min(stale age, NOT_REFRESHED_MAX_AGE_MS): several missed
//  touches. Foreign locks keep the full stale age; nothing promises they are
//  refreshed. binkd touches its own every 60 s as well.
//
const REFRESH_MAX_INTERVAL_MS = 60 * 1000;
const NOT_REFRESHED_MAX_AGE_MS = 5 * 60 * 1000;
const MIN_REFRESH_INTERVAL_MS = 10;

//  How long release() waits before reading a lock it could not read again.
const RELEASE_RETRY_MS = 50;

let hostIdCache = null;

//
//  This kernel boot and this PID namespace, hashed, or '-' when either cannot
//  be read (anything but Linux, or a sandbox that hides them).
//
//  A PID in a lock can only be checked with kill(pid, 0) by a process on the
//  same boot in the same PID namespace. A hostname cannot say that: two
//  containers sharing an outbound can have the same one, each with its own
//  PID 1. The hash keeps the line short and says nothing about the machine.
//
function lockHostId() {
    if (null === hostIdCache) {
        try {
            const bootId = fs
                .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
                .trim();
            const pidNs = fs.readlinkSync('/proc/self/ns/pid');
            hostIdCache =
                bootId && pidNs
                    ? crypto
                          .createHash('sha256')
                          .update(`${bootId}\n${pidNs}`)
                          .digest('hex')
                          .slice(0, 12)
                    : '-';
        } catch (err) {
            hostIdCache = '-';
        }
    }
    return hostIdCache;
}

function newLockContent() {
    return `${process.pid} ENiGMA ${lockHostId()} ${crypto
        .randomBytes(8)
        .toString('hex')}\n`;
}

//  { pid, hostId, token } for a lock in our form, else null.
function parseLockContent(content) {
    const m = 'string' === typeof content ? LOCK_CONTENT_RE.exec(content) : null;
    return m ? { pid: parseInt(m[1], 10), hostId: m[2], token: m[3] } : null;
}

//  The lock's content, or null when there is no lock (ENOENT). Rejects when it
//  cannot be read: that says nothing about whose it is.
async function readLockContent(bsyPath) {
    let fh;
    try {
        fh = await fsp.open(bsyPath, 'r');
        const buf = Buffer.alloc(LOCK_CONTENT_MAX_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.toString('utf8', 0, bytesRead);
    } catch (err) {
        if ('ENOENT' === err.code) {
            return null;
        }
        throw err;
    } finally {
        if (fh) {
            await fh.close().catch(() => {});
        }
    }
}

//  False only when |pid| is certainly not running. EPERM means it runs as
//  someone else.
function pidRunning(pid) {
    //  0 and negative PIDs name process groups; never ask about those.
    if (!Number.isInteger(pid) || pid < 1) {
        return true;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return 'ESRCH' !== err.code;
    }
}

function notRefreshedMaxAgeMs(staleMaxAgeMs) {
    return Math.min(staleMaxAgeMs, NOT_REFRESHED_MAX_AGE_MS);
}

//
//  How long a held lock may go without a successful refresh before this
//  process stops counting on it: half the age at which others reap it, so
//  it is given up well before anyone else could take it.
//
function refreshGiveUpMs(staleMaxAgeMs) {
    return Math.floor(notRefreshedMaxAgeMs(staleMaxAgeMs) / 2);
}

function refreshIntervalMs(options) {
    const explicit = options.refreshMs;
    if ('number' === typeof explicit && isFinite(explicit) && explicit > 0) {
        return Math.max(MIN_REFRESH_INTERVAL_MS, explicit);
    }
    return Math.max(
        MIN_REFRESH_INTERVAL_MS,
        Math.min(
            REFRESH_MAX_INTERVAL_MS,
            Math.floor(notRefreshedMaxAgeMs(_staleMaxAgeMs(options)) / 5)
        )
    );
}

//
//  Every lock this process holds: lockKey -> entry
//
//      { key, path, content, pending, created, releasing, refreshing,
//        refreshMs, refreshedAt, giveUpMs, onLost, log }
//
//  |pending| while the lock file is being created and written, |releasing|
//  while it is being removed: it is ours throughout, so nothing else in the
//  process may take or reap it.
//
//  |created| once our exclusive create has succeeded (the file is ours even
//  before it is written); |refreshedAt| when it was last written or touched.
//
//  The registry is per instance of this module: loading it twice in one
//  process (two copies of the file, or worker threads, which each get their
//  own) makes two registries that do not know each other's locks, and the
//  same-PID rule in reapReason() would then reap a live lock. Use it from the
//  main thread only, through one require().
//
//  This is what makes a lock ours. A second holder in this process is refused
//  without looking at the lock's age; release() only removes a file whose
//  content is still what we wrote; and the refresh keeps every lock here
//  fresh for everyone else.
//
const heldLocks = new Map();
let refreshTimer = null;
let refreshTimerMs = 0;
let exitHookInstalled = false;
const noneHeldWaiters = new Set();

function heldChanged() {
    scheduleRefresh();
    if (0 === heldLocks.size) {
        for (const resolve of noneHeldWaiters) {
            resolve(true);
        }
        noneHeldWaiters.clear();
    }
}

//  One timer for the whole process, at the shortest interval any held lock
//  needs. unref()'d: a held lock never keeps the process alive.
function scheduleRefresh() {
    let wantMs = 0;
    for (const entry of heldLocks.values()) {
        if (!wantMs || entry.refreshMs < wantMs) {
            wantMs = entry.refreshMs;
        }
    }
    if (refreshTimer && wantMs === refreshTimerMs) {
        return;
    }
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
        refreshTimerMs = 0;
    }
    if (wantMs) {
        refreshTimer = setInterval(() => {
            refreshHeldNow().catch(() => {});
        }, wantMs);
        refreshTimer.unref();
        refreshTimerMs = wantMs;
    }
}

//
//  The lock in |entry| is no longer ours: deleted, or replaced by another
//  holder. Forget it, so nothing goes on believing it holds it (a FlowLockSet
//  drops it, and its flow files are then refused), and say so.
//
function lockLost(entry, why) {
    if (heldLocks.get(entry.key) !== entry) {
        return;
    }
    heldLocks.delete(entry.key);
    entry.log &&
        entry.log.warn(
            { path: entry.path, reason: why },
            'Held .bsy lock is no longer ours; its flow files will not be changed'
        );
    try {
        entry.onLost && entry.onLost();
    } catch (err) {
        //  a holder's callback must not stop the others
    }
    heldChanged();
}

//
//  Touch one held lock, through a handle on the file we checked, so a file
//  that replaced ours in between is never the one touched.
//
//  The touch writes the lock's own bytes back over themselves rather than
//  setting a time: the content never changes (a reader sees the same line
//  before, during and after), and the new mtime is the one the filesystem
//  assigns -- on NFS the server's clock, as when the lock was created -- so
//  only the reaper's clock against the server's matters, not ours.
//
async function refreshOne(entry) {
    let fh;
    try {
        fh = await fsp.open(entry.path, 'r+');
    } catch (err) {
        if ('ENOENT' === err.code) {
            return lockLost(entry, 'removed');
        }
        entry.log &&
            entry.log.warn(
                { path: entry.path, error: err.message },
                'Could not refresh held .bsy lock'
            );
        return;
    }
    try {
        const buf = Buffer.alloc(LOCK_CONTENT_MAX_BYTES);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        if (heldLocks.get(entry.key) !== entry || entry.releasing) {
            return; //  being released meanwhile
        }
        if (buf.toString('utf8', 0, bytesRead) !== entry.content) {
            return lockLost(entry, 'replaced');
        }
        const bytes = Buffer.from(entry.content);
        await fh.write(bytes, 0, bytes.length, 0);
        entry.refreshedAt = Date.now();
    } catch (err) {
        entry.log &&
            entry.log.warn(
                { path: entry.path, error: err.message },
                'Could not refresh held .bsy lock'
            );
    } finally {
        await fh.close().catch(() => {});
    }
}

//
//  Touch every lock this process holds, now. A lock whose last touch is still
//  running (a slow filesystem) is not touched twice; one that hangs holds up
//  only itself. Resolves when every touch started or joined here is done.
//
function refreshHeldNow() {
    const running = [];
    for (const entry of Array.from(heldLocks.values())) {
        if (entry.pending || entry.releasing) {
            continue;
        }
        //  Not refreshed for too long (a touch that hangs, or fails every
        //  time): soon anyone may reap it, so stop relying on it now.
        if (Date.now() - entry.refreshedAt > entry.giveUpMs) {
            lockLost(entry, 'could not be refreshed');
            continue;
        }
        if (!entry.refreshing) {
            entry.refreshing = refreshOne(entry)
                .catch(() => {})
                .then(() => {
                    entry.refreshing = null;
                });
        }
        running.push(entry.refreshing);
    }
    return Promise.all(running).then(() => {});
}

//
//  Remove every lock this process still holds, synchronously, as it exits.
//  A process that is exiting holds nothing, so this is always right; only
//  files still carrying our content are removed. Covers process.exit() from
//  anywhere, including the shutdown safety timer. Not a crash or SIGKILL:
//  reapIfStale() handles those.
//
function releaseHeldSync() {
    for (const entry of Array.from(heldLocks.values())) {
        heldLocks.delete(entry.key);
        if (entry.pending && !entry.created) {
            continue; //  not created by us (yet): whatever is there is not ours
        }
        try {
            const content = fs.readFileSync(entry.path, 'utf8');
            //  Created but not (fully) written yet: still ours.
            const ours = entry.pending
                ? entry.content.startsWith(content)
                : content === entry.content;
            if (ours) {
                fs.unlinkSync(entry.path);
            }
        } catch (err) {
            //  gone already, or cannot be read and so not known to be ours
        }
    }
    heldChanged();
}

function installExitHook() {
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.on('exit', releaseHeldSync);
    }
}

//  How many locks this process holds.
function heldCount() {
    return heldLocks.size;
}

//
//  Resolves true once this process holds no lock, or false after |timeoutMs|.
//  Held locks that have gone (removed or replaced underneath us) are dropped
//  first, so they cannot hold this up. Never rejects.
//
async function whenNoneHeld(timeoutMs) {
    //  Drops what has gone. Not awaited: a touch stuck on a slow filesystem
    //  must not hold this past its timeout.
    refreshHeldNow().catch(() => {});
    if (0 === heldLocks.size) {
        return true;
    }
    return new Promise(resolve => {
        let timer = null;
        const done = result => {
            clearTimeout(timer);
            noneHeldWaiters.delete(done);
            resolve(result);
        };
        noneHeldWaiters.add(done);
        timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
    });
}

//
//  Why the lock at |bsyPath| may be reaped, or null when it must be left.
//
//    * one this process holds: never.
//    * ours, written on this boot in this PID namespace (lockHostId()), by a
//      process that is not running -- or that had our own PID, which in the
//      same namespace means a process before us: at once.
//    * ours, untouched for min(stale age, NOT_REFRESHED_MAX_AGE_MS): its
//      holder stopped refreshing it.
//    * any lock, untouched for the stale age (FTS-5005.003 §5.1).
//
//  Foreign locks are never judged by their PID: their writer may be on
//  another machine or in another namespace, and nothing promises they are
//  refreshed.
//
function reapReason(content, ageMs, staleMaxAgeMs) {
    const lock = parseLockContent(content);
    if (lock) {
        const hostId = lockHostId();
        if ('-' !== hostId && lock.hostId === hostId) {
            if (lock.pid === process.pid) {
                //  Not in our registry (reapIfStale() checked), so not ours:
                //  true only while this module is loaded once per process.
                //  See heldLocks.
                return 'written by an earlier process with this PID';
            }
            if (!pidRunning(lock.pid)) {
                return 'holder process is not running';
            }
        }
        if (ageMs > notRefreshedMaxAgeMs(staleMaxAgeMs)) {
            return 'not refreshed by its holder';
        }
    }
    return ageMs > staleMaxAgeMs ? 'older than the stale age' : null;
}

//
//  True when the lock at |bsyPath| has been removed as orphaned -- or was
//  already gone, since either way the slot is now free. False when it is
//  still in use (see reapReason()), or when we could not confidently reap it.
//
async function reapIfStale(bsyPath, staleMaxAgeMs, log) {
    const entry = heldLocks.get(lockKey(bsyPath));
    if (entry) {
        if (entry.pending || entry.releasing) {
            return false;
        }
        let mine;
        try {
            mine = await readLockContent(entry.path);
        } catch (err) {
            return false; //  cannot tell; ours as far as we know
        }
        if (mine === entry.content) {
            return false; //  ours, and in use
        }
        lockLost(entry, null === mine ? 'removed' : 'replaced');
    }

    let stat;
    try {
        stat = await fsp.stat(bsyPath);
    } catch (err) {
        return 'ENOENT' === err.code;
    }

    //  A lock that cannot be read is judged as a foreign one: by age alone.
    let content = null;
    let unreadable = false;
    try {
        content = await readLockContent(bsyPath);
        if (null === content) {
            return true; //  gone since the stat
        }
    } catch (err) {
        unreadable = true;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    const reason = reapReason(content, ageMs, staleMaxAgeMs);
    if (!reason) {
        return false;
    }

    //  Someone may have reaped and replaced it since we looked; then it is
    //  not the lock we judged.
    if (unreadable) {
        let now;
        try {
            now = await fsp.stat(bsyPath);
        } catch (err) {
            return 'ENOENT' === err.code;
        }
        if (now.ino !== stat.ino || now.mtimeMs !== stat.mtimeMs) {
            return false;
        }
    } else {
        let now;
        try {
            now = await readLockContent(bsyPath);
        } catch (err) {
            return false;
        }
        if (null === now) {
            return true;
        }
        if (now !== content) {
            return false;
        }
    }

    try {
        await fsp.unlink(bsyPath);
        log && log.info({ path: bsyPath, ageMs, reason }, 'Reaped orphaned .bsy lock');
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
//  by someone else -- including by anything else in this process; rejects only
//  on unexpected filesystem errors.
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
//  With |options.createDir| false the lock's directory is not created, and a
//  missing one rejects with ENOENT.
//
//  While held, the lock is touched every |options.refreshMs| (by default a
//  minute, or less with a short stale age). |options.onLost| is called if it
//  is found removed or replaced while held; it is then no longer held.
//
async function acquire(bsyPath, options = {}) {
    const staleMaxAgeMs = _staleMaxAgeMs(options);
    const log = options.log;
    const key = lockKey(bsyPath);

    //  Held in this process already: by whom does not matter, it is in use.
    //  Unless it has gone from under us, in which case it is not held at all.
    const mine = heldLocks.get(key);
    if (mine) {
        if (mine.pending || mine.releasing) {
            return false;
        }
        let onDisk;
        try {
            onDisk = await readLockContent(mine.path);
        } catch (err) {
            return false; //  cannot tell: still ours as far as we know
        }
        if (onDisk === mine.content) {
            return false;
        }
        lockLost(mine, null === onDisk ? 'removed' : 'replaced');
    }

    if (false !== options.createDir) {
        await fsp.mkdir(paths.dirname(bsyPath), { recursive: true });
    }

    //  Resolves false when something else in this process got there first.
    //  The entry goes in before the file is created, so nothing else here can
    //  see the file without seeing that it is ours. A lock created but not
    //  written is removed again: an error here rejects, and nobody would
    //  release it.
    const tryCreate = async () => {
        if (heldLocks.has(key)) {
            return false;
        }
        const entry = {
            key,
            path: bsyPath,
            content: newLockContent(),
            pending: true,
            created: false,
            refreshMs: refreshIntervalMs(options),
            giveUpMs: refreshGiveUpMs(staleMaxAgeMs),
            refreshedAt: Date.now(),
            onLost: options.onLost,
            log,
        };
        heldLocks.set(key, entry);

        let fh;
        try {
            fh = await fsp.open(bsyPath, 'wx');
        } catch (err) {
            heldLocks.delete(key);
            heldChanged();
            throw err;
        }
        entry.created = true;
        let written = false;
        try {
            await fh.writeFile(entry.content);
            written = true;
        } finally {
            await fh.close().catch(() => {});
            if (!written) {
                await fsp.unlink(bsyPath).catch(() => {});
                heldLocks.delete(key);
                heldChanged();
            }
        }
        entry.pending = false;
        entry.refreshedAt = Date.now();
        installExitHook();
        heldChanged();
        return true;
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
        return await tryCreate();
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
        return await tryCreate();
    } catch (err) {
        if ('EEXIST' === err.code) {
            return false;
        }
        throw err;
    }
}

//
//  Release a lock this process took with acquire(). Only a file still holding
//  what we wrote is removed: if the lock was reaped and taken by another
//  holder meanwhile, that holder's lock stays. Releasing a lock this process
//  does not hold does nothing.
//
//  Never throws: a lock we cannot remove is reaped later, and failing a
//  completed job over it would be worse.
//
async function release(bsyPath) {
    const key = lockKey(bsyPath);
    const entry = heldLocks.get(key);
    if (!entry || entry.pending || entry.releasing) {
        return;
    }
    //  Still ours (and still counted, for whenNoneHeld()) until the file is
    //  gone; the refresh leaves it alone meanwhile.
    entry.releasing = true;
    try {
        let content;
        try {
            content = await readLockContent(entry.path);
        } catch (err) {
            //  Once more, in case it was passing (EMFILE, a network
            //  filesystem hiccup); never removed unread, since it might be
            //  another holder's by now.
            await new Promise(r => setTimeout(r, RELEASE_RETRY_MS));
            try {
                content = await readLockContent(entry.path);
            } catch (err2) {
                entry.log &&
                    entry.log.warn(
                        { path: entry.path, error: err2.message },
                        'Could not read our .bsy lock to release it; leaving it to be reaped'
                    );
                return;
            }
        }
        if (null !== content && content !== entry.content) {
            entry.log &&
                entry.log.info(
                    { path: entry.path },
                    '.bsy lock was replaced by another holder; leaving it in place'
                );
        } else if (null !== content) {
            await fsp.unlink(entry.path).catch(() => {});
        }
    } finally {
        if (heldLocks.get(key) === entry) {
            heldLocks.delete(key);
            heldChanged();
        }
    }
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
//  The identity of a lock for comparison: its directory, resolved, plus its
//  name in lower case. FTS-5005.003 §2 lets the same lock be spelled in
//  either case (see resolveExisting()), so 00680001.BSY and 00680001.bsy are
//  one lock. Directory names are compared as given (after resolving): a
//  point directory is found by the scan under the spelling it has on disk.
//
function lockKey(bsyPath) {
    return paths.join(
        paths.resolve(paths.dirname(bsyPath)),
        paths.basename(bsyPath).toLowerCase()
    );
}

//  Lock sets created by this module. Only these count as proof that a lock
//  is held: an object that merely looks like one does not.
const issuedLockSets = new WeakSet();

//
//  A set of .bsy locks held together -- for a session, every lock covering
//  the flow files it reads and rewrites; for a one-off edit, the one beside
//  the flow file. It is also the token rewriteFlowFile() checks: an edit is
//  only made while the set holds the lock beside that flow file.
//
//  acquire() is all or nothing, and re-entrant: a lock the set already holds
//  is not taken again (so the same lock reached two ways -- two spellings of
//  one address, say -- cannot make a session busy against itself).
//
class FlowLockSet {
    constructor(options = {}) {
        this._options = options;
        this._held = new Map(); //  lockKey -> path as created
        //  acquire() calls on one set run one at a time, so two of them
        //  reaching the same lock do not race each other for it.
        this._acquiring = Promise.resolve();
        this._closed = false;
        issuedLockSets.add(this);
    }

    holds(bsyPath) {
        return this._held.has(lockKey(bsyPath));
    }

    holdsFlowFile(flowFilePath) {
        return this.holds(bsyPathForFlowFile(flowFilePath));
    }

    get paths() {
        return Array.from(this._held.values());
    }

    get size() {
        return this._held.size;
    }

    get closed() {
        return this._closed;
    }

    //
    //  Take every lock in |bsyPaths| not already held. Resolves true when the
    //  set then holds them all. Resolves false when one is held elsewhere, or
    //  the set is (or gets) closed; any taken by this call are released
    //  again, so the set is as it was. Rejects on unexpected filesystem
    //  errors, likewise leaving the set as it was.
    //
    //  With |options.createDir| false no directory is created, and a lock
    //  whose directory does not exist is skipped: not held, and not a
    //  failure. A directory that does not exist holds no flow file to
    //  protect.
    //
    acquire(bsyPaths, options = {}) {
        const run = this._acquiring.then(() => this._acquire(bsyPaths, options));
        this._acquiring = run.catch(() => {});
        return run;
    }

    async _acquire(bsyPaths, options) {
        const opts = { ...this._options, ...options };
        const taken = [];
        //  Only what is still ours: close() may have released some of these
        //  already, and another process may have taken them since.
        const undo = () =>
            Promise.all(taken.filter(p => this.holds(p)).map(p => this._drop(p)));

        for (const bsyPath of bsyPaths) {
            if (this._closed) {
                await undo();
                return false;
            }
            if (this.holds(bsyPath)) {
                continue;
            }
            let got;
            try {
                got = await acquire(bsyPath, {
                    ...opts,
                    //  Gone from under us (removed, or reaped and taken by
                    //  someone else): no longer held, so rewriteFlowFile()
                    //  refuses its flow files from now on.
                    onLost: () => this._held.delete(lockKey(bsyPath)),
                });
            } catch (err) {
                if ('ENOENT' === err.code && false === opts.createDir) {
                    continue;
                }
                await undo();
                throw err;
            }
            if (!got) {
                await undo();
                return false;
            }
            if (this._closed) {
                //  Closed while this one was being taken: give it back.
                await release(bsyPath);
                await undo();
                return false;
            }
            this._held.set(lockKey(bsyPath), bsyPath);
            taken.push(bsyPath);
        }
        return true;
    }

    //  As acquire(), retrying until |options.timeoutMs| (default
    //  DEFAULT_ACQUIRE_TIMEOUT_MS) runs out.
    async acquireWithRetry(bsyPaths) {
        const timeoutMs = _finite(this._options.timeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS);
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            if (await this.acquire(bsyPaths)) {
                return true;
            }
            if (Date.now() >= deadline || this._closed) {
                return false;
            }
            await new Promise(r => setTimeout(r, ACQUIRE_RETRY_MS));
        }
    }

    //  Release those of |bsyPaths| the set holds. Never throws.
    async release(bsyPaths) {
        await Promise.all(
            bsyPaths
                .filter(p => this.holds(p))
                .map(p => this._drop(this._held.get(lockKey(p))))
        );
    }

    //  Release every lock the set holds. Never throws.
    async releaseAll() {
        await Promise.all(this.paths.map(p => this._drop(p)));
    }

    //  Release every lock the set holds and end the set: nothing can be
    //  acquired into it afterwards, including by an acquire() already
    //  running, which gives back what it took. Never throws.
    async close() {
        this._closed = true;
        await this.releaseAll();
    }

    async _drop(bsyPath) {
        this._held.delete(lockKey(bsyPath));
        await release(bsyPath);
    }
}

//  True when |lock| is a FlowLockSet created by this module.
function isFlowLockSet(lock) {
    return Boolean(lock) && issuedLockSets.has(lock);
}

//
//  Throws (Errors.General, ReasonCodes.NotHeld) unless |lock| is a
//  FlowLockSet from this module that holds the .bsy beside |flowFilePath|
//  -- the lock every other writer of that flow file takes.
//
function assertFlowFileLockHeld(lock, flowFilePath) {
    if (lock && issuedLockSets.has(lock) && lock.holdsFlowFile(flowFilePath)) {
        return;
    }
    throw Errors.General(
        `Lock not held: ${paths.basename(
            bsyPathForFlowFile(flowFilePath)
        )} must be held to change ${flowFilePath}`,
        ReasonCodes.NotHeld
    );
}

//
//  Callback-style "do this while holding the flow file's lock", for ftn_bso.
//
//  |work| is called as work(done, lock). |lock| is the FlowLockSet holding
//  the flow file's .bsy, to hand to rewriteFlowFile(). The lock is released
//  on every path, including a throw out of |work|.
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
    const lock = new FlowLockSet(options);

    lock.acquireWithRetry([bsyPath]).then(
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
                lock.releaseAll().then(() => cb(err));
            };

            try {
                work(done, lock);
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

function isNotHeldError(err) {
    return !!err && ReasonCodes.NotHeld === err.reasonCode;
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
    heldCount,
    whenNoneHeld,
    lockHostId,
    parseLockContent,
    _refreshHeldNow: refreshHeldNow,
    _releaseHeldSync: releaseHeldSync,
    lockKey,
    FlowLockSet,
    isFlowLockSet,
    assertFlowFileLockHeld,
    withFlowFileLock,
    isBusyError,
    isNotHeldError,
};
