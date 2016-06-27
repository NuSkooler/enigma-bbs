/* jslint node: true */
'use strict';
var MenuModule	= require('../core/menu_module.js').MenuModule;

const async			= require('async');
const _				= require('lodash');
const net			= require('net');

const packageJson 	= require('../package.json');

/*
	Expected configuration block:

	ercClient: {
		art: erc
		module: erc_client
		config: {
			host: 192.168.1.171
			port: 5001
			bbsTag: SUPER
		}

		form: {
			0: {
				mci: {
					MT1: {
						width: 79
						height: 21
						mode: preview
						autoScroll: true
					}
					ET3: {
						autoScale: false
						width: 77
						argName: chattxt
						focus: true
						submit: true
					}
				}

				submit: {
					*: [
						{
							value: { chattxt: null }
							action: @method:processInput
							}
					]
				}
				actionKeys: [
					{
						keys: [ "tab" ]
					}
					{
						keys: [ "up arrow" ]
						action: @method:scrollDown
					}
					{
						keys: [ "down arrow" ]
						action: @method:scrollUp
					}
				]
			}
		}
	}
*/

exports.getModule	= ErcClientModule;

exports.moduleInfo = {
	name	: 'ENiGMA Relay Chat Client',
	desc	: 'Chat with other ENiGMA BBSes',
	author	: 'Andrew Pamment',
};

var MciViewIds = {
  chatDisplay : 1,
  inputArea : 3,
};

function ErcClientModule(options) {
  MenuModule.call(this, options);

  var self	= this;
  this.config = options.menuConfig.config;
	this.chatConnection = null;
  this.finishedLoading = function() {
		async.series(
			[
				function validateConfig(callback) {
					if(_.isString(self.config.host) &&
						_.isNumber(self.config.port) &&
						_.isString(self.config.bbsTag))
					{
						callback(null);
					} else {
						callback(new Error('Configuration is missing required option(s)'));
					}
				},
        function connectToServer(callback) {
          const connectOpts = {
						port	: self.config.port,
						host	: self.config.host,
					};


					var chatMessageView = self.viewControllers.menu.getView(MciViewIds.chatDisplay);
					chatMessageView.setText("Connecting to server...");
					chatMessageView.redraw();
					self.viewControllers.menu.switchFocus(MciViewIds.inputArea);
					self.chatConnection = net.createConnection(connectOpts.port, connectOpts.host);

					self.chatConnection.on('data', data => {
						var chatMessageView = self.viewControllers.menu.getView(MciViewIds.chatDisplay);

						if (data.toString().substring(0, 12) == "ERCHANDSHAKE") {
							self.chatConnection.write("ERCMAGIC|" + self.config.bbsTag + "|" + self.client.user.username + "\r\n");
						} else {
							chatMessageView.addText(data.toString());
							if (chatMessageView.getLineCount() > 30) {
								chatMessageView.deleteLine(0);
								chatMessageView.scrollDown();
							}
							chatMessageView.redraw();
							self.viewControllers.menu.switchFocus(MciViewIds.inputArea);
						}
					});

					self.chatConnection.once('end', () => {
						return callback(null);
					});

					self.chatConnection.once('error', err => {
						self.client.log.info(`Telnet bridge connection error: ${err.message}`);
					});
        }
			],
			err => {
				if(err) {
					self.client.log.warn( { error : err.message }, 'Telnet connection error');
				}

				self.prevMenu();
			}
		);
	};


  this.menuMethods = {
      processInput : function(data, cb) {
        let chatInput = self.viewControllers.menu.getView(MciViewIds.inputArea);
        let chatData = chatInput.getData();
        if (chatData[0] === '/') {
          if (chatData[1] === 'q' || chatInput[1] === 'Q') {
            self.chatConnection.end();
          }
        } else {
          self.chatConnection.write(chatData + "\r\n");
					chatInput.clearText();
        }
      },
			scrollUp : function(data, cb) {
				let chatInput = self.viewControllers.menu.getView(MciViewIds.inputArea);
				let chatMessageView = self.viewControllers.menu.getView(MciViewIds.chatDisplay);
				chatMessageView.scrollUp();
				chatMessageView.redraw();
				chatInput.setFocus(true);
			},
			scrollDown : function(data, cb) {
				let chatInput = self.viewControllers.menu.getView(MciViewIds.inputArea);
				let chatMessageView = self.viewControllers.menu.getView(MciViewIds.chatDisplay);
				chatMessageView.scrollDown();
				chatMessageView.redraw();
				chatInput.setFocus(true);
			}
  };


}

require('util').inherits(ErcClientModule, MenuModule);

ErcClientModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};
