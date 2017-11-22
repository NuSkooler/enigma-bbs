/* jslint node: true */
'use strict';

const MenuModule	= require('../../core/menu_module.js').MenuModule;
const stringFormat	= require('../../core/string_format.js');

//	deps
const async			= require('async');
const _				= require('lodash');
const net			= require('net');

/*
	Expected configuration block example:

	config: {
		host: 192.168.1.171
		port: 5001
		bbsTag: SOME_TAG
	}

*/

exports.getModule	= ErcClientModule;

exports.moduleInfo = {
	name	: 'ENiGMA Relay Chat Client',
	desc	: 'Chat with other ENiGMA BBSes',
	author	: 'Andrew Pamment',
};

var MciViewIds = {
	ChatDisplay : 1,
	InputArea 	: 3,
};

//	:TODO: needs converted to ES6 MenuModule subclass
function ErcClientModule(options) {
	MenuModule.prototype.ctorShim.call(this, options);

	const self			= this;  
	this.config			= options.menuConfig.config;

	this.chatEntryFormat	= this.config.chatEntryFormat || '[{bbsTag}] {userName}: {message}';
	this.systemEntryFormat	= this.config.systemEntryFormat || '[*SYSTEM*] {message}';	
	
	this.finishedLoading = function() {
		async.waterfall(
			[
				function validateConfig(callback) {
					if(_.isString(self.config.host) &&
						_.isNumber(self.config.port) &&
						_.isString(self.config.bbsTag))
					{
						return callback(null);
					} else {
						return callback(new Error('Configuration is missing required option(s)'));
					}
				},
				function connectToServer(callback) {
					const connectOpts = {
						port	: self.config.port,
						host	: self.config.host,
					};

					const chatMessageView = self.viewControllers.menu.getView(MciViewIds.ChatDisplay);
					
					chatMessageView.setText('Connecting to server...');
					chatMessageView.redraw();
					
					self.viewControllers.menu.switchFocus(MciViewIds.InputArea);
					
					//	:TODO: Track actual client->enig connection for optional prevMenu @ final CB
					self.chatConnection = net.createConnection(connectOpts.port, connectOpts.host);

					self.chatConnection.on('data', data => {
						data = data.toString();

						if(data.startsWith('ERCHANDSHAKE')) {
							self.chatConnection.write(`ERCMAGIC|${self.config.bbsTag}|${self.client.user.username}\r\n`);
						} else if(data.startsWith('{')) {
							try {
								data = JSON.parse(data);
							} catch(e) {
								return self.client.log.warn( { error : e.message }, 'ERC: Error parsing ERC data from server');
							}

							let text;
							try {
								if(data.userName) {
									//	user message
									text = stringFormat(self.chatEntryFormat, data);
								} else {
									//	system message
									text = stringFormat(self.systemEntryFormat, data);
								}
							} catch(e) {
								return self.client.log.warn( { error : e.message }, 'ERC: chatEntryFormat error');
							}

							chatMessageView.addText(text);
					
							if(chatMessageView.getLineCount() > 30) {	//	:TODO: should probably be ChatDisplay.height?
								chatMessageView.deleteLine(0);
								chatMessageView.scrollDown();
							}
							
							chatMessageView.redraw();
							self.viewControllers.menu.switchFocus(MciViewIds.InputArea);
						}
					});

					self.chatConnection.once('end', () => {
						return callback(null);
					});

					self.chatConnection.once('error', err => {
						self.client.log.info(`ERC connection error: ${err.message}`);
						return callback(new Error('Failed connecting to ERC server!'));
					});
				}
			],
			err => {
				if(err) {
					self.client.log.warn( { error : err.message }, 'ERC error');
				}

				self.prevMenu();
			}
		);
	};

	this.scrollHandler = function(keyName) {
		const inputAreaView 	= self.viewControllers.menu.getView(MciViewIds.InputArea);
		const chatDisplayView	= self.viewControllers.menu.getView(MciViewIds.ChatDisplay);

		if('up arrow' === keyName) {
			chatDisplayView.scrollUp();
		} else {
			chatDisplayView.scrollDown();
		}

		chatDisplayView.redraw();
		inputAreaView.setFocus(true);
	};


	this.menuMethods = {
		inputAreaSubmit : function(formData, extraArgs, cb) {
			const inputAreaView = self.viewControllers.menu.getView(MciViewIds.InputArea);
			const inputData		= inputAreaView.getData();

			if('/quit' === inputData.toLowerCase()) {
				self.chatConnection.end();
			} else {
				try {
					self.chatConnection.write(`${inputData}\r\n`);
				} catch(e) {
					self.client.log.warn( { error : e.message }, 'ERC error');
				}
				inputAreaView.clearText();
			}
			return cb(null);
		},
		scrollUp : function(formData, extraArgs, cb) {
			self.scrollHandler(formData.key.name);
			return cb(null);
		},
		scrollDown : function(formData, extraArgs, cb) {
			self.scrollHandler(formData.key.name);
			return cb(null);
		}
	};
}

require('util').inherits(ErcClientModule, MenuModule);

ErcClientModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};
