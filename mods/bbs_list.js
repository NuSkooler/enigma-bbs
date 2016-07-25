/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;
const getModDatabasePath	= require('../core/database.js').getModDatabasePath;
const ViewController		= require('../core/view_controller.js').ViewController;
const ansi					= require('../core/ansi_term.js');
const theme					= require('../core/theme.js');
const getUserName			= require('../core/user.js').getUserName;

//	deps
const async 				= require('async');
const sqlite3				= require('sqlite3');
const _						= require('lodash');

//	:TODO: add notes field

exports.getModule	= BBSListModule;

const moduleInfo = {
	name		: 'BBS List',
	desc		: 'List of other BBSes',
	author		: 'Andrew Pamment',
	packageName	: 'com.magickabbs.enigma.bbslist'
};

exports.moduleInfo = moduleInfo;

const MciViewIds = {
	view : {
		BBSList					: 1,
		SelectedBBSName			: 2,
		SelectedBBSSysOp		: 3,
		SelectedBBSTelnet		: 4,
		SelectedBBSWww			: 5,
		SelectedBBSLoc			: 6,
		SelectedBBSSoftware		: 7,
		SelectedBBSNotes		: 8,
		SelectedBBSSubmitter	: 9,		
	},
	add : {
		BBSName		: 1,
		Sysop		: 2,
		Telnet		: 3,
		Www			: 4,
		Location	: 5,
		Software	: 6,
		Notes		: 7,
		Error		: 8,	
	}
};

const FormIds = {
	View	: 0,
	Add		: 1,
};

const SELECTED_MCI_NAME_TO_ENTRY = {
	SelectedBBSName			: 'bbsName',
	SelectedBBSSysOp		: 'sysOp',
	SelectedBBSTelnet		: 'telnet',
	SelectedBBSWww			: 'www',
	SelectedBBSLoc			: 'location',
	SelectedBBSSoftware		: 'software',
	SelectedBBSSubmitter	: 'submitter',
	SelectedBBSSubmitterId	: 'submitterUserId',
	SelectedBBSNotes		: 'notes',
};

