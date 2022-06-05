/* jslint node: true */
'use strict';

const Errors = require('./enig_error.js').Errors;

//  deps
const iconv = require('iconv-lite');
const { Parser } = require('binary-parser');

exports.readSAUCE = readSAUCE;

const SAUCE_SIZE = 128;
const SAUCE_ID = Buffer.from([0x53, 0x41, 0x55, 0x43, 0x45]); //  'SAUCE'

//  :TODO read comments
//const COMNT_ID        = Buffer.from([0x43, 0x4f, 0x4d, 0x4e, 0x54]);  //  'COMNT'

exports.SAUCE_SIZE = SAUCE_SIZE;
//  :TODO: SAUCE should be a class
//  - with getFontName()
//  - ...other methods

//
//  See
//  http://www.acid.org/info/sauce/sauce.htm
//
const SAUCE_VALID_DATA_TYPES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

const SAUCEParser = new Parser()
    .buffer('id', { length: 5 })
    .buffer('version', { length: 2 })
    .buffer('title', { length: 35 })
    .buffer('author', { length: 20 })
    .buffer('group', { length: 20 })
    .buffer('date', { length: 8 })
    .uint32le('fileSize')
    .int8('dataType')
    .int8('fileType')
    .uint16le('tinfo1')
    .uint16le('tinfo2')
    .uint16le('tinfo3')
    .uint16le('tinfo4')
    .int8('numComments')
    .int8('flags')
    //  :TODO: does this need to be optional?
    .buffer('tinfos', { length: 22 }); //  SAUCE 00.5

function readSAUCE(data, cb) {
    if (data.length < SAUCE_SIZE) {
        return cb(Errors.DoesNotExist('No SAUCE record present'));
    }

    let sauceRec;
    try {
        sauceRec = SAUCEParser.parse(data.slice(data.length - SAUCE_SIZE));
    } catch (e) {
        return cb(Errors.Invalid('Invalid SAUCE record'));
    }

    if (!SAUCE_ID.equals(sauceRec.id)) {
        return cb(Errors.DoesNotExist('No SAUCE record present'));
    }

    const ver = iconv.decode(sauceRec.version, 'cp437');

    if ('00' !== ver) {
        return cb(Errors.Invalid(`Unsupported SAUCE version: ${ver}`));
    }

    if (-1 === SAUCE_VALID_DATA_TYPES.indexOf(sauceRec.dataType)) {
        return cb(Errors.Invalid(`Unsupported SAUCE DataType: ${sauceRec.dataType}`));
    }

    const sauce = {
        id: iconv.decode(sauceRec.id, 'cp437'),
        version: iconv.decode(sauceRec.version, 'cp437').trim(),
        title: iconv.decode(sauceRec.title, 'cp437').trim(),
        author: iconv.decode(sauceRec.author, 'cp437').trim(),
        group: iconv.decode(sauceRec.group, 'cp437').trim(),
        date: iconv.decode(sauceRec.date, 'cp437').trim(),
        fileSize: sauceRec.fileSize,
        dataType: sauceRec.dataType,
        fileType: sauceRec.fileType,
        tinfo1: sauceRec.tinfo1,
        tinfo2: sauceRec.tinfo2,
        tinfo3: sauceRec.tinfo3,
        tinfo4: sauceRec.tinfo4,
        numComments: sauceRec.numComments,
        flags: sauceRec.flags,
        tinfos: sauceRec.tinfos,
    };

    const dt = SAUCE_DATA_TYPES[sauce.dataType];
    if (dt && dt.parser) {
        sauce[dt.name] = dt.parser(sauce);
    }

    return cb(null, sauce);
}

//  :TODO: These need completed:
const SAUCE_DATA_TYPES = {
    0: { name: 'None' },
    1: { name: 'Character', parser: parseCharacterSAUCE },
    2: 'Bitmap',
    3: 'Vector',
    4: 'Audio',
    5: 'BinaryText',
    6: 'XBin',
    7: 'Archive',
    8: 'Executable',
};

const SAUCE_CHARACTER_FILE_TYPES = {
    0: 'ASCII',
    1: 'ANSi',
    2: 'ANSiMation',
    3: 'RIP script',
    4: 'PCBoard',
    5: 'Avatar',
    6: 'HTML',
    7: 'Source',
    8: 'TundraDraw',
};

//
//  Map of SAUCE font -> encoding hint
//
//  Note that this is the same mapping that x84 uses. Be compatible!
//
const SAUCE_FONT_TO_ENCODING_HINT = {
    'Amiga MicroKnight': 'amiga',
    'Amiga MicroKnight+': 'amiga',
    'Amiga mOsOul': 'amiga',
    'Amiga P0T-NOoDLE': 'amiga',
    'Amiga Topaz 1': 'amiga',
    'Amiga Topaz 1+': 'amiga',
    'Amiga Topaz 2': 'amiga',
    'Amiga Topaz 2+': 'amiga',
    'Atari ATASCII': 'atari',
    'IBM EGA43': 'cp437',
    'IBM EGA': 'cp437',
    'IBM VGA25G': 'cp437',
    'IBM VGA50': 'cp437',
    'IBM VGA': 'cp437',
};

[
    '437',
    '720',
    '737',
    '775',
    '819',
    '850',
    '852',
    '855',
    '857',
    '858',
    '860',
    '861',
    '862',
    '863',
    '864',
    '865',
    '866',
    '869',
    '872',
].forEach(page => {
    const codec = 'cp' + page;
    SAUCE_FONT_TO_ENCODING_HINT['IBM EGA43 ' + page] = codec;
    SAUCE_FONT_TO_ENCODING_HINT['IBM EGA ' + page] = codec;
    SAUCE_FONT_TO_ENCODING_HINT['IBM VGA25g ' + page] = codec;
    SAUCE_FONT_TO_ENCODING_HINT['IBM VGA50 ' + page] = codec;
    SAUCE_FONT_TO_ENCODING_HINT['IBM VGA ' + page] = codec;
});

function parseCharacterSAUCE(sauce) {
    const result = {};

    result.fileType = SAUCE_CHARACTER_FILE_TYPES[sauce.fileType] || 'Unknown';

    if (sauce.fileType === 0 || sauce.fileType === 1 || sauce.fileType === 2) {
        //  convenience: create ansiFlags
        sauce.ansiFlags = sauce.flags;

        let i = 0;
        while (i < sauce.tinfos.length && sauce.tinfos[i] !== 0x00) {
            ++i;
        }

        const fontName = iconv.decode(sauce.tinfos.slice(0, i), 'cp437');
        if (fontName.length > 0) {
            result.fontName = fontName;
        }

        const setDimen = (v, field) => {
            const i = parseInt(v, 10);
            if (!isNaN(i)) {
                result[field] = i;
            }
        };

        setDimen(sauce.tinfo1, 'characterWidth');
        setDimen(sauce.tinfo2, 'characterHeight');
    }

    return result;
}
