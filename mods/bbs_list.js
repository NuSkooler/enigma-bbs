/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var sqlite3			= require('sqlite3').verbose();
var db			= require('../core/database.js');
var entry = require('./bbs_list_entry.js');
var async = require('async');
var _					= require('lodash');
var ViewController		= require('../core/view_controller.js').ViewController;

exports.getModule	= BBSListModule;

let moduleInfo = {
	name	: 'BBS List',
	desc	: 'List of other BBSes',
	author	: 'Andrew Pamment',
	packageName: 'com.magicka.enigma.bbslist'
};

exports.moduleInfo = moduleInfo;

var MciViewIds = {
	BBSList : 1,
	SelectedBBSName : 2,
	SelectedBBSSysOp : 3,
	SelectedBBSTelnet : 4,
	SelectedBBSWww : 5,
	SelectedBBSLoc : 6,
	SelectedBBSSoftware : 7,
	SelectedBBSSubmitter : 8
};

function BBSListModule(options) {
	const self	= this;
	this.selectedBBS = -1;
	this.database = new sqlite3.Database(db.getModDatabasePath(moduleInfo));
	this.bbsListContent = [];

	MenuModule.call(this, options);

	this.populateList = function() {
		let bbsListView = self.viewControllers.allViews.getView(MciViewIds.BBSList);

		bbsListView.setItems(_.map(self.bbsListContent, function formatBBSListEntry(ble) {
			return '|02' + ble.name;
		}));

		bbsListView.setFocusItems(_.map(self.bbsListContent, function formatBBSListEntry(ble) {
			return '|00|18|15' + ble.name;
		}));

		bbsListView.on('index update', function indexUpdated(idx) {
			if (self.bbsListContent.length === 0 || idx > self.bbsListContent.length) {
				self.setViewText(MciViewIds.SelectedBBSName, '');
				self.setViewText(MciViewIds.SelectedBBSSysOp, '');
				self.setViewText(MciViewIds.SelectedBBSTelnet, '');
				self.setViewText(MciViewIds.SelectedBBSWww, '');
				self.setViewText(MciViewIds.SelectedBBSLoc, '');
				self.setViewText(MciViewIds.SelectedBBSSoftware, '');
				self.setViewText(MciViewIds.SelectedBBSSubmitter, '');

				self.selectedBBS = -1;
			} else {
				self.setViewText(MciViewIds.SelectedBBSName, self.bbsListContent[idx].name);
				self.setViewText(MciViewIds.SelectedBBSSysOp, self.bbsListContent[idx].sysop);
				self.setViewText(MciViewIds.SelectedBBSTelnet, self.bbsListContent[idx].telnet);
				self.setViewText(MciViewIds.SelectedBBSWww, self.bbsListContent[idx].www);
				self.setViewText(MciViewIds.SelectedBBSLoc, self.bbsListContent[idx].location);
				self.setViewText(MciViewIds.SelectedBBSSoftware, self.bbsListContent[idx].software);
				if (self.bbsListContent[idx].submitter === self.client.user.userId) {
					self.setViewText(MciViewIds.SelectedBBSSubmitter, 'YOU SUBMITTED THIS ENTRY');
				} else {
					self.setViewText(MciViewIds.SelectedBBSSubmitter, '');
				}
				self.selectedBBS = idx;
			}
		});

		if (self.selectedBBS >= 0) {
			bbsListView.setFocusItemIndex(self.selectedBBS);
		}
		bbsListView.redraw();
	};

	this.menuMethods = {
		quitBBSList : function() {
			self.prevMenu();
		},
		addBBS : function() {
			self.gotoMenu('bbsListSubmission');
		},
		deleteBBS : function() {
			let bbsListView = self.viewControllers.allViews.getView(MciViewIds.BBSList);

			if (self.selectedBBS > -1 && self.selectedBBS < self.bbsListContent.length) {
				if (self.bbsListContent[self.selectedBBS].submitter === self.client.user.userId) {
					self.database.run(
						'DELETE FROM bbses WHERE id=?',
						[self.bbsListContent[self.selectedBBS].id],
						function done(err) {
							if (err) {
								self.client.log.error( { error : err.toString() }, 'Error deleting from BBS list');
							} else {
								self.bbsListContent.splice(self.selectedBBS, 1);
								self.populateList();
								bbsListView.focusNext();
							}
						}
					);
				}
			}
		}
	};
	this.setViewText = function(id, text) {
		var v = self.viewControllers.allViews.getView(id);
		if(v) {
			v.setText(text);
		}
	};
}

require('util').inherits(BBSListModule, MenuModule);

BBSListModule.prototype.mciReady = function(mciData, cb) {
	const self	= this;
	let vc		= self.viewControllers.allViews = new ViewController( { client : self.client } );

	async.series(
		[
			function createDatabase(callback) {
				self.database.run(
					'CREATE TABLE IF NOT EXISTS bbses(' +
					'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
					'bbsname TEXT,' +
					'sysop TEXT,' +
					'telnet TEXT,' +
					'www TEXT,' +
					'location TEXT,' +
					'software TEXT,' +
					'submitter INTEGER);',
					function done(err) {
						if (err) {
							callback(err);
						} else {
							callback(null);
						}
					}
				);
			},
			function loadBBSListing(callback) {
				self.database.all(
					'SELECT id, bbsname, sysop, telnet, www, location, software, submitter FROM bbses',
					[],
					function onResults(err, rows) {
						if (err) {
							callback(err);
						} else {

							if (rows.length > 0) {
								for (var i = 0; i < rows.length; i++) {
									let bbsEntry = new entry();
									bbsEntry.name = rows[i].bbsname;
									bbsEntry.sysop = rows[i].sysop;
									bbsEntry.telnet = rows[i].telnet;
									bbsEntry.www = rows[i].www;
									bbsEntry.location = rows[i].location;
									bbsEntry.software = rows[i].software;
									bbsEntry.submitter = rows[i].submitter;
									bbsEntry.id = rows[i].id;
									self.bbsListContent.push(bbsEntry);
								}
							}
							callback(null);
						}
					}
				);
			},
			function callParentMciReady(callback) {
				BBSListModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				var loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function populateList(callback) {
				self.populateList();

				callback(null);
			},
		],
		function complete(err) {
			if (err) {
				self.client.log.error( { error : err.toString() }, 'Error loading BBS list');
			}
			cb(err);
		}
	);
};
