const { ActivityStreamsContext } = require('./util');
const Endpoints = require('./endpoint');

// deps
const { isString, isObject } = require('lodash');

const Context = '@context';

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
        //
        //  If @context is present, it must be valid;
        //  child objects generally inherit, so they may not have one
        //
        if (this[Context]) {
            if (!this.isContextValid()) {
                return false;
            }
        }

        const checkString = s => isString(s) && s.length > 1;
        return checkString(this.id) && checkString(this.type);
    }

    isContextValid() {
        if (Array.isArray(this[Context])) {
            if (this[Context][0] === ActivityStreamsContext) {
                return true;
            }
        } else if (isString(this[Context])) {
            if (ActivityStreamsContext === this[Context]) {
                return true;
            }
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
