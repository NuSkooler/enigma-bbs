/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;
const ViewController		= require('../core/view_controller.js').ViewController;
const theme					= require('../core/theme.js');
const resetScreen			= require('../core/ansi_term.js').resetScreen;
const StatLog				= require('../core/stat_log.js');
const renderStringLength	= require('../core/string_util.js').renderStringLength;
const stringFormat			= require('../core/string_format.js');

//	deps
const async					= require('async');
const _						= require('lodash');

exports.moduleInfo = {
	name		: 'Rumorz',
	desc		: 'Standard local rumorz',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.rumorz',
};

const STATLOG_KEY_RUMORZ	= 'system_rumorz';

const FormIds = {
	View	: 0,
	Add		: 1,
};

const MciCodeIds = {
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

exports.getModule = class RumorzModule extends MenuModule {
	constructor(options) {
		super(options);

		this.menuMethods =  {
			viewAddScreen : (formData, extraArgs, cb) => {
				return this.displayAddScreen(cb);
			},

			addEntry : (formData, extraArgs, cb) => {
				if(_.isString(formData.value.rumor) && renderStringLength(formData.value.rumor) > 0) {
					const rumor = formData.value.rumor.trim();	//	remove any trailing ws
					
					StatLog.appendSystemLogEntry(STATLOG_KEY_RUMORZ, rumor, StatLog.KeepDays.Forever, StatLog.KeepType.Forever, () => {
						this.clearAddForm(); 
						return this.displayViewScreen(true, cb);	//	true=cls
					});
				} else {
					//	empty message - treat as if cancel was hit
					return this.displayViewScreen(true, cb);	//	true=cls
				}
			},

			cancelAdd : (formData, extraArgs, cb) => {
				this.clearAddForm();
				return this.displayViewScreen(true, cb);	//	true=cls
			}
		};
	}

	get config() { return this.menuConfig.config; }

	clearAddForm() {
		const newEntryView	= this.viewControllers.add.getView(MciCodeIds.AddForm.NewEntry);
		const previewView	= this.viewControllers.add.getView(MciCodeIds.AddForm.EntryPreview);

		newEntryView.setText('');
		
		//	preview is optional
		if(previewView) {
			previewView.setText('');
		}
	}

	initSequence() {
		const self = this;

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
						self.client.term.rawWrite(resetScreen());
					}

					theme.displayThemedAsset(
						self.config.art.entries,
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

					StatLog.getSystemLogEntries(STATLOG_KEY_RUMORZ, StatLog.Order.Timestamp, (err, entries) => {
						return callback(err, entriesView, entries);
					});
				},
				function populateEntries(entriesView, entries, callback) {
					const config			= self.config;
					const listFormat		= config.listFormat || '{rumor}';
					const focusListFormat	= config.focusListFormat || listFormat;

					entriesView.setItems(entries.map( e => stringFormat(listFormat, { rumor : e.log_value } ) ) );
					entriesView.setFocusItems(entries.map(e => stringFormat(focusListFormat, { rumor : e.log_value } ) ) );
					entriesView.redraw();

					return callback(null);
				},
				function finalPrep(callback) {
					const promptView = self.viewControllers.view.getView(MciCodeIds.ViewForm.AddPrompt);
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
					self.client.term.rawWrite(resetScreen());					

					theme.displayThemedAsset(
						self.config.art.add,
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
						self.viewControllers.add.switchFocus(MciCodeIds.AddForm.NewEntry);
						return callback(null);
					}
				},
				function initPreviewUpdates(callback) {
					const previewView	= self.viewControllers.add.getView(MciCodeIds.AddForm.EntryPreview);
					const entryView		= self.viewControllers.add.getView(MciCodeIds.AddForm.NewEntry); 
					if(previewView) {
						let timerId;
						entryView.on('key press', () => {
							clearTimeout(timerId);
							timerId = setTimeout( () => {
								const focused = self.viewControllers.add.getFocusedView();
								if(focused === entryView) {
									previewView.setText(entryView.getData());
									focused.setFocus(true);
								} 
							}, 500);
						});
					}
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
};
