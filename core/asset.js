/* jslint node: true */
'use strict';

var Config		= require('./config.js').config;
var theme		= require('./theme.js');

var _			= require('lodash');
var assert		= require('assert');

exports.parseAsset				= parseAsset;
exports.getArtAsset				= getArtAsset;
exports.resolveConfigAsset		= resolveConfigAsset;
exports.getViewPropertyAsset	= getViewPropertyAsset;
exports.displayArtAsset			= displayArtAsset;

var ALL_ASSETS = [
	'art',
	'menu',
	'method',
	'systemMethod',
	'prompt',
	'config',
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

function getArtAsset(art) {
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

function resolveConfigAsset(from) {
	var asset = parseAsset(from);
	if(asset) {
		assert('config' === asset.type);

		var path = asset.asset.split('.');
		var conf = Config;
		for(var i = 0; i < path.length; ++i) {
			if(_.isUndefined(conf[path[i]])) {
				return from;
			}
			conf = conf[path[i]];
		}
		return conf;
	} else {
		return from;
	}
}

function getViewPropertyAsset(src) {
	if(!_.isString(src) || '@' !== src.charAt(0)) {
		return null;
	}

	return parseAsset(src);
};

function displayArtAsset(assetSpec, client, options, cb) {
	assert(_.isObject(client));

	//	options are... optional
	if(3 === arguments.length) {
		cb = options;
		options = {};
	}

	var artAsset = getArtAsset(assetSpec);
	if(!artAsset) {
		cb(new Error('Asset not found: ' + assetSpec));
		return;
	}

	var dispOpts = {
		name	: artAsset.asset,
		client	: client,
		font	: options.font,
	};

	switch(artAsset.type) {
		case 'art' :
			theme.displayThemeArt(dispOpts, function displayed(err, artData) {
				cb(err, err ? null : { mciMap : artData.mciMap, height : artData.extraInfo.height } );
			});
			break;

		case 'method' : 
			//	:TODO: fetch & render via method
			break;

		case 'inline ' :
			//	:TODO: think about this more in relation to themes, etc. How can this come
			//	from a theme (with override from menu.json) ???
			//	look @ client.currentTheme.inlineArt[name] -> menu/prompt[name]
			break;

		default :
			cb(new Error('Unsupported art asset type: ' + artAsset.type));
			break;
	}
}