const { ActivityStreamsContext } = require('./util');
const Endpoints = require('./endpoint');

// deps
const { isString, isObject } = require('lodash');

module.exports = class ActivityPubObject {
    constructor(obj, withContext = [ActivityStreamsContext]) {
        if (withContext) {
            this.setContext(withContext);
        }
        Object.assign(this, obj);
    }

    static get DefaultContext() {
        return [ActivityStreamsContext];
    }

    static makeContext(namespaceUrls, aliases = null) {
        const context = [ActivityStreamsContext];
        if (Array.isArray(namespaceUrls)) {
            context.push(...namespaceUrls);
        }
        if (isObject(aliases)) {
            context.push(aliases);
        }
        return context;
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
        const nonEmpty = s => isString(s) && s.length > 1;
        //  :TODO: Additional validation
        if (
            (this['@context'] === ActivityStreamsContext ||
                this['@context'][0] === ActivityStreamsContext) &&
            nonEmpty(this.id) &&
            nonEmpty(this.type)
        ) {
            return true;
        }
        return false;
    }

    setContext(context) {
        if (!Array.isArray(context)) {
            context = [context];
        }
        this['@context'] = context;
    }

    static makeObjectId(webServer, objectType) {
        return Endpoints.objectId(webServer, objectType);
    }
};
