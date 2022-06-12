/* jslint node: true */
'use strict';

//  deps
const _ = require('lodash');

const mimeTypes = require('mime-types');

exports.startup = startup;
exports.resolveMimeType = resolveMimeType;

function startup(cb) {
    //
    //  Add in types (not yet) supported by mime-db -- and therefor, mime-types
    //
    const ADDITIONAL_EXT_MIMETYPES = {
        ans: 'text/x-ansi',
        gz: 'application/gzip', //  not in mime-types 2.1.15 :(
        lzx: 'application/x-lzx', //  :TODO: submit to mime-types
    };

    _.forEach(ADDITIONAL_EXT_MIMETYPES, (mimeType, ext) => {
        //  don't override any entries
        if (!_.isString(mimeTypes.types[ext])) {
            mimeTypes[ext] = mimeType;
        }

        if (!mimeTypes.extensions[mimeType]) {
            mimeTypes.extensions[mimeType] = [ext];
        }
    });

    return cb(null);
}

function resolveMimeType(query) {
    if (mimeTypes.extensions[query]) {
        return query; //  already a mime-type
    }

    return mimeTypes.lookup(query) || undefined; //  lookup() returns false; we want undefined
}
