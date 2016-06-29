/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;
const getModDatabasePath	= require('../core/database.js').getModDatabasePath;
const ViewController		= require('../core/view_controller.js').ViewController;
const theme					= require('../core/theme.js');
const ansi					= require('../core/ansi_term.js');

//	deps
const sqlite3				= require('sqlite3');
const async					= require('async');
const _						= require('lodash');

exports.moduleInfo = {
	name		: 'Onelinerz',
	desc		: 'Standard local onelinerz',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.onelinerz',
};

exports.getModule	= OnelinerzModule;

const MciCodeIds = {
	ViewForm	:  {
		Entries		: 1,
		AddPrompt	: 2,
	},
	AddForm : {

	}
};

const FormIds = {
	View	: 0,
	Add		: 1,
};

function OnelinerzModule(options) {
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
					self.displayViewScreen(false, callback);
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

	this.displayViewScreen = function(clearScreen, cb) {
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
						self.viewControllers.view.getView(MciCodeIds.ViewForm.AddPrompt).redraw();						
						return callback(null);
					}
				},
				function fetchEntries(callback) {
					const entriesView = self.viewControllers.view.getView(MciCodeIds.ViewForm.Entries);
					const limit = entriesView.dimens.height;
					let entries = [];

					self.db.each(
						`SELECT user_id, user_name, oneliner, timestamp
						FROM onelinerz
						LIMIT ${limit};`,
						(err, row) => {
							if(!err) {
								entries.push(row);
							}
						},
						err => {
							return callback(err, entriesView, entries);
						}
					);
				},
				function populateEntries(entriesView, entries, callback) {
					const listFormat = config.listFormat || '{username}: {oneliner}';

					//	:TODO: remove meh:
					entries = [
						{ user_id : 1, user_name : 'NuSkooler', oneliner : 'Boojahhhh!!!', timestamp : '2016-06-04' }
					]

					entriesView.setItems(entries.map( e => {
						return listFormat.format( {
							userId		: e.user_id,
							username	: e.user_name,
							oneliner	: e.oneliner,
							ts			: e.timestamp,
						} );
					}));

					entriesView.focusItems = entriesView.items;	//	:TODO: this is a hack
					entriesView.redraw();

					return callback(null);
				}
			],
			cb
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
						self.viewControllers.add.redrawAll();
						return callback(null);
					}
				}
			],
			cb
		);
	};

	this.menuMethods = {
		addPromptYes : function(formData, extraArgs) {
			self.displayAddScreen(err => {

			});
		}
	};

	this.initDatabase = function(cb) {
		async.series(
			[
				function openDatabase(callback) {
					self.db = new sqlite3.Database(
						getModDatabasePath(exports.moduleInfo), 
						callback
					);
				},
				function createTables(callback) {
					self.db.serialize( () => {
						self.db.run(
							`CREATE TABLE IF NOT EXISTS onelinerz (
								id				INTEGER PRIMARY KEY,
								user_id			INTEGER_NOT NULL,
								user_name		VARCHAR NOT NULL,								
								oneliner		VARCHAR NOT NULL,
								timestamp		DATETIME NOT NULL
							)`
						);
					});
					callback(null);
				}
			],
			cb
		);
	};
}

require('util').inherits(OnelinerzModule, MenuModule);

OnelinerzModule.prototype.beforeArt = function(cb) {
	OnelinerzModule.super_.prototype.beforeArt.call(this, err => {
		return err ? cb(err) : this.initDatabase(cb);				
	});
};

/*
OnelinerzModule.prototype.mciReady = function(mciData, cb) {
	const self	= this;
	const vc	= self.addViewController(
		'entries', 
		new ViewController( { client : self.client, formId : FormIds.AddPrompt } )
	);

	let entries = [];
	let entriesView;

	async.series(
		[
			function loadFromConfig(callback) {
				const loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.entries.mciMap,
				};

				vc.loadFromMenuConfig(loadOpts, callback);
			},
			function fetchEntries(callback) {
				entriesView = vc.getView(MciCodeIds.ViewScreen.Entries);
				const limit = entriesView.dimens.height;

				self.db.each(
					`SELECT user_id, user_name, oneliner, timestamp
					FROM onelinerz
					LIMIT ${limit};`,
					(err, row) => {
						if(!err) {
							entries.push(row);
						}
					},
					callback
				);
			},
			function populateEntries(callback) {
				const listFormat = self.menuConfig.config.listFormat || '{username}: {oneliner}';

				//	:TODO: remove meh:
				entries = [
					{ user_id : 1, user_name : 'NuSkooler', oneliner : 'Boojahhhh!!!', timestamp : '2016-06-04' }
				]

				entriesView.setItems(entries.map( e => {
					return listFormat.format( {
						userId		: e.user_id,
						username	: e.user_name,
						oneliner	: e.oneliner,
						ts			: e.timestamp,
					} );
				}));

				entriesView.focusItems = entriesView.items;	//	:TODO: this is a hack
				entriesView.redraw();

				return callback(null);
			}
		],
		cb
	);
};
*/
