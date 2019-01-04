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
const UserProps             = require('./user_property.js');
const { Errors }            = require('./enig_error.js');
const { getThemeArt }       = require('./theme.js');
const { pipeToAnsi }        = require('./color_codes.js');
const stringFormat          = require('./string_format.js');

//  deps
const _             = require('lodash');
const async         = require('async');
const moment        = require('moment');

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
                const details = achievement.match[matchValue];
                matchValue = parseInt(matchValue);

                async.series(
                    [
                        (callback) => {
                            this.loadAchievementHitCount(userStatEvent.user, achievementTag, null, matchValue, (err, count) => {
                                if(err) {
                                    return callback(err);
                                }
                                return callback(count > 0 ? Errors.General('Achievement already acquired') : null);
                            });
                        },
                        (callback) => {
                            const client = getConnectionByUserId(userStatEvent.user.userId);
                            if(!client) {
                                return callback(Errors.UnexpectedState('Failed to get client for user ID'));
                            }

                            const info = {
                                achievement,
                                details,
                                client,
                                value       : matchValue,
                                user        : userStatEvent.user,
                                timestamp   : moment(),
                            };

                            this.createAchievementInterruptItems(info, (err, interruptItems) => {
                                if(err) {
                                    return callback(err);
                                }

                                if(interruptItems.local) {
                                    UserInterruptQueue.queue(interruptItems.local, { clients : client } );
                                }

                                if(interruptItems.global) {
                                    UserInterruptQueue.queue(interruptItems.global, { omit : client } );
                                }
                            });
                        }
                    ]
                );
            }
        });
    }

    createAchievementInterruptItems(info, cb) {
        const dateTimeFormat =
            info.details.dateTimeFormat ||
            info.achievement.dateTimeFormat ||
            info.client.currentTheme.helpers.getDateTimeFormat();

        const config = Config();

        const formatObj = {
            userName        : info.user.username,
            userRealName    : info.user.properties[UserProps.RealName],
            userLocation    : info.user.properties[UserProps.Location],
            userAffils      : info.user.properties[UserProps.Affiliations],
            nodeId          : info.client.node,
            title           : info.details.title,
            text            : info.global ? info.details.globalText : info.details.text,
            points          : info.details.points,
            value           : info.value,
            timestamp       : moment(info.timestamp).format(dateTimeFormat),
            boardName       : config.general.boardName,
        };

        const title = stringFormat(info.details.title, formatObj);
        const text  = stringFormat(info.details.text, formatObj);

        let globalText;
        if(info.details.globalText) {
            globalText = stringFormat(info.details.globalText, formatObj);
        }

        const getArt = (name, callback) => {
            const spec =
                _.get(info.details, `art.${name}`) ||
                _.get(info.achievement, `art.${name}`) ||
                _.get(config, `userAchievements.art.${name}`);
            if(!spec) {
                return callback(null);
            }
            const getArtOpts = {
                name    : spec,
                client  : this.client,
                random  : false,
            };
            getThemeArt(getArtOpts, (err, artInfo) => {
                //  ignore errors
                return callback(artInfo ? artInfo.data : null);
            });
        };

        const interruptItems = {};
        let itemTypes = [ 'local' ];
        if(globalText) {
            itemTypes.push('global');
        }

        async.each(itemTypes, (itemType, nextItemType) => {
            async.waterfall(
                [
                    (callback) => {
                        getArt('header', headerArt => {
                            return callback(null, headerArt);
                        });
                    },
                    (headerArt, callback) => {
                        getArt('footer', footerArt => {
                            return callback(null, headerArt, footerArt);
                        });
                    },
                    (headerArt, footerArt, callback) => {
                        const itemText = 'global' === itemType ? globalText : text;
                        interruptItems[itemType] = {
                            text    : `${title}\r\n${itemText}`,
                            pause   : true,
                        };
                        if(headerArt || footerArt) {
                            interruptItems[itemType].contents = `${headerArt || ''}\r\n${pipeToAnsi(itemText)}\r\n${footerArt || ''}`;
                        }
                        return callback(null);
                    }
                ],
                err => {
                    return nextItemType(err);
                }
            );
        },
        err => {
            return cb(err, interruptItems);
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

