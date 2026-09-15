/* jslint node: true */
'use strict';

//  ENiGMA½
const Errors = require('./enig_error.js').Errors;
const Log = require('./logger.js').log;
const configModule = require('./config.js');
//  Look up configModule.get on each call rather than capturing it at load
//  time -- it is rebound when the Config bootstrapper runs, and swapped by
//  tests. Same reasoning as ftn_bso.js.
const Config = (...args) => configModule.get(...args);
const { copyFileWithCollisionHandling, safeCopyFile } = require('./file_util.js');

//  deps
const _ = require('lodash');
const async = require('async');
const fs = require('graceful-fs');
const paths = require('path');

//
//  Passthrough (transit) file areas: carrying a file echo for downlinks without
//  storing it in the local file base (#753).
//
//  * FTS-5006.001 @ http://ftsc.org/docs/fts-5006.001
//  * FSC-0087.001 @ http://ftsc.org/docs/fsc-0087.001
//
//  A hub carrying forty echoes for its downlinks does not necessarily want
//  forty local file areas, forty storage directories and forty areas' worth of
//  files its own users will never browse. htick calls this "passthrough" and
//  Synchronet's tickit does the same thing with an area that has no local dir;
//  both keep the payload only as long as some link still owes it.
//
//  The payload lives in a per-echo transit directory instead of file base
//  storage. Everything downstream of that is unchanged -- forwarding queues
//  |localInfo.newPath| whatever kind of path it is -- so the interesting parts
//  here are the two jobs the file base was quietly doing for us:
//
//    * telling us a file is a duplicate (the collision rename, which
//      forwardTicToDownlinks() refuses to forward), and
//    * deciding when the payload may be deleted.
//
//  The second is not the policy question #753 assumed. A flow file reference is
//  an exact answer to "does anyone still owe this file?", and BsoSpool can
//  enumerate every reference across every node. So cleanup is a reference
//  check, not an expiry rule, and does not wait on #755.
//

const DEFAULT_TRANSIT_DIR_NAME = 'ftn_tic_transit';

//
//  Is this echo carried in transit rather than stored?
//
//  Only ever when the operator says so. An absent "areaTag" looks like it means
//  the same thing -- there is no local area to store into, which is what
//  passthrough is -- and inferring it from that was the original design. It is
//  wrong, because the inference is not confined to new configurations:
//
//      fileBase:  { areas:    { fsx_gen: { ... } } }
//      ticAreas:  { fsx_gen:  { uplinks: [...], downlinks: [...] } }
//
//  That entry has no "areaTag" and works perfectly well today -- the key is
//  matched against fileBase.areas as well as ticAreas (getLocalAreaTagsForTic),
//  so the echo is stored in fsx_gen and its files stay there. Inferring
//  passthrough would silently reinterpret it, on upgrade, as "forward these and
//  then delete them", and the operator's users would find the area emptying
//  itself. The same goes for a plain typo in "areaTag".
//
//  When the consequence of guessing is destroying files, the flag is explicit.
//  An entry with no usable local area and no "passthrough" keeps failing the
//  way it does today, and logTicForwardingDiagnostics() says which key is
//  missing.
//
function isPassthroughArea(ticAreaConfig) {
    //  A bare string ticAreas value is shorthand for { areaTag: <it> }, which
    //  is by definition not passthrough.
    if (!ticAreaConfig || !_.isObject(ticAreaConfig)) {
        return false;
    }

    return true === ticAreaConfig.passthrough;
}

//
//  Where transit payloads for |externalAreaTag| live.
//
//  One directory per echo, so a "Replaces" pattern cannot reach across echoes
//  and a sweep can report per area. Lowercased: the area tag is upper case on
//  the wire and a case-sensitive filesystem would otherwise give us two
//  directories for one echo.
//
function transitDirFor(externalAreaTag) {
    const configured = _.get(Config(), 'scannerTossers.ftn_bso.paths.ticTransit');
    const base =
        configured ||
        paths.join(
            _.get(Config(), 'scannerTossers.ftn_bso.paths.reject', ''),
            '..',
            DEFAULT_TRANSIT_DIR_NAME
        );

    //  The area tag reaches us from a peer's TIC. validate() has already
    //  matched it against a configured ticAreas key, so it cannot be a
    //  traversal by the time we are called -- but this builds a path, so it
    //  does not take that on trust.
    const safe = String(externalAreaTag)
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '_')
        .replace(/^\.+/, '');

    return paths.join(base, safe || 'unknown');
}

