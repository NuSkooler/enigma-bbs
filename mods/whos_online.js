/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;
const ViewController		= require('../core/view_controller.js').ViewController;
const getActiveNodeList		= require('../core/client_connections.js').getActiveNodeList;
const stringFormat			= require('../core/string_format.js');

//	deps
const async					= require('async');
const _						= require('lodash');

exports.moduleInfo = {
	name		: 'Who\'s Online',
	desc		: 'Who is currently online',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.whosonline'
};

exports.getModule	= WhosOnlineModule;

const MciCodeIds = {
	OnlineList		: 1,
};

function WhosOnlineModule(options) {
	MenuModule.call(this, options);
}

require('util').inherits(WhosOnlineModule, MenuModule);

WhosOnlineModule.prototype.mciReady = function(mciData, cb) {
	const self	= this;
	const vc	= self.viewControllers.allViews = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				return WhosOnlineModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				const loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu,
					noInput			: true,
				};

				return vc.loadFromMenuConfig(loadOpts, callback);
			},
			function populateList(callback) {
				const onlineListView	= vc.getView(MciCodeIds.OnlineList);
				const listFormat		= self.menuConfig.config.listFormat || '{node} - {userName} - {action} - {timeOn}';
				const nonAuthUser		= self.menuConfig.config.nonAuthUser || 'Logging In';
				const otherUnknown		= self.menuConfig.config.otherUnknown || 'N/A';
				const onlineList 		= getActiveNodeList(self.menuConfig.config.authUsersOnly).slice(0, onlineListView.height);
				
				onlineListView.setItems(_.map(onlineList, oe => {
					if(oe.authenticated) {
						oe.timeOn = _.capitalize(oe.timeOn.humanize());
					} else {
						[ 'realName', 'location', 'affils', 'timeOn' ].forEach(m => {
							oe[m] = otherUnknown;
						});
						oe.userName = nonAuthUser;
					}
					return stringFormat(listFormat, oe);
				}));

				onlineListView.focusItems = onlineListView.items;
				onlineListView.redraw();

				return callback(null);
			}
		],
		function complete(err) {
			if(err) {
				self.client.log.error( { error : err.message }, 'Error loading who\'s online');
			}
			return cb(err);
		}
	);
};
