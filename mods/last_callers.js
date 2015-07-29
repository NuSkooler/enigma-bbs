/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var userDb				= require('../core/database.js').dbs.user;
var ViewController		= require('../core/view_controller.js').ViewController;
var TextView			= require('../core/text_view.js').TextView;
var getUserLoginHistory	= require('../core/stats.js').getUserLoginHistory;

var util				= require('util');
var moment				= require('moment');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.moduleInfo = {
	name		: 'Last Callers',
	desc		: 'Last callers to the system',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.lastcallers'	//	:TODO: concept idea for mods
};

exports.getModule	= LastCallersModule;

//	:TODO:
//	*	config.evenRowSGR (optional)

function LastCallersModule(options) {
	MenuModule.call(this, options);

	var self		= this;
	this.menuConfig	= options.menuConfig;

	this.rows			= 10;
	
	if(this.menuConfig.config) {
		if(_.isNumber(this.menuConfig.config.rows)) {
			this.rows = Math.max(1, this.menuConfig.config.rows);
		}
		if(_.isString(this.menuConfig.config.dateTimeFormat)) {
			this.dateTimeFormat = this.menuConfig.config.dateTimeFormat;
		}
	}
}

util.inherits(LastCallersModule, MenuModule);

LastCallersModule.prototype.enter = function(client) {
	LastCallersModule.super_.prototype.enter.call(this, client);

	//	we need the client to init this for theming
	if(!_.isString(this.dateTimeFormat)) {
		this.dateTimeFormat = this.client.currentTheme.helpers.getDateFormat('short') +
			this.client.currentTheme.helpers.getTimeFormat('short');
	}
};

LastCallersModule.prototype.mciReady = function(mciData) {
	LastCallersModule.super_.prototype.mciReady.call(this, mciData);

	var self	= this;
	var vc		= self.viewControllers.lastCallers = new ViewController( { client : self.client } );
	var loginHistory;

	async.series(
		[
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu	: self,
					mciMap		: mciData.menu,
					noInput		: true,
				};

				vc.loadFromMenuConfig(loadOpts, function startingViewReady(err) {
					callback(err);
				});
			},
			function fetchHistory(callback) {
				getUserLoginHistory(self.rows, function historyRetrieved(err, lh) {
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
			function createAndPopulateViews(callback) {
				//
				//	TL1 = who
				//	TL2 = location
				//	TL3 = affiliation
				//	TL4 = when
				//
				//	These form the order/layout for a row. Additional rows
				//	will use them as a template.
				//
				var views = {
					who			: vc.getView(1),
					location	: vc.getView(2),
					affils		: vc.getView(3),
					when		: vc.getView(4),
				};

				var row = views.who.position.row;

				var nextId = 5;

				function addView(templateView, text) {
					//	:TODO: Is there a better way to clone this when dealing with instances?
					var v = new TextView( {
						client			: self.client,
						id				: nextId++,
						position		: { row : row, col : templateView.position.col },
						ansiSGR			: templateView.ansiSGR,
						textStyle		: templateView.textStyle,
						textOverflow	: templateView.textOverflow,
						dimens			: templateView.dimens,
						resizable		: templateView.resizable,
					} );

					v.id			= nextId++;
					v.position.row	= row;

					v.setPropertyValue('text', text);
					vc.addView(v);
				};

				loginHistory.forEach(function entry(histEntry) {
					if(row === views.who.position.row) {
						views.who.setText(histEntry.userName);
						views.location.setText(histEntry.location);
						views.affils.setText(histEntry.affiliation);
						views.when.setText(moment(histEntry.timestamp).format(self.dateTimeFormat));
					} else {
						addView(views.who, histEntry.userName);
						addView(views.location, histEntry.location);
						addView(views.affils, histEntry.affiliation);
						addView(views.when, moment(histEntry.timestamp).format(self.dateTimeFormat));
					}

					row++;
				});
			}
		],
		function complete(err) {
			self.client.log.error(err);
		}
	);
};
