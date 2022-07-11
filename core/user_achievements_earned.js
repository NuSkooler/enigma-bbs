/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { getAchievementsEarnedByUser } = require('./achievement.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'User Achievements Earned',
    desc: 'Lists achievements earned by a user',
    author: 'NuSkooler',
};

const MciViewIds = {
    achievementList: 1,
    customRangeStart: 10, //  updated @ index update
};

exports.getModule = class UserAchievementsEarned extends MenuModule {
    constructor(options) {
        super(options);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.waterfall(
                [
                    callback => {
                        this.prepViewController('achievements', 0, mciData.menu, err => {
                            return callback(err);
                        });
                    },
                    callback => {
                        return this.validateMCIByViewIds(
                            'achievements',
                            MciViewIds.achievementList,
                            callback
                        );
                    },
                    callback => {
                        return getAchievementsEarnedByUser(
                            this.client.user.userId,
                            callback
                        );
                    },
                    (achievementsEarned, callback) => {
                        this.achievementsEarned = achievementsEarned;

                        const achievementListView =
                            this.viewControllers.achievements.getView(
                                MciViewIds.achievementList
                            );

                        achievementListView.on('index update', idx => {
                            this.selectionIndexUpdate(idx);
                        });

                        const dateTimeFormat = _.get(
                            this,
                            'menuConfig.config.dateTimeFormat',
                            this.client.currentTheme.helpers.getDateFormat('short')
                        );

                        achievementListView.setItems(
                            achievementsEarned.map(achiev =>
                                Object.assign(achiev, this.getUserInfo(), {
                                    ts: achiev.timestamp.format(dateTimeFormat),
                                })
                            )
                        );
                        achievementListView.redraw();
                        this.selectionIndexUpdate(0);

                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    getUserInfo() {
        //  :TODO: allow args to pass in a different user - ie from user list -> press A for achievs, so on...
        return {
            userId: this.client.user.userId,
            userName: this.client.user.username,
            realName: this.client.user.getProperty(UserProps.RealName),
            location: this.client.user.getProperty(UserProps.Location),
            affils: this.client.user.getProperty(UserProps.Affiliations),
            totalCount: this.client.user.getPropertyAsNumber(
                UserProps.AchievementTotalCount
            ),
            totalPoints: this.client.user.getPropertyAsNumber(
                UserProps.AchievementTotalPoints
            ),
        };
    }

    selectionIndexUpdate(index) {
        const achiev = this.achievementsEarned[index];
        if (!achiev) {
            return;
        }
        this.updateCustomViewTextsWithFilter(
            'achievements',
            MciViewIds.customRangeStart,
            achiev
        );
    }
};
