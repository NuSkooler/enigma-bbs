/* jslint node: true */
'use strict';

var MenuModule				= require('../core/menu_module.js').MenuModule;
var ViewController			= require('../core/view_controller.js').ViewController;
var getActiveNodeList		= require('../core/client_connections.js').getActiveNodeList;

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

				const listFormat	= self.menuConfig.config.listFormat || '{node} - {userName} - {action} - {timeOn}';
				const nonAuthUser	= self.menuConfig.config.nonAuthUser || 'Logging In';
				const otherUnknown	= self.menuConfig.config.otherUnknown || 'N/A';	
				const onlineList 	= getActiveNodeList().slice(0, onlineListView.height);
				
				onlineListView.setItems(_.map(onlineList, oe => {
					if(oe.authenticated) {
						oe.timeOn = _.capitalize(oe.timeOn.humanize());
					} else {
						[ 'realName', 'location', 'affils', 'timeOn' ].forEach(m => {
							oe[m] = otherUnknown;
						});
						oe.userName = nonAuthUser;
					}
					return listFormat.format(oe);
				}));

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

