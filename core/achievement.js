/* jslint node: true */
'use strict';

//  ENiGMA½
const Events = require('./events.js');
const Config = require('./config.js').get;
const ConfigLoader = require('./config_loader');
const { getConfigPath } = require('./config_util');
const UserDb = require('./database.js').dbs.user;
const { getISOTimestampString } = require('./database.js');
const UserInterruptQueue = require('./user_interrupt_queue.js');
const { getConnectionByUserId } = require('./client_connections.js');
const UserProps = require('./user_property.js');
const { Errors, ErrorReasons } = require('./enig_error.js');
const { getThemeArt } = require('./theme.js');
const { pipeToAnsi, stripMciColorCodes } = require('./color_codes.js');
const stringFormat = require('./string_format.js');
const StatLog = require('./stat_log.js');
const Log = require('./logger.js').log;

//  deps
const _ = require('lodash');
const async = require('async');
const moment = require('moment');

//  Fixed set of keys produced by getFormatObject(). Used to build the
//  SGR-wrapping regex once at module load rather than on every display call.
const FORMAT_VAR_KEYS = [
    'userName',
    'userRealName',
    'userLocation',
    'userAffils',
    'nodeId',
    'title',
    'points',
    'achievedValue',
    'matchField',
    'matchValue',
    'timestamp',
    'boardName',
];
//  String.prototype.replace() resets lastIndex before each call, so a
//  module-level regex with the /g flag is safe to reuse across invocations.
const FORMAT_VAR_RE = new RegExp(`{(${FORMAT_VAR_KEYS.join('|')})([^}]*)}`, 'g');

exports.getAchievementsEarnedByUser = getAchievementsEarnedByUser;

class Achievement {
    constructor(data) {
        this.data = data;

        //  achievements are retroactive by default
        this.data.retroactive = _.get(this.data, 'retroactive', true);
    }

    static factory(data) {
        if (!data) {
            return;
        }
        let achievement;
        switch (data.type) {
            case Achievement.Types.UserStatSet:
            case Achievement.Types.UserStatInc:
            case Achievement.Types.UserStatIncNewVal:
                achievement = new UserStatAchievement(data);
                break;

            default:
                return;
        }

        if (achievement.isValid()) {
            return achievement;
        }
    }

    static get Types() {
        return {
            UserStatSet: 'userStatSet',
            UserStatInc: 'userStatInc',
            UserStatIncNewVal: 'userStatIncNewVal',
        };
    }

    isValid() {
        switch (this.data.type) {
            case Achievement.Types.UserStatSet:
            case Achievement.Types.UserStatInc:
            case Achievement.Types.UserStatIncNewVal:
                if (!_.isString(this.data.statName)) {
                    return false;
                }
                if (!_.isObject(this.data.match)) {
                    return false;
                }
                break;

            default:
                return false;
        }
        return true;
    }

    getMatchDetails(/*matchAgainst*/) {}

    isValidMatchDetails(details) {
        if (
            !details ||
            !_.isString(details.title) ||
            !_.isString(details.text) ||
            !_.isNumber(details.points)
        ) {
            return false;
        }
        return _.isString(details.globalText) || !details.globalText;
    }
}

class UserStatAchievement extends Achievement {
    constructor(data) {
        super(data);

        //  sort match keys for quick match lookup
        this.matchKeys = Object.keys(this.data.match || {})
            .map(k => parseInt(k))
            .sort((a, b) => b - a);
    }

    isValid() {
        if (!super.isValid()) {
            return false;
        }
        return !Object.keys(this.data.match).some(k => !parseInt(k));
    }

    getMatchDetails(matchValue) {
        let ret = [];
        let matchField = this.matchKeys.find(v => matchValue >= v);
        if (matchField) {
            const match = this.data.match[matchField];
            matchField = parseInt(matchField);
            if (this.isValidMatchDetails(match) && !isNaN(matchField)) {
                ret = [match, matchField, matchValue];
            }
        }
        return ret;
    }
}

class Achievements {
    constructor(events) {
        this.events = events;
        this.enabled = false;
    }

    getAchievementByTag(tag) {
        return this.config.get().achievements[tag];
    }

    isEnabled() {
        return this.enabled;
    }

