const Message = require('../message');
const ActivityPubObject = require('./object');
const { Errors } = require('../enig_error');
const { getISOTimestampString } = require('../database');
const User = require('../user');
const {
    parseTimestampOrNow,
    messageToHtml,
    htmlToMessageBody,
    recipientIdsFromObject,
} = require('./util');
const { PublicCollectionId } = require('./const');
const { isAnsi } = require('../string_util');

// deps
const { v5: UUIDv5 } = require('uuid');
const Actor = require('./actor');
const Collection = require('./collection');
const async = require('async');
const { isString, isObject, truncate } = require('lodash');

const PublicMessageIdNamespace = 'a26ae389-5dfb-4b24-a58e-5472085c8e42';
const APDefaultSummary = '[No Subject]';

module.exports = class Note extends ActivityPubObject {
    constructor(obj) {
        super(obj, null); // Note are wrapped
    }

    isValid() {
        if (!super.isValid()) {
            return false;
        }

        if (this.type !== 'Note') {
            return false;
        }

        //  :TODO: validate required properties

        return true;
    }

    recipientIds() {
        return recipientIdsFromObject(this);
    }

    static fromPublicNoteId(noteId, cb) {
        Collection.objectByEmbeddedId(noteId, (err, obj, objInfo) => {
            if (err) {
                return cb(err);
            }

            if (!obj) {
                return cb(null, null);
            }

            if (objInfo.isPrivate || !obj.object || obj.object.type !== 'Note') {
                return cb(null, null);
            }

            return cb(null, new Note(obj.object));
        });
    }

    // A local Message bound for ActivityPub
    static fromLocalMessage(message, webServer, cb) {
        const localUserId = message.getLocalFromUserId();
        if (!localUserId) {
            return cb(Errors.UnexpectedState('Invalid user ID for local user!'));
        }

        const remoteActorAccount = message.getRemoteToUser();
        if (!remoteActorAccount && message.isPrivate()) {
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
                    Actor.fromLocalUser(fromUser, (err, fromActor) => {
                        return callback(err, fromUser, fromActor);
                    });
                },
                (fromUser, fromActor, callback) => {
                    if (message.isPrivate()) {
                        Actor.fromId(remoteActorAccount, (err, remoteActor) => {
                            return callback(err, fromUser, fromActor, remoteActor);
                        });
                    } else {
                        return callback(null, fromUser, fromActor, null);
                    }
                },
                (fromUser, fromActor, remoteActor, callback) => {
                    if (!message.replyToMsgId) {
                        return callback(null, null, fromUser, fromActor, remoteActor);
                    }

                    Message.getMetaValuesByMessageId(
                        message.replyToMsgId,
                        Message.WellKnownMetaCategories.ActivityPub,
                        Message.ActivityPubPropertyNames.NoteId,
                        (err, replyToNoteId) => {
                            // (ignore error)
                            return callback(
                                null,
                                replyToNoteId,
                                fromUser,
                                fromActor,
                                remoteActor
                            );
                        }
                    );
                },
                (replyToNoteId, fromUser, fromActor, remoteActor, callback) => {
                    const to = [
                        message.isPrivate() ? remoteActor.id : PublicCollectionId,
                    ];

                    const sourceMediaType = isAnsi(message.message)
                        ? 'text/x-ansi' // ye ol' https://lists.freedesktop.org/archives/xdg/2006-March/006214.html
                        : 'text/plain';

                    // https://docs.joinmastodon.org/spec/activitypub/#properties-used
                    const obj = {
                        id: ActivityPubObject.makeObjectId('note'),
                        type: 'Note',
                        published: getISOTimestampString(message.modTimestamp),
                        to,
                        attributedTo: fromActor.id,
                        summary: message.subject.trim(),
                        content: messageToHtml(message),
                        source: {
                            content: message.message,
                            mediaType: sourceMediaType,
                        },
                        sensitive: message.subject.startsWith('[NSFW]'),
                    };

                    if (replyToNoteId) {
                        obj.inReplyTo = replyToNoteId;
                    }

                    const note = new Note(obj);
                    const context = ActivityPubObject.makeContext([], {
                        sensitive: 'as:sensitive',
                    });
                    return callback(null, {
                        note,
                        fromUser,
                        remoteActor,
                        context,
                    });
                },
            ],
            (err, noteInfo) => {
                return cb(err, noteInfo);
            }
        );
    }

    toMessage(options, cb) {
        if (!options.toUser || !isString(options.areaTag)) {
            return cb(Errors.MissingParam('Missing one or more required options!'));
        }

        const isPrivate = isObject(options.toUser);

        //
        //  Message UUIDs are unique in the message database;
        //  However, we may need to deliver a particular message to:
        //  - #Public / sharedInbox
        //  - 1:N private user inboxes
        //
        //  In both cases, the UUID is stable. That is, the same ID
        //  will equal the same UUID as to prevent dupes.
        //
        const makeMessageUuid = () => {
            if (isPrivate) {
                // UUID specific to the target user
                const url = `${this.id}/${options.toUser.userId}`;
                return UUIDv5(url, UUIDv5.URL);
            } else {
                return UUIDv5(this.id, PublicMessageIdNamespace);
            }
        };

        // Fetch the remote actor info to get their user info
        Actor.fromId(this.attributedTo, (err, attributedToActor, fromActorSubject) => {
            if (err) {
                return cb(err);
            }

            const message = new Message({
                uuid: makeMessageUuid(),
            });

            message.fromUserName = fromActorSubject || this.attributedTo;

            //  :TODO: it would be better to do some basic HTML to ANSI or pipe codes perhaps
            message.message = htmlToMessageBody(
                // try to handle various implementations
                // - https://docs.joinmastodon.org/spec/activitypub/#payloads
                // - https://indieweb.org/post-type-discovery#Algorithm
                this.content || this.name || this.summary
            );

            this._setToUserName(message, isPrivate, options.toUser);
            this._setSubject(message);

            message.areaTag = options.areaTag || Message.WellKnownAreaTags.Private;

            //  List all attachments
            if (Array.isArray(this.attachment) && this.attachment.length > 0) {
                let attachmentInfoLines = ['--[Attachments]--'];
                // https://socialhub.activitypub.rocks/t/representing-images/624
                this.attachment.forEach(att => {
                    const type = att.mediaType.substring(0, att.mediaType.indexOf('/'));
                    switch (type) {
                        case 'image':
                            {
                                let imgInfo;
                                if (att.height && att.width) {
                                    imgInfo = `Image (${att.width}x${att.height})`;
                                } else {
                                    imgInfo = 'Image';
                                }
                                attachmentInfoLines.push(imgInfo);
                            }
                            break;

                        case 'audio':
                            attachmentInfoLines.push('Audio');
                            break;

                        case 'video':
                            attachmentInfoLines.push('Video');
                            break;

                        default:
                            attachmentInfoLines.push(att.mediaType);
                    }

                    if (att.name) {
                        attachmentInfoLines.push(att.name);
                    }

                    attachmentInfoLines.push(att.url);
                    attachmentInfoLines.push('');
                    attachmentInfoLines.push('');
                });

                message.message += '\r\n\r\n' + attachmentInfoLines.join('\r\n');
            }

            //  If the Note is marked sensitive, prefix the subject
            if (this.sensitive && message.subject.indexOf('[NSFW]') === -1) {
                message.subject = `[NSFW] ${message.subject}`;
            }

            message.modTimestamp = parseTimestampOrNow(this.published);

            message.setRemoteFromUser(this.attributedTo);
            message.setExternalFlavor(Message.AddressFlavor.ActivityPub);

            message.meta.ActivityPub = message.meta.ActivityPub || {};
            message.meta.ActivityPub[Message.ActivityPubPropertyNames.ActivityId] =
                options.activityId || 0;
            message.meta.ActivityPub[Message.ActivityPubPropertyNames.NoteId] = this.id;

            if (this.inReplyTo) {
                message.meta.ActivityPub[Message.ActivityPubPropertyNames.InReplyTo] =
                    this.inReplyTo;

                const filter = {
                    resultType: 'id',
                    metaTuples: [
                        {
                            category: Message.WellKnownMetaCategories.ActivityPub,
                            name: Message.ActivityPubPropertyNames.InReplyTo,
                            value: this.inReplyTo,
                        },
                    ],
                    limit: 1,
                };
                Message.findMessages(filter, (err, messageId) => {
                    if (messageId) {
                        // we get an array, but limited 1; use the first
                        messageId = messageId[0];
                        message.replyToMsgId = messageId;
                    }

                    return cb(null, message);
                });
            } else {
                return cb(null, message);
            }
        });
    }

    toUpdatedMessage(options, cb) {
        const original = new Message();
        original.load({ uuid: options.messageUuid }, err => {
            if (err) {
                return cb(err);
            }

            //  rebuild message
            options.areaTag = original.areaTag;

            async.waterfall(
                [
                    callback => {
                        if (!original.isPrivate()) {
                            options.toUser = 'All';
                            return callback(null);
                        }

                        const userId =
                            original.meta.System[Message.SystemMetaNames.LocalToUserID];
                        if (!userId) {
                            return cb(
                                Errors.MissingProperty(
                                    `User is missing "${Message.SystemMetaNames.LocalToUserID}" property`
                                )
                            );
                        }

                        User.getUser(userId, (err, user) => {
                            if (err) {
                                return callback(err);
                            }

                            options.toUser = user;
                            return callback(null);
                        });
                    },
                    callback => {
                        this.toMessage(options, (err, message) => {
                            if (err) {
                                return callback(err);
                            }

                            //  re-target as message to be updated
                            message.messageUuid = original.messageUuid;

                            return callback(null, message);
                        });
                    },
                ],
                (err, message) => {
                    return cb(err, message);
                }
            );
        });
    }

    static deleteAssocMessage(noteId, cb) {
        const filter = {
            resultType: 'uuid',
            metaTuples: [
                {
                    category: Message.WellKnownMetaCategories.ActivityPub,
                    name: Message.ActivityPubPropertyNames.NoteId,
                    value: noteId,
                },
            ],
            limit: 1,
        };

        return Message.findMessages(filter, (err, messageUuid) => {
            if (!messageUuid) {
                return cb(null);
            }

            messageUuid = messageUuid[0]; // limit 1

            Message.deleteByMessageUuid(messageUuid, err => {
                return cb(err);
            });
        });
    }

    _setSubject(message) {
        if (this.summary) {
            message.subject = this.summary.trim();
            return;
        }

        if (this.name) {
            message.subject = this.name.trim();
            return;
        }

        //
        //  Build a subject from the message itself:
        //  - First few characters of the message, removing the @username
        //    prefix, if any
        //  - Truncate at the first line feed, the end of the message,
        //    or 32 characters in length, whichever comes first
        //  - If not end of string, we'll sub in '...'
        //
        let subject = message.message.replace(`@${message.toUserName} `, '').trim();
        const m = /^(.+)\r?\n/.exec(subject);
        if (m && m[1]) {
            subject = m[1];
        }

        subject = truncate(subject, { length: 32, omission: '...' });
        subject = subject || APDefaultSummary;
        message.subject = subject;
    }

    _setToUserName(message, isPrivate, toUser) {
        if (isPrivate) {
            message.toUserName = toUser.username;
            message.meta.System[Message.SystemMetaNames.LocalToUserID] = toUser.userId;
            return;
        }

        const m = /^@([^ ]+) ./.exec(message.message);
        if (m && m[1]) {
            message.toUserName = m[1];
        }

        message.toUserName = message.toUserName || 'All';
    }
};
