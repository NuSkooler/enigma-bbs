/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;

var async			= require('async');
var _				= require('lodash');
var assert			= require('assert');

exports.getAvailableMessageAreas			= getAvailableMessageAreas;
exports.changeCurrentArea					= changeCurrentArea;

//	:TODO: need total / new + other stats
function getAvailableMessageAreas(cb) {
	var areas = [];	//	{ areaId, name, groupIds[] }
	
	async.series(
		[
			function getAreas(callback) {
				msgDb.all(
					'SELECT area_id, area_name '	+ 
					'FROM message_area;',
					function areaResults(err, areaRows) {
						if(err) {
							callback(err);
						} else {
							areaRows.forEach(function entry(ar) {
								areas.push( {
									areaId		: ar.area_id,
									name		: ar.area_name,
								});
							});

							callback(null);
						}
					}
				);
			},
			function getAreaGroups(callback) {
				var query = msgDb.prepare(
					'SELECT group_id '			+
					'FROM message_area_group '	+
					'WHERE area_id=?;');

				async.each(areas, function area(a, next) {
					query.all( [ a.areaId ], function groupRows(err, groups) {
						a.groupIds = groups;
						next(err);
					});
				},
				function complete(err) {
					query.finalize(function finalized(err2) {
						callback(err);	//	use orig err
					});
				});				
			}
		],
		function complete(err) {
			cb(err, areas);
		}
	);

}

function changeCurrentArea(client, areaId, cb) {
	async.series(
		[
			function validateAccess(callback) {
				//	:TODO: validate user has access to areaId -- must belong to group(s) specified
				callback(null);
			},
			function changeArea(callback) {
				client.user.persistProperty('message_area_id', areaId, function persisted(err) {
					callback(err);
				});
			},
			function cacheAreaName(callback) {
				msgDb.get(
					'SELECT area_name '		+
					'FROM message_area '	+
					'WHERE area_id=? '		+
					'LIMIT 1;',
					[ areaId ],
					function got(err, row) {
						//	note: failures here are non-fatal
						if(err) {
							callback(null);
						} else {
							client.user.persistProperty('message_area_name', row.area_name, function persisted(err) {
								callback(null);
							});
						}
					}
				);
			}
		],
		function complete(err) {
			if(!err) {
				client.log.info( { areaId : areaId }, 'Current message area changed');
			} else {
				client.log.warn( { areaId : areaId, error : err.message }, 'Could not change message area');
			}

			cb(err);
		}
	);
}