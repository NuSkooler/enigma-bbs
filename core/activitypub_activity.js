const { isString, isObject } = require('lodash');

module.exports = class Activity {
    constructor(obj) {
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
            this['@context'] !== 'https://www.w3.org/ns/activitystreams' ||
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
};
