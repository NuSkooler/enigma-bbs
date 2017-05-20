/* jslint node: true */
'use strict';

const mimeTypes	= require('mime-types');

exports.resolveMimeType		= resolveMimeType;

function resolveMimeType(query) {
	if(mimeTypes.extensions[query]) {
		return query;	//	alreaed a mime-type
	}
	
	return mimeTypes.lookup(query) || undefined;	//	lookup() returns false; we want undefined
}