/* jslint node: true */
'use strict';

//	ENiGMA½
var MCIViewFactory	= require('./mci_view_factory.js').MCIViewFactory;
var menuUtil		= require('./menu_util.js');
var Log				= require('./logger.js').log;
var Config			= require('./config.js').config;
var asset			= require('./asset.js');

var events			= require('events');
var util			= require('util');
var assert			= require('assert');
var async			= require('async');
var _				= require('lodash');
var paths			= require('path');

exports.ViewController		= ViewController;

var MCI_REGEXP	= /([A-Z]{2})([0-9]{1,2})/;

function ViewController(options) {
	assert(_.isObject(options));
	assert(_.isObject(options.client));

	events.EventEmitter.call(this);

	var self			= this;

	this.client			= options.client;
	this.views			= {};	//	map of ID -> view
	this.formId			= options.formId || 0;
	this.mciViewFactory	= new MCIViewFactory(this.client);

	this.onClientKeyPress = function(key, isSpecial) {
		if(isSpecial) {
			return;
		}

		if(self.focusedView && self.focusedView.acceptsInput) {
			key = 'string' === typeof key ? key : key.toString();
			self.focusedView.onKeyPress(key, isSpecial);
		}
	};

	this.onClientSpecialKeyPress = function(keyName) {
		if(self.focusedView && self.focusedView.acceptsInput) {
			self.focusedView.onSpecialKeyPress(keyName);
		}
	};

	this.viewActionListener = function(action) {
		switch(action) {
			case 'next' :
				self.emit('action', { view : this, action : action });
				self.nextFocus();
				break;

			case 'accept' :	//	:TODO: consider naming this 'done'
				//	:TODO: check if id is submit, etc.
				if(self.focusedView && self.focusedView.submit) {
					self.submitForm();
				} else {
					self.nextFocus();
				}
				break;
		}
	};

	this.submitForm = function() {
		/*
			Generate a form resonse. Example:

			{
				id : 0,
				submitId : 1,
				value : {
					"1" : "hurp",
					"2" : [ 'a', 'b', ... ],
					"3 " 2,
				}

			}
		*/
		var formData = {
			id			: self.formId,
			submitId	: self.focusedView.id,
			value		: {},
		};

		var viewData;
		var view;
		for(var id in self.views) {
			try {
				view = self.views[id];
				viewData = view.getData();
				if(!_.isUndefined(viewData)) {
					if(_.isString(view.submitArgName)) {
						formData.value[view.submitArgName] = viewData;
					} else {
						formData.value[id] = viewData;
					}
				}
			} catch(e) {
				Log.error(e);	//	:TODO: Log better ;)
			}
		}

		self.emit('submit', formData);
	};

	this.getLogFriendlyFormData = function(formData) {
		var safeFormData = _.cloneDeep(formData);
		if(safeFormData.value.password) {
			safeFormData.value.password = '*****';
		}
		return safeFormData;
	};

	this.switchFocusEvent = function(event, view) {
		if(self.emitSwitchFocus) {
			return;
		}

		self.emitSwitchFocus = true;
		self.emit(event, view);
		self.emitSwitchFocus = false;
	};

	this.handleSubmitAction = function(callingMenu, formData, conf) {
		assert(_.isObject(conf));
		assert(_.isString(conf.action));

		var actionAsset = asset.parseAsset(conf.action);
		assert(_.isObject(actionAsset));

		var extraArgs;
		if(conf.extraArgs) {
			extraArgs = self.formatMenuArgs(conf.extraArgs);
		}

		switch(actionAsset.type) {
			case 'method' :
				if(_.isString(actionAsset.location)) {
					//	:TODO: allow omition of '.js'
					var methodMod = require(paths.join(Config.paths.mods, actionAsset.location));
					if(_.isFunction(methodMod[actionAsset.asset])) {
						methodMod[actionAsset.asset](callingMenu, formData, extraArgs);
					}
				} else {
					//	local to current module
					var currentModule = self.client.currentMenuModule;
					if(_.isFunction(currentModule.menuMethods[actionAsset.asset])) {
						currentModule.menuMethods[actionAsset.asset](formData, extraArgs);
					}
				}
				break;

			case 'menu' :
			//	:TODO: update everythign to handle this format
				self.client.gotoMenuModule( { name : actionAsset.asset, submitData : formData, extraArgs : extraArgs } );
				break;
		}
	};

	this.createViewsFromMCI = function(mciMap, cb) {
		async.each(Object.keys(mciMap), function entry(name, nextItem) {
			var mci		= mciMap[name];
			var view	= self.mciViewFactory.createFromMCI(mci);

			if(view) {
				view.on('action', self.viewActionListener);

				self.addView(view);

				view.redraw();	//	:TODO: fix double-redraw if this is the item we set focus to!
			}

			nextItem(null);
		},
		function complete(err) {
			self.setViewOrder();
			cb(err);
		});
	};

	this.setViewPropertiesFromMCIConf = function(view, conf) {
		view.submit = conf.submit || false;

		if(_.isArray(conf.items)) {
			view.setItems(conf.items);
		}

		if(_.isString(conf.text)) {
			view.setText(conf.text);
		}

		if(_.isString(conf.argName)) {
			view.submitArgName = conf.argName;
		}
	};

	this.applyViewConfig = function(config, cb) {
		var highestId = 1;
		var submitId;
		var initialFocusId = 1;

		async.each(Object.keys(config.mci), function entry(mci, nextItem) {
			var mciMatch	= mci.match(MCI_REGEXP);	//	:TODO: How to handle auto-generated IDs????	

			var viewId		= parseInt(mciMatch[2]);
			assert(!isNaN(viewId));

			var view		= self.getView(viewId);
			var mciConf		= config.mci[mci];

			self.setViewPropertiesFromMCIConf(view, mciConf);

			if(mciConf.focus) {
				initialFocusId = viewId;
			}

			if(view.submit) {
				submitId = viewId;
			}

			nextItem(null);
		},
		function complete(err) {
			
			//	default to highest ID if no 'submit' entry present
			if(!submitId) {
				self.getView(highestId).submit = true;
			}

			cb(err, { initialFocusId : initialFocusId } );
		});
	};

	this.attachClientEvents();
}

