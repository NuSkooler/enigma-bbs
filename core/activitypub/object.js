const { ActivityStreamsContext } = require('./const');
const { WellKnownLocations } = require('../servers/content/web');

// deps
const { isString } = require('lodash');
const { v4: UUIDv4 } = require('uuid');

module.exports = class ActivityPubObject {
    constructor(obj) {
        this['@context'] = ActivityStreamsContext;
        Object.assign(this, obj);
    }

    static fromJsonString(s) {
        let obj;
        try {
            obj = JSON.parse(s);
            obj = new ActivityPubObject(obj);
        } catch (e) {
            return null;
        }
        return obj;
    }

    isValid() {
        const nes = s => isString(s) && s.length > 1;
        //  :TODO: Additional validation
        if (
            (this['@context'] === ActivityStreamsContext ||
                this['@context'][0] === ActivityStreamsContext) &&
            nes(this.id) &&
            nes(this.type)
        ) {
            return true;
        }
        return false;
    }

    static makeObjectId(webServer, suffix) {
        // e.g. http://some.host/_enig/ap/bf81a22e-cb3e-41c8-b114-21f375b61124/activity
        return webServer.buildUrl(
            WellKnownLocations.Internal + `/ap/${UUIDv4()}/${suffix}`
        );
    }
};
