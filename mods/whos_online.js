/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;
var ViewController			= require('../core/view_controller.js').ViewController;
var getActiveConnections	= require('../core/client_connections.js').getActiveConnections;

var moment					= require('moment');
var async					= require('async');
var assert					= require('assert');
var _						= require('lodash');

exports.moduleInfo = {
	name		: 'Who\'s Online',
	desc		: 'Who is currently online',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.whosonline'
};

/*
node
userName
userId
action
note
affils
timeOnSec
location
realName
serverName (Telnet, SSH, ...)

default
{node} - {username} - {action} - {timeOnSec}

*/

exports.getModule	= WhosOnlineModule;

var MciCodeIds = {
	OnlineList		: 1,
};

function WhosOnlineModule(options) {
	MenuModule.call(this, options);
}

require('util').inherits(WhosOnlineModule, MenuModule);

WhosOnlineModule.prototype.mciReady = function(mciData, cb) {
	var self		= this;
	var vc			= self.viewControllers.allViews = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				WhosOnlineModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu,
					noInput			: true,
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function populateList(callback) {
				var onlineListView = vc.getView(MciCodeIds.OnlineList);

				var onlineList = getActiveConnections().slice(0, onlineListView.height);

				var listFormat 	= self.menuConfig.config.listFormat || '{node} - {username} - {action} - {timeOn}';

				var now = moment();

				onlineListView.setItems(_.map(onlineList, function formatOnlineEntry(oe) {
					var fmtObj = {
						node		: oe.node,
						userId		: oe.user.userId,
						userName	: oe.user.username,
						realName	: oe.user.properties.real_name,
						timeOn		: function getTimeOn() {
							var diff = now.diff(moment(oe.user.properties.last_login_timestamp), 'minutes');
							return _.capitalize(moment.duration(diff, 'minutes').humanize());
						},
						action		: function getCurrentAction() {
							var cmm = oe.currentMenuModule;
							if(cmm) {
								return cmm.menuConfig.desc || 'Unknown';
							}
							return 'Unknown';
							//oe.currentMenuModule.menuConfig.desc || 'Unknown',
						},
						location	: oe.user.properties.location,
						affils		: oe.user.properties.affiliation,
					};
					try {
						return listFormat.format(fmtObj);
					} catch(e) {
						console.log('Exception caught formatting: ' + e.toString() + ':\n' + JSON.stringify(fmtObj));
					}
					/*
					return listFormat.format({
						node		: oe.node,
						userId		: oe.user.userId,
						userName	: oe.user.username,
						realName	: oe.user.properties.real_name,
						timeOn		: function getTimeOn() {
							var diff = now.diff(moment(oe.user.properties.last_login_timestamp), 'minutes');
							return _.capitalize(moment.duration(diff, 'minutes').humanize());
						},
						action		: function getCurrentAction() {
							var cmm = oe.currentMenuModule;
							if(cmm) {
								return cmm.menuConfig.desc || 'Unknown';
							}
							return 'Unknown';
							//oe.currentMenuModule.menuConfig.desc || 'Unknown',
						},
						location	: oe.user.properties.location,
						affils		: oe.user.properties.affiliation,
					});
					 */
				}));

				//	:TODO: This is a hack until pipe codes are better implemented
				onlineListView.focusItems = onlineListView.items;

				onlineListView.redraw();
				callback(null);
			}
		],
		function complete(err) {
			if(err) {
				self.client.log.error( { error : err.toString() }, 'Error loading who\'s online');
			}
			cb(err);
		}
	);
};