util.inherits(ViewController, events.EventEmitter);

ViewController.prototype.attachClientEvents = function() {
	if(this.attached) {
		return;
	}

	this.client.on('key press', this.onClientKeyPress);
	this.client.on('special key', this.onClientSpecialKeyPress);

	this.attached = true;
};

ViewController.prototype.detachClientEvents = function() {
	if(!this.attached) {
		return;
	}
	
	this.client.removeListener('key press', this.onClientKeyPress);
	this.client.removeListener('special key', this.onClientSpecialKeyPress);

	for(var id in this.views) {
		this.views[id].removeAllListeners();
	}

	this.attached = false;
};

ViewController.prototype.viewExists = function(id) {
	return id in this.views;
};

ViewController.prototype.addView = function(view) {
	assert(!this.viewExists(view.id), 'View with ID ' + view.id + ' already exists');

	this.views[view.id] = view;
};

ViewController.prototype.getView = function(id) {
	return this.views[id];
};

ViewController.prototype.getFocusedView = function() {
	return this.focusedView;
};

ViewController.prototype.switchFocus = function(id) {
	if(this.focusedView && this.focusedView.acceptsFocus) {
		this.switchFocusEvent('leave', this.focusedView);
		this.focusedView.setFocus(false);
	}

	var view = this.getView(id);
	if(view && view.acceptsFocus) {
		this.switchFocusEvent('enter', view);

		this.focusedView = view;
		this.focusedView.setFocus(true);
	}
};

