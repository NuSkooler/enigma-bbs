/* jslint node: true */
'use strict';

//	ENiGMA½
const Config	= require('./config.js').config;
const StatLog	= require('./stat_log.js');

//	deps
const _			= require('lodash');
const assert	= require('assert');

exports.parseAsset				= parseAsset;
exports.getAssetWithShorthand	= getAssetWithShorthand;
exports.getArtAsset				= getArtAsset;
exports.getModuleAsset			= getModuleAsset;
exports.resolveConfigAsset		= resolveConfigAsset;
exports.resolveSystemStatAsset	= resolveSystemStatAsset;
exports.getViewPropertyAsset	= getViewPropertyAsset;

const ALL_ASSETS = [
	'art',
	'menu',
	'method',
	'userModule',
	'systemMethod',
	'systemModule',
	'prompt',
	'config',
	'sysStat',
];

const ASSET_RE = new RegExp('\\@(' + ALL_ASSETS.join('|') + ')\\:([\\w\\d\\.]*)(?:\\/([\\w\\d\\_]+))*');

function parseAsset(s) {
	const m = ASSET_RE.exec(s);

	if(m) {
		let result = { type : m[1] };

		if(m[3]) {
			result.location = m[2];
			result.asset	= m[3];
		} else {
			result.asset	= m[2];
		}

		return result;
	}
}

function getAssetWithShorthand(spec, defaultType) {
	if(!_.isString(spec)) {
		return null;
	}

	if('@' === spec[0]) {
		const asset = parseAsset(spec);
		assert(_.isString(asset.type));

		return asset;
	}

	return {
		type	: defaultType,
		asset	: spec,
	};
}

function getArtAsset(spec) {
	const asset = getAssetWithShorthand(spec, 'art');

	if(!asset) {
		return null;
	}

	assert( ['art', 'method' ].indexOf(asset.type) > -1);
	return asset;
}

function getModuleAsset(spec) {
	const asset = getAssetWithShorthand(spec, 'systemModule');

	if(!asset) {
		return null;
	}

	assert( ['userModule', 'systemModule' ].includes(asset.type) );

	return asset;
}

function resolveConfigAsset(spec) {
	const asset = parseAsset(spec);
	if(asset) {
		assert('config' === asset.type);

		const path	= asset.asset.split('.');
		let conf	= Config;
		for(let i = 0; i < path.length; ++i) {
			if(_.isUndefined(conf[path[i]])) {
				return spec;
			}
			conf = conf[path[i]];
		}
		return conf;
	} else {
		return spec;
	}
}

function resolveSystemStatAsset(spec) {
	const asset = parseAsset(spec);
	if(!asset) {
		return spec;
	}

	assert('sysStat' === asset.type);

	return StatLog.getSystemStat(asset.asset) || spec;
}

function getViewPropertyAsset(src) {
	if(!_.isString(src) || '@' !== src.charAt(0)) {
		return null;
	}

	return parseAsset(src);
}
