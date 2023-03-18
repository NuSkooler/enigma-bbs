const {
    ActivityStreamsContext,
    ActivityStreamMediaType,
    HttpSignatureSignHeaders,
} = require('./const');
const Endpoints = require('./endpoint');
const UserProps = require('../user_property');
const { Errors } = require('../enig_error');
const { postJson } = require('../http_util');

// deps
const { isString, isObject, isEmpty } = require('lodash');

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
        return Endpoints.objectId(objectType);
    }

    sendTo(inboxEndpoint, fromUser, webServer, cb) {
        const privateKey = fromUser.getProperty(UserProps.PrivateActivityPubSigningKey);
        if (isEmpty(privateKey)) {
            return cb(
                Errors.MissingProperty(
                    `User "${fromUser.username}" is missing the '${UserProps.PrivateActivityPubSigningKey}' property`
                )
            );
        }

        const reqOpts = {
            headers: {
                'Content-Type': ActivityStreamMediaType,
            },
            sign: {
                key: privateKey,
                keyId: Endpoints.actorId(fromUser) + '#main-key',
                authorizationHeaderName: 'Signature',
                headers: HttpSignatureSignHeaders,
            },
        };

        const activityJson = JSON.stringify(this);
        return postJson(inboxEndpoint, activityJson, reqOpts, cb);
    }
};
