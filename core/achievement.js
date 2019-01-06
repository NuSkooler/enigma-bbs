/* jslint node: true */
'use strict';

//  ENiGMA½
const Events                = require('./events.js');
const Config                = require('./config.js').get;
const {
    getConfigPath,
    getFullConfig,
}                           = require('./config_util.js');
const UserDb                = require('./database.js').dbs.user;
const {
    getISOTimestampString
}                           = require('./database.js');
const UserInterruptQueue    = require('./user_interrupt_queue.js');
const {
    getConnectionByUserId
}                           = require('./client_connections.js');
const UserProps             = require('./user_property.js');
const {
    Errors,
    ErrorReasons
}                           = require('./enig_error.js');
const { getThemeArt }       = require('./theme.js');
const { pipeToAnsi }        = require('./color_codes.js');
const stringFormat          = require('./string_format.js');
const StatLog               = require('./stat_log.js');
const Log                   = require('./logger.js').log;
const ConfigCache           = require('./config_cache.js');

//  deps
const _             = require('lodash');
const async         = require('async');
const moment        = require('moment');
const paths         = require('path');

class Achievement {
    constructor(data) {
        this.data = data;
    }

    static factory(data) {
        let achievement;
        switch(data.type) {
            case Achievement.Types.UserStat : achievement = new UserStatAchievement(data); break;
            default : return;
        }

        if(achievement.isValid()) {
            return achievement;
        }
    }

    static get Types() {
        return {
            UserStat    : 'userStat',
        };
    }

    isValid() {
        switch(this.data.type) {
            case Achievement.Types.UserStat :
                if(!_.isString(this.data.statName)) {
                    return false;
                }
                if(!_.isObject(this.data.match)) {
                    return false;
                }
                break;

            default : return false;
        }
        return true;
    }

    getMatchDetails(/*matchAgainst*/) {
    }

    isValidMatchDetails(details) {
        if(!_.isString(details.title) || !_.isString(details.text) || !_.isNumber(details.points)) {
            return false;
        }
        return (_.isString(details.globalText) || !details.globalText);
    }
}

class UserStatAchievement extends Achievement {
    constructor(data) {
        super(data);
    }

    isValid() {
        if(!super.isValid()) {
            return false;
        }
        return !Object.keys(this.data.match).some(k => !parseInt(k));
    }

    getMatchDetails(matchValue) {
        let matchField = Object.keys(this.data.match || {}).sort( (a, b) => b - a).find(v => matchValue >= v);
        if(matchField) {
            const match = this.data.match[matchField];
            if(this.isValidMatchDetails(match)) {
                return [ match, parseInt(matchField), matchValue ];
            }
        }
    }
}

class Achievements {
    constructor(events) {
        this.events = events;
    }

    init(cb) {
        let achievementConfigPath = _.get(Config(), 'general.achievementFile');
        if(!achievementConfigPath) {
            Log.info('Achievements are not configured');
            return cb(null);
        }
        achievementConfigPath = getConfigPath(achievementConfigPath);   //  qualify

        const configLoaded = (achievementConfig) => {
            if(true !== achievementConfig.enabled) {
                Log.info('Achievements are not enabled');
                this.stopMonitoringUserStatUpdateEvents();
                delete this.achievementConfig;
            } else {
                Log.info('Achievements are enabled');
                this.achievementConfig = achievementConfig;
                this.monitorUserStatUpdateEvents();
            }
        };

        const changed = ( { fileName, fileRoot } ) => {
            const reCachedPath = paths.join(fileRoot, fileName);
            if(reCachedPath === achievementConfigPath) {
                getFullConfig(achievementConfigPath, (err, achievementConfig) => {
                    if(err) {
                        return Log.error( { error : err.message }, 'Failed to reload achievement config from cache');
                    }
                    configLoaded(achievementConfig);
                });
            }
        };

        ConfigCache.getConfigWithOptions(
            {
                filePath        : achievementConfigPath,
                forceReCache    : true,
                callback        : changed,
            },
            (err, achievementConfig) => {
                if(err) {
                    return cb(err);
                }

                configLoaded(achievementConfig);
                return cb(null);
            }
        );
    }

    loadAchievementHitCount(user, achievementTag, field, cb) {
        UserDb.get(
            `SELECT COUNT() AS count
            FROM user_achievement
            WHERE user_id = ? AND achievement_tag = ? AND match_field = ?;`,
            [ user.userId, achievementTag, field],
            (err, row) => {
                return cb(err, row && row.count || 0);
            }
        );
    }

    record(info, cb) {
        StatLog.incrementUserStat(info.client.user, UserProps.AchievementTotalCount, 1);
        StatLog.incrementUserStat(info.client.user, UserProps.AchievementTotalPoints, info.details.points);

        UserDb.run(
            `INSERT INTO user_achievement (user_id, achievement_tag, timestamp, match_field, match_value)
            VALUES (?, ?, ?, ?, ?);`,
            [ info.client.user.userId, info.achievementTag, getISOTimestampString(info.timestamp), info.matchField, info.matchValue ],
            err => {
                if(err) {
                    return cb(err);
                }

                this.events.emit(
                    Events.getSystemEvents().UserAchievementEarned,
                    {
                        user            : info.client.user,
                        achievementTag  : info.achievementTag,
                        points          : info.details.points,
                    }
                );

                return cb(null);
            }
        );
    }