function BBSListModule(options) {
	MenuModule.call(this, options);

	const self		= this;
	const config	= this.menuConfig.config;

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

	this.drawSelectedEntry = function(entry) {
		if(!entry) {
			Object.keys(SELECTED_MCI_NAME_TO_ENTRY).forEach(mciName => {						
				self.setViewText(MciViewIds.view[mciName], '');
			});
		} else {
			//	:TODO: we really need pipe code support for TextView!!
			const youSubmittedFormat = config.youSubmittedFormat || '{submitter} (You!)';
			
			Object.keys(SELECTED_MCI_NAME_TO_ENTRY).forEach(mciName => {
				const t = entry[SELECTED_MCI_NAME_TO_ENTRY[mciName]];
				if(MciViewIds.view[mciName]) {

					if('SelectedBBSSubmitter' == mciName && entry.submitterUserId == self.client.user.userId) {
						self.setViewText(MciViewIds.view.SelectedBBSSubmitter, youSubmittedFormat.format(entry));
					} else {
						self.setViewText(MciViewIds.view[mciName], t);
					}
				}
			});
		}
	};

	this.setEntries = function(entriesView) {
		/* 
			:TODO: This is currently disabled until VerticalMenuView 'justify' works properly with pipe code strings
		
		const listFormat		= config.listFormat || '{bbsName}';
		const focusListFormat	= config.focusListFormat || '{bbsName}';

		entriesView.setItems(self.entries.map( e => {
			return listFormat.format(e);
		}));
		
		entriesView.setFocusItems(self.entries.map( e => {
			return focusListFormat.format(e);
		}));
		*/
		entriesView.setItems(self.entries.map(e => e.bbsName));
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
						`SELECT id, bbs_name, sysop, telnet, www, location, software, submitter_user_id, notes
						FROM bbs_list;`,
						(err, row) => {
							if (!err) {
								self.entries.push({
									id				: row.id, 
									bbsName			: row.bbs_name,
									sysOp			: row.sysop,
									telnet			: row.telnet,
									www				: row.www,
									location		: row.location,
									software		: row.software,
									submitterUserId	: row.submitter_user_id,
									notes			: row.notes,
								});
							}
						},
						err => {
							return callback(err, entriesView);
						}
					);
				},
				function getUserNames(entriesView, callback) {
					async.each(self.entries, (entry, next) => {
						getUserName(entry.submitterUserId, (err, username) => {
							if(username) {
								entry.submitter = username;
							} else {
								entry.submitter = 'N/A';
							}
							return next();
						});
					}, () => {
						return callback(null, entriesView);
					});
				},
				function populateEntries(entriesView, callback) {
					self.setEntries(entriesView);

					entriesView.on('index update', idx => {
						const entry = self.entries[idx];
						
						self.drawSelectedEntry(entry);
						
						if(!entry) {
							self.selectedBBS = -1;
						} else {
							self.selectedBBS = idx;
						}
					});

					if (self.selectedBBS >= 0) {
						entriesView.setFocusItemIndex(self.selectedBBS);
						self.drawSelectedEntry(self.entries[self.selectedBBS]);
					} else if (self.entries.length > 0) {
						entriesView.setFocusItemIndex(0);
						self.drawSelectedEntry(self.entries[0]);
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
		[ 'BBSName', 'Sysop', 'Telnet', 'Www', 'Location', 'Software', 'Error', 'Notes' ].forEach( mciName => {
			const v = self.viewControllers.add.getView(MciViewIds.add[mciName]);
			if(v) {
				v.setText('');
			}	
		});
	};

	this.menuMethods = {
		//
		//	Validators
		//
		viewValidationListener : function(err, cb) {
			const errMsgView = self.viewControllers.add.getView(MciViewIds.add.Error);
			if(errMsgView) {
				if(err) {
					errMsgView.setText(err.message);
				} else {
					errMsgView.clearText();
				}
			}

			return cb(null);
		},

		//
		//	Key & submit handlers
		//
		addBBS : function(formData, extraArgs, cb) {
			self.displayAddScreen(cb);
		},
		deleteBBS : function(formData, extraArgs, cb) {
			const entriesView = self.viewControllers.view.getView(MciViewIds.view.BBSList);

			if(self.entries[self.selectedBBS].submitterUserId !== self.client.user.userId && !self.client.user.isSysOp()) {
				//	must be owner or +op
				return cb(null);
			}

			const entry = self.entries[self.selectedBBS];
			if(!entry) {
				return cb(null);
			}

			self.database.run(
				`DELETE FROM bbs_list 
				WHERE id=?;`,
				[ entry.id ],
				err => {
					if (err) {
						self.client.log.error( { err : err }, 'Error deleting from BBS list');
					} else {
						self.entries.splice(self.selectedBBS, 1);

						self.setEntries(entriesView);

						if(self.entries.length > 0) {
							entriesView.focusPrevious();
						}

						self.viewControllers.view.redrawAll();
					}

					return cb(null);
				}
			);
		},
		submitBBS : function(formData, extraArgs, cb) {

			let ok = true;
			[ 'BBSName', 'Sysop', 'Telnet' ].forEach( mciName => {
				if('' === self.viewControllers.add.getView(MciViewIds.add[mciName]).getData()) {
					ok = false;
				}
			});
			if(!ok) {
				//	validators should prevent this!
				return cb(null);
			}

			self.database.run(
				`INSERT INTO bbs_list (bbs_name, sysop, telnet, www, location, software, submitter_user_id, notes) 
				VALUES(?, ?, ?, ?, ?, ?, ?, ?);`,
				[ formData.value.name, formData.value.sysop, formData.value.telnet, formData.value.www, formData.value.location, formData.value.software, self.client.user.userId, formData.value.notes ],
				err => {
					if(err) {
						self.client.log.error( { err : err }, 'Error adding to BBS list');
					}

					self.clearAddForm();
					self.displayBBSList(true, cb);
				}
			);
		},
		cancelSubmit : function(formData, extraArgs, cb) {
			self.clearAddForm();
			self.displayBBSList(true, cb);
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
							`CREATE TABLE IF NOT EXISTS bbs_list (
								id					INTEGER PRIMARY KEY,
								bbs_name			VARCHAR NOT NULL,
								sysop				VARCHAR NOT NULL,
								telnet				VARCHAR NOT NULL,
								www					VARCHAR,
								location			VARCHAR,
								software			VARCHAR,
								submitter_user_id	INTEGER NOT NULL,
								notes				VARCHAR
							);`
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
