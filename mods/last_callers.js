/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var userDb			= require('../core/database.js').dbs.user;
var ViewController	= require('../core/view_controller.js').ViewController;

var util			= require('util');
var moment			= require('moment');
var async			= require('async');
var assert			= require('assert');
var _				= require('lodash');

exports.moduleInfo = {
	name	: 'Last Callers',
	desc	: 'Last 10 callers to the system',
	author	: 'NuSkooler',
};

exports.getModule	= LastCallersModule;

//	:TODO:
//	* Order should be menu/theme defined
//	* Text needs overflow defined (optional), e.g. "..."
//	* Date/time format should default to theme short date + short time
//	* 

function LastCallersModule(options) {
	MenuModule.call(this, options);

	var self		= this;
	this.menuConfig	= options.menuConfig;

	this.menuMethods = {
		getLastCaller : function(formData, extraArgs) {
			//console.log(self.lastCallers[self.lastCallerIndex])
			var lc = self.lastCallers[self.lastCallerIndex++];
			var when	= moment(lc.timestamp).format(self.menuConfig.config.dateTimeFormat);
			return util.format('%s         %s         %s       %s', lc.name, lc.location, lc.affiliation, when);
		}
	};
}

util.inherits(LastCallersModule, MenuModule);

/*
LastCallersModule.prototype.enter = function(client) {
	LastCallersModule.super_.prototype.enter.call(this, client);

	var self				= this;
	self.lastCallers		= [];
	self.lastCallerIndex	= 0;

	var userInfoStmt = userDb.prepare(
		'SELECT prop_name, prop_value '	+ 
		'FROM user_property '			+
		'WHERE user_id=? AND (prop_name=? OR prop_name=?);');

	var caller;

	userDb.each(
		'SELECT user_id, user_name, timestamp '		+
		'FROM user_login_history '		+
		'ORDER BY timestamp DESC '	+
		'LIMIT 10;',
		function userRows(err, userEntry) {
			caller = { 
				who		: userEntry.user_name,
				when	: userEntry.timestamp,
			};

			userInfoStmt.each( [ userEntry.user_id, 'location', 'affiliation' ], function propRow(err, propEntry) {
				if(!err) {
					caller[propEntry.prop_name] = propEntry.prop_value;
				}
			}, function complete(err) {
				if(!err) {
					self.lastCallers.push(caller);
				}
			});
		}
	);
};
*/

/*
LastCallersModule.prototype.mciReady = function(mciData) {
	LastCallersModule.super_.prototype.mciReady.call(this, mciData);

	//	 we do this so other modules can be both customized and still perform standard tasks
	LastCallersModule.super_.prototype.standardMCIReadyHandler.call(this, mciData);
};
*/

LastCallersModule.prototype.mciReady = function(mciData) {
	LastCallersModule.super_.prototype.mciReady.call(this, mciData);

	var self	= this;
	var vc		= self.viewControllers.lastCallers = new ViewController( { client : self.client } );
	var lc		= [];
	var count	= _.size(mciData.menu) / 4;

	if(count < 1) {
		//	:TODO: Log me!
		return;
	}

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
				userDb.each(
					'SELECT user_id, user_name, timestamp '	+
					'FROM user_login_history '				+
					'ORDER BY timestamp DESC '				+
					'LIMIT ' + count + ';',
					function historyRow(err, histEntry) {
						lc.push( {
							userId	: histEntry.user_id,
							who		: histEntry.user_name,
							when	: histEntry.timestamp,
						} );
					},
					function complete(err, recCount) {
						count = recCount;	//	adjust to retrieved
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
				assert(lc.length === count);

				var rowsPerColumn = count / 4;

				//
				//	TL1...count				= who
				//	TL<count>...<count*2>	= location
				//
				var i;
				var v;
				for(i = 0; i < rowsPerColumn; ++i) {
					v = vc.getView(i + 1);
					v.setText(lc[i].who);
				}

				for( ; i < rowsPerColumn * 2; ++i) {
					v = vc.getView(i + 1);
					v.setText(lc[i].location);
				}

				//

				//	1..count/4 = who
				//	count/10

				/*
				var viewOpts = {
					client		: self.client,					
				};

				var rowViewId = 1;
				var v;
				lc.forEach(function lcEntry(caller) {
					v = vc.getView(rowViewId++);

					self.menuConfig.config.fields.forEach(function field(f) {
						switch(f.name) {
							case 'who' :

						}
					});

					v.setText(caller.who)
				});
				*/

			}
		],
		function complete(err) {
			console.log(lc)
		}
	);
};


/*
LastCallersModule.prototype.mciReady = function(mciData) {
	LastCallersModule.super_.prototype.mciReady.call(this, mciData);

	var lastCallers = [];
	var self		= this;

	//	:TODO: durp... need a table just for this so dupes are possible
	
	var userInfoStmt = userDb.prepare(
		'SELECT prop_name, prop_value '	+ 
		'FROM user_property '			+
		'WHERE user_id=? AND (prop_name=? OR prop_name=?);');

	var caller;

	userDb.each(
		'SELECT id, user_name, timestamp '		+
		'FROM user_last_login '		+
		'ORDER BY timestamp DESC '	+
		'LIMIT 10;',
		function userRows(err, userEntry) {
			caller = { name : userEntry.user_name };

			userInfoStmt.each(userEntry.id, 'location', 'affiliation', function propRow(err, propEntry) {
				console.log(propEntry)
				if(!err) {
					caller[propEntry.prop_name] = propEntry.prop_value;
				}
			}, function complete(err) {
				lastCallers.push(caller);
			});
		},
		function complete(err) {
			//
			//	TL1=name, TL2=location, TL3=affils
			//	TL4=name, TL5=location,	...
			//  ...
			//	TL28=name, TL29=location, TL30=affils
			//
			var lc = self.viewControllers.lastCallers = new ViewController( { client : self.client });

			var loadOpts = {
				callingMenu	: self,
				mciMap		: mciData.menu,
				noInput		: true,
			};

			self.viewControllers.lastCallers.loadFromMenuConfig(loadOpts, function viewsReady(err) {
							console.log(lastCallers);
				var callerIndex = 0;
				for(var i = 1; i < 30; i += 3) {
					if(lastCallers.length > callerIndex) {
						lc.getView(i).setText(lastCallers[callerIndex].name);
						lc.getView(i + 1).setText(lastCallers[callerIndex].location);
						lc.getView(i + 2).setText(lastCallers[callerIndex].affiliation);
						++callerIndex;
					} else {

					}
				}
			});
		}
	);
};
*/