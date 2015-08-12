/* jslint node: true */
'use strict';

var assert				= require('assert');

//
//	A simple mixin for View Controller management
//
var ViewControllerManagement = function() {
	this.initViewControllers = function() {
		this.viewControllers = {};
	};

	this.detachViewControllers = function() {
		var self = this;
		Object.keys(this.viewControllers).forEach(function vc(name) {
			self.viewControllers[name].detachClientEvents();
		});
	};

	this.addViewController = function(name, vc) {
		assert(this.viewControllers, 		'initViewControllers() has not been called!');
		assert(!this.viewControllers[name], 'ViewController by the name of \'' + name + '\' already exists!');
		
		this.viewControllers[name] = vc;
		return vc;
	};
};

exports.ViewControllerManagement	= ViewControllerManagement;