/* jslint node: true */
'use strict';

//	ENiGMA½
const Config		= require('./config.js').config;
const Log			= require('./logger.js').log;

//	deps
const _				= require('lodash');

exports.getAvailableFileAreas			= getAvailableFileAreas;

exports.getFileAreaByTag				= getFileAreaByTag;

function getAvailableFileAreas(client, options) {
	options = options || { includeSystemInternal : false };

	//	perform ACS check per conf & omit system_internal if desired
	return _.omit(Config.fileAreas.areas, (area, areaTag) => {        
	/*	if(!options.includeSystemInternal && 'system_internal' === confTag) {
			return true;
		}*/

		return !client.acs.hasFileAreaRead(area);
	});
}


function getFileAreaByTag(areaTag) {
	return Config.fileAreas.areas[areaTag];
}