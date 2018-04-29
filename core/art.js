/* jslint node: true */
'use strict';

//	ENiGMA½
const Config	= require('./config.js').config;
const miscUtil	= require('./misc_util.js');
const ansi		= require('./ansi_term.js');
const aep		= require('./ansi_escape_parser.js');
const sauce		= require('./sauce.js');

//	deps
const fs		= require('graceful-fs');
const paths		= require('path');
const assert	= require('assert');
const iconv		= require('iconv-lite');
const _			= require('lodash');
const xxhash	= require('xxhash');

exports.getArt							= getArt;
exports.getArtFromPath					= getArtFromPath;
exports.display							= display;
exports.defaultEncodingFromExtension	= defaultEncodingFromExtension;

//	:TODO: Return MCI code information
//	:TODO: process SAUCE comments
//	:TODO: return font + font mapped information from SAUCE

const SUPPORTED_ART_TYPES = {
	//	:TODO: the defualt encoding are really useless if they are all the same ...
	//	perhaps .ansamiga and .ascamiga could be supported as well as overrides via conf
	'.ans'	: { name : 'ANSI',		defaultEncoding : 'cp437',	eof : 0x1a	},
	'.asc'	: { name : 'ASCII',		defaultEncoding : 'cp437',	eof : 0x1a  },
	'.pcb'	: { name : 'PCBoard',	defaultEncoding : 'cp437',	eof : 0x1a  },
	'.bbs'	: { name : 'Wildcat',	defaultEncoding : 'cp437',	eof : 0x1a  },

	'.amiga'	: { name : 'Amiga',			defaultEncoding	: 'amiga',	eof : 0x1a },
	'.txt'		: { name : 'Amiga Text',	defaultEncoding : 'cp437',	eof : 0x1a  },
	//	:TODO: extentions for wwiv, renegade, celerity, syncronet, ...
	//	:TODO: extension for atari
	//	:TODO: extension for topaz ansi/ascii.
};

function getFontNameFromSAUCE(sauce) {
	if(sauce.Character) {
		return sauce.Character.fontName;
	}
}

function sliceAtEOF(data, eofMarker) {
	let eof			= data.length;
	const stopPos	= Math.max(data.length - (256), 0);	//	256 = 2 * sizeof(SAUCE)

	for(let i = eof - 1; i > stopPos; i--) {
		if(eofMarker === data[i]) {
			eof = i;
			break;
		}
	}
	return data.slice(0, eof);
}

function getArtFromPath(path, options, cb) {
	fs.readFile(path, (err, data) => {
		if(err) {
			return cb(err);
		}

		//
		//	Convert from encodedAs -> j
		//
		const ext		= paths.extname(path).toLowerCase();
		const encoding	= options.encodedAs || defaultEncodingFromExtension(ext);

		//	:TODO: how are BOM's currently handled if present? Are they removed? Do we need to?

		function sliceOfData() {
			if(options.fullFile === true) {
				return iconv.decode(data, encoding);
			} else {
				const eofMarker = defaultEofFromExtension(ext);
				return iconv.decode(eofMarker ? sliceAtEOF(data, eofMarker) : data, encoding);
			}
		}

		function getResult(sauce) {
			const result = {
				data		: sliceOfData(),
				fromPath	: path,
			};

			if(sauce) {
				result.sauce = sauce;
			}

			return result;
		}

		if(options.readSauce === true) {
			sauce.readSAUCE(data, (err, sauce) => {
				if(err) {
					return cb(null, getResult());
				}

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
				return cb(null, getResult(sauce));
			});
		} else {
			return cb(null, getResult());
		}
	});
}