    display(info, cb) {
        this.createAchievementInterruptItems(info, (err, interruptItems) => {
            if(err) {
                return cb(err);
            }

            if(interruptItems.local) {
                UserInterruptQueue.queue(interruptItems.local, { clients : info.client } );
            }

            if(interruptItems.global) {
                UserInterruptQueue.queue(interruptItems.global, { omit : info.client } );
            }

            return cb(null);
        });
    }

    monitorUserStatUpdateEvents() {
        if(this.userStatEventListener) {
            return; //  already listening
        }

        this.userStatEventListener = this.events.on(Events.getSystemEvents().UserStatUpdate, userStatEvent => {
            if([ UserProps.AchievementTotalCount, UserProps.AchievementTotalPoints ].includes(userStatEvent.statName)) {
                return;
            }

            const statValue = parseInt(userStatEvent.statValue, 10);
            if(isNaN(statValue)) {
                return;
            }

            //  :TODO: Make this code generic - find + return factory created object
            const achievementTag = _.findKey(
                _.get(this.achievementConfig, 'achievements', {}),
                achievement => {
                    if(false === achievement.enabled) {
                        return false;
                    }
                    return Achievement.Types.UserStat === achievement.type &&
                        achievement.statName === userStatEvent.statName;
                }
            );

            if(!achievementTag) {
                return;
            }

            const achievement = Achievement.factory(this.achievementConfig.achievements[achievementTag]);
            if(!achievement) {
                return;
            }

            const [ details, matchField, matchValue ] = achievement.getMatchDetails(statValue);
            if(!details || _.isUndefined(matchField) || _.isUndefined(matchValue)) {
                return;
            }

            async.waterfall(
                [
                    (callback) => {
                        this.loadAchievementHitCount(userStatEvent.user, achievementTag, matchField, (err, count) => {
                            if(err) {
                                return callback(err);
                            }
                            return callback(count > 0 ? Errors.General('Achievement already acquired', ErrorReasons.TooMany) : null);
                        });
                    },
                    (callback) => {
                        const client = getConnectionByUserId(userStatEvent.user.userId);
                        if(!client) {
                            return callback(Errors.UnexpectedState('Failed to get client for user ID'));
                        }

                        const info = {
                            achievementTag,
                            achievement,
                            details,
                            client,
                            matchField,                     //  match - may be in odd format
                            matchValue,                     //  actual value
                            achievedValue   : matchField,   //  achievement value met
                            user            : userStatEvent.user,
                            timestamp       : moment(),
                        };

                        return callback(null, info);
                    },
                    (info, callback) => {
                        this.record(info, err => {
                            return callback(err, info);
                        });
                    },
                    (info, callback) => {
                        return this.display(info, callback);
                    }
                ],
                err => {
                    if(err && ErrorReasons.TooMany !== err.reasonCode) {
                        Log.warn( { error : err.message, userStatEvent }, 'Error handling achievement for user stat event');
                    }
                }
            );
        });
    }

    stopMonitoringUserStatUpdateEvents() {
        if(this.userStatEventListener) {
            this.events.removeListener(Events.getSystemEvents().UserStatUpdate, this.userStatEventListener);
            delete this.userStatEventListener;
        }
    }

    getFormattedTextFor(info, textType) {
        const themeDefaults = _.get(info.client.currentTheme, 'achievements.defaults', {});
        const defSgr        = themeDefaults[`${textType}SGR`] || '|07';

        const wrap = (fieldName, value) => {
            return `${themeDefaults[fieldName] || defSgr}${value}${defSgr}`;
        };

        const formatObj = {
            userName        : wrap('userName', info.user.username),
            userRealName    : wrap('userRealName', info.user.properties[UserProps.RealName]),
            userLocation    : wrap('userLocation', info.user.properties[UserProps.Location]),
            userAffils      : wrap('userAffils', info.user.properties[UserProps.Affiliations]),
            nodeId          : wrap('nodeId', info.client.node),
            title           : wrap('title', info.details.title),
            text            : wrap('text', info.global ? info.details.globalText : info.details.text),
            points          : wrap('points', info.details.points),
            achievedValue   : wrap('achievedValue', info.achievedValue),
            matchField      : wrap('matchField', info.matchField),
            matchValue      : wrap('matchValue', info.matchValue),
            timestamp       : wrap('timestamp', moment(info.timestamp).format(info.dateTimeFormat)),
            boardName       : wrap('boardName', Config().general.boardName),
        };

        return stringFormat(`${defSgr}${info.details[textType]}`, formatObj);
    }

    createAchievementInterruptItems(info, cb) {
        info.dateTimeFormat =
            info.details.dateTimeFormat ||
            info.achievement.dateTimeFormat ||
            info.client.currentTheme.helpers.getDateTimeFormat();

        const title = this.getFormattedTextFor(info, 'title');
        const text  = this.getFormattedTextFor(info, 'text');

        let globalText;
        if(info.details.globalText) {
            globalText = this.getFormattedTextFor(info, 'globalText');
        }

        const getArt = (name, callback) => {
            const spec =
                _.get(info.details, `art.${name}`) ||
                _.get(info.achievement, `art.${name}`) ||
                _.get(this.achievementConfig, `art.${name}`);
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
                        getArt(`${itemType}Header`, headerArt => {
                            return callback(null, headerArt);
                        });
                    },
                    (headerArt, callback) => {
                        getArt(`${itemType}Footer`, footerArt => {
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
                            interruptItems[itemType].contents =
                                `${headerArt || ''}\r\n${pipeToAnsi(title)}\r\n${pipeToAnsi(itemText)}\r\n${footerArt || ''}`;
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
    achievements = new Achievements(initInfo.events);
    return achievements.init(cb);
};