    init(cb) {
        const configPath = this._getConfigPath();
        if (!configPath) {
            Log.info('Achievements are not configured');
            return cb(null);
        }

        const configLoaded = () => {
            if (true !== this.config.get().enabled) {
                Log.info('Achievements are not enabled');
                this.enabled = false;
                this._statNameIndex = new Map();
                this.stopMonitoringUserStatEvents();
            } else {
                Log.info('Achievements are enabled');
                this.enabled = true;
                this._buildAchievementIndex();
                this.monitorUserStatEvents();
            }
        };

        this.config = new ConfigLoader({
            onReload: err => {
                if (!err) {
                    configLoaded();
                }
            },
        });

        this.config.init(configPath, err => {
            if (err) {
                return cb(err);
            }

            configLoaded();
            return cb(null);
        });
    }

    _getConfigPath() {
        const path = _.get(Config(), 'general.achievementFile');
        if (!path) {
            return;
        }
        return getConfigPath(path); //  qualify
    }

    //  Build a statName → [achievementTag, ...] index from the current config.
    //  Called at startup and on every config reload so the hot-path event
    //  handler pays only a Map.get() instead of a full _.pickBy() scan.
    _buildAchievementIndex() {
        this._statNameIndex = new Map();
        const achievements = _.get(this.config.get(), 'achievements', {});
        const acceptedTypes = [
            Achievement.Types.UserStatSet,
            Achievement.Types.UserStatInc,
            Achievement.Types.UserStatIncNewVal,
        ];
        Object.entries(achievements).forEach(([tag, achievement]) => {
            if (false === achievement.enabled) {
                return;
            }
            if (!acceptedTypes.includes(achievement.type)) {
                return;
            }
            if (!achievement.statName) {
                return;
            }
            const existing = this._statNameIndex.get(achievement.statName) || [];
            existing.push(tag);
            this._statNameIndex.set(achievement.statName, existing);
        });
    }

    loadAchievementHitCount(user, achievementTag, field, cb) {
        UserDb.get(
            `SELECT COUNT() AS count
            FROM user_achievement
            WHERE user_id = ? AND achievement_tag = ? AND match = ?;`,
            [user.userId, achievementTag, field],
            (err, row) => {
                return cb(err, row ? row.count : 0);
            }
        );
    }

    //  Returns a Set of already-earned match values (integers) for a given
    //  user/achievementTag pair — one query instead of N per retroactive tier.
    loadEarnedMatchFields(user, achievementTag, cb) {
        UserDb.all(
            `SELECT match FROM user_achievement
            WHERE user_id = ? AND achievement_tag = ?;`,
            [user.userId, achievementTag],
            (err, rows) => {
                if (err) {
                    return cb(err);
                }
                return cb(null, new Set(rows.map(r => parseInt(r.match))));
            }
        );
    }

    record(info, localInterruptItem, cb) {
        const cleanTitle = stripMciColorCodes(localInterruptItem.title);
        const cleanText = stripMciColorCodes(localInterruptItem.achievText);

        const recordData = [
            info.client.user.userId,
            info.achievementTag,
            getISOTimestampString(info.timestamp),
            info.matchField,
            cleanTitle,
            cleanText,
            info.details.points,
        ];

        const events = this.events;

        UserDb.run(
            `INSERT OR IGNORE INTO user_achievement (user_id, achievement_tag, timestamp, match, title, text, points)
            VALUES (?, ?, ?, ?, ?, ?, ?);`,
            recordData,
            function (err) {
                if (err) {
                    return cb(err);
                }

                //  0 changes means the UNIQUE constraint fired - already earned; skip stats/display
                if (0 === this.changes) {
                    return cb(
                        Errors.General(
                            'Achievement already acquired',
                            ErrorReasons.TooMany
                        )
                    );
                }

                StatLog.incrementUserStat(
                    info.client.user,
                    UserProps.AchievementTotalCount,
                    1
                );
                StatLog.incrementUserStat(
                    info.client.user,
                    UserProps.AchievementTotalPoints,
                    info.details.points
                );

                events.emit(Events.getSystemEvents().UserAchievementEarned, {
                    user: info.client.user,
                    achievementTag: info.achievementTag,
                    points: info.details.points,
                    title: cleanTitle,
                    text: cleanText,
                });

                return cb(null);
            }
        );
    }

