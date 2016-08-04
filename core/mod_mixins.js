/* jslint node: true */
'use strict';

const messageArea		= require('../core/message_area.js');

//	deps
const assert				= require('assert');

//
//	A simple mixin for View Controller management
//
exports.ViewControllerManagement = function() {
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

exports.MessageAreaConfTempSwitcher = function() {
	
	this.tempMessageConfAndAreaSwitch = function(messageAreaTag) {
		messageAreaTag = messageAreaTag || this.messageAreaTag;
		if(!messageAreaTag) {
			return;	//	nothing to do!
		}
		this.prevMessageConfAndArea = {
			confTag	: this.client.user.properties.message_conf_tag,
			areaTag	: this.client.user.properties.message_area_tag,		
		};
		if(!messageArea.tempChangeMessageConfAndArea(this.client, this.messageAreaTag)) {
			this.client.log.warn( { messageAreaTag : messageArea }, 'Failed to perform temporary message area/conf switch');
		}
	};

	this.tempMessageConfAndAreaRestore = function() {
		if(this.prevMessageConfAndArea) {
			this.client.user.properties.message_conf_tag = this.prevMessageConfAndArea.confTag;
			this.client.user.properties.message_area_tag = this.prevMessageConfAndArea.areaTag;		
		}
	};

};
