/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var userDb				= require('../core/database.js').dbs.user;
var ViewController		= require('../core/view_controller.js').ViewController;
var getSystemLoginHistory	= require('../core/stats.js').getSystemLoginHistory;

var moment				= require('moment');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

/*
	Available listFormat object members:
	userId
	userName
	location
	affiliation
	ts
	
*/

exports.moduleInfo = {
	name		: 'Last Callers',
	desc		: 'Last callers to the system',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.lastcallers'	//	:TODO: concept idea for mods
};

exports.getModule	= LastCallersModule;

var MciCodeIds = {
	CallerList		: 1,
};

function LastCallersModule(options) {
	MenuModule.call(this, options);
}

require('util').inherits(LastCallersModule, MenuModule);

LastCallersModule.prototype.mciReady = function(mciData, cb) {
	var self		= this;
	var vc			= self.viewControllers.allViews = new ViewController( { client : self.client } );

	var loginHistory;
	var callersView;

	async.series(
		[
			function callParentMciReady(callback) {
				LastCallersModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu,
					noInput			: true,
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function fetchHistory(callback) {
				callersView = vc.getView(MciCodeIds.CallerList);

				getSystemLoginHistory(callersView.dimens.height, function historyRetrieved(err, lh) {
					loginHistory = lh;
					callback(err);
				});
			},
			function fetchUserProperties(callback) {
				async.each(loginHistory, function entry(histEntry, next) {
					userDb.each(
						'SELECT prop_name, prop_value '	+ 
						'FROM user_property '			+
						'WHERE user_id=? AND (prop_name="location" OR prop_name="affiliation");',
						[ histEntry.userId ],
						function propRow(err, propEntry) {
							histEntry[propEntry.prop_name] = propEntry.prop_value;
						},
						function complete(err) {
							next();
						}
					);
				}, function complete(err) {
					callback(err);
				});
			},
			function populateList(callback) {
				var listFormat 	= self.menuConfig.config.listFormat || '{userName} - {location} - {affils} - {ts}';
				var dateTimeFormat	= self.menuConfig.config.dateTimeFormat || 'ddd MMM DD';

				callersView.setItems(_.map(loginHistory, function formatCallEntry(ce) {
					return listFormat.format({
						userId		: ce.userId,
						userName	: ce.userName,
						ts			: moment(ce.timestamp).format(dateTimeFormat),
						location	: ce.location,
						affils		: ce.affiliation,
					});
				}));

				//	:TODO: This is a hack until pipe codes are better implemented
				callersView.focusItems = callersView.items;

				callersView.redraw();
				callback(null);
			}
		],
		function complete(err) {
			if(err) {
				self.client.log.error( { error : err.toString() }, 'Error loading last callers');
			}
			cb(err);
		}
	);
};
