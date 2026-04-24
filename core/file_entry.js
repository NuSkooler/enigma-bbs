/* jslint node: true */
'use strict';

const fileDb = require('./database.js').dbs.file;
const Errors = require('./enig_error.js').Errors;
const { getISOTimestampString, sanitizeString, coerceToText } = require('./database.js');
const Config = require('./config.js').get;

//  deps
const async = require('async');
const _ = require('lodash');
const paths = require('path');
const fse = require('fs-extra');
const { unlink, readFile } = require('graceful-fs');
const crypto = require('crypto');
const moment = require('moment');

const FILE_TABLE_MEMBERS = [
    'file_id',
    'area_tag',
    'file_sha256',
    'file_name',
    'storage_tag',
    'storage_tag_rel_path',
    'desc',
    'desc_long',
    'upload_timestamp',
];

const FILE_WELL_KNOWN_META = {
    //  name -> *read* converter, if any
    upload_by_username: null,
    upload_by_user_id: u => parseInt(u) || 0,
    file_md5: null,
    file_sha1: null,
    file_crc32: null,
    est_release_year: y => parseInt(y) || new Date().getFullYear(),
    dl_count: d => parseInt(d) || 0,
    byte_size: b => parseInt(b) || 0,
    archive_type: null,
    short_file_name: null, //  e.g. DOS 8.3 filename, avail in some scenarios such as TIC import
    tic_origin: null, //  TIC "Origin"
    tic_desc: null, //  TIC "Desc"
    tic_ldesc: null, //  TIC "Ldesc" joined by '\n'
    session_temp_dl: v => (parseInt(v) ? true : false),
    desc_sauce: s => JSON.parse(s) || {},
    desc_long_sauce: s => JSON.parse(s) || {},
};

