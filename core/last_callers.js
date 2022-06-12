/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const StatLog = require('./stat_log.js');
const User = require('./user.js');
const sysDb = require('./database.js').dbs.system;
const { Errors } = require('./enig_error.js');
const UserProps = require('./user_property.js');
const SysLogKeys = require('./system_log.js');

//  deps
const moment = require('moment');
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Last Callers',
    desc: 'Last callers to the system',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.lastcallers',
};

const MciViewIds = {
    callerList: 1,
};

exports.getModule = class LastCallersModule extends MenuModule {
    constructor(options) {
        super(options);

        this.actionIndicators = _.get(options, 'menuConfig.config.actionIndicators', {});
        this.actionIndicatorDefault = _.get(
            options,
            'menuConfig.config.actionIndicatorDefault',
            '-'
        );
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.waterfall(
                [
                    callback => {
                        this.prepViewController('callers', 0, mciData.menu, err => {
                            return callback(err);
                        });
                    },
                    callback => {
                        this.fetchHistory((err, loginHistory) => {
                            return callback(err, loginHistory);
                        });
                    },
                    (loginHistory, callback) => {
                        this.loadUserForHistoryItems(
                            loginHistory,
                            (err, updatedHistory) => {
                                return callback(err, updatedHistory);
                            }
                        );
                    },
                    (loginHistory, callback) => {
                        const callersView = this.viewControllers.callers.getView(
                            MciViewIds.callerList
                        );
                        if (!callersView) {
                            return cb(
                                Errors.MissingMci(
                                    `Missing caller list MCI ${MciViewIds.callerList}`
                                )
                            );
                        }
                        callersView.setItems(loginHistory);
                        callersView.redraw();
                        return callback(null);
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.warn(
                            { error: err.message },
                            'Error loading last callers'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }

    getCollapse(conf) {
        let collapse = _.get(this, conf);
        collapse =
            collapse &&
            collapse.match(/^([0-9]+)\s*(minutes?|seconds?|hours?|days?|months?)$/);
        if (collapse) {
            return moment.duration(parseInt(collapse[1]), collapse[2]);
        }
    }

    fetchHistory(cb) {
        const callersView = this.viewControllers.callers.getView(MciViewIds.callerList);
        if (!callersView || 0 === callersView.dimens.height) {
            return cb(null);
        }

        StatLog.getSystemLogEntries(
            SysLogKeys.UserLoginHistory,
            StatLog.Order.TimestampDesc,
            200, //  max items to fetch - we need more than max displayed for filtering/etc.
            (err, loginHistory) => {
                if (err) {
                    return cb(err);
                }

                const dateTimeFormat = _.get(
                    this,
                    'menuConfig.config.dateTimeFormat',
                    this.client.currentTheme.helpers.getDateFormat('short')
                );

                loginHistory = loginHistory.map(item => {
                    try {
                        const historyItem = JSON.parse(item.log_value);
                        if (_.isObject(historyItem)) {
                            item.userId = historyItem.userId;
                            item.sessionId = historyItem.sessionId;
                        } else {
                            item.userId = historyItem; //  older format
                            item.sessionId = '-none-';
                        }
                    } catch (e) {
                        return null; //  we'll filter this out
                    }

                    item.timestamp = moment(item.timestamp);

                    return Object.assign(item, {
                        ts: moment(item.timestamp).format(dateTimeFormat),
                    });
                });

                const hideSysOp = _.get(this, 'menuConfig.config.sysop.hide');
                const sysOpCollapse = this.getCollapse(
                    'menuConfig.config.sysop.collapse'
                );

                const collapseList = (withUserId, minAge) => {
                    let lastUserId;
                    let lastTimestamp;
                    loginHistory = loginHistory.filter(item => {
                        const secApart = lastTimestamp
                            ? moment
                                  .duration(lastTimestamp.diff(item.timestamp))
                                  .asSeconds()
                            : 0;
                        const collapse =
                            (null === withUserId ? true : withUserId === item.userId) &&
                            lastUserId === item.userId &&
                            secApart < minAge;

                        lastUserId = item.userId;
                        lastTimestamp = item.timestamp;

                        return !collapse;
                    });
                };

                if (hideSysOp) {
                    loginHistory = loginHistory.filter(
                        item => false === User.isRootUserId(item.userId)
                    );
                } else if (sysOpCollapse) {
                    collapseList(User.RootUserID, sysOpCollapse.asSeconds());
                }

                const userCollapse = this.getCollapse('menuConfig.config.user.collapse');
                if (userCollapse) {
                    collapseList(null, userCollapse.asSeconds());
                }

                return cb(
                    null,
                    loginHistory.slice(0, callersView.dimens.height) //  trim the fat
                );
            }
        );
    }

    loadUserForHistoryItems(loginHistory, cb) {
        const getPropOpts = {
            names: [UserProps.RealName, UserProps.Location, UserProps.Affiliations],
        };

        const actionIndicatorNames = _.map(this.actionIndicators, (v, k) => k);
        let indicatorSumsSql;
        if (actionIndicatorNames.length > 0) {
            indicatorSumsSql = actionIndicatorNames.map(i => {
                return `SUM(CASE WHEN log_name='${_.snakeCase(
                    i
                )}' THEN 1 ELSE 0 END) AS ${i}`;
            });
        }

        async.map(
            loginHistory,
            (item, nextHistoryItem) => {
                User.getUserName(item.userId, (err, userName) => {
                    if (err) {
                        return nextHistoryItem(null, null);
                    }

                    item.userName = item.text = userName;

                    User.loadProperties(item.userId, getPropOpts, (err, props) => {
                        item.location = (props && props[UserProps.Location]) || '';
                        item.affiliation = item.affils =
                            (props && props[UserProps.Affiliations]) || '';
                        item.realName = (props && props[UserProps.RealName]) || '';

                        if (!indicatorSumsSql) {
                            return nextHistoryItem(null, item);
                        }

                        sysDb.get(
                            `SELECT ${indicatorSumsSql.join(', ')}
                        FROM user_event_log
                        WHERE user_id=? AND session_id=?
                        LIMIT 1;`,
                            [item.userId, item.sessionId],
                            (err, results) => {
                                if (_.isObject(results)) {
                                    item.actions = '';
                                    Object.keys(results).forEach(n => {
                                        const indicator =
                                            results[n] > 0
                                                ? this.actionIndicators[n] ||
                                                  this.actionIndicatorDefault
                                                : this.actionIndicatorDefault;
                                        item[n] = indicator;
                                        item.actions += indicator;
                                    });
                                }
                                return nextHistoryItem(null, item);
                            }
                        );
                    });
                });
            },
            (err, mapped) => {
                return cb(
                    err,
                    mapped.filter(item => item)
                ); //  remove deleted
            }
        );
    }
};
