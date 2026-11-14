/* jslint node: true */
'use strict';

//  ENiGMA½
const Errors = require('./enig_error.js').Errors;
const { copyFileWithCollisionHandling, safeCopyFile } = require('./file_util.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');

//
//  Putting a TIC payload where it will live: file base storage for an import
//  or a hatch, an echo's transit directory for a passthrough area (#753).
//
//  All three share one rule, and it is the whole reason this exists:
//
//      An existing file is overwritten only when it is the very file being
//      superseded.
//
//  |dst| is built from the *incoming* file's name. A "Replaces" match is
//  found by an unrelated route -- stored metadata, or a pattern over the
//  directory -- and names whatever file it names. The two coincide in the
//  common case (this week's NODELIST.Z21 replacing last week's under the
//  same name) and not otherwise: a payload BAR.ZIP replacing FOO.ZIP must
//  not overwrite some other entry's BAR.ZIP on the way past, leaving that
//  entry's row describing bytes it never had and two rows sharing one file.
//  So anything at |dst| that is not the superseded file is kept, and the
//  payload goes in beside it under a collision name -- or, for a caller that
//  must store under the announced name or not at all, is refused.
//

const ReasonCodes = {
    NameTaken: 'NAME_TAKEN',
};

//
//  Copy |sourcePath| to |dst|.
//
//  opts.supersedes  string   path of the file this payload replaces, if any.
//                            Overwritten in place only when it is |dst|.
//  opts.exactName   boolean  store under |dst| or not at all. A collision is
//                            refused with reasonCode ReasonCodes.NameTaken,
//                            and nothing is left behind.
//
//  cb(err, finalPath) -- |finalPath| differs from |dst| only when renamed
//  around a collision, which |exactName| never allows.
//
function storePayload(sourcePath, dst, opts, cb) {
    const { supersedes, exactName } = opts || {};

    if (supersedes && paths.resolve(supersedes) === paths.resolve(dst)) {
        return safeCopyFile(sourcePath, dst, { overwrite: true }, err =>
            cb(err, err ? undefined : dst)
        );
    }

    return copyFileWithCollisionHandling(sourcePath, dst, (err, finalPath) => {
        if (err) {
            return cb(err);
        }

        if (exactName && finalPath !== dst) {
            //
            //  Take the renamed copy back out. Collision handling is still
            //  what does the detecting -- a stat beforehand leaves a window
            //  for the name to be taken between the check and the copy --
            //  but a refused store must not leave a file that no database
            //  row, flow file or TIC names.
            //
            return fs.unlink(finalPath, () =>
                cb(
                    Errors.Duplicate(
                        `${paths.basename(dst)} already exists`,
                        ReasonCodes.NameTaken
                    )
                )
            );
        }

        return cb(null, finalPath);
    });
}

module.exports = {
    ReasonCodes,
    storePayload,
};
