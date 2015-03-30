/* jslint node: true */
'use strict';

//	ENiGMA½
var MCIViewFactory	= require('./mci_view_factory.js').MCIViewFactory;
var menuUtil		= require('./menu_util.js');
var Log				= require('./logger.js').log;

var events			= require('events');
var util			= require('util');
var assert			= require('assert');
var async			= require('async');
var ld				= require('lodash');

exports.ViewController		= ViewController;

function ViewController(client, formId) {
	events.EventEmitter.call(this);

	var self		= this;

	this.client		= client;
	this.views		= {};	//	map of ID -> view
	this.formId		= formId || 0;

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

	this.onViewAction = function(action) {
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
		for(var id in self.views) {
			try {
				viewData = self.views[id].getViewData();				
				if(typeof viewData !== 'undefined') {
					formData.value[id] = viewData;
				}
			} catch(e) {
				Log.error(e);	//	:TODO: Log better ;)
			}
		}

		self.emit('submit', formData);
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

ViewController.prototype.switchFocus = function(id) {
	if(this.focusedView && this.focusedView.acceptsFocus) {
		this.focusedView.setFocus(false);
	}

	var view = this.getView(id);
	if(view && view.acceptsFocus) {
		this.focusedView = view;
		this.focusedView.setFocus(true);
	}

	//	:TODO: Probably log here
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
			view.on('action', self.onViewAction);
			self.addView(view);
			view.redraw();	//	:TODO: This can result in double redraw() if we set focus on this item after
		}
	});
};

ViewController.prototype.loadFromMCIMapAndConfig = function(options, cb) {
	assert(options.mciMap);

	var factory = new MCIViewFactory(this.client);
	var self	= this;

	async.waterfall(
		[
			function getFormConfig(callback) {
				menuUtil.getFormConfig(options.menuConfig, options.mciMap, function onFormConfig(err, formConfig) {
					if(err) {
						Log.warn(err, 'Unable to load menu configuration');
					}

					callback(null, formConfig);
				});
			},
			function createViewsFromMCIMap(formConfig, callback) {
				async.each(Object.keys(options.mciMap), function onMciEntry(name, eachCb) {
					var mci		= options.mciMap[name];
					var view	= factory.createFromMCI(mci);

					if(view) {
						view.on('action', self.onViewAction);
						self.addView(view);
						view.redraw();	//	:TODO: This can result in double redraw() if we set focus on this item after
					}
					eachCb(null);
				},
				function eachMciComplete(err) {
					self.setViewOrder();

					callback(err, formConfig);					
				});
			},
			function applyFormConfig(formConfig, callback) {
				if(formConfig) {
					async.each(Object.keys(formConfig.mci), function onMciConf(mci, eachCb) {
						var viewId	= parseInt(mci[2]);	//	:TODO: what about auto-generated ID's? Do they simply not apply to menu configs?
						var mciConf = formConfig.mci[mci];

						//	:TODO: Break all of this up ... and/or better way of doing it
						if(mciConf.items) {
							self.getView(viewId).setItems(mciConf.items);
						}

						if(mciConf.submit) {
							self.getView(viewId).submit = true;	//	:TODO: should really be actual value
						}

						if(mciConf.focus) {
							self.switchFocus(viewId);
						}


						eachCb(null);
					},
					function eachMciConfComplete(err) {
						callback(err, formConfig);
					});
				} else {
					callback(null);
				}
			},
			function mapMenuSubmit(formConfig, callback) {
				if(formConfig) {
					//
					//	If we have a 'submit' section, create a submit handler
					//	and map the various entries to menus/etc.
					//
					if(formConfig.submit && formConfig.submit.length > 0) {
						self.on('submit', function onSubmit(formData) {
							Log.debug( { formData : formData }, 'Submit form');

							for(var c = 0; c < formConfig.submit.length; ++c) {
								console.log(formConfig.submit[c]);

								if(ld.isEqual(formData.value, formConfig.submit[c].value)) {
									self.client.gotoMenuModule(formConfig.submit[c].menu);
									break;
								}

								//	:TODO: Match various wildcards, etc.
							}						
						});
					}
				} else {
					callback(null);
				}
			}
		],
		function complete(err) {
			if(cb) {
				cb(err);
			}
		}
	);
};