ViewController.prototype.nextFocus = function() {
	if(!this.focusedView) {
		this.switchFocus(this.views[this.firstId].id);
	} else {
		var nextId = this.views[this.focusedView.id].nextId;
		this.switchFocus(nextId);
	}
};

ViewController.prototype.setViewOrder = function(order) {
	var viewIdOrder = order || [];

	if(0 === viewIdOrder.length) {
		for(var id in this.views) {
			if(this.views[id].acceptsFocus) {
				viewIdOrder.push(id);
			}
		}

		viewIdOrder.sort(function intSort(a, b) {
			return a - b;
		});
	}

	if(viewIdOrder.length > 0) {
		var view;
		var count = viewIdOrder.length - 1;
		for(var i = 0; i < count; ++i) {
			this.views[viewIdOrder[i]].nextId = viewIdOrder[i + 1];
		}

		this.firstId = viewIdOrder[0];
		var lastId = viewIdOrder.length > 1 ? viewIdOrder[viewIdOrder.length - 1] : this.firstId;
		this.views[lastId].nextId = this.firstId;
	}
};

ViewController.prototype.loadFromMCIMap = function(mciMap) {
	var factory = new MCIViewFactory(this.client);
	var self	= this;

	Object.keys(mciMap).forEach(function onMciEntry(name) {
		var mci		= mciMap[name];
		var view	= factory.createFromMCI(mci);

		if(view) {
			view.on('action', self.viewActionListener);
			self.addView(view);
			view.redraw();	//	:TODO: This can result in double redraw() if we set focus on this item after
		}
	});
};

ViewController.prototype.loadFromPromptConfig = function(options, cb) {
	assert(_.isObject(options));
	assert(_.isObject(options.callingMenu));
	assert(_.isObject(options.callingMenu.menuConfig));
	assert(_.isObject(options.callingMenu.menuConfig.promptConfig));
	assert(_.isObject(options.mciMap));

	var promptConfig	= options.callingMenu.menuConfig.promptConfig;
	var self			= this;
	var initialFocusId	= 1;	//	default to first

	async.waterfall(
		[
			function createViewsFromMCI(callback) {
				self.createViewsFromMCI(options.mciMap, function viewsCreated(err) {
					callback(err);
				});
			},
			function applyViewConfiguration(callback) {
				self.applyViewConfig(promptConfig, function configApplied(err, info) {
					initialFocusId = info.initialFocusId;
					callback(err);
				});				
			},
			function prepareFormSubmission(callback) {

				self.on('submit', function promptSubmit(formData) {
					Log.trace( { formData : self.getLogFriendlyFormData(formData) }, 'Prompt submit');

					self.handleSubmitAction(options.callingMenu, formData, options.callingMenu.menuConfig);
				});

				callback(null);
			},
			function setInitialViewFocus(callback) {
				if(initialFocusId) {
					self.switchFocus(initialFocusId);
				}
				callback(null);
			}
		],
		function complete(err) {
			cb(err);
		}
	);
};

