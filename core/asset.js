/* jslint node: true */
'use strict';

var _			= require('lodash');
var assert		= require('assert');

exports.parseAsset			= parseAsset;
exports.getArtAsset			= getArtAsset;

var ALL_ASSETS = [
	'art',
	'menu',
	'method',
	'prompt',
];

var ASSET_RE = new RegExp('\\@(' + ALL_ASSETS.join('|') + ')\\:([\\w\\d\\.]*)(?:\\/([\\w\\d\\_]+))*');

function parseAsset(s) {	
	var m = ASSET_RE.exec(s);

	if(m) {
		var result = { type : m[1] };

		if(m[3]) {
			result.location = m[2];
			result.asset	= m[3];
		} else {
			result.asset	= m[2];
		}

		return result;
	}
}

function getArtAsset(art, cb) {
	if(!_.isString(art)) {
		return null;
	}

	if('@' === art[0]) {
		var artAsset = parseAsset(art);
		assert('art' === artAsset.type || 'method' === artAsset.type);

		return artAsset;
	} else {
		return {
			type	: 'art',
			asset	: art,
		};
	}
}