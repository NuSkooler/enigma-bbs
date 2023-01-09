const { isString, isObject } = require('lodash');
const { v4: UUIDv4 } = require('uuid');
const { ActivityStreamsContext } = require('./activitypub_util');

module.exports = class Activity {
    constructor(obj) {
        this['@context'] = ActivityStreamsContext;
        Object.assign(this, obj);
    }

    static get ActivityTypes() {
        return [
            'Create',
            'Update',
            'Delete',
            'Follow',
            'Accept',
            'Reject',
            'Add',
            'Remove',
            'Like',
            'Announce',
            'Undo',
        ];
    }

    static fromJson(json) {
        const parsed = JSON.parse(json);
        return new Activity(parsed);
    }

    isValid() {
        if (
            this['@context'] !== ActivityStreamsContext ||
            !isString(this.id) ||
            !isString(this.actor) ||
            (!isString(this.object) && !isObject(this.object)) ||
            !Activity.ActivityTypes.includes(this.type)
        ) {
            return false;
        }

        //  :TODO: we could validate the particular types

        return true;
    }

    // https://www.w3.org/TR/activitypub/#accept-activity-inbox
    static makeAccept(webServer, localActor, followRequest, id = null) {
        id = id || webServer.buildUrl(`/${UUIDv4()}`);

        return new Activity({
            type: 'Accept',
            actor: localActor,
            object: followRequest, // previous request Activity
        });
    }

    sendTo(actorUrl, cb) {
        //  :TODO: https send |this| to actorUrl
    }
};