//
//  Every transit file we hold, as { areaTag, path }.
//
//  Used by the sweep, and small: a transit directory holds only what is still
//  in flight, which is the point of it.
//
function listTransitFiles(cb) {
    const configured = _.get(Config(), 'scannerTossers.ftn_bso.paths.ticTransit');
    const ticAreas = _.get(Config(), 'scannerTossers.ftn_bso.ticAreas', {});

    const areas = Object.keys(ticAreas).filter(tag => isPassthroughArea(ticAreas[tag]));

    if (!configured && 0 === areas.length) {
        return cb(null, []);
    }

    const results = [];

    async.each(
        areas,
        (areaTag, nextArea) => {
            const dir = transitDirFor(areaTag);
            fs.readdir(dir, (err, entries) => {
                if (err) {
                    //  No directory yet is the ordinary case for an echo that
                    //  has not carried anything.
                    return nextArea(null);
                }
                entries.forEach(name =>
                    results.push({ areaTag, path: paths.join(dir, name) })
                );
                return nextArea(null);
            });
        },
        () => cb(null, results)
    );
}

//
//  Copy the payload into |externalAreaTag|'s transit directory, under the name
//  it was announced as.
//
//  The name is not negotiable. BinkP offers a file by its actual basename and
//  htick resolves a payload strictly by the "File" name with no size or CRC
//  fallback (see the reasoning in #759), so a transit file stored under any
//  other name arrives at the downlink as an orphan it can never pair up. That
//  is also why this cannot borrow the unique-naming trick the generated TICs
//  use.
//
//  Which leaves the duplicate problem the file base was solving for us. A name
//  already present is one of two very different things:
//
//    * still referenced by some flow file -- a downlink has not collected it,
//      so this is a re-announcement of a file already in flight. Overwriting
//      would change the bytes under a reference that is already queued, and the
//      downlink would receive the new file under the old announcement's CRC.
//      Refused.
//    * referenced by nobody -- every link has had it and the sweep has not run
//      yet, or it never queued at all. A leftover, and safe to replace.
//
//  |isReferenced| answers that; the caller supplies it because only the caller
//  has the spool.
//
//  |supersedes| is the path a "Replaces" matched, when this file is superseding
//  one we already hold. A same-name supersede -- a weekly nodelist re-hatched
//  under the name it always has, which is the single most routine case in a
//  file echo -- lands on exactly the name-already-present branch above, and
//  refusing it would reject every week's file for as long as one downlink
//  stayed offline. It is not a duplicate: the operator upstream told us it
//  replaces what we hold, and the stored path handles it by overwriting in
//  place (copyTicAttachment with isUpdate). Same answer here.
//
function storeTransitFile(
    sourcePath,
    fileName,
    externalAreaTag,
    isReferenced,
    supersedes,
    cb
) {
    const dir = transitDirFor(externalAreaTag);

    fs.mkdir(dir, { recursive: true }, err => {
        if (err && 'EEXIST' !== err.code) {
            return cb(err);
        }

        const dst = paths.join(dir, fileName);

        fs.stat(dst, statErr => {
            if (statErr) {
                //  Not there. Collision handling still, rather than a bare
                //  copy: the stat above is a moment ago, and a rename around
                //  an unexpected file is caught below either way.
                return copyFileWithCollisionHandling(
                    sourcePath,
                    dst,
                    (copyErr, finalPath) => {
                        if (copyErr) {
                            return cb(copyErr);
                        }
                        if (finalPath !== dst) {
                            return fs.unlink(finalPath, () =>
                                cb(
                                    Errors.General(
                                        `Transit file ${fileName} appeared while we were writing it`
                                    )
                                )
                            );
                        }
                        return cb(null, finalPath);
                    }
                );
            }

            //
            //  A supersede of this very file. Not a re-announcement of
            //  something already in flight, so the reference check below does
            //  not apply -- the caller has already matched a "Replaces" against
            //  it, and dequeueReplacedForDownlinks() deals with whatever is
            //  still queued for it.
            //
            if (supersedes && paths.resolve(supersedes) === paths.resolve(dst)) {
                Log.debug(
                    { path: dst, area: externalAreaTag },
                    'Superseding a transit file in place'
                );
                return safeCopyFile(sourcePath, dst, { overwrite: true }, copyErr =>
                    cb(copyErr, dst)
                );
            }

            isReferenced(dst, (refErr, referenced) => {
                if (refErr) {
                    //  Could not tell. Refuse rather than risk changing the
                    //  bytes under a queued reference.
                    return cb(refErr);
                }

                if (referenced) {
                    return cb(
                        Errors.General(
                            `${fileName} is already queued for a downlink in ${externalAreaTag}; refusing to re-announce it`
                        )
                    );
                }

                Log.debug(
                    { path: dst, area: externalAreaTag },
                    'Replacing an unreferenced transit file'
                );

                return safeCopyFile(sourcePath, dst, { overwrite: true }, copyErr =>
                    cb(copyErr, dst)
                );
            });
        });
    });
}

