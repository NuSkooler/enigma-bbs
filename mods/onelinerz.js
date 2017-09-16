/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;

const {
	getModDatabasePath,
	getTransactionDatabase
}							= require('../core/database.js');

const ViewController		= require('../core/view_controller.js').ViewController;
const theme					= require('../core/theme.js');
const ansi					= require('../core/ansi_term.js');
const stringFormat			= require('../core/string_format.js');

//	deps
const sqlite3				= require('sqlite3');
const async					= require('async');
const _						= require('lodash');
const moment				= require('moment');

/* 
	Module :TODO:
	* Add pipe code support
		- override max length & monitor *display* len as user types in order to allow for actual display len with color
	* Add preview control: Shows preview with pipe codes resolved
	* Add ability to at least alternate formatStrings -- every other
*/


exports.moduleInfo = {
	name		: 'Onelinerz',
	desc		: 'Standard local onelinerz',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.onelinerz',
};

const MciViewIds = {
	ViewForm	:  {
		Entries		: 1,
		AddPrompt	: 2,
	},
	AddForm : {
		NewEntry		: 1,
		EntryPreview	: 2,
		AddPrompt		: 3,
	}
};

const FormIds = {
	View	: 0,
	Add		: 1,
};

exports.getModule = class OnelinerzModule extends MenuModule {
	constructor(options) {
		super(options);

		const self = this;

		this.menuMethods = {
			viewAddScreen : function(formData, extraArgs, cb) {
				return self.displayAddScreen(cb);
			},

			addEntry : function(formData, extraArgs, cb) {
				if(_.isString(formData.value.oneliner) && formData.value.oneliner.length > 0) {
					const oneliner = formData.value.oneliner.trim();	//	remove any trailing ws

					self.storeNewOneliner(oneliner, err => {
						if(err) {
							self.client.log.warn( { error : err.message }, 'Failed saving oneliner');
						}

						self.clearAddForm(); 
						return self.displayViewScreen(true, cb);	//	true=cls
					});

				} else {
					//	empty message - treat as if cancel was hit
					return self.displayViewScreen(true, cb);	//	true=cls
				}
			},

			cancelAdd : function(formData, extraArgs, cb) {
				self.clearAddForm();
				return self.displayViewScreen(true, cb);	//	true=cls
			}
		};
	}
	
	initSequence() {
		const self = this;
		async.series(
			[
				function beforeDisplayArt(callback) {
					return self.beforeArt(callback);
				},
				function display(callback) {
					return self.displayViewScreen(false, callback);
				}
			],
			err => {
				if(err) {
					//	:TODO: Handle me -- initSequence() should really take a completion callback
				}
				self.finishedLoading();
			}
		);
	}

	displayViewScreen(clearScreen, cb) {
		const self = this;

		async.waterfall(
			[
				function clearAndDisplayArt(callback) {
					if(self.viewControllers.add) {
						self.viewControllers.add.setFocus(false);
					}

					if(clearScreen) {
						self.client.term.rawWrite(ansi.resetScreen());
					}

					theme.displayThemedAsset(
						self.menuConfig.config.art.entries,
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
						self.viewControllers.view.getView(MciViewIds.ViewForm.AddPrompt).redraw();						
						return callback(null);
					}
				},
				function fetchEntries(callback) {
					const entriesView = self.viewControllers.view.getView(MciViewIds.ViewForm.Entries);
					const limit = entriesView.dimens.height;
					let entries = [];

					self.db.each(
						`SELECT *
						FROM (
							SELECT * 
							FROM onelinerz
							ORDER BY timestamp DESC
							LIMIT ${limit}
							)
						ORDER BY timestamp ASC;`,
						(err, row) => {
							if(!err) {
								row.timestamp = moment(row.timestamp);	//	convert -> moment
								entries.push(row);
							}
						},
						err => {
							return callback(err, entriesView, entries);
						}
					);
				},
				function populateEntries(entriesView, entries, callback) {
					const listFormat	= self.menuConfig.config.listFormat || '{username}@{ts}: {oneliner}';//	:TODO: should be userName to be consistent
					const tsFormat		= self.menuConfig.config.timestampFormat || 'ddd h:mma';

					entriesView.setItems(entries.map( e => {
						return stringFormat(listFormat, {
							userId		: e.user_id,
							username	: e.user_name,
							oneliner	: e.oneliner,
							ts			: e.timestamp.format(tsFormat),
						} );
					}));

					entriesView.redraw();

					return callback(null);
				},
				function finalPrep(callback) {
					const promptView = self.viewControllers.view.getView(MciViewIds.ViewForm.AddPrompt);
					promptView.setFocusItemIndex(1);	//	default to NO
					return callback(null);
				}
			],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	displayAddScreen(cb) {
		const self = this;

		async.waterfall(
			[
				function clearAndDisplayArt(callback) {
					self.viewControllers.view.setFocus(false);
					self.client.term.rawWrite(ansi.resetScreen());					

					theme.displayThemedAsset(
						self.menuConfig.config.art.add,
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
						self.viewControllers.add.switchFocus(MciViewIds.AddForm.NewEntry);
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
	}

	clearAddForm() {
		this.setViewText('add', MciViewIds.AddForm.NewEntry, '');
		this.setViewText('add', MciViewIds.AddForm.EntryPreview, '');
	}

	initDatabase(cb) {
		const self = this;

		async.series(
			[
				function openDatabase(callback) {
					self.db = getTransactionDatabase(new sqlite3.Database(
						getModDatabasePath(exports.moduleInfo), 
						err => {
							return callback(err);
						}
					));
				},
				function createTables(callback) {
					self.db.run(
						`CREATE TABLE IF NOT EXISTS onelinerz (
							id				INTEGER PRIMARY KEY,
							user_id			INTEGER_NOT NULL,
							user_name		VARCHAR NOT NULL,								
							oneliner		VARCHAR NOT NULL,
							timestamp		DATETIME NOT NULL
						);`
					,
					err => {
						return callback(err);
					});
				}
			],
			err => {
				return cb(err);
			}
		);
	}

	storeNewOneliner(oneliner, cb) {
		const self	= this;
		const ts	= moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ');

		async.series(
			[
				function addRec(callback) {
					self.db.run(
						`INSERT INTO onelinerz (user_id, user_name, oneliner, timestamp)
						VALUES (?, ?, ?, ?);`,
						[ self.client.user.userId, self.client.user.username, oneliner, ts ],
						callback
					);
				},
				function removeOld(callback) {
					//	keep 25 max most recent items - remove the older ones
					self.db.run(
						`DELETE FROM onelinerz
						WHERE id IN (
							SELECT id
							FROM onelinerz
							ORDER BY id DESC
							LIMIT -1 OFFSET 25
						);`,
						callback
					);
				}
			],
			err => {
				return cb(err);
			}
		);		
	}

	beforeArt(cb) {
		super.beforeArt(err => {
			return err ? cb(err) : this.initDatabase(cb);
		});
	}
};
