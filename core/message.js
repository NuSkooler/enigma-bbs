/* jslint node: true */
'use strict';

const msgDb = require('./database.js').dbs.message;
const wordWrapText = require('./word_wrap.js').wordWrapText;
const { createNamedUUID, parseUUID, unparseUUID } = require('./uuid_util.js');
const Errors = require('./enig_error.js').Errors;
const ANSI = require('./ansi_term.js');
const { sanitizeString, getISOTimestampString, coerceToText } = require('./database.js');
const { isCP437Encodable } = require('./cp437util');
const { containsNonLatinCodepoints } = require('./string_util');
const MessageConst = require('./message_const');
const { getQuotePrefixFromName } = require('./mail_util');

const {
    isAnsi,
    isFormattedLine,
    splitTextAtTerms,
    renderSubstr,
} = require('./string_util.js');

const ansiPrep = require('./ansi_prep.js');

//  deps
const async = require('async');
const _ = require('lodash');
const assert = require('assert');
const moment = require('moment');
const iconvEncode = require('iconv-lite').encode;

const ENIGMA_MESSAGE_UUID_NAMESPACE = parseUUID('154506df-1df8-46b9-98f8-ebb5815baaf8');

//  :TODO: this is a ugly hack due to bad variable names - clean it up & just _.camelCase(k)!
const MESSAGE_ROW_MAP = {
    reply_to_message_id: 'replyToMsgId',
    modified_timestamp: 'modTimestamp',
};

