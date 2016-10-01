/* jslint node: true */
'use strict';

//	ENiGMA½
const Config			= require('./config.js').config;
const Errors			= require('./enig_error.js').Errors;
const sortAreasOrConfs	= require('./conf_area_util.js').sortAreasOrConfs;

//	deps
const _				= require('lodash');
const async			= require('async');

exports.getAvailableFileAreas			= getAvailableFileAreas;
exports.getSortedAvailableFileAreas		= getSortedAvailableFileAreas;
exports.getDefaultFileArea				= getDefaultFileArea;
exports.getFileAreaByTag				= getFileAreaByTag;
exports.changeFileAreaWithOptions		= changeFileAreaWithOptions;

const WellKnownAreaTags					= exports.WellKnownAreaTags = {
	Invalid				: '',
	MessageAreaAttach	: 'message_area_attach',
};

function getAvailableFileAreas(client, options) {
	options = options || { includeSystemInternal : false };

	//	perform ACS check per conf & omit system_internal if desired
	return _.omit(Config.fileAreas.areas, (area, areaTag) => {        
		if(!options.includeSystemInternal && WellKnownAreaTags.MessageAreaAttach === areaTag) {
			return true;
		}

		return !client.acs.hasFileAreaRead(area);
	});
}

function getSortedAvailableFileAreas(client, options) {
	const areas = _.map(getAvailableFileAreas(client, options), (v, k) => { 
		return {
			areaTag : k,
			area	: v
		};
	});

	sortAreasOrConfs(areas, 'area');
	return areas;
}

function getDefaultFileArea(client, disableAcsCheck) {
	let defaultArea = _.findKey(Config.fileAreas, o => o.default);
	if(defaultArea) {
		const area = Config.fileAreas.areas[defaultArea];
		if(true === disableAcsCheck || client.acs.hasFileAreaRead(area)) {
			return defaultArea;
		}
	}

	//  just use anything we can
	defaultArea = _.findKey(Config.fileAreas.areas, (area, areaTag) => {
		return WellKnownAreaTags.MessageAreaAttach !== areaTag && (true === disableAcsCheck || client.acs.hasFileAreaRead(area));
	});
    
	return defaultArea;
}

function getFileAreaByTag(areaTag) {
	return Config.fileAreas.areas[areaTag];
}

function changeFileAreaWithOptions(client, areaTag, options, cb) {
	async.waterfall(
		[
			function getArea(callback) {
				const area = getFileAreaByTag(areaTag);
				return callback(area ? null : Errors.Invalid('Invalid file areaTag'), area);
			},
			function validateAccess(area, callback) {
				if(!client.acs.hasFileAreaRead(area)) {
					return callback(Errors.AccessDenied('No access to this area'));
				}
			},
			function changeArea(area, callback) {
				if(true === options.persist) {
					client.user.persistProperty('file_area_tag', areaTag, err => {
						return callback(err, area);
					});
				} else {
					client.user.properties['file_area_tag'] = areaTag;
					return callback(null, area);
				}
			}
		],
		(err, area) => {
			if(!err) {
				client.log.info( { areaTag : areaTag, area : area }, 'Current file area changed');
			} else {
				client.log.warn( { areaTag : areaTag, area : area, error : err.message }, 'Could not change file area');
			}

			return cb(err);
		}
	);
}
