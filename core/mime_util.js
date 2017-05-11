/* jslint node: true */
'use strict';

const mimeTypes	= require('mime-types');

exports.resolveMimeType		= resolveMimeType;

function resolveMimeType(query) {
	return mimeTypes.extension(query) || mimeTypes.lookup(query) || undefined;	//	lookup() returns false; we want undefined
}