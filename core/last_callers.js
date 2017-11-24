/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule		= require('./menu_module.js').MenuModule;
const ViewController	= require('./view_controller.js').ViewController;
const StatLog			= require('./stat_log.js');
const User				= require('./user.js');
const stringFormat		= require('./string_format.js');

//	deps
const moment			= require('moment');
const async				= require('async');
const _					= require('lodash');

/*
	Available listFormat object members:
	userId
	userName
	location
	affiliation
	ts
	
*/

exports.moduleInfo = {
	name		: 'Last Callers',
	desc		: 'Last callers to the system',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.lastcallers'
};

const MciCodeIds = {
	CallerList		: 1,
};

exports.getModule = class LastCallersModule extends MenuModule {
	constructor(options) {
		super(options);
	}

	mciReady(mciData, cb) {
		super.mciReady(mciData, err => {
			if(err) {
				return cb(err);
			}

			const self		= this;
			const vc		= self.viewControllers.allViews = new ViewController( { client : self.client } );

			let loginHistory;
			let callersView;

			async.series(
				[
					function loadFromConfig(callback) {
						const loadOpts = {
							callingMenu		: self,
							mciMap			: mciData.menu,
							noInput			: true,
						};

						vc.loadFromMenuConfig(loadOpts, callback);
					},
					function fetchHistory(callback) {
						callersView = vc.getView(MciCodeIds.CallerList);

						//	fetch up 
						StatLog.getSystemLogEntries('user_login_history', StatLog.Order.TimestampDesc, 200, (err, lh) => {
							loginHistory = lh;

							if(self.menuConfig.config.hideSysOpLogin) {
								const noOpLoginHistory = loginHistory.filter(lh => {
									return false === User.isRootUserId(parseInt(lh.log_value));	//	log_value=userId
								});

								//
								//	If we have enough items to display, or hideSysOpLogin is set to 'always',
								//	then set loginHistory to our filtered list. Else, we'll leave it be.
								//
								if(noOpLoginHistory.length >= callersView.dimens.height || 'always' === self.menuConfig.config.hideSysOpLogin) {
									loginHistory = noOpLoginHistory;
								}
							}
							
							//
							//	Finally, we need to trim up the list to the needed size
							//
							loginHistory = loginHistory.slice(0, callersView.dimens.height);
							
							return callback(err);
						});
					},
					function getUserNamesAndProperties(callback) {
						const getPropOpts = {
							names		: [ 'location', 'affiliation' ]
						};

						const dateTimeFormat = self.menuConfig.config.dateTimeFormat || 'ddd MMM DD';

						async.each(
							loginHistory, 
							(item, next) => {
								item.userId = parseInt(item.log_value);
								item.ts		= moment(item.timestamp).format(dateTimeFormat);						

								User.getUserName(item.userId, (err, userName) => {
									if(err) {
										item.deleted = true;
										return next(null);
									} else {
										item.userName = userName || 'N/A';

										User.loadProperties(item.userId, getPropOpts, (err, props) => {
											if(!err && props) {
												item.location 		= props.location || 'N/A';
												item.affiliation	= item.affils = (props.affiliation || 'N/A');
											} else {
												item.location		= 'N/A';
												item.affiliation	= item.affils = 'N/A';
											}
											return next(null);
										});
									}
								});
							},
							err => {
								loginHistory = loginHistory.filter(lh => true !== lh.deleted);
								return callback(err);
							}
						);
					},
					function populateList(callback) {
						const listFormat = self.menuConfig.config.listFormat || '{userName} - {location} - {affiliation} - {ts}';

						callersView.setItems(_.map(loginHistory, ce => stringFormat(listFormat, ce) ) );

						callersView.redraw();
						return callback(null);
					}
				],
				(err) => {
					if(err) {
						self.client.log.error( { error : err.toString() }, 'Error loading last callers');
					}
					cb(err);
				}
			);
		});
	}
};
