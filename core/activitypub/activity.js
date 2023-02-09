const { WellKnownActivityTypes, WellKnownActivity } = require('./const');
const { recipientIdsFromObject } = require('./util');
const ActivityPubObject = require('./object');
const { getISOTimestampString } = require('../database');

module.exports = class Activity extends ActivityPubObject {
    constructor(obj, withContext = ActivityPubObject.DefaultContext) {
        super(obj, withContext);
    }

    static get ActivityTypes() {
        return WellKnownActivityTypes;
    }

    static fromJsonString(s) {
        const obj = ActivityPubObject.fromJsonString(s);
        return new Activity(obj);
    }

    static makeFollow(webServer, localActor, remoteActor) {
        return new Activity({
            id: Activity.activityObjectId(webServer),
            type: WellKnownActivity.Follow,
            actor: localActor,
            object: remoteActor.id,
        });
    }

    // https://www.w3.org/TR/activitypub/#accept-activity-inbox
    static makeAccept(webServer, localActor, followRequest) {
        return new Activity({
            id: Activity.activityObjectId(webServer),
            type: WellKnownActivity.Accept,
            actor: localActor,
            object: followRequest, // previous request Activity
        });
    }

    static makeCreate(webServer, actor, obj, context) {
        const activity = new Activity(
            {
                id: Activity.activityObjectId(webServer),
                to: obj.to,
                type: WellKnownActivity.Create,
                actor,
                object: obj,
            },
            context
        );

        const copy = n => {
            if (obj[n]) {
                activity[n] = obj[n];
            }
        };

        copy('to');
        copy('cc');
        //  :TODO: Others?

        return activity;
    }

    static makeTombstone(obj) {
        const deleted = getISOTimestampString();
        return new Activity({
            id: obj.id,
            type: WellKnownActivity.Tombstone,
            deleted,
            published: deleted,
            updated: deleted,
        });
    }

    recipientIds() {
        return recipientIdsFromObject(this);
    }

    static activityObjectId(webServer) {
        return ActivityPubObject.makeObjectId(webServer, 'activity');
    }
};
