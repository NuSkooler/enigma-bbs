/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var userDb			= require('../core/database.js').dbs.user;
var ViewController	= require('../core/view_controller.js').ViewController;
var TextView		= require('../core/text_view.js').TextView;

var util			= require('util');
var moment			= require('moment');
var async			= require('async');
var assert			= require('assert');
var _				= require('lodash');

exports.moduleInfo = {
	name		: 'Last Callers',
	desc		: 'Last callers to the system',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.lastcallers'
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
	var lc		= [];
	var rows	= self.rows;

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
			//	:TODO: a public method of getLastCallers(count) would be better
			function fetchHistory(callback) {
				userDb.each(
					'SELECT user_id, user_name, timestamp '	+
					'FROM user_login_history '				+
					'ORDER BY timestamp DESC '				+
					'LIMIT ' + rows + ';',
					function historyRow(err, histEntry) {
						lc.push( {
							userId	: histEntry.user_id,
							who		: histEntry.user_name,
							when	: histEntry.timestamp,
						} );
					},
					function complete(err, recCount) {
						rows = recCount;	//	adjust to retrieved
						callback(err);
					}
				);
			},
			function fetchUserProperties(callback) {
				async.each(lc, function callEntry(c, next) {
					userDb.each(
						'SELECT prop_name, prop_value '	+ 
						'FROM user_property '			+
						'WHERE user_id=? AND (prop_name="location" OR prop_name="affiliation");',
						[ c.userId ],
						function propRow(err, propEntry) {
							c[propEntry.prop_name] = propEntry.prop_value;
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

				lc.forEach(function lastCaller(c) {
					if(row === views.who.position.row) {
						views.who.setText(c.who);
						views.location.setText(c.location);
						views.affils.setText(c.affiliation);
						views.when.setText(moment(c.when).format(self.dateTimeFormat));
					} else {
						addView(views.who, c.who);
						addView(views.location, c.location);
						addView(views.affils, c.affiliation);
						addView(views.when, moment(c.when).format(self.dateTimeFormat));
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
