/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var userDb				= require('../core/database.js').dbs.user;
var ViewController		= require('../core/view_controller.js').ViewController;

var moment				= require('moment');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

/*
	Available listFormat object members:
	userId
	userName
	lastCall
	status
	location
	affiliation
	timestamp	
*/

exports.moduleInfo = {
	name		: 'User List',
	desc		: 'Lists all system users',
	author		: 'NuSkooler',
};

exports.getModule	= UserListModule;

function UserListModule(options) {
	MenuModule.call(this, options);
}

require('util').inherits(UserListModule, MenuModule);

UserListModule.prototype.mciReady = function(mciData, cb) {
	var self		= this;
	var vc			= self.viewControllers.allViews = new ViewController( { client : self.client } );

	async.series(
		[

		],
		function complete(err) {
			if(err) {
				self.client.log.error( { error : err.toString() }, 'Error loading user list');
			}
			cb(err);
		}
	);
};