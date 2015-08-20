/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;
var Config			= require('./config.js').config;

var async			= require('async');
var _				= require('lodash');
var assert			= require('assert');

exports.getAvailableMessageAreas			= getAvailableMessageAreas;
exports.changeMessageArea					= changeMessageArea;

function getAvailableMessageAreas() {
	return Config.messages.areas;
}

function changeMessageArea(client, areaName, cb) {
	
	async.waterfall(
		[
			function getArea(callback) {
				var availAreas = getAvailableMessageAreas();

				areaName	= areaName.toLowerCase();	//	always lookup lowercase
				var index	= _.findIndex(availAreas, function pred(a) {
					return a.name === areaName;
				});

				if(index > -1) {
					callback(null, availAreas[index]);
				} else {
					callback(new Error('Invalid message area'));
				}
			},
			function validateAccess(area, callback) {
				//	:TODO: validate user has access to |area| -- must belong to group(s) specified
				callback(null, area);
			},
			function changeArea(area, callback) {
				client.user.persistProperties( { message_area_name : area.name, message_area_desc : area.desc }, function persisted(err) {
					callback(err, area);
				});
			}
		],
		function complete(err, area) {
			if(!err) {
				client.log.info( area, 'Current message area changed');
			} else {
				client.log.warn( { area : area, error : err.message }, 'Could not change message area');
			}

			cb(err);
		}
	);
}
