/* jslint node: true */
'use strict';

var fs			= require('fs');
var paths		= require('path');
var assert		= require('assert');
var iconv		= require('iconv-lite');
var conf		= require('./config.js');
var miscUtil	= require('./misc_util.js');
var binary		= require('binary');
var events		= require('events');
var util		= require('util');
var ansi		= require('./ansi_term.js');
var aep			= require('./ansi_escape_parser.js');

var _			= require('lodash');

exports.getArt							= getArt;
exports.getArtFromPath					= getArtFromPath;
exports.display							= display;
exports.defaultEncodingFromExtension	= defaultEncodingFromExtension;

var SAUCE_SIZE		= 128;
var SAUCE_ID		= new Buffer([0x53, 0x41, 0x55, 0x43, 0x45]);	//	'SAUCE'
var COMNT_ID		= new Buffer([0x43, 0x4f, 0x4d, 0x4e, 0x54]);	//	'COMNT'

//	:TODO: Return MCI code information
//	:TODO: process SAUCE comments
//	:TODO: return font + font mapped information from SAUCE

var SUPPORTED_ART_TYPES = {
	//	:TODO: the defualt encoding are really useless if they are all the same ...
	//	perhaps .ansamiga and .ascamiga could be supported as well as overrides via conf
	'.ans'	: { name : 'ANSI',		defaultEncoding : 'cp437',	eof : 0x1a	},
	'.asc'	: { name : 'ASCII',		defaultEncoding : 'cp437',	eof : 0x1a  },
	'.pcb'	: { name : 'PCBoard',	defaultEncoding : 'cp437',	eof : 0x1a  },
	'.bbs'	: { name : 'Wildcat',	defaultEncoding : 'cp437',	eof : 0x1a  },
	'.txt'	: { name : 'Text',		defaultEncoding : 'cp437',	eof : 0x1a  },	//	:TODO: think about this more...
	//	:TODO: extentions for wwiv, renegade, celerity, syncronet, ...
	//	:TODO: extension for atari
	//	:TODO: extension for topaz ansi/ascii.
};

//
//	See
//	http://www.acid.org/info/sauce/sauce.htm
//
//	:TODO: Move all SAUCE stuff to sauce.js
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
				cb(new Error('No SAUCE record present'));
				return;
			}	

			var ver = vars.version.toString('cp437');

			if('00' !== ver) {
				cb(new Error('Unsupported SAUCE version: ' + ver));
				return;
			}

			var sauce = {
				id 			: vars.id.toString('cp437'),
				version		: vars.version.toString('cp437'),
				title		: vars.title.toString('cp437').trim(),
				author		: vars.author.toString('cp437').trim(),
				group		: vars.group.toString('cp437').trim(),
				date		: vars.date.toString('cp437').trim(),
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
		var fontName = sauce.tinfos.slice(0, i).toString('cp437');
		if(fontName.length > 0) {
			result.fontName = fontName;
		}
	}

	return result;
}

function getFontNameFromSAUCE(sauce) {
	if(sauce.Character) {
		return sauce.Character.fontName;
	}
}

function sliceAtEOF(data, eofMarker) {
	var eof = data.length;
	//	:TODO: max scan back or other beter way of doing this?!	
	for(var i = data.length - 1; i > 0; i--) {
		if(data[i] === eofMarker) {
			eof = i;
			break;
		}
	}
	return data.slice(0, eof);
}

function getArtFromPath(path, options, cb) {
	fs.readFile(path, function onData(err, data) {
		if(err) {
			cb(err);
			return;
		}

		//
		//	Convert from encodedAs -> j
		//
		var ext = paths.extname(path).toLowerCase();
		var encoding = options.encodedAs || defaultEncodingFromExtension(ext);

		//	:TODO: how are BOM's currently handled if present? Are they removed? Do we need to?

		function sliceOfData() {
			if(options.fullFile === true) {
				return iconv.decode(data, encoding);
			} else {
				var eofMarker = defaultEofFromExtension(ext);
				return iconv.decode(sliceAtEOF(data, eofMarker), encoding);
			}
		}

		function getResult(sauce) {
			var result = {
				data		: sliceOfData(),
				fromPath	: path,
			};

			if(sauce) {
				result.sauce = sauce;
			}

			return result;
		}

		if(options.readSauce === true) {
			readSAUCE(data, function onSauce(err, sauce) {
				if(err) {
					cb(null, getResult());
				} else {
					//
					//	If a encoding was not provided & we have a mapping from
					//	the information provided by SAUCE, use that.
					//
					if(!options.encodedAs) {
						/*
						if(sauce.Character && sauce.Character.fontName) {
							var enc = SAUCE_FONT_TO_ENCODING_HINT[sauce.Character.fontName];
							if(enc) {
								encoding = enc;
							}
						}
						*/
					}
					cb(null, getResult(sauce));
				}
			});
		} else {
			cb(null, getResult());
		}
	});
}