    display(info, interruptItems, cb) {
        if (interruptItems.local) {
            UserInterruptQueue.queue(interruptItems.local, { clients: info.client });
        }

        if (interruptItems.global) {
            UserInterruptQueue.queue(interruptItems.global, { omit: info.client });
        }

        return cb(null);
    }

    recordAndDisplayAchievement(info, cb) {
        async.waterfall(
            [
                callback => {
                    return this.createAchievementInterruptItems(info, callback);
                },
                (interruptItems, callback) => {
                    this.record(info, interruptItems.local, err => {
                        return callback(err, interruptItems);
                    });
                },
                (interruptItems, callback) => {
                    return this.display(info, interruptItems, callback);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    monitorUserStatEvents() {
        if (this.userStatEventListeners) {
            return; //  already listening
        }

        const listenEvents = [
            Events.getSystemEvents().UserStatSet,
            Events.getSystemEvents().UserStatIncrement,
        ];

        this.userStatEventListeners = this.events.addMultipleEventListener(
            listenEvents,
            userStatEvent => {
                if (
                    [
                        UserProps.AchievementTotalCount,
                        UserProps.AchievementTotalPoints,
                    ].includes(userStatEvent.statName)
                ) {
                    return;
                }

                if (
                    !_.isNumber(userStatEvent.statValue) &&
                    !_.isNumber(userStatEvent.statIncrementBy)
                ) {
                    return;
                }

                //  O(1) lookup via pre-built index rather than O(N) pickBy scan
                const achievementTags =
                    (this._statNameIndex || new Map()).get(userStatEvent.statName) || [];

                if (0 === achievementTags.length) {
                    return;
                }

                async.eachSeries(
                    achievementTags,
                    (achievementTag, nextAchievementTag) => {
                        const achievement = Achievement.factory(
                            this.getAchievementByTag(achievementTag)
                        );
                        if (!achievement) {
                            return nextAchievementTag(null);
                        }

                        const statValue = parseInt(
                            [
                                Achievement.Types.UserStatSet,
                                Achievement.Types.UserStatIncNewVal,
                            ].includes(achievement.data.type)
                                ? userStatEvent.statValue
                                : userStatEvent.statIncrementBy
                        );
                        if (isNaN(statValue)) {
                            return nextAchievementTag(null);
                        }

                        const [details, matchField, matchValue] =
                            achievement.getMatchDetails(statValue);
                        if (!details) {
                            return nextAchievementTag(null);
                        }

                        async.waterfall(
                            [
                                callback => {
                                    this.loadAchievementHitCount(
                                        userStatEvent.user,
                                        achievementTag,
                                        matchField,
                                        (err, count) => {
                                            if (err) {
                                                return callback(err);
                                            }
                                            return callback(
                                                count > 0
                                                    ? Errors.General(
                                                          'Achievement already acquired',
                                                          ErrorReasons.TooMany
                                                      )
                                                    : null
                                            );
                                        }
                                    );
                                },
                                callback => {
                                    const client = getConnectionByUserId(
                                        userStatEvent.user.userId
                                    );
                                    if (!client) {
                                        return callback(
                                            Errors.UnexpectedState(
                                                'Failed to get client for user ID'
                                            )
                                        );
                                    }

                                    const info = {
                                        achievementTag,
                                        achievement,
                                        details,
                                        client,
                                        matchField, //  match - may be in odd format
                                        matchValue, //  actual value
                                        achievedValue: matchField, //  achievement value met
                                        user: userStatEvent.user,
                                        timestamp: moment(),
                                    };

                                    const achievementsInfo = [info];
                                    return callback(null, achievementsInfo, info);
                                },
                                (achievementsInfo, basicInfo, callback) => {
                                    if (true !== achievement.data.retroactive) {
                                        return callback(null, achievementsInfo);
                                    }

                                    const index = achievement.matchKeys.findIndex(
                                        v => v < matchField
                                    );
                                    if (
                                        -1 === index ||
                                        !Array.isArray(achievement.matchKeys)
                                    ) {
                                        return callback(null, achievementsInfo);
                                    }

                                    //  For userStat, any lesser match keys(values) are also met. Example:
                                    //  matchKeys: [ 500, 200, 100, 20, 10, 2 ]
                                    //                    ^---- we met here
                                    //                         ^------------^ retroactive range
                                    //
                                    //  Single query fetches all already-earned tiers so we can
                                    //  filter client-side rather than issuing N separate queries.
                                    this.loadEarnedMatchFields(
                                        userStatEvent.user,
                                        achievementTag,
                                        (err, earnedFields) => {
                                            if (err) {
                                                return callback(err);
                                            }

                                            achievement.matchKeys
                                                .slice(index)
                                                .forEach(k => {
                                                    const [det, fld, val] =
                                                        achievement.getMatchDetails(k);
                                                    if (!det || earnedFields.has(fld)) {
                                                        return;
                                                    }
                                                    achievementsInfo.push(
                                                        Object.assign({}, basicInfo, {
                                                            details: det,
                                                            matchField: fld,
                                                            achievedValue: fld,
                                                            matchValue: val,
                                                        })
                                                    );
                                                });

                                            return callback(null, achievementsInfo);
                                        }
                                    );
                                },
                                (achievementsInfo, callback) => {
                                    //  reverse achievementsInfo so we display smallest > largest
                                    achievementsInfo.reverse();

                                    async.eachSeries(
                                        achievementsInfo,
                                        (achInfo, nextAchInfo) => {
                                            return this.recordAndDisplayAchievement(
                                                achInfo,
                                                err => {
                                                    //  TooMany means this tier was already in the DB
                                                    //  (race condition or retroactive overlap) — skip
                                                    //  it and continue processing the rest of the batch.
                                                    if (
                                                        err &&
                                                        ErrorReasons.TooMany ===
                                                            err.reasonCode
                                                    ) {
                                                        return nextAchInfo(null);
                                                    }
                                                    return nextAchInfo(err);
                                                }
                                            );
                                        },
                                        err => {
                                            return callback(err);
                                        }
                                    );
                                },
                            ],
                            err => {
                                if (err && ErrorReasons.TooMany !== err.reasonCode) {
                                    Log.warn(
                                        { error: err.message, userStatEvent },
                                        'Error handling achievement for user stat event'
                                    );
                                }
                                return nextAchievementTag(null); //  always try the next, regardless
                            }
                        );
                    }
                );
            }
        );
    }

    stopMonitoringUserStatEvents() {
        if (this.userStatEventListeners) {
            this.events.removeMultipleEventListener(this.userStatEventListeners);
            delete this.userStatEventListeners;
        }
    }

    getFormatObject(info) {
        return {
            userName: info.user.username,
            userRealName: info.user.realName(false) || 'N/A',
            userLocation: info.user.properties[UserProps.Location] || 'N/A',
            userAffils: info.user.properties[UserProps.Affiliations] || 'N/A',
            nodeId: info.client.node,
            title: info.details.title,
            points: info.details.points,
            achievedValue: info.achievedValue,
            matchField: info.matchField,
            matchValue: info.matchValue,
            timestamp: moment(info.timestamp).format(info.dateTimeFormat),
            boardName: Config().general.boardName,
        };
    }

    //  |formatObj| is optional; if provided it is reused instead of calling
    //  getFormatObject() again (avoids redundant property reads per display).
    getFormattedTextFor(info, textType, defaultSgr = '|07', formatObj = null) {
        const themeDefaults = _.get(
            info.client.currentTheme,
            'achievements.defaults',
            {}
        );
        const textTypeSgr = themeDefaults[`${textType}SGR`] || defaultSgr;

        if (!formatObj) {
            formatObj = this.getFormatObject(info);
        }

        const wrap = input => {
            //  FORMAT_VAR_RE is a module-level constant; replace() resets lastIndex
            //  automatically before each call so it is safe to reuse with /g.
            return input.replace(FORMAT_VAR_RE, (m, formatVar, formatOpts) => {
                const varSgr = themeDefaults[`${formatVar}SGR`] || textTypeSgr;
                let r = `${varSgr}{${formatVar}`;
                if (formatOpts) {
                    r += formatOpts;
                }
                return `${r}}${textTypeSgr}`;
            });
        };

        return stringFormat(`${textTypeSgr}${wrap(info.details[textType])}`, formatObj);
    }

    createAchievementInterruptItems(info, cb) {
        info.dateTimeFormat =
            info.details.dateTimeFormat ||
            info.achievement.dateTimeFormat ||
            info.client.currentTheme.helpers.getDateTimeFormat();

        //  Compute once; pass through to avoid redundant property reads.
        const formatObj = this.getFormatObject(info);

        const title = this.getFormattedTextFor(info, 'title', '|07', formatObj);
        const text = this.getFormattedTextFor(info, 'text', '|07', formatObj);

        let globalText;
        if (info.details.globalText) {
            globalText = this.getFormattedTextFor(info, 'globalText', '|07', formatObj);
        }

        const getArt = (name, callback) => {
            const spec =
                _.get(info.details, `art.${name}`) ||
                _.get(info.achievement, `art.${name}`) ||
                _.get(this.config.get(), `art.${name}`);
            if (!spec) {
                return callback(null);
            }
            const getArtOpts = {
                name: spec,
                client: info.client,
                random: false,
            };
            getThemeArt(getArtOpts, (err, artInfo) => {
                //  ignore errors
                return callback(artInfo ? artInfo.data : null);
            });
        };

        const interruptItems = {};
        let itemTypes = ['local'];
        if (globalText) {
            itemTypes.push('global');
        }

        async.each(
            itemTypes,
            (itemType, nextItemType) => {
                async.waterfall(
                    [
                        callback => {
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
                                title,
                                achievText: itemText,
                                text: `${title}\r\n${itemText}`,
                                pause: true,
                            };
                            if (headerArt || footerArt) {
                                const themeDefaults = _.get(
                                    info.client.currentTheme,
                                    'achievements.defaults',
                                    {}
                                );
                                const defaultContentsFormat = '{title}\r\n{message}';
                                const contentsFormat =
                                    'global' === itemType
                                        ? themeDefaults.globalFormat ||
                                          defaultContentsFormat
                                        : themeDefaults.format || defaultContentsFormat;

                                //  Reuse the pre-computed formatObj; override title (needs
                                //  '' defaultSgr for art context) and add message.
                                const artFormatObj = Object.assign({}, formatObj, {
                                    title: this.getFormattedTextFor(
                                        info,
                                        'title',
                                        '',
                                        formatObj
                                    ),
                                    message: itemText,
                                });

                                const contents = pipeToAnsi(
                                    stringFormat(contentsFormat, artFormatObj)
                                );

                                interruptItems[itemType].contents = `${
                                    headerArt || ''
                                }\r\n${contents}\r\n${footerArt || ''}`;
                            }
                            return callback(null);
                        },
                    ],
                    err => {
                        return nextItemType(err);
                    }
                );
            },
            err => {
                return cb(err, interruptItems);
            }
        );
    }

    getAchievementsEarnedByUser(userId, cb) {
        UserDb.all(
            `SELECT achievement_tag, timestamp, match, title, text, points
            FROM user_achievement
            WHERE user_id = ?
            ORDER BY DATETIME(timestamp);`,
            [userId],
            (err, rows) => {
                if (err) {
                    return cb(err);
                }

                const earned = rows
                    .map(row => {
                        const achievement = Achievement.factory(
                            this.getAchievementByTag(row.achievement_tag)
                        );
                        if (!achievement) {
                            return;
                        }

                        const earnedInfo = {
                            achievementTag: row.achievement_tag,
                            type: achievement.data.type,
                            retroactive: achievement.data.retroactive,
                            title: row.title,
                            text: row.text,
                            points: row.points,
                            timestamp: moment(row.timestamp),
                        };

                        switch (earnedInfo.type) {
                            case Achievement.Types.UserStatSet:
                            case Achievement.Types.UserStatInc:
                            case Achievement.Types.UserStatIncNewVal:
                                earnedInfo.statName = achievement.data.statName;
                                break;
                        }

                        return earnedInfo;
                    })
                    .filter(a => a); //  remove any empty records (ie: no achievement.hjson entry exists anymore).

                return cb(null, earned);
            }
        );
    }
}

let achievementsInstance;

function getAchievementsEarnedByUser(userId, cb) {
    if (!achievementsInstance) {
        return cb(Errors.UnexpectedState('Achievements not initialized'));
    }
    return achievementsInstance.getAchievementsEarnedByUser(userId, cb);
}

exports.moduleInitialize = (initInfo, cb) => {
    achievementsInstance = new Achievements(initInfo.events);
    achievementsInstance.init(err => {
        if (err) {
            return cb(err);
        }

        return cb(null);
    });
};

exports.Achievement = Achievement;
exports.UserStatAchievement = UserStatAchievement;
exports.Achievements = Achievements;
