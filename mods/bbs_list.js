/* jslint node: true */
'use strict';

const MenuModule		= require('../core/menu_module.js').MenuModule;
const sqlite3			= require('sqlite3').verbose();
const getModDatabasePath			= require('../core/database.js').getModDatabasePath;
const async = require('async');
const _					= require('lodash');
const ViewController		= require('../core/view_controller.js').ViewController;
const ansi	= require('../core/ansi_term.js');
const theme	= require('../core/theme.js');

exports.getModule	= BBSListModule;

const moduleInfo = {
	name	: 'BBS List',
	desc	: 'List of other BBSes',
	author	: 'Andrew Pamment',
	packageName: 'com.magickabbs.enigma.bbslist'
};

exports.moduleInfo = moduleInfo;

const MciViewIds = {
	view : {
		BBSList : 1,
		SelectedBBSName : 2,
		SelectedBBSSysOp : 3,
		SelectedBBSTelnet : 4,
		SelectedBBSWww : 5,
		SelectedBBSLoc : 6,
		SelectedBBSSoftware : 7,
		SelectedBBSSubmitter : 8
	},
	add : {
		BBSName : 1,
		Sysop : 2,
		Telnet : 3,
		Www : 4,
		Location : 5,
		Software : 6
	}
};

const FormIds = {
	View	: 0,
	Add		: 1,
};