function getArt(name, options, cb) {
	var ext = paths.extname(name);

	options.basePath	= miscUtil.valueWithDefault(options.basePath, conf.config.paths.art);
	options.asAnsi		= miscUtil.valueWithDefault(options.asAnsi, true);

	//	:TODO: make use of asAnsi option and convert from supported -> ansi

	if('' !== ext) {
		options.types = [ ext.toLowerCase() ];
	} else {
		if(_.isUndefined(options.types)) {
			options.types = Object.keys(SUPPORTED_ART_TYPES);
		} else if(_.isString(options.types)) {
			options.types = [ options.types.toLowerCase() ];
		}
	}

	//	If an extension is provided, just read the file now
	if('' !== ext) {
		var directPath = paths.join(options.basePath, name);
		getArtFromPath(directPath, options, cb);
		return;
	}

	fs.readdir(options.basePath, function onFiles(err, files) {
		if(err) {
			cb(err);
			return;
		}

		var filtered = files.filter(function onFile(file) {
			//
			//  Ignore anything not allowed in |options.types|
			//
			var fext = paths.extname(file);
			if(options.types.indexOf(fext.toLowerCase()) < 0) {
				return false;
			}

			var bn = paths.basename(file, fext).toLowerCase();
			if(options.random) {
				var suppliedBn = paths.basename(name, fext).toLowerCase();
				//
				//  Random selection enabled. We'll allow for
				//  basename1.ext, basename2.ext, ...
				//
				if(bn.indexOf(suppliedBn) !== 0) {
					return false;
				}
				var num = bn.substr(suppliedBn.length);
				if(num.length > 0) {
					if(isNaN(parseInt(num, 10))) {
						return false;
					}
				}
			} else {
				//
				//  We've already validated the extension (above). Must be an exact
				//  match to basename here
				//
				if(bn != paths.basename(name, fext).toLowerCase()) {
					return false;
				}
			}
			return true;
		});
	  
		if(filtered.length > 0) {
			//
			//  We should now have:
			//  - Exactly (1) item in |filtered| if non-random
			//  - 1:n items in |filtered| to choose from if random
			//
			var readPath;
			if(options.random) {
				readPath = paths.join(options.basePath, filtered[Math.floor(Math.random() * filtered.length)]);
			} else {
				assert(1 === filtered.length);
				readPath = paths.join(options.basePath, filtered[0]);
			}

			getArtFromPath(readPath, options, cb);
		} else {
			cb(new Error('No matching art for supplied criteria'));
		}
	});
}

//	:TODO: need a showArt()
//	- center (if term width > 81)
//	- interruptable
//	- pausable: by user key and/or by page size (e..g term height)


function defaultEncodingFromExtension(ext) {
	return SUPPORTED_ART_TYPES[ext.toLowerCase()].defaultEncoding;
}

function defaultEofFromExtension(ext) {
	return SUPPORTED_ART_TYPES[ext.toLowerCase()].eof;
}

//	:TODO: change to display(art, options, cb)
//	cb(err, mci)

