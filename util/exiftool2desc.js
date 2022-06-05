#!/usr/bin/env node

/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	:TODO: Make this it's own sep tool/repo

const exiftool = require('exiftool');
const fs = require('graceful-fs');
const moment = require('moment');

const TOOL_VERSION = '1.0.0.0';

//	map fileTypes -> handlers
const FILETYPE_HANDLERS = {};
['AIFF', 'APE', 'FLAC', 'OGG', 'MP3'].forEach(
    ext => (FILETYPE_HANDLERS[ext] = audioFile)
);
[
    'PDF',
    'DOC',
    'DOCX',
    'DOCM',
    'ODB',
    'ODC',
    'ODF',
    'ODG',
    'ODI',
    'ODP',
    'ODS',
    'ODT',
].forEach(ext => (FILETYPE_HANDLERS[ext] = documentFile));
['PNG', 'JPEG', 'GIF', 'WEBP', 'XCF'].forEach(
    ext => (FILETYPE_HANDLERS[ext] = imageFile)
);
['MP4', 'MOV', 'AVI', 'MKV', 'MPG', 'MPEG', 'M4V', 'WMV'].forEach(
    ext => (FILETYPE_HANDLERS[ext] = videoFile)
);

function audioFile(metadata) {
    //	nothing if we don't know at least the author or title
    if (!metadata.author && !metadata.title) {
        return;
    }

    let desc = `${metadata.artist || 'Unknown Artist'} - ${
        metadata.title || 'Unknown'
    } (`;
    if (metadata.year) {
        desc += `${metadata.year}, `;
    }
    desc += `${metadata.audioBitrate})`;
    return desc;
}

function videoFile(metadata) {
    return `${metadata.fileType} video(${metadata.imageSize}px, ${metadata.duration}, ${metadata.audioBitsPerSample}/${metadata.audioSampleRate} audio)`;
}

function documentFile(metadata) {
    //	nothing if we don't know at least the author or title
    if (!metadata.author && !metadata.title) {
        return;
    }

    let result = metadata.author || '';
    if (result) {
        result += ' - ';
    }
    result += metadata.title || 'Unknown Title';
    return result;
}

function imageFile(metadata) {
    let desc = `${metadata.fileType} image (`;
    if (metadata.animationIterations) {
        desc += 'Animated, ';
    }
    desc += `${metadata.imageSize}px`;
    const created = moment(metadata.createdate);
    if (created.isValid()) {
        desc += `, ${created.format('YYYY')})`;
    } else {
        desc += ')';
    }
    return desc;
}

function main() {
    const argv = (exports.argv = require('minimist')(process.argv.slice(2), {
        alias: {
            h: 'help',
            v: 'version',
        },
    }));

    if (argv.version) {
        console.info(TOOL_VERSION);
        return 0;
    }

    if (0 === argv._.length || argv.help) {
        console.info('usage: exiftool2desc.js [--version] [--help] PATH');
        return 0;
    }

    const path = argv._[0];

    fs.readFile(path, (err, data) => {
        if (err) {
            return -1;
        }

        exiftool.metadata(data, (err, metadata) => {
            if (err) {
                return -1;
            }

            const handler = FILETYPE_HANDLERS[metadata.fileType];
            if (!handler) {
                return -1;
            }

            const info = handler(metadata);
            if (!info) {
                return -1;
            }

            console.info(info);
            return 0;
        });
    });
}

return main();
