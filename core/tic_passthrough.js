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
//  Two spellings, because they say the same thing and an operator will reach
//  for either: an explicit "passthrough: true", or simply no "areaTag" -- there
//  is no local area to store into, which is what passthrough means. The
//  explicit form exists so the intent is readable in config.hjson and so a
//  *typo* in areaTag is not silently reinterpreted as "carry this in transit".
//
function isPassthroughArea(ticAreaConfig) {
    if (!ticAreaConfig || !_.isObject(ticAreaConfig)) {
        //  A bare string ticAreas value is shorthand for { areaTag: <it> },
        //  which is by definition not passthrough.
        return false;
    }

    if (true === ticAreaConfig.passthrough) {
        return true;
    }

    return !_.isString(ticAreaConfig.areaTag) || 0 === ticAreaConfig.areaTag.length;
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
function storeTransitFile(sourcePath, fileName, externalAreaTag, isReferenced, cb) {
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

        const re = globToRegExp(replaces);
        const matches = entries.filter(name => re.test(name));

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
//  A DOS style glob ('*' and '?') as an anchored, case insensitive RegExp.
//
//  Every other character is escaped, so a pattern is matched as a pattern and
//  never as a regular expression -- "Replaces" arrives from a peer's TIC.
//
function globToRegExp(glob) {
    const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
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
    globToRegExp,
    sweepTransit,
};
