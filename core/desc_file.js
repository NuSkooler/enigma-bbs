/* jslint node: true */
'use strict';

const iconv = require('iconv-lite');

//  :TODO: This is basically sliceAtEOF() from art.js .... DRY!
//  Cut a description file's raw bytes at the EOF marker (0x1a) that comes before a
//  SAUCE record. It works on the Buffer, before the CP437 decode: a decoded
//  string's characters are never equal to the number 0x1a.
function sliceAtSauceMarker(data) {
    let eof = data.length;
    const stopPos = Math.max(data.length - 256, 0); //  256 = 2 * sizeof(SAUCE)

    for (let i = eof - 1; i > stopPos; i--) {
        if (0x1a === data[i]) {
            eof = i;
            break;
        }
    }
    return data.slice(0, eof);
}

//  Assume FILE_ID.DIZ, NFO files, etc. are CP437; decode them to a native format
//  for storage, without the EOF marker and SAUCE record some of them end with.
//
//  :TODO: This isn't really always the case - how to handle this? We could do a quick detection...
function decodeDescFile(data) {
    return iconv.decode(sliceAtSauceMarker(data), 'cp437');
}

exports.sliceAtSauceMarker = sliceAtSauceMarker;
exports.decodeDescFile = decodeDescFile;
