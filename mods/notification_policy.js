/* jslint node: true */
'use strict';

const fs = require('fs');
const _ = require('lodash');
const notificationDb = require('./notification_db');
const notificationService = require('./notification_service');

function areaAllowsNewTopicEmail(areaConfig) {
    return true === _.get(areaConfig, 'notifications.allowNewTopicEmail', false);
}

function areaAllowsReplyToOwnPostEmail(areaConfig) {
    return true === _.get(areaConfig, 'notifications.allowReplyToOwnPostEmail', false);
}

async function getNewTopicRecipientCandidates(areaTag, options = {}) {
    const resolveUserEmail = _.isFunction(options.resolveUserEmail)
        ? options.resolveUserEmail
        : async () => null;

    const canUserReadArea = _.isFunction(options.canUserReadArea)
        ? options.canUserReadArea
        : async () => true;

    const subscriptions = await notificationDb.getAreaSubscriptions(areaTag, 'new_topic');
    const recipients = [];
    const seenUserIds = new Set();

        for (const sub of subscriptions) {
        const userId = parseInt(sub.user_id, 10) || 0;

        fs.appendFileSync(
            '/home/enigma/enigma-bbs/logs/notification_debug.log',
            `[${new Date().toISOString()}] NEWTOPIC CANDIDATE userId=${userId} areaTag=${areaTag}\n`
        );

        if (userId < 1 || seenUserIds.has(userId)) {
            fs.appendFileSync(
                '/home/enigma/enigma-bbs/logs/notification_debug.log',
                `[${new Date().toISOString()}] NEWTOPIC SKIP invalid_or_duplicate userId=${userId} areaTag=${areaTag}\n`
            );
            continue;
        }

        seenUserIds.add(userId);

        const mayRead = await canUserReadArea(userId, areaTag);
        if (!mayRead) {
            fs.appendFileSync(
                '/home/enigma/enigma-bbs/logs/notification_debug.log',
                `[${new Date().toISOString()}] NEWTOPIC SKIP cannot_read userId=${userId} areaTag=${areaTag}\n`
            );
            continue;
        }

        const email = await resolveUserEmail(userId);
        if (!notificationService.isPlausibleEmail(email)) {
            fs.appendFileSync(
                '/home/enigma/enigma-bbs/logs/notification_debug.log',
                `[${new Date().toISOString()}] NEWTOPIC SKIP invalid_email userId=${userId} areaTag=${areaTag} email=${email || 'NULL'}\n`
            );
            continue;
        }

        fs.appendFileSync(
            '/home/enigma/enigma-bbs/logs/notification_debug.log',
            `[${new Date().toISOString()}] NEWTOPIC ACCEPT userId=${userId} areaTag=${areaTag} email=${email}\n`
        );

        recipients.push({
            userId,
            email: email.trim(),
        });
    }

    return recipients;
}

async function getReplyToOwnPostRecipient(userId, areaTag, options = {}) {
    const numericUserId = parseInt(userId, 10) || 0;
    if (numericUserId < 1) {
        fs.appendFileSync(
            '/home/enigma/enigma-bbs/logs/notification_debug.log',
            `[${new Date().toISOString()}] REPLY SKIP invalid_user userId=${userId} areaTag=${areaTag}\n`
        );
        return null;
    }

    const resolveUserEmail = _.isFunction(options.resolveUserEmail)
        ? options.resolveUserEmail
        : async () => null;

    const canUserReadArea = _.isFunction(options.canUserReadArea)
        ? options.canUserReadArea
        : async () => true;

    const replyEnabled = await notificationDb.isReplyNotificationEnabled(numericUserId, areaTag);
    if (!replyEnabled) {
        fs.appendFileSync(
            '/home/enigma/enigma-bbs/logs/notification_debug.log',
            `[${new Date().toISOString()}] REPLY SKIP disabled userId=${numericUserId} areaTag=${areaTag}\n`
        );
        return null;
    }

    const mayRead = await canUserReadArea(numericUserId, areaTag);
    if (!mayRead) {
        fs.appendFileSync(
            '/home/enigma/enigma-bbs/logs/notification_debug.log',
            `[${new Date().toISOString()}] REPLY SKIP cannot_read userId=${numericUserId} areaTag=${areaTag}\n`
        );
        return null;
    }

    const email = await resolveUserEmail(numericUserId);
    if (!notificationService.isPlausibleEmail(email)) {
        fs.appendFileSync(
            '/home/enigma/enigma-bbs/logs/notification_debug.log',
            `[${new Date().toISOString()}] REPLY SKIP invalid_email userId=${numericUserId} areaTag=${areaTag} email=${email || 'NULL'}\n`
        );
        return null;
    }

    fs.appendFileSync(
        '/home/enigma/enigma-bbs/logs/notification_debug.log',
        `[${new Date().toISOString()}] REPLY ACCEPT userId=${numericUserId} areaTag=${areaTag} email=${email}\n`
    );

    return {
        userId: numericUserId,
        email: email.trim(),
    };
}

async function getEligibleNewTopicRecipients(areaTag, areaConfig, options = {}) {
    if (!areaAllowsNewTopicEmail(areaConfig)) {
        return [];
    }

    return getNewTopicRecipientCandidates(areaTag, options);
}

async function getEligibleReplyRecipient(userId, areaTag, areaConfig, options = {}) {
    if (!areaAllowsReplyToOwnPostEmail(areaConfig)) {
        return null;
    }

    return getReplyToOwnPostRecipient(userId, areaTag, options);
}

module.exports = {
    areaAllowsNewTopicEmail,
    areaAllowsReplyToOwnPostEmail,
    getNewTopicRecipientCandidates,
    getReplyToOwnPostRecipient,
    getEligibleNewTopicRecipients,
    getEligibleReplyRecipient,
};