function BBSListModule(options) {
	MenuModule.call(this, options);

	const self	= this;
	const config	= this.menuConfig.config;

	let entries = [];

	this.initSequence = function() {
		async.series(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt(callback);
				},
				function display(callback) {
					self.displayBBSList(false, callback);
				}
			],
			err => {
				if(err) {
					//	:TODO: Handle me -- initSequence() should really take a completion callback
				}
				self.finishedLoading();
			}
		);
	};

	this.displayBBSList = function(clearScreen, cb) {
		async.waterfall(
			[
				function clearAndDisplayArt(callback) {
					if(self.viewControllers.add) {
						self.viewControllers.add.setFocus(false);
					}
					if (clearScreen) {
						self.client.term.rawWrite(ansi.resetScreen());
					}
					theme.displayThemedAsset(
						config.art.entries,
						self.client,
						{ font : self.menuConfig.font, trailingLF : false },
						(err, artData) => {
							return callback(err, artData);
						}
					);
				},
				function initOrRedrawViewController(artData, callback) {
					if(_.isUndefined(self.viewControllers.add)) {
						const vc = self.addViewController(
							'view',
							new ViewController( { client : self.client, formId : FormIds.View } )
						);

						const loadOpts = {
							callingMenu		: self,
							mciMap			: artData.mciMap,
							formId			: FormIds.View,
						};

						return vc.loadFromMenuConfig(loadOpts, callback);
					} else {
						self.viewControllers.view.setFocus(true);
						self.viewControllers.view.getView(MciViewIds.view.BBSList).redraw();
						return callback(null);
					}
				},
				function fetchEntries(callback) {
					const entriesView = self.viewControllers.view.getView(MciViewIds.view.BBSList);
					self.entries = [];

					self.database.each(
						'SELECT id, bbsname, sysop, telnet, www, location, software, submitter FROM bbses',
						(err, row) => {
							if (!err) {
								self.entries.push(row);
							}
						},
						err => {
							return callback(err, entriesView, entries);
						}
					);
				},
				function populateEntries(entriesView, entries, callback) {
					const listFormat = config.listFormat || '{bbsname}';
					const focusListFormat = config.focusListFormat || '{bbsname}';
					entriesView.setItems(self.entries.map( e => {
						return listFormat.format({
							bbsname : e.bbsname
						});
					}));
					entriesView.setFocusItems(self.entries.map( e => {
						return focusListFormat.format({
							bbsname : e.bbsname
						});
					}));

					entriesView.on('index update', function indexUpdated(idx) {
						if (self.entries.length === 0 || idx > self.entries.length) {
							[ 'BBSName', 'BBSSysOp', 'BBSTelnet', 'BBSWww', 'BBSLoc', 'BBSSoftware', 'BBSSubmitter'].forEach( n => {
								self.setViewText(MciViewIds.view['Selected' + n], '');
							});
							self.selectedBBS = -1;
						} else {
							self.setViewText(MciViewIds.view.SelectedBBSName, self.entries[idx].bbsname);
							self.setViewText(MciViewIds.view.SelectedBBSSysOp, self.entries[idx].sysop);
							self.setViewText(MciViewIds.view.SelectedBBSTelnet, self.entries[idx].telnet);
							self.setViewText(MciViewIds.view.SelectedBBSWww, self.entries[idx].www);
							self.setViewText(MciViewIds.view.SelectedBBSLoc, self.entries[idx].location);
							self.setViewText(MciViewIds.view.SelectedBBSSoftware, self.entries[idx].software);
							if (self.entries[idx].submitter === self.client.user.userId) {
								self.setViewText(MciViewIds.view.SelectedBBSSubmitter, 'YOU SUBMITTED THIS ENTRY');
							} else {
								self.setViewText(MciViewIds.view.SelectedBBSSubmitter, '');
							}
							self.selectedBBS = idx;
						}
					});

					if (self.selectedBBS >= 0) {
						entriesView.setFocusItemIndex(self.selectedBBS);
					} else if (self.entries.length > 0) {
						entriesView.setFocusItemIndex(0);
					}
					entriesView.redraw();
					return callback(null);
				}
			],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	};

	this.displayAddScreen = function(cb) {
		async.waterfall(
			[
				function clearAndDisplayArt(callback) {
					self.viewControllers.view.setFocus(false);
					self.client.term.rawWrite(ansi.resetScreen());

					theme.displayThemedAsset(
						config.art.add,
						self.client,
						{ font : self.menuConfig.font },
						(err, artData) => {
							return callback(err, artData);
						}
					);
				},
				function initOrRedrawViewController(artData, callback) {
					if(_.isUndefined(self.viewControllers.add)) {
						const vc = self.addViewController(
							'add',
							new ViewController( { client : self.client, formId : FormIds.Add } )
						);

						const loadOpts = {
							callingMenu		: self,
							mciMap			: artData.mciMap,
							formId			: FormIds.Add,
						};

						return vc.loadFromMenuConfig(loadOpts, callback);
					} else {
						self.viewControllers.add.setFocus(true);
						self.viewControllers.add.redrawAll();
						self.viewControllers.add.switchFocus(MciViewIds.add.BBSName);
						return callback(null);
					}
				}
			],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	};

	this.clearAddForm = function() {
		self.viewControllers.add.getView(MciViewIds.add.BBSName).setText('');
		self.viewControllers.add.getView(MciViewIds.add.Sysop).setText('');
		self.viewControllers.add.getView(MciViewIds.add.Telnet).setText('');
		self.viewControllers.add.getView(MciViewIds.add.Www).setText('');
		self.viewControllers.add.getView(MciViewIds.add.Location).setText('');
		self.viewControllers.add.getView(MciViewIds.add.Software).setText('');
	};

	this.menuMethods = {
		quitBBSList : function() {
			self.prevMenu();
		},
		addBBS : function() {
			self.displayAddScreen();
		},
		deleteBBS : function() {
			const entriesView = self.viewControllers.view.getView(MciViewIds.view.BBSList);

			if (self.selectedBBS > -1 && self.selectedBBS < self.entries.length) {
				if (self.entries[self.selectedBBS].submitter === self.client.user.userId || self.client.user.isSysOp()) {
					self.database.run(
						'DELETE FROM bbses WHERE id=?',
						[self.entries[self.selectedBBS].id],
						function done(err) {
							if (err) {
								self.client.log.error( { error : err.toString() }, 'Error deleting from BBS list');
							} else {
								self.entries.splice(self.selectedBBS, 1);

								entriesView.setItems(self.entries.map( e => {
									return '|02' + e.bbsname;
								}));
								entriesView.setFocusItems(self.entries.map( e => {
									return '|00|18|15' + e.bbsname;
								}));

								entriesView.on('index update', function indexUpdated(idx) {
									if (self.entries.length === 0 || idx > self.entries.length) {
										[ 'BBSName', 'BBSSysOp', 'BBSTelnet', 'BBSWww', 'BBSLoc', 'BBSSoftware', 'BBSSubmitter'].forEach( n => {
											self.setViewText(MciViewIds.view['Selected' + n], '');
										});

										self.selectedBBS = -1;
									} else {
										self.setViewText(MciViewIds.view.SelectedBBSName, self.entries[idx].bbsname);
										self.setViewText(MciViewIds.view.SelectedBBSSysOp, self.entries[idx].sysop);
										self.setViewText(MciViewIds.view.SelectedBBSTelnet, self.entries[idx].telnet);
										self.setViewText(MciViewIds.view.SelectedBBSWww, self.entries[idx].www);
										self.setViewText(MciViewIds.view.SelectedBBSLoc, self.entries[idx].location);
										self.setViewText(MciViewIds.view.SelectedBBSSoftware, self.entries[idx].software);
										if (self.entries[idx].submitter === self.client.user.userId) {
											self.setViewText(MciViewIds.view.SelectedBBSSubmitter, 'YOU SUBMITTED THIS ENTRY');
										} else {
											self.setViewText(MciViewIds.view.SelectedBBSSubmitter, '');
										}
										self.selectedBBS = idx;
									}
								});
								if (self.entries.length > 0) {
									entriesView.focusPrevious();
								}
								self.viewControllers.view.redrawAll();
							}
						}
					);
				}
			}
		},
		submitBBS : function(formData) {
			self.database.run(
				'INSERT INTO bbses (bbsname, sysop, telnet, www, location, software, submitter) VALUES(?, ?, ?, ?, ?, ?, ?)',
				[formData.value.name, formData.value.sysop, formData.value.telnet, formData.value.www, formData.value.location, formData.value.software, self.client.user.userId],
				err => {
					if (err) {
						self.client.log.error( { error : err.toString() }, 'Error adding to BBS list');
					}
					self.clearAddForm();
					self.displayBBSList(true);
				}
			);
		},
		cancelSubmit : function() {
			self.clearAddForm();
			self.displayBBSList(true);
		}
	};
	this.setViewText = function(id, text) {
		var v = self.viewControllers.view.getView(id);
		if(v) {
			v.setText(text);
		}
	};
	this.initDatabase = function(cb) {
		async.series(
			[
				function openDatabase(callback) {
					self.database = new sqlite3.Database(
						getModDatabasePath(moduleInfo),
						callback
					);
				},
				function createTables(callback) {
					self.database.serialize( () => {
						self.database.run(
							'CREATE TABLE IF NOT EXISTS bbses(' +
							'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
							'bbsname TEXT,' +
							'sysop TEXT,' +
							'telnet TEXT,' +
							'www TEXT,' +
							'location TEXT,' +
							'software TEXT,' +
							'submitter INTEGER);'
						);
					});
					callback(null);
				}
			],
			cb
		);
	};
}

require('util').inherits(BBSListModule, MenuModule);

BBSListModule.prototype.beforeArt = function(cb) {
	BBSListModule.super_.prototype.beforeArt.call(this, err => {
		return err ? cb(err) : this.initDatabase(cb);
	});
};
