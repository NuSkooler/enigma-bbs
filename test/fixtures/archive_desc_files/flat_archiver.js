'use strict';

//
//  A stand-in archiver that drops entry paths on extract, as 7za e and
//  unrar e do. The "archive" is JSON: { entries: [ { name, data } ] }.
//
//    flat_archiver.js list ARCHIVE
//      prints the listing in the form `unarc list --json` does
//    flat_archiver.js extract ARCHIVE DIR NAME...
//      writes each named entry to DIR under its base name
//
const fs = require('fs');
const paths = require('path');

const [action, archivePath, extractPath, ...names] = process.argv.slice(2);
const { entries } = JSON.parse(fs.readFileSync(archivePath, 'utf8'));

if ('list' === action) {
    process.stdout.write(
        JSON.stringify({
            format: 'FLAT',
            entries: entries.map(e => ({
                name: e.name,
                kind: 'file',
                size: Buffer.byteLength(e.data),
            })),
        })
    );
} else if ('extract' === action) {
    names.forEach(name => {
        const entry = entries.find(e => e.name === name);
        if (!entry) {
            process.exitCode = 1;
            return;
        }
        fs.writeFileSync(paths.join(extractPath, paths.basename(name)), entry.data);
    });
} else {
    process.exitCode = 2;
}
