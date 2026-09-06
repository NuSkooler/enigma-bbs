/* jslint node: true */
'use strict';

//
//  A schema for config/achievements.hjson.
//
//  Unlike the main configuration there is nothing to derive it from: this file
//  has no defaults object, so the shape is hand written. It is small enough to
//  be: three top level keys, six fields on an achievement and six on a tier.
//
//  Everything here was checked against the code that reads it rather than
//  against the file that ships, and the two disagree in one direction worth
//  knowing about -- "art" and "dateTimeFormat" are legal on an achievement and
//  on a tier (core/achievement.js, createAchievementInterruptItems) but appear
//  in neither the shipped file nor the documentation. Closing the key sets on
//  what the shipped file happens to contain would have reported both as typos.
//
//  Closed key sets are the point here. Achievements are all-or-nothing at load
//  time: Achievement.factory() returns undefined for an entry it cannot make
//  sense of and the achievement simply never fires, with nothing logged. A
//  "statname" for "statName" is silent in exactly the way this whole effort
//  exists to catch.
//

const NodeType = require('./schema.js').NodeType;

//  the same object Achievement.Types returns; see core/achievement_types.js
//  for why it does not live in core/achievement.js
const AchievementTypes = require('../achievement_types.js');

//  The four frames of an achievement interrupt. Legal at three levels, most
//  specific first: the tier, the achievement, then the file's own top level.
function artNode() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            localHeader: { type: NodeType.String },
            localFooter: { type: NodeType.String },
            globalHeader: { type: NodeType.String },
            globalFooter: { type: NodeType.String },
        },
        description: 'Art shown around the achievement notification.',
    };
}

//
//  One tier under "match", keyed by the threshold that awards it.
//
function matchDetailNode() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            title: {
                type: NodeType.String,
                description: 'Short title for this tier.',
            },
            text: {
                type: NodeType.String,
                description: 'Notification shown only to the user who earned it.',
            },
            globalText: {
                type: NodeType.String,
                description:
                    'Notification broadcast to everyone else online. Omit for no broadcast.',
            },
            points: {
                type: NodeType.Number,
                min: 0,
                description: 'Points awarded. 0 for a badge that carries no score.',
            },
            art: artNode(),
            dateTimeFormat: {
                type: NodeType.String,
                description: 'Overrides the theme format for {timestamp} in this tier.',
            },
        },
    };
}

function buildAchievementSchema() {
    return {
        type: NodeType.Object,
        closedKeys: true,
        children: {
            enabled: {
                type: NodeType.Boolean,
                description: 'Turns the whole achievement system on or off.',
            },

            art: artNode(),

            achievements: {
                type: NodeType.Object,
                openMap: true, //  keyed by achievement tag, which the sysop chooses
                closedKeys: false,
                value: {
                    type: NodeType.Object,
                    closedKeys: true,
                    children: {
                        type: {
                            type: NodeType.String,
                            enum: Object.values(AchievementTypes),
                            description:
                                'What the threshold is compared against: the new value, a single increment, or the running total after one.',
                        },
                        statName: {
                            type: NodeType.String,
                            description:
                                'User property that drives this achievement; see core/user_property.js.',
                        },
                        //
                        //  Keys are numeric thresholds, so this is an open map
                        //  in the same sense as any other sysop-keyed block.
                        //  Achievement.isValid() rejects the whole achievement
                        //  if any key fails parseInt().
                        //
                        match: {
                            type: NodeType.Object,
                            openMap: true,
                            closedKeys: false,
                            value: matchDetailNode(),
                            description:
                                'Threshold to tier. Every key must be a number.',
                        },
                        retroactive: {
                            type: NodeType.Boolean,
                            description:
                                'Reaching a tier also awards the lower ones not yet earned. Default true.',
                        },
                        art: artNode(),
                        dateTimeFormat: {
                            type: NodeType.String,
                            description:
                                'Overrides the theme format for {timestamp} in this achievement.',
                        },
                    },
                },
            },
        },
    };
}

module.exports = {
    buildAchievementSchema,
};
