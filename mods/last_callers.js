/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var userDb			= require('../core/database.js').dbs.user;
var ViewController	= require('../core/view_controller.js').ViewController;

exports.moduleInfo = {
	name	: 'Last Callers',
	desc	: 'Last 10 callers to the system',
	author	: 'NuSkooler',
};

exports.getModule	= LastCallersModule;

function LastCallersModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(LastCallersModule, MenuModule);

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
		'SELECT u.id, u.user_name, up.prop_value '						+
		'FROM user u '													+
		'INNER JOIN user_property up '									+
		'ON u.id=up.user_id AND up.prop_name="last_login_timestamp" '	+
		'ORDER BY up.prop_value DESC'										+
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