module.exports = class Message {
    constructor({
        messageId = 0,
        areaTag = Message.WellKnownAreaTags.Invalid,
        uuid,
        replyToMsgId = 0,
        toUserName = '',
        fromUserName = '',
        subject = '',
        message = '',
        modTimestamp = moment(),
        meta,
        hashTags = [],
    } = {}) {
        this.messageId = messageId;
        this.areaTag = areaTag;
        this.messageUuid = uuid;
        this.replyToMsgId = replyToMsgId;
        this.toUserName = toUserName;
        this.fromUserName = fromUserName;
        this.subject = subject;
        this.message = message;

        if (_.isDate(modTimestamp) || _.isString(modTimestamp)) {
            modTimestamp = moment(modTimestamp);
        }

        this.modTimestamp = modTimestamp || moment();

        this.meta = {};
        _.defaultsDeep(this.meta, { System: {} }, meta);

        this.hashTags = hashTags;
    }

    get uuid() {
        //  deprecated, will be removed in the near future
        return this.messageUuid;
    }

    isValid() {
        return true;
    } //  :TODO: obviously useless; look into this or remove it

    static isPrivateAreaTag(areaTag) {
        return areaTag.toLowerCase() === Message.WellKnownAreaTags.Private;
    }

    isPrivate() {
        return Message.isPrivateAreaTag(this.areaTag);
    }

    isPublic() {
        return !this.isPrivate();
    }

    isFromRemoteUser() {
        return null !== this.getRemoteFromUser();
    }

    setRemoteFromUser(remoteFrom) {
        this.meta[Message.WellKnownMetaCategories.System][
            Message.SystemMetaNames.RemoteFromUser
        ] = remoteFrom;
    }

    getRemoteFromUser() {
        return _.get(
            this,
            [
                'meta',
                Message.WellKnownMetaCategories.System,
                Message.SystemMetaNames.RemoteFromUser,
            ],
            null
        );
    }

    isCP437Encodable() {
        return (
            isCP437Encodable(this.toUserName) &&
            isCP437Encodable(this.fromUserName) &&
            isCP437Encodable(this.subject) &&
            isCP437Encodable(this.message)
        );
    }

    containsNonLatinCodepoints() {
        return (
            containsNonLatinCodepoints(this.toUserName) ||
            containsNonLatinCodepoints(this.fromUserName) ||
            containsNonLatinCodepoints(this.subject) ||
            containsNonLatinCodepoints(this.message)
        );
    }

    /*
    :TODO: finish me
    static checkUserHasDeleteRights(user, messageIdOrUuid, cb) {
        const isMessageId = _.isNumber(messageIdOrUuid);
        const getMetaName = isMessageId ? 'getMetaValuesByMessageId' : 'getMetaValuesByMessageUuid';

        Message[getMetaName](messageIdOrUuid, 'System', Message.SystemMetaNames.LocalToUserID, (err, localUserId) => {
            if(err) {
                return cb(err);
            }

            //  expect single value
            if(!_.isString(localUserId)) {
                return cb(Errors.Invalid(`Invalid ${Message.SystemMetaNames.LocalToUserID} value: ${localUserId}`));
            }

            localUserId = parseInt(localUserId);
        });
    }
    */

    userHasDeleteRights(user) {
        const messageLocalUserId = parseInt(
            this.meta.System[Message.SystemMetaNames.LocalToUserID]
        );
        return (this.isPrivate() && user.userId === messageLocalUserId) || user.isSysOp();
    }

    static get WellKnownMetaCategories() {
        return MessageConst.WellKnownMetaCategories;
    }

    static get WellKnownAreaTags() {
        return MessageConst.WellKnownAreaTags;
    }

    static get SystemMetaNames() {
        return MessageConst.SystemMetaNames;
    }

    static get AddressFlavor() {
        return MessageConst.AddressFlavor;
    }

    static get StateFlags0() {
        return MessageConst.StateFlags0;
    }

    static get FtnPropertyNames() {
        return MessageConst.FtnPropertyNames;
    }

    static get QWKPropertyNames() {
        return MessageConst.QWKPropertyNames;
    }

    static get ActivityPubPropertyNames() {
        return MessageConst.ActivityPubPropertyNames;
    }

    setLocalToUserId(userId) {
        this.meta.System = this.meta.System || {};
        this.meta.System[Message.SystemMetaNames.LocalToUserID] = userId;
    }

    setLocalFromUserId(userId) {
        this.meta.System = this.meta.System || {};
        this.meta.System[Message.SystemMetaNames.LocalFromUserID] = userId;
    }

    getLocalFromUserId() {
        let id = _.get(this, 'meta.System.local_from_user_id', 0);
        return parseInt(id);
    }

    setRemoteToUser(remoteTo) {
        this.meta.System = this.meta.System || {};
        this.meta.System[Message.SystemMetaNames.RemoteToUser] = remoteTo;
    }

    getRemoteToUser() {
        return _.get(this, 'meta.System.remote_to_user');
    }

    setExternalFlavor(flavor) {
        this.meta.System = this.meta.System || {};
        this.meta.System[Message.SystemMetaNames.ExternalFlavor] = flavor;
    }

    getAddressFlavor() {
        return _.get(this, 'meta.System.external_flavor', Message.AddressFlavor.Local);
    }

    static createMessageUUID(areaTag, modTimestamp, subject, body) {
        assert(_.isString(areaTag));
        assert(_.isDate(modTimestamp) || moment.isMoment(modTimestamp));
        assert(_.isString(subject));
        assert(_.isString(body));

        if (!moment.isMoment(modTimestamp)) {
            modTimestamp = moment(modTimestamp);
        }

        areaTag = iconvEncode(areaTag.toUpperCase(), 'CP437');
        modTimestamp = iconvEncode(modTimestamp.format('DD MMM YY  HH:mm:ss'), 'CP437');
        subject = iconvEncode(subject.toUpperCase().trim(), 'CP437');
        body = iconvEncode(
            body.replace(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g, '').trim(),
            'CP437'
        );

        return unparseUUID(
            createNamedUUID(
                ENIGMA_MESSAGE_UUID_NAMESPACE,
                Buffer.concat([areaTag, modTimestamp, subject, body])
            )
        );
    }

    static getMessageFromRow(row) {
        const msg = {};
        _.each(row, (v, k) => {
            //  :TODO: see notes around MESSAGE_ROW_MAP -- clean this up so we can just _camelCase()!
            k = MESSAGE_ROW_MAP[k] || _.camelCase(k);
            msg[k] = v;
        });
        return msg;
    }

    /*
        Find message IDs or UUIDs by filter. Available filters/options:

        filter.uuids - use with resultType='id'
        filter.ids - use with resultType='uuid'
        filter.toUserName - string|Array(string)
        filter.fromUserName - string|Array(string)
        filter.replyToMessageId

        filter.operator = (AND)|OR

        filter.newerThanTimestamp - may not be used with |date|
        filter.date - moment object - may not be used with |newerThanTimestamp|

        filter.newerThanMessageId
        filter.areaTag - note if you want by conf, send in all areas for a conf
        filter.metaTuples - [ {category, name, value} ]

        filter.terms - FTS search

        filter.sort = modTimestamp | messageId
        filter.order = ascending | (descending)

        filter.limit
        filter.resultType = (id) | uuid | count | messageList
        filter.extraFields = []

        filter.privateTagUserId = <userId> - if set, only private messages belonging to <userId> are processed
        - areaTags filter ignored
        - if NOT present, private areas are skipped

        filter.resultType == messageList only:
        - genMissingSubjects: generate missing subject lines by inspecting the message contents

        *=NYI
    */
    static findMessages(filter, cb) {
        filter = filter || {};

        filter.resultType = filter.resultType || 'id';
        filter.extraFields = filter.extraFields || [];
        filter.operator = filter.operator || 'AND';

        if ('messageList' === filter.resultType) {
            filter.extraFields = [
                ...new Set(
                    filter.extraFields.concat([
                        'area_tag',
                        'message_uuid',
                        'reply_to_message_id',
                        'to_user_name',
                        'from_user_name',
                        'subject',
                        'modified_timestamp',
                    ])
                ),
            ];
        }

        const field = 'uuid' === filter.resultType ? 'message_uuid' : 'message_id';

        if (moment.isMoment(filter.newerThanTimestamp)) {
            filter.newerThanTimestamp = getISOTimestampString(filter.newerThanTimestamp);
        }

        let sql;
        if ('count' === filter.resultType) {
            sql = `SELECT COUNT() AS count
                FROM message m`;
        } else {
            let additionalFields =
                filter.extraFields.length > 0
                    ? ', ' + filter.extraFields.map(f => `m.${f}`).join(', ')
                    : '';

            if (true === filter.genMissingSubjects) {
                additionalFields += `, CASE WHEN LENGTH(m.subject) > 0 THEN
                        m.subject
                    ELSE
                        REPLACE(REPLACE(SUBSTR(m.message,1,32),CHAR(10),''),CHAR(13),'') || '...'
                    END gen_subject`;
            }

            sql = `SELECT DISTINCT m.${field}${additionalFields}
                FROM message m`;
        }

        const sqlOrderDir = 'ascending' === filter.order ? 'ASC' : 'DESC';
        let sqlOrderBy;
        let sqlWhere = '';

        function appendWhereClause(clause, op) {
            if (sqlWhere) {
                sqlWhere += ` ${op || filter.operator} `;
            } else {
                sqlWhere += ' WHERE ';
            }
            sqlWhere += clause;
        }

        //  currently only avail sort
        if ('modTimestamp' === filter.sort) {
            sqlOrderBy = `ORDER BY m.modified_timestamp ${sqlOrderDir}`;
        } else {
            sqlOrderBy = `ORDER BY m.message_id ${sqlOrderDir}`;
        }

        if (Array.isArray(filter.ids)) {
            appendWhereClause(`m.message_id IN (${filter.ids.join(', ')})`);
        }

        if (Array.isArray(filter.uuids)) {
            const uuidList = filter.uuids.map(u => `'${u}'`).join(', ');
            appendWhereClause(`m.message_id IN (${uuidList})`);
        }

        if (_.isNumber(filter.privateTagUserId)) {
            appendWhereClause(`m.area_tag = '${Message.WellKnownAreaTags.Private}'`);
            appendWhereClause(
                `m.message_id IN (
                    SELECT message_id
                    FROM message_meta
                    WHERE meta_category = 'System' AND meta_name = '${Message.SystemMetaNames.LocalToUserID}' AND meta_value = ${filter.privateTagUserId}
                )`
            );
        } else {
            if (filter.areaTag && filter.areaTag.length > 0) {
                if (!Array.isArray(filter.areaTag)) {
                    filter.areaTag = [filter.areaTag];
                }

                const areaList = filter.areaTag
                    .filter(t => t !== Message.WellKnownAreaTags.Private)
                    .map(t => `'${t}'`)
                    .join(', ');
                if (areaList.length > 0) {
                    appendWhereClause(`m.area_tag IN(${areaList})`);
                } else {
                    //  nothing to do; no areas remain
                    return cb(null, []);
                }
            } else {
                //  explicit exclude of Private
                appendWhereClause(
                    `m.area_tag != '${Message.WellKnownAreaTags.Private}'`,
                    'AND'
                );
            }
        }

        if (_.isNumber(filter.replyToMessageId)) {
            appendWhereClause(`m.reply_to_message_id=${filter.replyToMessageId}`);
        }

        ['toUserName', 'fromUserName'].forEach(field => {
            let val = filter[field];
            if (!val) {
                return; //  next item
            }
            if (_.isString(val)) {
                val = [val];
            }
            if (Array.isArray(val)) {
                val =
                    '(' +
                    val
                        .map(v => {
                            return `m.${_.snakeCase(field)} LIKE '${sanitizeString(v)}'`;
                        })
                        .join(' OR ') +
                    ')';
                appendWhereClause(val);
            }
        });

        if (
            _.isString(filter.newerThanTimestamp) &&
            filter.newerThanTimestamp.length > 0
        ) {
            //  :TODO: should be using "localtime" here?
            appendWhereClause(
                `DATETIME(m.modified_timestamp) > DATETIME('${filter.newerThanTimestamp}', '+1 seconds')`
            );
        } else if (moment.isMoment(filter.date)) {
            appendWhereClause(
                `DATE(m.modified_timestamp, 'localtime') = DATE('${filter.date.format(
                    'YYYY-MM-DD'
                )}')`
            );
        }

        if (_.isNumber(filter.newerThanMessageId)) {
            appendWhereClause(`m.message_id > ${filter.newerThanMessageId}`);
        }

        if (filter.terms && filter.terms.length > 0) {
            //  note the ':' in MATCH expr., see https://www.sqlite.org/cvstrac/wiki?p=FullTextIndex
            appendWhereClause(
                `m.message_id IN (
                    SELECT rowid
                    FROM message_fts
                    WHERE message_fts MATCH ":${sanitizeString(filter.terms)}"
                )`
            );
        }

        if (Array.isArray(filter.metaTuples)) {
            let sub = [];
            filter.metaTuples.forEach(mt => {
                sub.push(
                    `(meta_category = '${mt.category}' AND meta_name = '${
                        mt.name
                    }' AND meta_value = '${sanitizeString(mt.value)}')`
                );
            });
            sub = sub.join(` ${filter.operator} `);
            appendWhereClause(
                `m.message_id IN (
                    SELECT message_id
                    FROM message_meta
                    WHERE ${sub}
                )`
            );
        }

        sql += `${sqlWhere} ${sqlOrderBy}`;

        if (_.isNumber(filter.limit)) {
            sql += ` LIMIT ${filter.limit}`;
        }

        sql += ';';

        if ('count' === filter.resultType) {
            try {
                const row = msgDb.prepare(sql).get();
                return cb(null, row ? row.count : 0);
            } catch (err) {
                return cb(err);
            }
        } else {
            const matches = [];
            const extra = filter.extraFields.length > 0;

            const rowConv =
                'messageList' === filter.resultType
                    ? Message.getMessageFromRow
                    : row => row;

            try {
                const rows = msgDb.prepare(sql).all();
                for (const row of rows) {
                    if (_.isObject(row)) {
                        matches.push(extra ? rowConv(row) : row[field]);
                    }
                }
                return cb(null, matches);
            } catch (err) {
                return cb(err);
            }
        }
    }

    //  :TODO: use findMessages, by uuid, limit=1
    static getMessageIdByUuid(uuid, cb) {
        try {
            const row = msgDb
                .prepare(
                    `SELECT message_id
                    FROM message
                    WHERE message_uuid = ?
                    LIMIT 1;`
                )
                .get(uuid);
            const success = row && row.message_id;
            return cb(
                success ? null : Errors.DoesNotExist(`No message for UUID ${uuid}`),
                success ? row.message_id : null
            );
        } catch (err) {
            return cb(err);
        }
    }

    //  :TODO: use findMessages
    static getMessageIdsByMetaValue(category, name, value, cb) {
        try {
            const rows = msgDb
                .prepare(
                    `SELECT message_id
                    FROM message_meta
                    WHERE meta_category = ? AND meta_name = ? AND meta_value = ?;`
                )
                .all(category, name, value);
            return cb(
                null,
                rows.map(r => parseInt(r.message_id))
            ); //  return array of ID(s)
        } catch (err) {
            return cb(err);
        }
    }

    //  Add a single meta value to an already-persisted message.
    //  OR IGNORE makes this idempotent — calling twice with the same args is safe.
    static addMetaValue(messageId, category, name, value, cb) {
        try {
            msgDb
                .prepare(
                    `INSERT OR IGNORE INTO message_meta (message_id, meta_category, meta_name, meta_value)
                    VALUES (?, ?, ?, ?);`
                )
                .run(messageId, category, name, coerceToText(value));
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static getMetaValuesByMessageId(messageId, category, name, cb) {
        const sql = `SELECT meta_value
            FROM message_meta
            WHERE message_id = ? AND meta_category = ? AND meta_name = ?;`;

        try {
            const rows = msgDb.prepare(sql).all(messageId, category, name);

            if (0 === rows.length) {
                return cb(Errors.DoesNotExist('No value for category/name'));
            }

            //  single values are returned without an array
            if (1 === rows.length) {
                return cb(null, rows[0].meta_value);
            }

            return cb(
                null,
                rows.map(r => r.meta_value)
            ); //  map to array of values only
        } catch (err) {
            return cb(err);
        }
    }

    static getMetaValuesByMessageUuid(uuid, category, name, cb) {
        async.waterfall(
            [
                function getMessageId(callback) {
                    Message.getMessageIdByUuid(uuid, (err, messageId) => {
                        return callback(err, messageId);
                    });
                },
                function getMetaValues(messageId, callback) {
                    Message.getMetaValuesByMessageId(
                        messageId,
                        category,
                        name,
                        (err, values) => {
                            return callback(err, values);
                        }
                    );
                },
            ],
            (err, values) => {
                return cb(err, values);
            }
        );
    }

    loadMeta(cb) {
        /*
            Example of loaded this.meta:

            meta: {
                System: {
                    local_to_user_id: 1234,
                },
                FtnProperty: {
                    ftn_seen_by: [ "1/102 103", "2/42 52 65" ]
                }
            }
        */
        const sql = `SELECT meta_category, meta_name, meta_value
            FROM message_meta
            WHERE message_id = ?;`;

        try {
            const rows = msgDb.prepare(sql).all(this.messageId);
            for (const row of rows) {
                if (!(row.meta_category in this.meta)) {
                    this.meta[row.meta_category] = {};
                    this.meta[row.meta_category][row.meta_name] = row.meta_value;
                } else {
                    if (!(row.meta_name in this.meta[row.meta_category])) {
                        this.meta[row.meta_category][row.meta_name] = row.meta_value;
                    } else {
                        if (_.isString(this.meta[row.meta_category][row.meta_name])) {
                            this.meta[row.meta_category][row.meta_name] = [
                                this.meta[row.meta_category][row.meta_name],
                            ];
                        }

                        this.meta[row.meta_category][row.meta_name].push(row.meta_value);
                    }
                }
            }
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    load(loadWith, cb) {
        assert(_.isString(loadWith.uuid) || _.isNumber(loadWith.messageId));

        const self = this;

        async.series(
            [
                function loadMessage(callback) {
                    const whereField = loadWith.uuid ? 'message_uuid' : 'message_id';
                    try {
                        const msgRow = msgDb
                            .prepare(
                                `SELECT message_id, area_tag, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject,
                                message, modified_timestamp, view_count
                                FROM message
                                WHERE ${whereField} = ?
                                LIMIT 1;`
                            )
                            .get(loadWith.uuid || loadWith.messageId);

                        if (!msgRow) {
                            return callback(
                                Errors.DoesNotExist('Message (no longer) available')
                            );
                        }

                        self.messageId = msgRow.message_id;
                        self.areaTag = msgRow.area_tag;
                        self.messageUuid = msgRow.message_uuid;
                        self.replyToMsgId = msgRow.reply_to_message_id;
                        self.toUserName = msgRow.to_user_name;
                        self.fromUserName = msgRow.from_user_name;
                        self.subject = msgRow.subject;
                        self.message = msgRow.message;

                        //  We use parseZone() to *preserve* the time zone information
                        self.modTimestamp = moment.parseZone(msgRow.modified_timestamp);

                        return callback(null);
                    } catch (err) {
                        return callback(err);
                    }
                },
                function loadMessageMeta(callback) {
                    self.loadMeta(err => {
                        return callback(err);
                    });
                },
                function loadHashTags(callback) {
                    //  :TODO:
                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    static deleteByMessageUuid(messageUuid, cb) {
        try {
            msgDb
                .prepare(
                    `DELETE FROM message
                    WHERE message_uuid = ?;`
                )
                .run(messageUuid);
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    persistMetaValue(category, name, value, cb) {
        try {
            if (!Array.isArray(value)) {
                value = [value];
            }

            const stmt = msgDb.prepare(
                `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
                VALUES (?, ?, ?, ?);`
            );
            for (const v of value) {
                stmt.run(this.messageId, category, name, coerceToText(v));
            }
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    updateMetaValue(category, name, value, cb) {
        try {
            if (!Array.isArray(value)) {
                value = [value];
            }

            const stmt = msgDb.prepare(
                `REPLACE INTO message_meta (message_id, meta_category, meta_name, meta_value)
                VALUES (?, ?, ?, ?);`
            );
            for (const v of value) {
                stmt.run(this.messageId, category, name, coerceToText(v));
            }
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    persist(cb) {
        const containsNonWhitespaceCharacterRegEx = /\S/;
        if (!containsNonWhitespaceCharacterRegEx.test(this.message)) {
            return cb(Errors.Invalid('Empty message'));
        }

        if (!this.isValid()) {
            return cb(Errors.Invalid('Cannot persist invalid message!'));
        }

        const self = this;

        try {
            msgDb.transaction(() => {
                if (!self.messageUuid) {
                    self.messageUuid = Message.createMessageUUID(
                        self.areaTag,
                        self.modTimestamp,
                        self.subject,
                        self.message
                    );
                }

                const info = msgDb
                    .prepare(
                        `INSERT INTO message (area_tag, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
                    )
                    .run(
                        self.areaTag,
                        self.messageUuid,
                        self.replyToMsgId,
                        self.toUserName,
                        self.fromUserName,
                        self.subject,
                        self.message,
                        getISOTimestampString(self.modTimestamp)
                    );
                self.messageId = info.lastInsertRowid;

                if (self.meta) {
                    /*
                        Example of self.meta:

                        meta: {
                            System: {
                                local_to_user_id: 1234,
                            },
                            FtnProperty: {
                                ftn_seen_by: [ "1/102 103", "2/42 52 65" ]
                            }
                        }
                    */
                    const metaStmt = msgDb.prepare(
                        `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
                        VALUES (?, ?, ?, ?);`
                    );
                    for (const category of Object.keys(self.meta)) {
                        for (const name of Object.keys(self.meta[category])) {
                            const val = self.meta[category][name];
                            for (const v of Array.isArray(val) ? val : [val]) {
                                metaStmt.run(self.messageId, category, name, coerceToText(v));
                            }
                        }
                    }
                }

                //  :TODO: hash tag support
            })();

            return cb(null, self.messageId);
        } catch (err) {
            return cb(err);
        }
    }

    update(cb) {
        if (!this.isValid()) {
            return cb(Errors.Invalid('Cannot update invalid message!'));
        }

        if (!this.messageUuid) {
            return cb(Errors.Invalid("Cannot update without a valid 'messageUUID'"));
        }

        const self = this;

        try {
            msgDb.transaction(() => {
                const info = msgDb
                    .prepare(
                        `REPLACE INTO message (area_tag, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
                    )
                    .run(
                        this.areaTag,
                        this.messageUuid,
                        this.replyToMsgId,
                        this.toUserName,
                        this.fromUserName,
                        this.subject,
                        this.message,
                        getISOTimestampString(this.modTimestamp)
                    );
                self.messageId = info.lastInsertRowid;

                if (this.meta) {
                    const metaStmt = msgDb.prepare(
                        `REPLACE INTO message_meta (message_id, meta_category, meta_name, meta_value)
                        VALUES (?, ?, ?, ?);`
                    );
                    for (const category of Object.keys(this.meta)) {
                        for (const name of Object.keys(this.meta[category])) {
                            const val = this.meta[category][name];
                            for (const v of Array.isArray(val) ? val : [val]) {
                                metaStmt.run(self.messageId, category, name, coerceToText(v));
                            }
                        }
                    }
                }
            })();

            return cb(null, self.messageId);
        } catch (err) {
            return cb(err);
        }
    }

    deleteMessage(requestingUser, cb) {
        if (!this.userHasDeleteRights(requestingUser)) {
            return cb(
                Errors.AccessDenied('User does not have rights to delete this message')
            );
        }

        try {
            msgDb
                .prepare(
                    `DELETE FROM message
                    WHERE message_uuid = ?;`
                )
                .run(this.messageUuid);
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    _getQuotePrefix(source) {
        source = source || 'fromUserName';

        //  grab out the name member, so we don't try to build
        //  quote prefixes such as "@N" for "@NuSkooler@some.host", etc.
        const userName = this[source];
        return getQuotePrefixFromName(userName);
    }

    static getTearLinePosition(input) {
        const m = input.match(/^--- .+$(?![\s\S]*^--- .+$)/m);
        return m ? m.index : -1;
    }

    getQuoteLines(options, cb) {
        if (!options.termWidth || !options.termHeight || !options.cols) {
            return cb(Errors.MissingParam());
        }

        options.startCol = options.startCol || 1;
        options.includePrefix = _.get(options, 'includePrefix', true);
        options.ansiResetSgr =
            options.ansiResetSgr ||
            ANSI.getSGRFromGraphicRendition({ fg: 39, bg: 49 }, true);
        options.ansiFocusPrefixSgr =
            options.ansiFocusPrefixSgr ||
            ANSI.getSGRFromGraphicRendition({ intensity: 'bold', fg: 39, bg: 49 });
        options.isAnsi = options.isAnsi || isAnsi(this.message); //  :TODO: If this.isAnsi, use that setting

        /*
            Some long text that needs to be wrapped and quoted should look right after
            doing so, don't ya think? yeah I think so

            Nu> Some long text that needs to be wrapped and quoted should look right
            Nu> after doing so, don't ya think? yeah I think so

            Ot> Nu> Some long text that needs to be wrapped and quoted should look
            Ot> Nu> right after doing so, don't ya think? yeah I think so

        */
        const quotePrefix =
            options.quotePrefix !== undefined
                ? options.quotePrefix
                : options.includePrefix
                  ? this._getQuotePrefix(options.prefixSource || 'fromUserName')
                  : '';

        //  When the caller explicitly provides a quotePrefix, the content is
        //  known plain text (e.g. HTML-stripped AP note). Skip isFormattedLine
        //  checks and always word-wrap, regardless of non-ASCII characters.
        const skipFormattedCheck = options.quotePrefix !== undefined;

        function getWrapped(text, extraPrefix) {
            extraPrefix = extraPrefix ? ` ${extraPrefix}` : '';

            const wrapOpts = {
                width: options.cols - (quotePrefix.length + extraPrefix.length),
                tabHandling: 'expand',
                tabWidth: 4,
            };

            return wordWrapText(text, wrapOpts).wrapped.map((w, i) => {
                return i === 0
                    ? `${quotePrefix}${w}`
                    : `${quotePrefix}${extraPrefix}${w}`;
            });
        }

        function getFormattedLine(line) {
            //  for pre-formatted text, we just append a line truncated to fit
            let newLen;
            const total = line.length + quotePrefix.length;

            if (total > options.cols) {
                newLen = options.cols - total;
            } else {
                newLen = total;
            }

            return `${quotePrefix}${line.slice(0, newLen)}`;
        }

        if (options.isAnsi) {
            ansiPrep(
                this.message.replace(/\r?\n/g, '\r\n'), //  normalized LF -> CRLF
                {
                    termWidth: options.termWidth,
                    termHeight: options.termHeight,
                    cols: options.cols,
                    rows: 'auto',
                    startCol: options.startCol,
                    forceLineTerm: true,
                },
                (err, prepped) => {
                    prepped = prepped || this.message;

                    let lastSgr = '';
                    const split = splitTextAtTerms(prepped);

                    const quoteLines = [];
                    const focusQuoteLines = [];

                    //
                    //  Do not include quote prefixes (e.g. XX> ) on ANSI replies (and therefor quote builder)
                    //  as while this works in ENiGMA, other boards such as Mystic, WWIV, etc. will try to
                    //  strip colors, colorize the lines, etc. If we exclude the prefixes, this seems to do
                    //  the trick and allow them to leave them alone!
                    //
                    split.forEach(l => {
                        quoteLines.push(`${lastSgr}${l}`);

                        focusQuoteLines.push(
                            `${options.ansiFocusPrefixSgr}>${lastSgr}${renderSubstr(
                                l,
                                1,
                                l.length - 1
                            )}`
                        );
                        lastSgr =
                            (l.match(
                                /(?:\x1b\x5b)[?=;0-9]*m(?!.*(?:\x1b\x5b)[?=;0-9]*m)/
                            ) || [])[0] || ''; //  eslint-disable-line no-control-regex
                    });

                    quoteLines[quoteLines.length - 1] += options.ansiResetSgr;

                    return cb(null, quoteLines, focusQuoteLines, true);
                }
            );
        } else {
            const QUOTE_RE = /^ ((?:[A-Za-z0-9]{1,2}> )+(?:[A-Za-z0-9]{1,2}>)*) */;
            const quoted = [];
            const input = this.message.trimEnd().replace(/\x08/g, ''); //  eslint-disable-line no-control-regex

            //  find *last* tearline
            let tearLinePos = Message.getTearLinePosition(input);
            tearLinePos = -1 === tearLinePos ? input.length : tearLinePos; //  we just want the index or the entire string

            input
                .slice(0, tearLinePos)
                .split(/\r\n\r\n|\n\n/)
                .forEach(paragraph => {
                    //
                    //  For each paragraph, a state machine:
                    //  - New line - line
                    //  - New (pre)quoted line - quote_line
                    //  - Continuation of new/quoted line
                    //
                    //  Also:
                    //  - Detect pre-formatted lines & try to keep them as-is
                    //
                    let state;
                    let buf = '';
                    let quoteMatch;

                    if (quoted.length > 0) {
                        //
                        //  Preserve paragraph separation.
                        //
                        //  FSC-0032 states something about leaving blank lines fully blank
                        //  (without a prefix) but it seems nicer (and more consistent with other systems)
                        //  to put 'em in.
                        //
                        quoted.push(quotePrefix);
                    }

                    paragraph.split(/\r?\n/).forEach(line => {
                        if (0 === line.trim().length) {
                            //  see blank line notes above
                            return quoted.push(quotePrefix);
                        }

                        quoteMatch = line.match(QUOTE_RE);

                        switch (state) {
                            case 'line':
                                if (quoteMatch) {
                                    if (!skipFormattedCheck && isFormattedLine(line)) {
                                        quoted.push(
                                            getFormattedLine(line.replace(/\s/, ''))
                                        );
                                    } else {
                                        quoted.push(...getWrapped(buf, quoteMatch[1]));
                                        state = 'quote_line';
                                        buf = line;
                                    }
                                } else {
                                    buf += ` ${line}`;
                                }
                                break;

                            case 'quote_line':
                                if (quoteMatch) {
                                    const rem = line.slice(quoteMatch[0].length);
                                    if (!buf.startsWith(quoteMatch[0])) {
                                        quoted.push(...getWrapped(buf, quoteMatch[1]));
                                        buf = rem;
                                    } else {
                                        buf += ` ${rem}`;
                                    }
                                } else {
                                    quoted.push(...getWrapped(buf));
                                    buf = line;
                                    state = 'line';
                                }
                                break;

                            default:
                                if (!skipFormattedCheck && isFormattedLine(line)) {
                                    quoted.push(getFormattedLine(line));
                                } else {
                                    state = quoteMatch ? 'quote_line' : 'line';
                                    buf =
                                        'line' === state ? line : line.replace(/\s/, ''); //  trim *first* leading space, if any
                                }
                                break;
                        }
                    });

                    quoted.push(...getWrapped(buf, quoteMatch ? quoteMatch[1] : null));
                });

            return cb(null, quoted, null, false);
        }
    }
};
