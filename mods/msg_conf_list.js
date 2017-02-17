/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule			= require('../core/menu_module.js').MenuModule;
const ViewController		= require('../core/view_controller.js').ViewController;
const messageArea			= require('../core/message_area.js');
const displayThemeArt		= require('../core/theme.js').displayThemeArt;
const resetScreen			= require('../core/ansi_term.js').resetScreen;
const stringFormat			= require('../core/string_format.js');

//	deps
const async				= require('async');
const _					= require('lodash');

exports.moduleInfo = {
	name	: 'Message Conference List',
	desc	: 'Module for listing / choosing message conferences',
	author	: 'NuSkooler',
};

const MciViewIds = {
	ConfList	: 1,
	
	//	:TODO:
	//	# areas in conf .... see Obv/2, iNiQ, ...
	//	
};

exports.getModule = class MessageConfListModule extends MenuModule {
	constructor(options) {
		super(options);

		this.messageConfs = messageArea.getSortedAvailMessageConferences(this.client);
		const self = this;
		
		this.menuMethods = {
			changeConference : function(formData, extraArgs, cb) {
				if(1 === formData.submitId) {
					let conf		= self.messageConfs[formData.value.conf];
					const confTag	= conf.confTag;
					conf = conf.conf;	//	what we want is embedded 

					messageArea.changeMessageConference(self.client, confTag, err => {
						if(err) {						
							self.client.term.pipeWrite(`\n|00Cannot change conference: ${err.message}\n`);

							setTimeout( () => {
								return self.prevMenu(cb);
							}, 1000);
						} else {
							if(_.isString(conf.art)) {
								const dispOptions = {
									client	: self.client,
									name	: conf.art,
								};

								self.client.term.rawWrite(resetScreen());

								displayThemeArt(dispOptions, () => {
									//	pause by default, unless explicitly told not to
									if(_.has(conf, 'options.pause') && false === conf.options.pause) { 
										return self.prevMenuOnTimeout(1000, cb);
									} else {
										self.pausePrompt( () => {
											return self.prevMenu(cb);
										});
									}
								});
							} else {
								return self.prevMenu(cb);
							}
						}
					});
				} else {
					return cb(null);
				}
			}
		};
	}

	prevMenuOnTimeout(timeout, cb) {
		setTimeout( () => {
			return this.prevMenu(cb);
		}, timeout);
	}

	mciReady(mciData, cb) {
		super.mciReady(mciData, err => {
			if(err) {
				return cb(err);
			}

			const self	= this;
			const vc	= self.viewControllers.areaList = new ViewController( { client : self.client } );

			async.series(
				[
					function loadFromConfig(callback) {
						let loadOpts = {
							callingMenu	: self,
							mciMap		: mciData.menu,
							formId		: 0,
						};

						vc.loadFromMenuConfig(loadOpts, callback);
					},
					function populateConfListView(callback) {
						const listFormat 		= self.menuConfig.config.listFormat || '{index} ) - {name}';
						const focusListFormat	= self.menuConfig.config.focusListFormat || listFormat;
						
						const confListView = vc.getView(MciViewIds.ConfList);
						let i = 1;
						confListView.setItems(_.map(self.messageConfs, v => {
							return stringFormat(listFormat, {
								index   : i++,
								confTag : v.conf.confTag,
								name    : v.conf.name,
								desc    : v.conf.desc, 
							});
						}));

						i = 1;
						confListView.setFocusItems(_.map(self.messageConfs, v => {
							return stringFormat(focusListFormat, {
								index   : i++,
								confTag : v.conf.confTag,
								name    : v.conf.name,
								desc    : v.conf.desc, 
							});
						}));

						confListView.redraw();

						callback(null);
					},
					function populateTextViews(callback) {
						//	:TODO: populate other avail MCI, e.g. current conf name
						callback(null);
					}
				],
				function complete(err) {
					cb(err);
				}
			);
		});
	}
};