function display(options, cb) {
	assert(_.isObject(options));
	assert(_.isObject(options.client));
	assert(!_.isUndefined(options.art));

	if(0 === options.art.length) {
		cb(new Error('Empty art'));
		return;
	}

	//	pause = none/off | end | termHeight | [ "key1", "key2", ... ]

	var cancelKeys			= miscUtil.valueWithDefault(options.cancelKeys, []);
	var pauseKeys			= miscUtil.valueWithDefault(options.pauseKeys, []);
	var pauseAtTermHeight	= miscUtil.valueWithDefault(options.pauseAtTermHeight, false);
	var mciReplaceChar		= miscUtil.valueWithDefault(options.mciReplaceChar, ' ');

	var iceColors			= options.iceColors;
	if(_.isUndefined(options.iceColors)) {
		//	detect from SAUCE, if present
		iceColors = false;
		if(_.isObject(options.sauce) && _.isNumber(options.sauce.ansiFlags)) {
			if(options.sauce.ansiFlags & (1 << 0)) {
				iceColors = true;
			}
		}
	}

	//var iceColors			= miscUtil.valueWithDefault(options.iceColors, false);

	//	:TODO: support pause/cancel & pause @ termHeight
	var canceled = false;

	var parser			= new aep.ANSIEscapeParser({
		mciReplaceChar	: mciReplaceChar,
		termHeight		: options.client.term.termHeight,
		termWidth		: options.client.term.termWidth,
	});

	var mciMap			= {};
	var mciPosQueue		= [];
	var parseComplete	= false;

	var generatedId		= 100;

	var cprListener = function(pos) {
		console.log(pos)
		if(mciPosQueue.length > 0) {
			var forMapItem = mciPosQueue.shift();
			mciMap[forMapItem].position = pos;

			if(parseComplete && 0 === mciPosQueue.length) {
				completed();
			}
		}
	};

	function completed() {
		console.log('completed')
		options.client.removeListener('cursor position report', cprListener);
		parser.removeAllListeners();	//	:TODO: Necessary???

		if(iceColors) {
		//	options.client.term.write(ansi.blinkNormal());
		}

		var extraInfo = {
			height : parser.row - 1
		};

		cb(null, mciMap, extraInfo);
	}

	options.client.on('cursor position report', cprListener);

	options.pause = 'termHeight';	//	:TODO: remove!!
	var nextPauseTermHeight = options.client.term.termHeight;
	var continous = false;


	/*
	parser.on('row update', function rowUpdate(row) {
		if(row >= nextPauseTermHeight) {
			if(!continous && 'termHeight' === options.pause) {
				//	:TODO: Must use new key type (ch, key)
				options.client.waitForKeyPress(function kp(k) {
					//	:TODO: Allow for configurable key(s) here; or none
					if('C' === k || 'c' == k) {
						continous = true;
					}
					parser.parse();
				});
				parser.stop();
			}
			nextPauseTermHeight += options.client.term.termHeight;
		}
	});
	*/

	parser.on('mci', function mciEncountered(mciInfo) {

		/*
		if('PA' === mciInfo.mci) {
			//	:TODO: can't do this until this thing is pausable anyway...
			options.client.waitForKeyPress(function kp(k) {
				console.log('got a key: ' + k);
			});
			return;
		}
		*/

		//	:TODO: ensure generatedId's do not conflict with any |id|
		//	:TODO: Bug here - should only generate & increment ID's for the initial entry, not the "focus" version 
		var id			= !_.isNumber(mciInfo.id) ? generatedId++ : mciInfo.id;
		var mapKey		= mciInfo.mci + id;
		var mapEntry	= mciMap[mapKey];
		if(mapEntry) {
			mapEntry.focusSGR	= mciInfo.SGR;
			mapEntry.focusArgs	= mciInfo.args;
		} else {
			mciMap[mapKey] = {
				args	: mciInfo.args,
				SGR		: mciInfo.SGR,
				code	: mciInfo.mci,
				id		: id,
			};

			mciPosQueue.push(mapKey);

			console.log('querying pos...')
			options.client.term.rawWrite(ansi.queryPos());
		}
	});

	parser.on('chunk', function onChunk(chunk) {
		options.client.term.write(chunk, false);
	});

	parser.on('complete', function onComplete() {
		parseComplete = true;

		if(0 === mciPosQueue.length) {
			completed();
		}		
	});

	//	:TODO: If options.font, set the font via ANSI
	//	...this should come from sauce, be passed in, or defaulted

	var ansiFont = '';
	if(options.font) {
		//	:TODO: how to set to ignore SAUCE?		
		ansiFont = ansi.setSyncTERMFont(options.font);
	} else if(options.sauce) {
		var fontName = getFontNameFromSAUCE(options.sauce);
		if(fontName) {
			fontName = ansi.getSyncTERMFontFromAlias(fontName);
		}
		
		if(fontName) {
			ansiFont = ansi.setSyncTERMFont(fontName);
		}
	}

	if(ansiFont.length > 1) {
		options.client.term.rawWrite(ansiFont);
	}


	if(iceColors) {
		options.client.term.rawWrite(ansi.blinkToBrightIntensity());
	}

	parser.reset(options.art);
	parser.parse();
	//parser.parse(options.art);
}