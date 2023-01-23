const Message = require('../message');
const ActivityPubObject = require('./object');
const { Errors } = require('../enig_error');
const { getISOTimestampString } = require('../database');
const User = require('../user');
const { messageBodyToHtml } = require('./util');

// deps
const { v5: UUIDv5 } = require('uuid');
const Actor = require('./actor');
const moment = require('moment');
const Collection = require('./collection');
const async = require('async');

const APMessageIdNamespace = '307bc7b3-3735-4573-9a20-e3f9eaac29c5';

module.exports = class Note extends ActivityPubObject {
    constructor(obj) {
        super(obj);
    }

    isValid() {
        if (!super.isValid()) {
            return false;
        }

        //  :TODO: validate required properties

        return true;
    }

    static fromPublicNoteId(noteId, cb) {
        Collection.embeddedObjById('outbox', false, noteId, (err, obj) => {
            if (err) {
                return cb(err);
            }

            return cb(null, new Note(obj.object));
        });
    }

    // A local Message bound for ActivityPub
    static fromLocalOutgoingMessage(message, webServer, cb) {
        const localUserId = message.getLocalFromUserId();
        if (!localUserId) {
            return cb(Errors.UnexpectedState('Invalid user ID for local user!'));
        }

        if (Message.AddressFlavor.ActivityPub !== message.getAddressFlavor()) {
            return cb(
                Errors.Invalid('Cannot build note for non-ActivityPub addressed message')
            );
        }

        const remoteActorAccount = message.getRemoteToUser();
        if (!remoteActorAccount) {
            return cb(
                Errors.UnexpectedState('Message does not contain a remote address')
            );
        }

        async.waterfall(
            [
                callback => {
                    return User.getUser(localUserId, callback);
                },
                (fromUser, callback) => {
                    Actor.fromLocalUser(fromUser, webServer, (err, fromActor) => {
                        return callback(err, fromUser, fromActor);
                    });
                },
                (fromUser, fromActor, callback) => {
                    Actor.fromAccountName(remoteActorAccount, (err, remoteActor) => {
                        return callback(err, fromUser, fromActor, remoteActor);
                    });
                },
                (fromUser, fromActor, remoteActor, callback) => {
                    const to = message.isPrivate()
                        ? remoteActor.id
                        : Collection.PublicCollectionId;

                    // Refs
                    // - https://docs.joinmastodon.org/spec/activitypub/#properties-used
                    const obj = {
                        id: ActivityPubObject.makeObjectId(webServer, 'note'),
                        type: 'Note',
                        published: getISOTimestampString(message.modTimestamp),
                        to,
                        attributedTo: fromActor.id,
                        audience: [message.isPrivate() ? 'as:Private' : 'as:Public'],

                        // :TODO: inReplyto if this is a reply; we need this store in message meta.

                        content: messageBodyToHtml(message.message.trim()),
                    };

                    const note = new Note(obj);
                    return callback(null, { note, fromUser, remoteActor });
                },
            ],
            (err, noteInfo) => {
                return cb(err, noteInfo);
            }
        );
    }

    toMessage(cb) {
        // stable ID based on Note ID
        const message = new Message({
            uuid: UUIDv5(this.id, APMessageIdNamespace),
        });

        // Fetch the remote actor
        Actor.fromId(this.attributedTo, false, (err, attributedToActor) => {
            if (err) {
                //  :TODO: Log me
                message.toUserName = this.attributedTo; // have some sort of value =/
            } else {
                message.toUserName =
                    attributedToActor.preferredUsername || this.attributedTo;
            }

            message.subject = this.summary || '-ActivityPub-';
            message.message = this.content; //  :TODO: HTML to suitable format, or even strip

            try {
                message.modTimestamp = moment(this.published);
            } catch (e) {
                //  :TODO: Log warning
                message.modTimestamp = moment();
            }

            //  :TODO: areaTag
            //  :TODO: replyToMsgId from 'inReplyTo'
            //  :TODO: RemoteFromUser

            message.meta[Message.WellKnownMetaCategories.ActivityPub] =
                message.meta[Message.WellKnownMetaCategories.ActivityPub] || {};
            const apMeta = message.meta[Message.WellKnownAreaTags.ActivityPub];

            apMeta[Message.ActivityPubPropertyNames.ActivityId] = this.id;
            if (this.InReplyTo) {
                apMeta[Message.ActivityPubPropertyNames.InReplyTo] = this.InReplyTo;
            }

            message.setRemoteFromUser(this.attributedTo);
            message.setExternalFlavor(Message.ExternalFlavor.ActivityPub);

            return cb(null, message);
        });
    }
};