module.exports = class FileEntry {
    constructor(options) {
        options = options || {};

        this.fileId = options.fileId || 0;
        this.areaTag = options.areaTag || '';
        this.meta = Object.assign({ dl_count: 0 }, options.meta);
        this.hashTags = options.hashTags || new Set();
        this.fileName = options.fileName;
        this.storageTag = options.storageTag;
        this.fileSha256 = options.fileSha256;
        this.relPath = options.relPath || null;
    }

    static loadBasicEntry(fileId, dest, cb) {
        dest = dest || {};

        try {
            const file = fileDb
                .prepare(
                    `SELECT ${FILE_TABLE_MEMBERS.join(', ')}
                    FROM file
                    WHERE file_id=?
                    LIMIT 1;`
                )
                .get(fileId);

            if (!file) {
                return cb(Errors.DoesNotExist('No file is available by that ID'));
            }

            FILE_TABLE_MEMBERS.forEach(prop => {
                dest[_.camelCase(prop)] = file[prop];
            });
            //  expose storage_tag_rel_path under the canonical internal name
            dest.relPath = file.storage_tag_rel_path || null;

            return cb(null, dest);
        } catch (err) {
            return cb(err);
        }
    }

    load(fileId, cb) {
        const self = this;

        async.series(
            [
                function loadBasicEntry(callback) {
                    FileEntry.loadBasicEntry(fileId, self, callback);
                },
                function loadMeta(callback) {
                    return self.loadMeta(callback);
                },
                function loadHashTags(callback) {
                    return self.loadHashTags(callback);
                },
                function loadUserRating(callback) {
                    return self.loadRating(callback);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    persist(isUpdate, cb) {
        if (!cb && _.isFunction(isUpdate)) {
            cb = isUpdate;
            isUpdate = false;
        }

        const self = this;

        if (isUpdate && !self.fileId) {
            return cb(
                Errors.Invalid(
                    'Cannot update file entry without an existing "fileId" member'
                )
            );
        }

        function persistToDb(err) {
            if (err) {
                return cb(err);
            }

            try {
                fileDb.transaction(() => {
                    if (isUpdate) {
                        fileDb
                            .prepare(
                                `REPLACE INTO file (file_id, area_tag, file_sha256, file_name, storage_tag, storage_tag_rel_path, desc, desc_long, upload_timestamp)
                                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?);`
                            )
                            .run(
                                self.fileId,
                                self.areaTag,
                                self.fileSha256,
                                self.fileName,
                                self.storageTag,
                                self.relPath || null,
                                self.desc,
                                self.descLong,
                                getISOTimestampString()
                            );
                    } else {
                        const info = fileDb
                            .prepare(
                                `REPLACE INTO file (area_tag, file_sha256, file_name, storage_tag, storage_tag_rel_path, desc, desc_long, upload_timestamp)
                                VALUES(?, ?, ?, ?, ?, ?, ?, ?);`
                            )
                            .run(
                                self.areaTag,
                                self.fileSha256,
                                self.fileName,
                                self.storageTag,
                                self.relPath || null,
                                self.desc,
                                self.descLong,
                                getISOTimestampString()
                            );
                        self.fileId = info.lastInsertRowid;
                    }

                    const metaStmt = fileDb.prepare(
                        `REPLACE INTO file_meta (file_id, meta_name, meta_value)
                        VALUES (?, ?, ?);`
                    );
                    for (const [n, v] of Object.entries(self.meta)) {
                        metaStmt.run(self.fileId, n, coerceToText(v));
                    }

                    const insertTagStmt = fileDb.prepare(
                        `INSERT OR IGNORE INTO hash_tag (hash_tag) VALUES (?);`
                    );
                    const insertFileTagStmt = fileDb.prepare(
                        `REPLACE INTO file_hash_tag (hash_tag_id, file_id)
                        VALUES (
                            (SELECT hash_tag_id FROM hash_tag WHERE hash_tag = ?),
                            ?
                        );`
                    );
                    for (const hashTag of self.hashTags) {
                        insertTagStmt.run(hashTag);
                        insertFileTagStmt.run(hashTag, self.fileId);
                    }
                })();

                return cb(null);
            } catch (transErr) {
                return cb(transErr);
            }
        }

        if (self.fileSha256) {
            return persistToDb(null);
        }

        if (isUpdate) {
            return cb(
                Errors.MissingParam('fileSha256 property must be set for updates!')
            );
        }

        readFile(self.filePath, (err, data) => {
            if (err) {
                return persistToDb(err);
            }

            const sha256 = crypto.createHash('sha256');
            sha256.update(data);
            self.fileSha256 = sha256.digest('hex');
            return persistToDb(null);
        });
    }

    static getAreaStorageDirectoryByTag(storageTag) {
        const config = Config();
        const storageLocation = storageTag && config.fileBase.storageTags[storageTag];
        //  strip trailing /* for wildcard tags — the base dir is what we resolve to
        const normalized = (storageLocation || '').replace(/\/\*$/, '');

        //  absolute paths as-is
        if (normalized && '/' === normalized.charAt(0)) {
            return normalized;
        }

        //  relative to |areaStoragePrefix|
        return paths.join(config.fileBase.areaStoragePrefix, normalized);
    }

    get filePath() {
        const storageDir = paths.resolve(
            FileEntry.getAreaStorageDirectoryByTag(this.storageTag)
        );
        const resolved = paths.resolve(
            storageDir,
            this.relPath || '',
            this.fileName || ''
        );
        //  guard against a crafted storage_tag_rel_path escaping the storage root
        if (resolved !== storageDir && !resolved.startsWith(storageDir + paths.sep)) {
            throw new Error(`Path traversal detected for file_id ${this.fileId}`);
        }
        return resolved;
    }

    static quickCheckExistsByPath(fullPath, storageTag, relPath, cb) {
        try {
            const row = fileDb
                .prepare(
                    `SELECT COUNT() AS count
                    FROM file
                    WHERE file_name = ? AND storage_tag = ? AND storage_tag_rel_path IS ?
                    LIMIT 1;`
                )
                .get(paths.basename(fullPath), storageTag, relPath || null);
            return cb(null, row.count > 0);
        } catch (err) {
            return cb(err);
        }
    }

    static persistUserRating(fileId, userId, rating, cb) {
        try {
            fileDb
                .prepare(
                    `REPLACE INTO file_user_rating (file_id, user_id, rating)
                    VALUES (?, ?, ?);`
                )
                .run(fileId, userId, rating);
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static removeUserRatings(userId, cb) {
        try {
            fileDb
                .prepare(
                    `DELETE FROM file_user_rating
                    WHERE user_id = ?;`
                )
                .run(userId);
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static persistMetaValue(fileId, name, value, cb) {
        try {
            fileDb
                .prepare(
                    `REPLACE INTO file_meta (file_id, meta_name, meta_value)
                    VALUES (?, ?, ?);`
                )
                .run(fileId, name, coerceToText(value));
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static incrementAndPersistMetaValue(fileId, name, incrementBy, cb) {
        incrementBy = incrementBy || 1;
        try {
            fileDb
                .prepare(
                    `UPDATE file_meta
                    SET meta_value = meta_value + ?
                    WHERE file_id = ? AND meta_name = ?;`
                )
                .run(incrementBy, fileId, name);
            if (cb) {
                return cb(null);
            }
        } catch (err) {
            if (cb) {
                return cb(err);
            }
        }
    }

    loadMeta(cb) {
        try {
            for (const meta of fileDb
                .prepare(
                    `SELECT meta_name, meta_value
                    FROM file_meta
                    WHERE file_id=?;`
                )
                .iterate(this.fileId)) {
                const conv = FILE_WELL_KNOWN_META[meta.meta_name];
                this.meta[meta.meta_name] = conv
                    ? conv(meta.meta_value)
                    : meta.meta_value;
            }
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    static persistHashTag(fileId, hashTag, cb) {
        try {
            fileDb
                .prepare(`INSERT OR IGNORE INTO hash_tag (hash_tag) VALUES (?);`)
                .run(hashTag);
            fileDb
                .prepare(
                    `REPLACE INTO file_hash_tag (hash_tag_id, file_id)
                    VALUES (
                        (SELECT hash_tag_id FROM hash_tag WHERE hash_tag = ?),
                        ?
                    );`
                )
                .run(hashTag, fileId);
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    loadHashTags(cb) {
        try {
            for (const hashTag of fileDb
                .prepare(
                    `SELECT ht.hash_tag_id, ht.hash_tag
                    FROM hash_tag ht
                    WHERE ht.hash_tag_id IN (
                        SELECT hash_tag_id
                        FROM file_hash_tag
                        WHERE file_id=?
                    );`
                )
                .iterate(this.fileId)) {
                this.hashTags.add(hashTag.hash_tag);
            }
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    loadRating(cb) {
        try {
            const result = fileDb
                .prepare(
                    `SELECT AVG(fur.rating) AS avg_rating
                    FROM file_user_rating fur
                    INNER JOIN file f
                        ON f.file_id = fur.file_id
                        AND f.file_id = ?`
                )
                .get(this.fileId);
            if (result) {
                this.userRating = result.avg_rating;
            }
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    }

    setHashTags(hashTags) {
        if (_.isString(hashTags)) {
            this.hashTags = new Set(hashTags.split(/[\s,]+/));
        } else if (Array.isArray(hashTags)) {
            this.hashTags = new Set(hashTags);
        } else if (hashTags instanceof Set) {
            this.hashTags = hashTags;
        }
    }

    static get WellKnownMetaValues() {
        return Object.keys(FILE_WELL_KNOWN_META);
    }

    static getFileIdsBySha(sha, options = {}, cb) {
        //  full or partial SHA-256
        const limit = _.isNumber(options.limit) ? `LIMIT ${options.limit}` : '';
        try {
            const fileIdRows = fileDb
                .prepare(
                    `SELECT file_id
                    FROM file
                    WHERE file_sha256 LIKE '${sha}%' ${limit};`
                )
                .all();
            return cb(
                null,
                (fileIdRows || []).map(r => r.file_id)
            );
        } catch (err) {
            return cb(err);
        }
    }

    static findBySha(sha, cb) {
        FileEntry.getFileIdsBySha(sha, { limit: 2 }, (err, fileIds) => {
            if (err) {
                return cb(err);
            }

            if (!fileIds || 0 === fileIds.length) {
                return cb(Errors.DoesNotExist('No matches'));
            }

            if (fileIds.length > 1) {
                return cb(Errors.Invalid('SHA is ambiguous'));
            }

            const fileEntry = new FileEntry();
            return fileEntry.load(fileIds[0], err => {
                return cb(err, fileEntry);
            });
        });
    }

    //  Attempt to fine a file by an *existing* full path.
    //  Checkums may have changed and are not validated here.
    static findByFullPath(fullPath, cb) {
        //  first, basic by-filename lookup.
        FileEntry.findByFileNameWildcard(paths.basename(fullPath), (err, entries) => {
            if (err) {
                return cb(err);
            }
            if (!entries || !entries.length || entries.length > 1) {
                return cb(Errors.DoesNotExist('No matches'));
            }

            //  ensure the *full* path has not changed
            //  :TODO: if FS is case-insensitive, we probably want a better check here
            const possibleMatch = entries[0];
            if (possibleMatch.fullPath === fullPath) {
                return cb(null, possibleMatch);
            }

            return cb(Errors.DoesNotExist('No matches'));
        });
    }

    static findByFileNameWildcard(wc, cb) {
        //  convert any * -> % and ? -> _ for SQLite syntax - see https://www.sqlite.org/lang_expr.html
        wc = wc.replace(/\*/g, '%').replace(/\?/g, '_');

        //  Fetch all matching file rows in one query, then batch-load meta/tags/ratings
        //  to avoid N+1 queries.
        let fileRows;
        try {
            fileRows = fileDb
                .prepare(
                    `SELECT ${FILE_TABLE_MEMBERS.join(', ')}
                    FROM file
                    WHERE file_name LIKE ?`
                )
                .all(wc);
        } catch (err) {
            return cb(err);
        }

        if (!fileRows || 0 === fileRows.length) {
            return cb(Errors.DoesNotExist('No matches'));
        }

        //  build a map of fileId -> FileEntry and an IN() placeholder string
        const entriesById = new Map();
        fileRows.forEach(row => {
            const entry = new FileEntry();
            FILE_TABLE_MEMBERS.forEach(prop => {
                entry[_.camelCase(prop)] = row[prop];
            });
            entry.relPath = row.storage_tag_rel_path || null;
            entriesById.set(row.file_id, entry);
        });

        const ids = Array.from(entriesById.keys());
        const placeholders = ids.map(() => '?').join(', ');

        try {
            const metaRows = fileDb
                .prepare(
                    `SELECT file_id, meta_name, meta_value
                    FROM file_meta
                    WHERE file_id IN (${placeholders})`
                )
                .all(...ids);
            (metaRows || []).forEach(row => {
                const entry = entriesById.get(row.file_id);
                if (entry) {
                    const conv = FILE_WELL_KNOWN_META[row.meta_name];
                    entry.meta[row.meta_name] = conv
                        ? conv(row.meta_value)
                        : row.meta_value;
                }
            });

            const tagRows = fileDb
                .prepare(
                    `SELECT fht.file_id, ht.hash_tag
                    FROM file_hash_tag fht
                    JOIN hash_tag ht ON ht.hash_tag_id = fht.hash_tag_id
                    WHERE fht.file_id IN (${placeholders})`
                )
                .all(...ids);
            (tagRows || []).forEach(row => {
                const entry = entriesById.get(row.file_id);
                if (entry) {
                    entry.hashTags.add(row.hash_tag);
                }
            });

            const ratingRows = fileDb
                .prepare(
                    `SELECT file_id, AVG(rating) AS avg_rating
                    FROM file_user_rating
                    WHERE file_id IN (${placeholders})
                    GROUP BY file_id`
                )
                .all(...ids);
            (ratingRows || []).forEach(row => {
                const entry = entriesById.get(row.file_id);
                if (entry) {
                    entry.userRating = row.avg_rating;
                }
            });

            return cb(null, Array.from(entriesById.values()));
        } catch (err) {
            return cb(err);
        }
    }

    //
    //  Find file(s) by |filter|
    //
    //  - sort: sort results by any well known name, file_id, or user_rating
    //  - terms: one or more search terms to search within filenames as well
    //    as short and long descriptions. We attempt to use the FTS ability when
    //    possible, but want to allow users to search for wildcard matches in
    //    which some cases we'll use multiple LIKE queries.
    //    See _normalizeFileSearchTerms()
    //
    static findFiles(filter, cb) {
        filter = filter || {};

        let sql;
        let sqlWhere = '';
        let sqlOrderBy;
        const sqlOrderDir = 'ascending' === filter.order ? 'ASC' : 'DESC';

        if (moment.isMoment(filter.newerThanTimestamp)) {
            filter.newerThanTimestamp = getISOTimestampString(filter.newerThanTimestamp);
        }

        function getOrderByWithCast(ob) {
            if (['dl_count', 'est_release_year', 'byte_size'].indexOf(filter.sort) > -1) {
                return `ORDER BY CAST(${ob} AS INTEGER)`;
            }

            return `ORDER BY ${ob}`;
        }

        function appendWhereClause(clause) {
            if (sqlWhere) {
                sqlWhere += ' AND ';
            } else {
                sqlWhere += ' WHERE ';
            }
            sqlWhere += clause;
        }

        if (filter.sort && filter.sort.length > 0) {
            if (Object.keys(FILE_WELL_KNOWN_META).indexOf(filter.sort) > -1) {
                //  sorting via a meta value?
                sql = `SELECT DISTINCT f.file_id
                    FROM file f, file_meta m`;

                appendWhereClause(
                    `f.file_id = m.file_id AND m.meta_name = '${filter.sort}'`
                );

                sqlOrderBy = `${getOrderByWithCast('m.meta_value')} ${sqlOrderDir}`;
            } else {
                //  additional special treatment for user ratings: we need to average them
                if ('user_rating' === filter.sort) {
                    sql = `SELECT DISTINCT f.file_id,
                            (SELECT IFNULL(AVG(rating), 0) rating
                            FROM file_user_rating
                            WHERE file_id = f.file_id)
                            AS avg_rating
                        FROM file f`;

                    sqlOrderBy = `ORDER BY avg_rating ${sqlOrderDir}`;
                } else {
                    sql = `SELECT DISTINCT f.file_id
                        FROM file f`;

                    sqlOrderBy =
                        getOrderByWithCast(`f.${filter.sort}`) + ' ' + sqlOrderDir;
                }
            }
        } else {
            sql = `SELECT DISTINCT f.file_id
                FROM file f`;

            sqlOrderBy = `${getOrderByWithCast('f.file_id')} ${sqlOrderDir}`;
        }

        if (filter.areaTag && filter.areaTag.length > 0) {
            if (Array.isArray(filter.areaTag)) {
                const areaList = filter.areaTag
                    .map(t => `'${sanitizeString(t)}'`)
                    .join(', ');
                appendWhereClause(`f.area_tag IN(${areaList})`);
            } else {
                appendWhereClause(`f.area_tag = '${sanitizeString(filter.areaTag)}'`);
            }
        }

        if (filter.metaPairs && filter.metaPairs.length > 0) {
            filter.metaPairs.forEach(mp => {
                const safeName = sanitizeString(mp.name);
                if (mp.wildcards) {
                    //  convert any * -> % and ? -> _ for SQLite syntax - see https://www.sqlite.org/lang_expr.html
                    mp.value = mp.value.replace(/\*/g, '%').replace(/\?/g, '_');
                    appendWhereClause(
                        `f.file_id IN (
                            SELECT file_id
                            FROM file_meta
                            WHERE meta_name = '${safeName}' AND meta_value LIKE '${sanitizeString(
                                mp.value
                            )}'
                        )`
                    );
                } else {
                    appendWhereClause(
                        `f.file_id IN (
                            SELECT file_id
                            FROM file_meta
                            WHERE meta_name = '${safeName}' AND meta_value = '${sanitizeString(
                                mp.value
                            )}'
                        )`
                    );
                }
            });
        }

        if (filter.storageTag && filter.storageTag.length > 0) {
            appendWhereClause(`f.storage_tag='${sanitizeString(filter.storageTag)}'`);
        }

        if (filter.terms && filter.terms.length > 0) {
            const [terms, queryType] = FileEntry._normalizeFileSearchTerms(filter.terms);

            if ('fts_match' === queryType) {
                //  note the ':' in MATCH expr., see https://www.sqlite.org/cvstrac/wiki?p=FullTextIndex
                appendWhereClause(
                    `f.file_id IN (
                        SELECT rowid
                        FROM file_fts
                        WHERE file_fts MATCH ":${terms}"
                    )`
                );
            } else {
                const safeTerms = sanitizeString(terms);
                appendWhereClause(
                    `(f.file_name LIKE '${safeTerms}' OR
                    f.desc LIKE '${safeTerms}' OR
                    f.desc_long LIKE '${safeTerms}')`
                );
            }
        }

        if (_.isString(filter.fileName) && filter.fileName.length > 0) {
            const caseSensitive = _.get(filter, 'filenameCaseSensitive', false);
            const collate = caseSensitive ? '' : 'COLLATE NOCASE';
            appendWhereClause(
                `(f.file_name = '${sanitizeString(filter.fileName)}' ${collate})`
            );
        }

        //  handle e.g. 1998 -> "1998"
        if (_.isNumber(filter.tags)) {
            filter.tags = filter.tags.toString();
        }

        if (filter.tags && filter.tags.length > 0) {
            //  build list of quoted tags; filter.tags comes in as a space and/or comma separated values
            const tags = filter.tags
                .replace(/,/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .split(' ')
                .map(tag => `'${sanitizeString(tag)}'`)
                .join(',');

            appendWhereClause(
                `f.file_id IN (
                    SELECT file_id
                    FROM file_hash_tag
                    WHERE hash_tag_id IN (
                        SELECT hash_tag_id
                        FROM hash_tag
                        WHERE hash_tag IN (${tags})
                    )
                )`
            );
        }

        if (
            _.isString(filter.newerThanTimestamp) &&
            filter.newerThanTimestamp.length > 0
        ) {
            appendWhereClause(
                `DATETIME(f.upload_timestamp) > DATETIME('${filter.newerThanTimestamp}', '+1 seconds')`
            );
        }

        if (_.isNumber(filter.newerThanFileId)) {
            appendWhereClause(`f.file_id > ${filter.newerThanFileId}`);
        }

        sql += `${sqlWhere} ${sqlOrderBy}`;

        if (_.isNumber(filter.limit)) {
            sql += ` LIMIT ${filter.limit}`;
        }

        sql += ';';

        try {
            const rows = fileDb.prepare(sql).all();
            if (!rows || 0 === rows.length) {
                return cb(null, []); //  no matches
            }
            return cb(
                null,
                rows.map(r => r.file_id)
            );
        } catch (err) {
            return cb(err);
        }
    }

    static removeEntry(srcFileEntry, options, cb) {
        if (!_.isFunction(cb) && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        async.series(
            [
                function removeFromDatabase(callback) {
                    try {
                        fileDb
                            .prepare(
                                `DELETE FROM file
                                WHERE file_id = ?;`
                            )
                            .run(srcFileEntry.fileId);
                        return callback(null);
                    } catch (err) {
                        return callback(err);
                    }
                },
                function optionallyRemovePhysicalFile(callback) {
                    if (true !== options.removePhysFile) {
                        return callback(null);
                    }

                    unlink(srcFileEntry.filePath, err => {
                        return callback(err);
                    });
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    static moveEntry(srcFileEntry, destAreaTag, destStorageTag, destFileName, cb) {
        if (!cb && _.isFunction(destFileName)) {
            cb = destFileName;
            destFileName = srcFileEntry.fileName;
        }

        const srcPath = srcFileEntry.filePath;
        const dstDir = FileEntry.getAreaStorageDirectoryByTag(destStorageTag);

        if (!dstDir) {
            return cb(Errors.Invalid('Invalid storage tag'));
        }

        const dstPath = paths.join(dstDir, destFileName);

        async.series(
            [
                function movePhysFile(callback) {
                    if (srcPath === dstPath) {
                        return callback(null); //  don't need to move file, but may change areas
                    }

                    fse.move(srcPath, dstPath, err => {
                        return callback(err);
                    });
                },
                function updateDatabase(callback) {
                    try {
                        fileDb
                            .prepare(
                                `UPDATE file
                                SET area_tag = ?, file_name = ?, storage_tag = ?, storage_tag_rel_path = NULL
                                WHERE file_id = ?;`
                            )
                            .run(
                                destAreaTag,
                                destFileName,
                                destStorageTag,
                                srcFileEntry.fileId
                            );
                        return callback(null);
                    } catch (err) {
                        return callback(err);
                    }
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    static _normalizeFileSearchTerms(terms) {
        //  ensure we have reasonable input to start with
        terms = sanitizeString(terms.toString());

        //	No wildcards?
        const hasSingleCharWC = terms.indexOf('?') > -1;
        if (terms.indexOf('*') === -1 && !hasSingleCharWC) {
            return [terms, 'fts_match'];
        }

        const prepareLike = () => {
            //	Convert * and ? to SQL LIKE style
            terms = terms.replace(/\*/g, '%').replace(/\?/g, '_');
            return terms;
        };

        //	Any ? wildcards?
        if (hasSingleCharWC) {
            return [prepareLike(terms), 'like'];
        }

        const split = terms.replace(/\s+/g, ' ').split(' ');
        const useLike = split.some(term => {
            if (term.indexOf('?') > -1) {
                return true;
            }

            const wcPos = term.indexOf('*');
            if (wcPos > -1 && wcPos !== term.length - 1) {
                return true;
            }

            return false;
        });

        if (useLike) {
            return [prepareLike(terms), 'like'];
        }

        return [terms, 'fts_match'];
    }
};