function getArt(name, options, cb) {
	const ext = paths.extname(name);

	options.basePath	= miscUtil.valueWithDefault(options.basePath, Config.paths.art);
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
		const directPath = paths.join(options.basePath, name);
		return getArtFromPath(directPath, options, cb);
	}

	fs.readdir(options.basePath, (err, files) => {
		if(err) {
			return cb(err);
		}

		const filtered = files.filter( file => {
			//
			//  Ignore anything not allowed in |options.types|
			//
			const fext = paths.extname(file);
			if(!options.types.includes(fext.toLowerCase())) {
				return false;
			}

			const bn = paths.basename(file, fext).toLowerCase();
			if(options.random) {
				const suppliedBn = paths.basename(name, fext).toLowerCase();

				//
				//  Random selection enabled. We'll allow for
				//  basename1.ext, basename2.ext, ...
				//
				if(!bn.startsWith(suppliedBn)) {
					return false;
				}

				const num = bn.substr(suppliedBn.length);
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
			let readPath;
			if(options.random) {
				readPath = paths.join(options.basePath, filtered[Math.floor(Math.random() * filtered.length)]);
			} else {
				assert(1 === filtered.length);
				readPath = paths.join(options.basePath, filtered[0]);
			}

			return getArtFromPath(readPath, options, cb);
		}

		return cb(new Error(`No matching art for supplied criteria: ${name}`));
	});
}

function defaultEncodingFromExtension(ext) {
	const artType = SUPPORTED_ART_TYPES[ext.toLowerCase()];
	return artType ? artType.defaultEncoding : 'utf8';
}

function defaultEofFromExtension(ext) {
	const artType = SUPPORTED_ART_TYPES[ext.toLowerCase()];
	if(artType) {
		return artType.eof;
	}
}

//	:TODO: Implement the following
//	* Pause (disabled | termHeight | keyPress )
//	* Cancel (disabled | <keys> )
//	* Resume from pause -> continous (disabled | <keys>)
function display(client, art, options, cb) {
	if(_.isFunction(options) && !cb) {
		cb = options;
		options = {};
	}

	if(!art || !art.length) {
		return cb(new Error('Empty art'));
	}

	options.mciReplaceChar 	= options.mciReplaceChar || ' ';
	options.disableMciCache	= options.disableMciCache || false;

	//	:TODO: this is going to be broken into two approaches controlled via options:
	//	1) Standard - use internal tracking of locations for MCI -- no CPR's/etc.
	//	2) CPR driven

	if(!_.isBoolean(options.iceColors)) {
		//	try to detect from SAUCE
		if(_.has(options, 'sauce.ansiFlags') && (options.sauce.ansiFlags & (1 << 0))) {
			options.iceColors = true;
		}
	}

	const ansiParser = new aep.ANSIEscapeParser({
		mciReplaceChar	: options.mciReplaceChar,
		termHeight		: client.term.termHeight,
		termWidth		: client.term.termWidth,
		trailingLF		: options.trailingLF,
	});

	let parseComplete = false;
	let cprListener;
	let mciMap;
	const mciCprQueue = [];
	let artHash;
	let mciMapFromCache;

	function completed() {
		if(cprListener) {
			client.removeListener('cursor position report', cprListener);
		}

		if(!options.disableMciCache && !mciMapFromCache) {
			//	cache our MCI findings...
			client.mciCache[artHash] = mciMap;
			client.log.trace( { artHash : artHash.toString(16), mciMap : mciMap }, 'Added MCI map to cache');
		}

		ansiParser.removeAllListeners();	//	:TODO: Necessary???

		const extraInfo = {
			height : ansiParser.row - 1,
		};

		return cb(null, mciMap, extraInfo);
	}

	if(!options.disableMciCache) {
		artHash	= xxhash.hash(Buffer.from(art), 0xCAFEBABE);

		//	see if we have a mciMap cached for this art
		if(client.mciCache) {
			mciMap	= client.mciCache[artHash];
		}
	}

	if(mciMap) {
		mciMapFromCache = true;
		client.log.trace( { artHash : artHash.toString(16), mciMap : mciMap }, 'Loaded MCI map from cache');
	} else {
		//	no cached MCI info
		mciMap = {};

		cprListener = function(pos) {
			if(mciCprQueue.length > 0) {
				mciMap[mciCprQueue.shift()].position = pos;

				if(parseComplete && 0 === mciCprQueue.length) {
					return completed();
				}
			}
		};

		client.on('cursor position report', cprListener);

		let generatedId = 100;

		ansiParser.on('mci', mciInfo => {
			//	:TODO: ensure generatedId's do not conflict with any existing |id|
			const id		= _.isNumber(mciInfo.id) ? mciInfo.id : generatedId;
			const mapKey	= `${mciInfo.mci}${id}`;
			const mapEntry	= mciMap[mapKey];

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

				if(!mciInfo.id) {
					++generatedId;
				}

				mciCprQueue.push(mapKey);
				client.term.rawWrite(ansi.queryPos());
			}

		});
	}

	ansiParser.on('literal', literal => client.term.write(literal, false) );
	ansiParser.on('control', control => client.term.rawWrite(control) );

	ansiParser.on('complete', () => {
		parseComplete = true;

		if(0 === mciCprQueue.length) {
			return completed();
		}
	});

	let initSeq = '';
	if(options.font) {
		initSeq = ansi.setSyncTermFontWithAlias(options.font);
	} else if(options.sauce) {
		let fontName = getFontNameFromSAUCE(options.sauce);
		if(fontName) {
			fontName = ansi.getSyncTERMFontFromAlias(fontName);
		}

		//
		//	Set SyncTERM font if we're switching only. Most terminals
		//	that support this ESC sequence can only show *one* font
		//	at a time. This applies to detection only (e.g. SAUCE).
		//	If explicit, we'll set it no matter what (above)
		//
		if(fontName && client.term.currentSyncFont != fontName) {
			client.term.currentSyncFont = fontName;
			initSeq = ansi.setSyncTERMFont(fontName);
		}
	}

	if(options.iceColors) {
		initSeq += ansi.blinkToBrightIntensity();
	}

	if(initSeq) {
		client.term.rawWrite(initSeq);
	}

	ansiParser.reset(art);
	return ansiParser.parse();
}
