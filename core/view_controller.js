/* jslint node: true */
'use strict';

//	ENiGMA½
var MCIViewFactory	= require('./mci_view_factory.js').MCIViewFactory;
var menuUtil		= require('./menu_util.js');
var Log				= require('./logger.js').log;
var Config			= require('./config.js').config;
var asset			= require('./asset.js');
var ansi			= require('./ansi_term.js');

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
	this.submitKeyMap	= {};

	this.clientKeyPressHandler = function(key, isSpecial) {
		if(isSpecial) {
			return;
		}

		if(self.focusedView && self.focusedView.acceptsInput) {
			key = 'string' === typeof key ? key : key.toString();
			self.focusedView.onKeyPress(key, isSpecial);
		}
	};

	this.clientSpecialKeyHandler = function(keyName) {

		var submitViewId = self.submitKeyMap[keyName];
		if(submitViewId) {
			self.switchFocus(submitViewId);
			self.submitForm();
		} else {
			if(self.focusedView && self.focusedView.acceptsInput) {
				self.focusedView.onSpecialKeyPress(keyName);
			}
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
					"3" 2,
					"pants" : "no way"
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
		//	:TODO: these fields should be part of menu.json sensitiveMembers[]
		var safeFormData = _.cloneDeep(formData);
		if(safeFormData.value.password) {
			safeFormData.value.password = '*****';
		}
		if(safeFormData.value.passwordConfirm) {
			safeFormData.value.passwordConfirm = '*****';
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

	this.createViewsFromMCI = function(mciMap, cb) {
		async.each(Object.keys(mciMap), function entry(name, nextItem) {
			var mci		= mciMap[name];
			var view	= self.mciViewFactory.createFromMCI(mci);

			if(view) {
				view.on('action', self.viewActionListener);

				self.addView(view);
			}

			nextItem(null);
		},
		function complete(err) {
			self.setViewOrder();
			cb(err);
		});
	};

	//	:TODO: move this elsewhere
	this.setViewPropertiesFromMCIConf = function(view, conf) {

		function setViewProp(propName, setter) {
			if(conf[propName]) {
				var propValue = asset.resolveConfigAsset(conf[propName]);
				if(propValue) {
					if(setter) {
						setter(propValue);
					} else {
						view[propName] = propValue;
					}
				}
			}
		}

		setViewProp('width', function(v) { view.setWidth(parseInt(v, 10)); });
		setViewProp('height', function(v) { view.setHeight(parseInt(v, 10)); });
		
		setViewProp('itemSpacing', function(v) { view.setItemSpacing(v); });
		setViewProp('items', function(v) { view.setItems(v); });
		
		setViewProp('text', function(v) { view.setText(v); });
		setViewProp('textStyle');
		setViewProp('focusTextStyle');
		setViewProp('textMaskChar', function(v) { view.textMaskChar = v.substr(0, 1); });
		setViewProp('justify');
		setViewProp('textOverflow');
		
		setViewProp('maxLength');


		['styleSGR1', 'styleSGR2'].forEach(function styleSgr(style) {
			setViewProp(style, function(v) {
				if(_.isObject(v)) {
					view.styleSGR1 = ansi.getSGRFromGraphicRendition(v, true);
				} else if(_.isString(v)) {
					view.styleSGR1 = v;
				}
			});
		});		

		setViewProp('fillChar', function(v) {
			if(_.isNumber(v)) {
				view.fillChar = String.fromCharCode(v);
			} else if(_.isString(v)) {
				view.fillChar = v.substr(0, 1);
			}
		});

		setViewProp('password', function(v) {
			if(true === v) {
				view.textMaskChar = self.client.currentThemeInfo.getPasswordChar();
			}
		});

		
		setViewProp('hotKeys', function(v) { view.setHotKeys(v); });

		setViewProp('submit', function(v) {
			if(_.isBoolean(v)) {
				view.submit = v;
			} else {
				view.submit = _.isArray(v) && v.length > 0;
			}
		});

		setViewProp('argName', function(v) { view.submitArgName = v; });
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
			
			if(!view) {
				Log.warn( { viewId : viewId }, 'Cannot find view');
				nextItem(null);
				return;
			}

			var mciConf		= config.mci[mci];

			self.setViewPropertiesFromMCIConf(view, mciConf);

			if(mciConf.focus) {
				initialFocusId = viewId;
			}

			if(view.submit) {
				submitId = viewId;

				if(_.isArray(mciConf.submit)) {
					for(var i = 0; i < mciConf.submit.length; i++) {
						self.submitKeyMap[mciConf.submit[i]] = viewId;
					}
				}
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

	this.client.on('key press', this.clientKeyPressHandler);
	this.client.on('special key', this.clientSpecialKeyHandler);

	this.attached = true;
};

ViewController.prototype.detachClientEvents = function() {
	if(!this.attached) {
		return;
	}
	
	this.client.removeListener('key press', this.clientKeyPressHandler);
	this.client.removeListener('special key', this.clientSpecialKeyHandler);

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

ViewController.prototype.loadFromPromptConfig = function(options, cb) {
	assert(_.isObject(options));
	assert(_.isObject(options.mciMap));
	
	var self			= this;
	var promptConfig	= self.client.currentMenuModule.menuConfig.promptConfig;
	var initialFocusId	= 1;	//	default to first

	async.waterfall(
		[
			function createViewsFromMCI(callback) {
				self.createViewsFromMCI(options.mciMap, function viewsCreated(err) {
					callback(err);
				});
			},
			function applyViewConfiguration(callback) {
				if(_.isObject(promptConfig.mci)) {
					self.applyViewConfig(promptConfig, function configApplied(err, info) {
						initialFocusId = info.initialFocusId;
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function prepareFormSubmission(callback) {

				self.on('submit', function promptSubmit(formData) {
					Log.trace( { formData : self.getLogFriendlyFormData(formData) }, 'Prompt submit');

					menuUtil.handleAction(self.client, formData, self.client.currentMenuModule.menuConfig);
				});

				callback(null);
			},
			function drawAllViews(callback) {
				self.client.term.write(ansi.hideCursor());
				
				for(var id in self.views) {
					if(initialFocusId === id) {
						continue;	//	will draw @ focus
					}
					self.views[id].redraw();
				}
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
	assert(_.isObject(options.mciMap));

	var self			= this;
	var formIdKey		= options.formId ? options.formId.toString() : '0';
	var initialFocusId	= 1;	//	default to first
	var formConfig;

	//	:TODO: honor options.withoutForm

	//	method for comparing submitted form data to configuration entries
	var actionBlockValueComparator = function(formValue, actionValue) {
		//
		//	For a match to occur, one of the following must be true:
		//
		//	*	actionValue is a Object:
		//		a)	All key/values must exactly match
		//		b)	value is null; The key (view ID) must be present
		//			in formValue. This is a wildcard/any match.
		//	*	actionValue is a Number: This represents a view ID that
		//		must be present in formValue.
		//
		if(_.isNumber(actionValue)) {
			if(_.isUndefined(formValue[actionValue])) {
				return false;
			}
		} else {
			var actionValueKeys = Object.keys(actionValue);
			for(var i = 0; i < actionValueKeys.length; ++i) {
				var viewId = actionValueKeys[i];
				if(!_.has(formValue, viewId)) {
					return false;
				}

				if(null !== actionValue[viewId] && actionValue[viewId] !== formValue[viewId]) {
					return false;
				}
			}
		}

		Log.trace( { formValue : formValue, actionValue : actionValue }, 'Action match');
		return true;
	};

	async.waterfall(
		[
			function findMatchingFormConfig(callback) {
				menuUtil.getFormConfigByIDAndMap(self.client.currentMenuModule.menuConfig, formIdKey, options.mciMap, function matchingConfig(err, fc) {
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
							menuUtil.handleAction(self.client, formData, actionBlock);
							break;	//	there an only be one...
						}
					}
				});

				callback(null);
			},
			function drawAllViews(callback) {
				self.client.term.write(ansi.hideCursor());

				for(var id in self.views) {
					if(initialFocusId === id) {
						continue;	//	will draw @ focus
					}
					self.views[id].redraw();
				}
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

/*
ViewController.prototype.formatMenuArgs = function(args) {
	var self = this;

	return _.mapValues(args, function val(value) {
		if('string' === typeof value) {
			return self.formatMCIString(value);
		}
		return value;
	});
};
*/