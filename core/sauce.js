/* jslint node: true */
'use strict';

var binary				= require('binary');
var iconv				= require('iconv-lite');

exports.readSAUCE		= readSAUCE;

const SAUCE_SIZE	= 128;
const SAUCE_ID		= new Buffer([0x53, 0x41, 0x55, 0x43, 0x45]);	//	'SAUCE'

//	:TODO read comments
//const COMNT_ID		= new Buffer([0x43, 0x4f, 0x4d, 0x4e, 0x54]);	//	'COMNT'

exports.SAUCE_SIZE		= SAUCE_SIZE;
//	:TODO: SAUCE should be a class
//	- with getFontName()
//	- ...other methods

//
//	See
//	http://www.acid.org/info/sauce/sauce.htm
//
const SAUCE_VALID_DATA_TYPES = [0, 1, 2, 3, 4, 5, 6, 7, 8 ];

function readSAUCE(data, cb) {
	if(data.length < SAUCE_SIZE) {
		cb(new Error('No SAUCE record present'));
		return;
	}

	var offset		= data.length - SAUCE_SIZE;
	var sauceRec	= data.slice(offset);

	binary.parse(sauceRec)
		.buffer('id', 5)
		.buffer('version', 2)
		.buffer('title', 35)
		.buffer('author', 20)
		.buffer('group', 20)
		.buffer('date', 8)
		.word32lu('fileSize')
		.word8('dataType')
		.word8('fileType')
		.word16lu('tinfo1')
		.word16lu('tinfo2')
		.word16lu('tinfo3')
		.word16lu('tinfo4')
		.word8('numComments')
		.word8('flags')
		.buffer('tinfos', 22)	//	SAUCE 00.5
		.tap(function onVars(vars) {

			if(!SAUCE_ID.equals(vars.id)) {
				return cb(new Error('No SAUCE record present'));
			}

			var ver = iconv.decode(vars.version, 'cp437');

			if('00' !== ver) {
				return cb(new Error('Unsupported SAUCE version: ' + ver));
			}

			if(-1 === SAUCE_VALID_DATA_TYPES.indexOf(vars.dataType)) {
				return cb(new Error('Unsupported SAUCE DataType: ' + vars.dataType));
			}

			var sauce = {
				id 			: iconv.decode(vars.id, 'cp437'),
				version		: iconv.decode(vars.version, 'cp437').trim(),
				title		: iconv.decode(vars.title, 'cp437').trim(),
				author		: iconv.decode(vars.author, 'cp437').trim(),
				group		: iconv.decode(vars.group, 'cp437').trim(),
				date		: iconv.decode(vars.date, 'cp437').trim(),
				fileSize	: vars.fileSize,
				dataType	: vars.dataType,
				fileType	: vars.fileType,
				tinfo1		: vars.tinfo1,
				tinfo2		: vars.tinfo2,
				tinfo3		: vars.tinfo3,
				tinfo4		: vars.tinfo4,
				numComments	: vars.numComments,
				flags		: vars.flags,
				tinfos		: vars.tinfos,
			};

			var dt = SAUCE_DATA_TYPES[sauce.dataType];
			if(dt && dt.parser) {
				sauce[dt.name] = dt.parser(sauce);
			}

			cb(null, sauce);
		});
}

//	:TODO: These need completed:
var SAUCE_DATA_TYPES = {};
SAUCE_DATA_TYPES[0]		= { name : 'None' };
SAUCE_DATA_TYPES[1]		= { name : 'Character', parser : parseCharacterSAUCE };
SAUCE_DATA_TYPES[2]		= 'Bitmap';
SAUCE_DATA_TYPES[3]		= 'Vector';
SAUCE_DATA_TYPES[4]		= 'Audio';
SAUCE_DATA_TYPES[5]		= 'BinaryText';
SAUCE_DATA_TYPES[6]		= 'XBin';
SAUCE_DATA_TYPES[7]		= 'Archive';
SAUCE_DATA_TYPES[8]		= 'Executable';

var SAUCE_CHARACTER_FILE_TYPES = {};
SAUCE_CHARACTER_FILE_TYPES[0]	= 'ASCII';
SAUCE_CHARACTER_FILE_TYPES[1]	= 'ANSi';
SAUCE_CHARACTER_FILE_TYPES[2]	= 'ANSiMation';
SAUCE_CHARACTER_FILE_TYPES[3]	= 'RIP script';
SAUCE_CHARACTER_FILE_TYPES[4]	= 'PCBoard';
SAUCE_CHARACTER_FILE_TYPES[5]	= 'Avatar';
SAUCE_CHARACTER_FILE_TYPES[6]	= 'HTML';
SAUCE_CHARACTER_FILE_TYPES[7]	= 'Source';
SAUCE_CHARACTER_FILE_TYPES[8]	= 'TundraDraw';

//
//	Map of SAUCE font -> encoding hint
//
//	Note that this is the same mapping that x84 uses. Be compatible!
//
var SAUCE_FONT_TO_ENCODING_HINT = {
	'Amiga MicroKnight'		: 'amiga',
	'Amiga MicroKnight+'	: 'amiga',
	'Amiga mOsOul'			: 'amiga',
	'Amiga P0T-NOoDLE'		: 'amiga',
	'Amiga Topaz 1'			: 'amiga',
	'Amiga Topaz 1+'		: 'amiga',
	'Amiga Topaz 2'			: 'amiga',
	'Amiga Topaz 2+'		: 'amiga',
	'Atari ATASCII'			: 'atari',
	'IBM EGA43'				: 'cp437',
	'IBM EGA'				: 'cp437',
	'IBM VGA25G'			: 'cp437',
	'IBM VGA50'				: 'cp437',
	'IBM VGA'				: 'cp437',
};

['437', '720', '737', '775', '819', '850', '852', '855', '857', '858',
	'860', '861', '862', '863', '864', '865', '866', '869', '872'].forEach(function onPage(page) {
	var codec = 'cp' + page;
	SAUCE_FONT_TO_ENCODING_HINT['IBM EGA43 ' + page]	= codec;
	SAUCE_FONT_TO_ENCODING_HINT['IBM EGA ' + page]		= codec;
	SAUCE_FONT_TO_ENCODING_HINT['IBM VGA25g ' + page]	= codec;
	SAUCE_FONT_TO_ENCODING_HINT['IBM VGA50 ' + page]	= codec;
	SAUCE_FONT_TO_ENCODING_HINT['IBM VGA ' + page]		= codec;
});

function parseCharacterSAUCE(sauce) {
	var result = {};

	result.fileType	= SAUCE_CHARACTER_FILE_TYPES[sauce.fileType] || 'Unknown';

	if(sauce.fileType === 0 || sauce.fileType === 1 || sauce.fileType === 2) {
		//	convience: create ansiFlags
		sauce.ansiFlags = sauce.flags;

		var i = 0;
		while(i < sauce.tinfos.length && sauce.tinfos[i] !== 0x00) {
			++i;
		}
		var fontName = iconv.decode(sauce.tinfos.slice(0, i), 'cp437');
		if(fontName.length > 0) {
			result.fontName = fontName;
		}
	}

	return result;
}