ViewController.prototype.loadFromMenuConfig = function(options, cb) {
	assert(_.isObject(options));
	assert(_.isObject(options.callingMenu));
	assert(_.isObject(options.callingMenu.menuConfig));
	assert(_.isObject(options.mciMap));

	var self			= this;
	var formIdKey		= options.formId ? options.formId.toString() : '0';
	var initialFocusId	= 1;	//	default to first
	var formConfig;

	//	:TODO: honor options.withoutForm

	//	method for comparing submitted form data to configuration entries
	var actionBlockValueComparator = function(formValue, actionValue) {
		//
		//	Any key(s) in actionValue must:
		//	1) Be present in formValue
		//	2) Either:
		//		a) Be set to null (wildcard/any)
		//		b) Have matching value(s)
		//
		var keys = Object.keys(actionValue);
		for(var i = 0; i < keys.length; ++i) {
			var name = keys[i];

			//	submit data contains config key?
			if(!_.has(formValue, name)) {
				return false;	//	not present in what was submitted
			}

			if(null !== actionValue[name] && actionValue[name] !== formValue[name]) {
				return false;
			}
		}
		
		return true;
	};

	async.waterfall(
		[
			function findMatchingFormConfig(callback) {
				menuUtil.getFormConfigByIDAndMap(options.callingMenu.menuConfig, formIdKey, options.mciMap, function matchingConfig(err, fc) {
					formConfig = fc;

					if(err) {
						//	non-fatal
						Log.trace(
							{ error : err, mci : Object.keys(options.mciMap), formId : formIdKey },
							'Unable to find matching form configuration');
					}

					callback(null);
				});
			},
			function createViews(callback) {
				self.createViewsFromMCI(options.mciMap, function viewsCreated(err) {
					callback(err);
				});
			},
			function applyViewConfiguration(callback) {
				if(_.isObject(formConfig)) {
					self.applyViewConfig(formConfig, function configApplied(err, info) {
						initialFocusId = info.initialFocusId;
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function prepareFormSubmission(callback) {
				if(!_.isObject(formConfig) || !_.isObject(formConfig.submit)) {
					callback(null);
					return;
				}

				self.on('submit', function formSubmit(formData) {
					Log.trace( { formData : self.getLogFriendlyFormData(formData) }, 'Form submit');

					//
					//	Locate configuration for this form ID
					//
					var confForFormId;
					if(_.isObject(formConfig.submit[formData.submitId])) {
						confForFormId = formConfig.submit[formData.submitId];
					} else if(_.isObject(formConfig.submit['*'])) {
						confForFormId = formConfig.submit['*'];
					} else {
						//	no configuration for this submitId
						Log.debug( { formId : formData.submitId }, 'No configuration for form ID');
						return;
					}

					//
					//	Locate a matching action block based on the submitted data
					//
					for(var c = 0; c < confForFormId.length; ++c) {
						var actionBlock = confForFormId[c];

						if(_.isEqual(formData.value, actionBlock.value, actionBlockValueComparator)) {
							self.handleSubmitAction(options.callingMenu, formData, actionBlock);
							break;	//	there an only be one...
						}
					}
				});

				callback(null);
			},
			function setInitialViewFocus(callback) {
				if(initialFocusId) {
					self.switchFocus(initialFocusId);
				}
				callback(null);
			}
		],
		function complete(err) {
			if(_.isFunction(cb)) {
				cb(err);
			}
		}
	);
};

ViewController.prototype.loadFromMCIMapAndConfig = function(options, cb) {
	assert(options.mciMap);

	var factory 		= new MCIViewFactory(this.client);
	var self			= this;
	var formIdKey		= options.formId ? options.formId.toString() : '0';
	var initialFocusId;
	var formConfig;

	var mciRegEx 		= /([A-Z]{2})([0-9]{1,2})/;

	//	:TODO: remove all the passing of fromConfig - use local
	//	:TODO: break all of this up ... a lot

	async.waterfall(
		[
			function getFormConfig(callback) {
				menuUtil.getFormConfigByIDAndMap(options.menuConfig, formIdKey, options.mciMap, function onFormConfig(err, fc) {
					formConfig = fc;

					if(err) {
						//	:TODO: fix logging of err here:
						Log.trace( 
							{ err : err.toString(), mci : Object.keys(options.mciMap), formIdKey : formIdKey } , 
							'Unable to load menu configuration');
					}

					callback(null);
				});
			},
			function createViews(callback) {
				self.createViewsFromMCI(options.mciMap, function viewsCreated(err) {
					callback(err);
				});
			},
			function applyFormConfig(callback) {
				if(formConfig) {
					async.each(Object.keys(formConfig.mci), function onMciConf(mci, eachCb) {
						var mciMatch = mci.match(mciRegEx);	//	:TODO: what about auto-generated IDs? Do they simply not apply to menu configs?
						var viewId	= parseInt(mciMatch[2]);
						var view	= self.getView(viewId);
						var mciConf = formConfig.mci[mci];

						//	:TODO: Break all of this up ... and/or better way of doing it
						if(mciConf.items) {
							view.setItems(mciConf.items);
						}

						if(mciConf.submit) {
							view.submit = true;	//	:TODO: should really be actual value
						}

						if(mciConf.text) {
							view.setText(mciConf.text);
						}

						if(mciConf.focus) {
							initialFocusId = viewId;
						}

						eachCb(null);
					},
					function eachMciConfComplete(err) {
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function mapMenuSubmit(callback) {
				if(formConfig) {
					//
					//	If we have a 'submit' section, create a submit handler
					//	and map the various entries to menus/etc.
					//
					if(_.isObject(formConfig.submit)) {
						//	:TODO: If this model is kept, formData does not need to include actual data, just form ID & submitID
						//	we can get the rest here via each view in form -> getData()
						self.on('submit', function onSubmit(formData) {
							Log.debug( { formData : formData }, 'Submit form');

							var confForFormId;
							if(_.isObject(formConfig.submit[formData.submitId])) {
								confForFormId = formConfig.submit[formData.submitId];
							} else if(_.isObject(formConfig.submit['*'])) {
								confForFormId = formConfig.submit['*'];
							} else {
								//	no configuration for this submitId
								return;
							}

							var formValueCompare = function(formDataValue, formConfigValue) {
								//
								//	Any key(s) in formConfigValue must:
								//	1) be present in formDataValue
								//	2) must either:
								//		a) be set to null (wildcard/any)
								//		b) have matching values
								//
								var formConfigValueKeys = Object.keys(formConfigValue);
								for(var k = 0; k < formConfigValueKeys.length; ++k) {
									var memberKey = formConfigValueKeys[k];

									//	submit data contains config key?
									if(!_.has(formDataValue, memberKey)) {
										return false;	//	not present in what was submitted
									}

									if(null !== formConfigValue[memberKey] && formConfigValue[memberKey] !== formDataValue[memberKey]) {
										return false;
									}
								}
								
								return true;
							};

							var conf;
							for(var c = 0; c < confForFormId.length; ++c) {
								conf = confForFormId[c];
								if(_.isEqual(formData.value, conf.value, formValueCompare)) {

									if(!conf.action) {
										continue;
									}

									var formattedArgs;
									if(conf.args) {
										formattedArgs = self.formatMenuArgs(conf.args);
									}

									var actionAsset = asset.parseAsset(conf.action);
									assert(_.isObject(actionAsset));

									if('method' === actionAsset.type) {
										if(actionAsset.location) {
											//	:TODO: call with (client, args, ...) at least.
										} else {
											//	local to current module
											var currentMod = self.client.currentMenuModule;
											if(currentMod.menuMethods[actionAsset.asset]) {
												currentMod.menuMethods[actionAsset.asset](formattedArgs);
											}
										}
									} else if('menu' === actionAsset.type) {
										self.client.gotoMenuModule( { name : actionAsset.asset, args : formattedArgs } );
									}
								}
							}
						});
					}
				}

				callback(null);
			},
			function setInitialFocus(callback) {
				if(initialFocusId) {
					self.switchFocus(initialFocusId);
				}

				callback(null);
			}
		],
		function complete(err) {
			if(cb) {
				cb(err);
			}
		}
	);
};

ViewController.prototype.formatMCIString = function(format) {
	var self = this;
	var view;

	return format.replace(/{(\d+)}/g, function replacer(match, number) {
		view = self.getView(number);
		
		if(!view) {
			return match;
		}

		return view.getData();
	});
};

ViewController.prototype.formatMenuArgs = function(args) {
	var self = this;

	return _.mapValues(args, function val(value) {
		if('string' === typeof value) {
			return self.formatMCIString(value);
		}
		return value;
	});
};