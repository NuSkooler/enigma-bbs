/* jslint node: true */
'use strict';

//	deps
const _			= require('lodash');

const mimeTypes	= require('mime-types');

exports.startup				= startup;
exports.resolveMimeType		= resolveMimeType;

function startup(cb) {
	//
	//	Add in types (not yet) supported by mime-db -- and therefor, mime-types
	//
	const ADDITIONAL_EXT_MIMETYPES = {
		arj				: 'application/x-arj',
		ans				: 'text/x-ansi',		
	};

	_.forEach(ADDITIONAL_EXT_MIMETYPES, (mimeType, ext) => {
		//	don't override any entries
		if(!_.isString(mimeTypes.types[ext])) {
			mimeTypes[ext] = mimeType;
		}
	});

	return cb(null);
}

function resolveMimeType(query) {
	if(mimeTypes.extensions[query]) {
		return query;	//	alreaed a mime-type
	}
	
	return mimeTypes.lookup(query) || undefined;	//	lookup() returns false; we want undefined
}