//
//  The transit file a "Replaces" pattern supersedes, if there is exactly one.
//
//  The file base path matches on stored |short_file_name| and |tic_origin|
//  metadata; transit has no metadata, so this matches names within the echo's
//  own directory. That is not the loosening it looks like. Origin was never a
//  security boundary here -- it comes off the TIC and an attacker sets it -- and
//  the boundary that does the work, "uplinks", has already been applied by
//  canForwardTic() before anything reaches this. The per-echo directory is what
//  keeps a pattern from reaching across echoes.
//
//  0 or 1 only, exactly as findExistingItem() requires. "Replaces *" against a
//  busy echo would otherwise dequeue an area's worth of pending traffic from
//  every downlink.
//
function findReplacedTransitFile(replaces, externalAreaTag, cb) {
    if (!replaces) {
        return cb(null, null);
    }

    const dir = transitDirFor(externalAreaTag);

    fs.readdir(dir, (err, entries) => {
        if (err) {
            return cb(null, null); //  nothing carried yet
        }

        const matches = entries.filter(name => globMatches(replaces, name));

        if (0 === matches.length) {
            return cb(null, null);
        }

        if (matches.length > 1) {
            return cb(
                Errors.General(
                    `"${replaces}" matches ${matches.length} transit files in ${externalAreaTag}; refusing to guess`
                )
            );
        }

        return cb(null, paths.join(dir, matches[0]));
    });
}

//
//  Does |name| match the DOS style glob |pattern| ('*' and '?')?
//
//  Matched with a linear scanner rather than a RegExp, and that is the whole
//  point of it. The obvious implementation maps '*' to '.*' and hands the
//  result to `new RegExp`, which backtracks catastrophically on a run of them:
//  against a 34 character filename, '*'x6 took 43ms, '*'x8 took 1.5s and
//  '*'x10 took 36s -- roughly 5x per added star. "Replaces" arrives from a
//  peer's TIC and is matched here synchronously, inside an import pass, so a
//  peer could wedge the event loop for as long as it liked: every user session,
//  the web server and every timer with it. Not even the import watchdog would
//  fire, since its setTimeout cannot run either.
//
//  The stored-area path does the same job through SQL LIKE (see
//  FileEntry.findFiles), which has no backtracking; this keeps passthrough from
//  being the weaker door.
//
//  The algorithm is the standard greedy backtrack-once scan: remember where the
//  last '*' was and what it had consumed, and on a mismatch resume from there
//  with the star eating one more character. O(len(name) * len(pattern)) worst
//  case, no recursion, no exponential behaviour.
//
function globMatches(pattern, name) {
    const p = String(pattern).toLowerCase();
    const n = String(name).toLowerCase();

    let pi = 0;
    let ni = 0;
    let starAt = -1;
    let matchAt = 0;

    while (ni < n.length) {
        if (pi < p.length && ('?' === p[pi] || p[pi] === n[ni])) {
            pi++;
            ni++;
            continue;
        }

        if (pi < p.length && '*' === p[pi]) {
            starAt = pi++;
            matchAt = ni;
            continue;
        }

        if (starAt >= 0) {
            //  Back up to the last '*' and let it consume one more character.
            pi = starAt + 1;
            ni = ++matchAt;
            continue;
        }

        return false;
    }

    //  Trailing stars match the empty string.
    while (pi < p.length && '*' === p[pi]) {
        pi++;
    }

    return pi === p.length;
}

//
//  Delete transit files nothing owes any more.
//
//  "Is this still referenced?" is answerable exactly, so this is a reference
//  check rather than an expiry policy -- which is the part of #753 that was
//  thought to be blocked on #755 and is not. A file every downlink has
//  collected has a '~' reference or none at all, and either way we are done
//  with it; one a downlink has not collected is still named by a live line and
//  stays.
//
//  |referencedPaths| is every path any flow file still names, sent or not.
//  Including the sent ones is deliberate and the conservative choice: a '~'
//  line is history, and a file named by one is about to disappear from the flow
//  file on the next successful drain anyway. Deleting underneath it buys
//  nothing and would make a "why is this gone?" question unanswerable.
//
function sweepTransit(referencedPaths, cb) {
    const referenced = new Set(
        Array.from(referencedPaths || []).map(p => paths.resolve(p))
    );

    listTransitFiles((err, files) => {
        if (err) {
            return cb(err);
        }

        const removed = [];

        async.each(
            files,
            (file, nextFile) => {
                if (referenced.has(paths.resolve(file.path))) {
                    return nextFile(null);
                }

                fs.unlink(file.path, unlinkErr => {
                    if (unlinkErr) {
                        if ('ENOENT' !== unlinkErr.code) {
                            Log.warn(
                                { path: file.path, error: unlinkErr.message },
                                'Failed removing transit file'
                            );
                        }
                        return nextFile(null);
                    }

                    removed.push(file);
                    return nextFile(null);
                });
            },
            () => {
                if (removed.length > 0) {
                    Log.info(
                        { count: removed.length },
                        'Swept transit files no downlink still owes'
                    );
                }
                return cb(null, removed);
            }
        );
    });
}

module.exports = {
    DEFAULT_TRANSIT_DIR_NAME,
    isPassthroughArea,
    transitDirFor,
    listTransitFiles,
    storeTransitFile,
    findReplacedTransitFile,
    globMatches,
    sweepTransit,
};
