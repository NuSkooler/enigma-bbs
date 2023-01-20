const { messageBodyToHtml, selfUrl, makeUserUrl } = require('./util');
const { ActivityStreamsContext, WellKnownActivityTypes } = require('./const');
const ActivityPubObject = require('./object');
const User = require('../user');
const Actor = require('./actor');
const { Errors } = require('../enig_error');
const { getISOTimestampString } = require('../database');
const UserProps = require('../user_property');
const { postJson } = require('../http_util');
const { getOutboxEntries } = require('./db');
const { WellKnownLocations } = require('../servers/content/web');

// deps
//const { isString, isObject } = require('lodash');
const { v4: UUIDv4 } = require('uuid');
const async = require('async');
const _ = require('lodash');

module.exports = class Activity extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    static get ActivityTypes() {
        return WellKnownActivityTypes;
    }

    static fromJsonString(json) {
        const parsed = JSON.parse(json);
        return new Activity(parsed);
    }

    // isValid() {
    //     if (
    //         this['@context'] !== ActivityStreamsContext ||
    //         !isString(this.id) ||
    //         !isString(this.actor) ||
    //         (!isString(this.object) && !isObject(this.object)) ||
    //         !Activity.ActivityTypes.includes(this.type)
    //     ) {
    //         return false;
    //     }

    //     //  :TODO: Additional validation

    //     return true;
    // }

    // https://www.w3.org/TR/activitypub/#accept-activity-inbox
    static makeAccept(webServer, localActor, followRequest, id = null) {
        id = id || Activity._makeFullId(webServer, 'accept');

        return new Activity({
            id,
            type: 'Accept',
            actor: localActor,
            object: followRequest, // previous request Activity
        });
    }

    static noteFromLocalMessage(webServer, message, cb) {
        const localUserId = message.getLocalFromUserId();
        if (!localUserId) {
            return cb(Errors.UnexpectedState('Invalid user ID for local user!'));
        }

        async.waterfall(
            [
                callback => {
                    return User.getUser(localUserId, callback);
                },
                (localUser, callback) => {
                    const remoteActorAccount = message.getRemoteToUser();
                    if (!remoteActorAccount) {
                        return callback(
                            Errors.UnexpectedState(
                                'Message does not contain a remote address'
                            )
                        );
                    }

                    const opts = {};
                    Actor.fromAccountName(
                        remoteActorAccount,
                        opts,
                        (err, remoteActor) => {
                            return callback(err, localUser, remoteActor);
                        }
                    );
                },
                (localUser, remoteActor, callback) => {
                    Actor.fromLocalUser(localUser, webServer, (err, localActor) => {
                        return callback(err, localUser, localActor, remoteActor);
                    });
                },
                (localUser, localActor, remoteActor, callback) => {
                    // we'll need the entire |activityId| as a linked reference later
                    const activityId = Activity._makeFullId(webServer, 'create');

                    const obj = {
                        '@context': ActivityStreamsContext,
                        id: activityId,
                        type: 'Create',
                        actor: localActor.id,
                        object: {
                            id: Activity._makeFullId(webServer, 'note'),
                            type: 'Note',
                            published: getISOTimestampString(message.modTimestamp),
                            attributedTo: localActor.id,
                            audience: [message.isPrivate() ? 'as:Private' : 'as:Public'],
                            // :TODO: inReplyto if this is a reply; we need this store in message meta.

                            content: messageBodyToHtml(message.message.trim()),
                        },
                    };

                    //  :TODO: this probably needs to change quite a bit based on "groups"
                    //  :TODO: verify we need both 'to' fields: https://socialhub.activitypub.rocks/t/problems-posting-to-mastodon-inbox/801/4
                    if (message.isPrivate()) {
                        //obj.to = remoteActor.id;
                        obj.object.to = remoteActor.id;
                    } else {
                        const publicInbox = `${ActivityStreamsContext}#Public`;
                        //obj.to = publicInbox;
                        obj.object.to = publicInbox;
                    }

                    const activity = new Activity(obj);
                    return callback(null, activity, localUser, remoteActor);
                },
            ],
            (err, activity, fromUser, remoteActor) => {
                return cb(err, { activity, fromUser, remoteActor });
            }
        );
    }

    //  :TODO: move to Collection
    static fromOutboxEntries(owningUser, webServer, cb) {
        //  :TODO: support paging
        const getOpts = {
            create: true, // items marked 'Create'
        };
        getOutboxEntries(owningUser, getOpts, (err, entries) => {
            if (err) {
                return cb(err);
            }

            const obj = {
                '@context': ActivityStreamsContext,
                //  :TODO: makeOutboxUrl() and use elsewhere also
                id: makeUserUrl(webServer, owningUser, '/ap/users') + '/outbox',
                type: 'OrderedCollection',
                totalItems: entries.length,
                orderedItems: entries.map(e => {
                    return {
                        '@context': ActivityStreamsContext,
                        id: e.activity.id,
                        type: 'Create',
                        actor: e.activity.actor,
                        object: e.activity.object,
                    };
                }),
            };

            return cb(null, new Activity(obj));
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

    static _makeFullId(webServer, prefix) {
        // e.g. http://some.host/_enig/ap/note/bf81a22e-cb3e-41c8-b114-21f375b61124
        return webServer.buildUrl(
            WellKnownLocations.Internal + `/ap/${prefix}/${UUIDv4()}`
        );
    }
};
