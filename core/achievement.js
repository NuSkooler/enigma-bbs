/* jslint node: true */
'use strict';

//  ENiGMA½
const Events                = require('./events.js');
const Config                = require('./config.js').get;
const UserDb                = require('./database.js').dbs.user;
const UserInterruptQueue    = require('./user_interrupt_queue.js');
const {
    getConnectionByUserId
}                           = require('./client_connections.js');

//  deps
const _             = require('lodash');

class Achievements {
    constructor(events) {
        this.events = events;
    }

    init(cb) {
        this.monitorUserStatUpdateEvents();
        return cb(null);
    }

    loadAchievementHitCount(user, achievementTag, field, value, cb) {
        UserDb.get(
            `SELECT COUNT() AS count
            FROM user_achievement
            WHERE user_id = ? AND achievement_tag = ? AND match_field = ? AND match_value >= ?;`,
            [ user.userId, achievementTag, field, value ],
            (err, row) => {
                return cb(err, row && row.count || 0);
            }
        );
    }

    monitorUserStatUpdateEvents() {
        this.events.on(Events.getSystemEvents().UserStatUpdate, userStatEvent => {
            const statValue = parseInt(userStatEvent.statValue, 10);
            if(isNaN(statValue)) {
                return;
            }

            const config = Config();
            const achievementTag = _.findKey(
                _.get(config, 'userAchievements.achievements', {}),
                achievement => {
                    if(false === achievement.enabled) {
                        return false;
                    }
                    return 'userStat' === achievement.type &&
                        achievement.statName === userStatEvent.statName;
                }
            );

            if(!achievementTag) {
                return;
            }

            const achievement = config.userAchievements.achievements[achievementTag];
            let matchValue = Object.keys(achievement.match || {}).sort( (a, b) => b - a).find(v => statValue >= v);
            if(matchValue) {
                const match = achievement.match[matchValue];

                //
                //  Check if we've triggered this event before
                //
                this.loadAchievementHitCount(userStatEvent.user, achievementTag, null, matchValue, (err, count) => {
                    if(count > 0) {
                        return;
                    }

                    const conn = getConnectionByUserId(userStatEvent.user.userId);
                    if(!conn) {
                        return;
                    }

                    const interruptItem = {
                        text : match.text,
                        pause : true,
                    };

                    UserInterruptQueue.queue(interruptItem, { omit : conn} );
                });
            }
        });
    }
}

let achievements;

exports.moduleInitialize = (initInfo, cb) => {

    if(false === _.get(Config(), 'userAchievements.enabled')) {
        //  :TODO: Log disabled
        return cb(null);
    }

    achievements = new Achievements(initInfo.events);
    return achievements.init(cb);
};

