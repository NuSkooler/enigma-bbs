const { selfUrl, WellKnownActivityTypes } = require('./util');
const ActivityPubObject = require('./object');
const { Errors } = require('../enig_error');
const UserProps = require('../user_property');
const { postJson } = require('../http_util');
const { getISOTimestampString } = require('../database');

// deps
const _ = require('lodash');

module.exports = class Activity extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    static get ActivityTypes() {
        return WellKnownActivityTypes;
    }

    static makeFollow(webServer, localActor, remoteActor) {
        return new Activity({
            id: Activity.activityObjectId(webServer),
            type: 'Follow',
            actor: localActor,
            object: remoteActor.id,
        });
    }

    // https://www.w3.org/TR/activitypub/#accept-activity-inbox
    static makeAccept(webServer, localActor, followRequest) {
        return new Activity({
            id: Activity.activityObjectId(webServer),
            type: 'Accept',
            actor: localActor,
            object: followRequest, // previous request Activity
        });
    }

    static makeCreate(webServer, actor, obj) {
        return new Activity({
            id: Activity.activityObjectId(webServer),
            type: 'Create',
            actor,
            object: obj,
        });
    }

    static makeTombstone(obj) {
        const deleted = getISOTimestampString();
        return new Activity({
            id: obj.id,
            type: 'Tombstone',
            deleted,
            published: deleted,
            updated: deleted,
        });
    }

    sendTo(actorUrl, fromUser, webServer, cb) {
        const privateKey = fromUser.getProperty(UserProps.PrivateActivityPubSigningKey);
        if (_.isEmpty(privateKey)) {
            return cb(
                Errors.MissingProperty(
                    `User "${fromUser.username}" is missing the '${UserProps.PrivateActivityPubSigningKey}' property`
                )
            );
        }

        const reqOpts = {
            headers: {
                'Content-Type': 'application/activity+json',
            },
            sign: {
                //  :TODO: Make a helper for this
                key: privateKey,
                keyId: selfUrl(webServer, fromUser) + '#main-key',
                authorizationHeaderName: 'Signature',
                headers: ['(request-target)', 'host', 'date', 'digest', 'content-type'],
            },
        };

        const activityJson = JSON.stringify(this);
        return postJson(actorUrl, activityJson, reqOpts, cb);
    }

    static activityObjectId(webServer) {
        return ActivityPubObject.makeObjectId(webServer, 'activity');
    }
};
