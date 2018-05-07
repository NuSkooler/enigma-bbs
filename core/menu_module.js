/* jslint node: true */
'use strict';

const PluginModule				= require('./plugin_module.js').PluginModule;
const theme						= require('./theme.js');
const ansi						= require('./ansi_term.js');
const ViewController			= require('./view_controller.js').ViewController;
const menuUtil					= require('./menu_util.js');
const Config					= require('./config.js').config;
const stringFormat				= require('../core/string_format.js');
const MultiLineEditTextView		= require('../core/multi_line_edit_text_view.js').MultiLineEditTextView;
const Errors					= require('../core/enig_error.js').Errors;
const { getPredefinedMCIValue }	= require('../core/predefined_mci.js');

//	deps
const async					= require('async');
const assert				= require('assert');
const _						= require('lodash');

exports.MenuModule = class MenuModule extends PluginModule {

	constructor(options) {
		super(options);

		this.menuName			= options.menuName;
		this.menuConfig			= options.menuConfig;
		this.client				= options.client;
		this.menuConfig.options	= options.menuConfig.options || {};
		this.menuMethods		= {};	//	methods called from @method's
		this.menuConfig.config	= this.menuConfig.config || {};

		this.cls = _.isBoolean(this.menuConfig.options.cls) ? this.menuConfig.options.cls : Config.menus.cls;

		this.viewControllers	= {};
	}

	enter() {
		this.initSequence();
	}

	leave() {
		this.detachViewControllers();
	}

	initSequence() {
		const self		= this;
		const mciData	= {};
		let pausePosition;

		async.series(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt(callback);
				},
				function displayMenuArt(callback) {
					if(!_.isString(self.menuConfig.art)) {
						return callback(null);
					}

					self.displayAsset(
						self.menuConfig.art,
						self.menuConfig.options,
						(err, artData) => {
							if(err) {
								self.client.log.trace('Could not display art', { art : self.menuConfig.art, reason : err.message } );
							} else {
								mciData.menu = artData.mciMap;
							}

							return callback(null);	//	any errors are non-fatal
						}
					);
				},
				function moveToPromptLocation(callback) {
					if(self.menuConfig.prompt) {
						//	:TODO: fetch and move cursor to prompt location, if supplied. See notes/etc. on placements
					}

					return callback(null);
				},
				function displayPromptArt(callback) {
					if(!_.isString(self.menuConfig.prompt)) {
						return callback(null);
					}

					if(!_.isObject(self.menuConfig.promptConfig)) {
						return callback(Errors.MissingConfig('Prompt specified but no "promptConfig" block found'));
					}

					self.displayAsset(
						self.menuConfig.promptConfig.art,
						self.menuConfig.options,
						(err, artData) => {
							if(artData) {
								mciData.prompt = artData.mciMap;
							}
							return callback(err);	//	pass err here; prompts *must* have art
						}
					);
				},
				function recordCursorPosition(callback) {
					if(!self.shouldPause()) {
						return callback(null);	//	cursor position not needed
					}

					self.client.once('cursor position report', pos => {
						pausePosition = { row : pos[0], col : 1 };
						self.client.log.trace('After art position recorded', pausePosition );
						return callback(null);
					});

					self.client.term.rawWrite(ansi.queryPos());
				},
				function afterArtDisplayed(callback) {
					return self.mciReady(mciData, callback);
				},
				function displayPauseIfRequested(callback) {
					if(!self.shouldPause()) {
						return callback(null);
					}

					return self.pausePrompt(pausePosition, callback);
				},
				function finishAndNext(callback) {
					self.finishedLoading();
					return self.autoNextMenu(callback);
				}
			],
			err => {
				if(err) {
					self.client.log.warn('Error during init sequence', { error : err.message } );

					return self.prevMenu( () => { /* dummy */ } );
				}
			}
		);
	}

	beforeArt(cb) {
		if(_.isNumber(this.menuConfig.options.baudRate)) {
			//	:TODO: some terminals not supporting cterm style emulated baud rate end up displaying a broken ESC sequence or a single "r" here
			this.client.term.rawWrite(ansi.setEmulatedBaudRate(this.menuConfig.options.baudRate));
		}

		if(this.cls) {
			this.client.term.rawWrite(ansi.resetScreen());
		}

		return cb(null);
	}

	mciReady(mciData, cb) {
		//	available for sub-classes
		return cb(null);
	}

	finishedLoading() {
		//	nothing in base
	}

	getSaveState() {
		//	nothing in base
	}

	restoreSavedState(/*savedState*/) {
		//	nothing in base
	}

	getMenuResult() {
		//	default to the formData that was provided @ a submit, if any
		return this.submitFormData;
	}

	nextMenu(cb) {
		if(!this.haveNext()) {
			return this.prevMenu(cb);	//	no next, go to prev
		}

		return this.client.menuStack.next(cb);
	}

	prevMenu(cb) {
		return this.client.menuStack.prev(cb);
	}

	gotoMenu(name, options, cb) {
		return this.client.menuStack.goto(name, options, cb);
	}

	addViewController(name, vc) {
		assert(!this.viewControllers[name], `ViewController by the name of "${name}" already exists!`);

		this.viewControllers[name] = vc;
		return vc;
	}

	detachViewControllers() {
		Object.keys(this.viewControllers).forEach( name => {
			this.viewControllers[name].detachClientEvents();
		});
	}

	shouldPause() {
		return ('end' === this.menuConfig.options.pause || true === this.menuConfig.options.pause);
	}

	hasNextTimeout() {
		return _.isNumber(this.menuConfig.options.nextTimeout);
	}

	haveNext() {
		return (_.isString(this.menuConfig.next) || _.isArray(this.menuConfig.next));
	}

	autoNextMenu(cb) {
		const self = this;

		function gotoNextMenu() {
			if(self.haveNext()) {
				return menuUtil.handleNext(self.client, self.menuConfig.next, {}, cb);
			} else {
				return self.prevMenu(cb);
			}
		}

		if(_.has(this.menuConfig, 'runtime.autoNext') && true === this.menuConfig.runtime.autoNext) {
			if(this.hasNextTimeout()) {
				setTimeout( () => {
					return gotoNextMenu();
				}, this.menuConfig.options.nextTimeout);
			} else {
				return gotoNextMenu();
			}
		}
	}

	standardMCIReadyHandler(mciData, cb) {
		//
		//	A quick rundown:
		//	*	We may have mciData.menu, mciData.prompt, or both.
		//	*	Prompt form is favored over menu form if both are present.
		//	*	Standard/prefdefined MCI entries must load both (e.g. %BN is expected to resolve)
		//
		const self = this;

		async.series(
			[
				function addViewControllers(callback) {
					_.forEach(mciData, (mciMap, name) => {
						assert('menu' === name || 'prompt' === name);
						self.addViewController(name, new ViewController( { client : self.client } ) );
					});

					return callback(null);
				},
				function createMenu(callback) {
					if(!self.viewControllers.menu) {
						return callback(null);
					}

					const menuLoadOpts = {
						mciMap		: mciData.menu,
						callingMenu	: self,
						withoutForm	: _.isObject(mciData.prompt),
					};

					self.viewControllers.menu.loadFromMenuConfig(menuLoadOpts, err => {
						return callback(err);
					});
				},
				function createPrompt(callback) {
					if(!self.viewControllers.prompt) {
						return callback(null);
					}

					const promptLoadOpts = {
						callingMenu		: self,
						mciMap			: mciData.prompt,
					};

					self.viewControllers.prompt.loadFromPromptConfig(promptLoadOpts, err => {
						return callback(err);
					});
				}
			],
			err => {
				return cb(err);
			}
		);
	}

	displayAsset(name, options, cb) {
		if(_.isFunction(options)) {
			cb = options;
			options = {};
		}

		if(options.clearScreen) {
			this.client.term.rawWrite(ansi.resetScreen());
		}

		return theme.displayThemedAsset(
			name,
			this.client,
			Object.assign( { font : this.menuConfig.config.font }, options ),
			(err, artData) => {
				if(cb) {
					return cb(err, artData);
				}
			}
		);
	}

	prepViewController(name, formId, mciMap, cb) {
		if(_.isUndefined(this.viewControllers[name])) {
			const vcOpts = {
				client		: this.client,
				formId		: formId,
			};

			const vc = this.addViewController(name, new ViewController(vcOpts));

			const loadOpts = {
				callingMenu		: this,
				mciMap			: mciMap,
				formId			: formId,
			};

			return vc.loadFromMenuConfig(loadOpts, err => {
				return cb(err, vc);
			});
		}

		this.viewControllers[name].setFocus(true);

		return cb(null, this.viewControllers[name]);
	}

	prepViewControllerWithArt(name, formId, options, cb) {
		this.displayAsset(
			this.menuConfig.config.art[name],
			options,
			(err, artData) => {
				if(err) {
					return cb(err);
				}

				return this.prepViewController(name, formId, artData.mciMap, cb);
			}
		);
	}

	optionalMoveToPosition(position) {
		if(position) {
			position.x = position.row || position.x || 1;
			position.y = position.col || position.y || 1;

			this.client.term.rawWrite(ansi.goto(position.x, position.y));
		}
	}

	pausePrompt(position, cb) {
		if(!cb && _.isFunction(position)) {
			cb = position;
			position = null;
		}

		this.optionalMoveToPosition(position);

		return theme.displayThemedPause(this.client, cb);
	}

	/*
	:TODO: this needs quite a bit of work - but would be nice: promptForInput(..., (err, formData) => ... )
	promptForInput(formName, name, options, cb) {
		if(!cb && _.isFunction(options)) {
			cb = options;
			options = {};
		}

		options.viewController = this.viewControllers[formName];

		this.optionalMoveToPosition(options.position);

		return theme.displayThemedPrompt(name, this.client, options, cb);
	}
	*/

	setViewText(formName, mciId, text, appendMultiLine) {
		const view = this.viewControllers[formName].getView(mciId);
		if(!view) {
			return;
		}

		if(appendMultiLine && (view instanceof MultiLineEditTextView)) {
			view.addText(text);
		} else {
			view.setText(text);
		}
	}

	updateCustomViewTextsWithFilter(formName, startId, fmtObj, options) {
		options = options || {};

		let textView;
		let customMciId = startId;
		const config	= this.menuConfig.config;
		const endId		= options.endId || 99;	//	we'll fail to get a view before 99

		while(customMciId <= endId && (textView = this.viewControllers[formName].getView(customMciId)) ) {
			const key		= `${formName}InfoFormat${customMciId}`;	//	e.g. "mainInfoFormat10"
			const format	= config[key];

			if(format && (!options.filter || options.filter.find(f => format.indexOf(f) > - 1))) {
				const text = stringFormat(format, fmtObj);

				if(options.appendMultiLine && (textView instanceof MultiLineEditTextView)) {
					textView.addText(text);
				} else {
					textView.setText(text);
				}
			}

			++customMciId;
		}
	}

	refreshPredefinedMciViewsByCode(formName, mciCodes) {
		const form = _.get(this, [ 'viewControllers', formName] );
		if(form) {
			form.getViewsByMciCode(mciCodes).forEach(v => {
				if(!v.setText) {
					return;
				}

				v.setText(getPredefinedMCIValue(this.client, v.mciCode));
			});
		}
	}
};
