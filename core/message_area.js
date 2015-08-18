/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;

var async			= require('async');
var _				= require('lodash');
var assert			= require('assert');

exports.getAvailableMessageAreas			= getAvailableMessageAreas;

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