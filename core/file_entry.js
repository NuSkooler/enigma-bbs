/* jslint node: true */
'use strict';

const fileDb				= require('./database.js').dbs.file;
const Errors				= require('./enig_error.js').Errors;
const {
	getISOTimestampString,
	sanatizeString
}							= require('./database.js');
const Config				= require('./config.js').config;

//	deps
const async					= require('async');
const _						= require('lodash');
const paths					= require('path');
const fse					= require('fs-extra');
const { unlink, readFile }	= require('graceful-fs');
const crypto				= require('crypto');
const moment				= require('moment');

const FILE_TABLE_MEMBERS	= [
	'file_id', 'area_tag', 'file_sha256', 'file_name', 'storage_tag',
	'desc', 'desc_long', 'upload_timestamp'
];

const FILE_WELL_KNOWN_META = {
	//	name -> *read* converter, if any
	upload_by_username	: null,
	upload_by_user_id	: (u) => parseInt(u) || 0,
	file_md5			: null,
	file_sha1			: null,
	file_crc32			: null,
	est_release_year	: (y) => parseInt(y) || new Date().getFullYear(),
	dl_count			: (d) => parseInt(d) || 0,
	byte_size			: (b) => parseInt(b) || 0,
	archive_type		: null,
	short_file_name		: null,	//	e.g. DOS 8.3 filename, avail in some scenarios such as TIC import
	tic_origin			: null,	//	TIC "Origin"
	tic_desc			: null,	//	TIC "Desc"
	tic_ldesc			: null,	//	TIC "Ldesc" joined by '\n'
	session_temp_dl		: (v) => parseInt(v) ? true : false,
};

module.exports = class FileEntry {
	constructor(options) {
		options			= options || {};

		this.fileId		= options.fileId || 0;
		this.areaTag	= options.areaTag || '';
		this.meta		= Object.assign( { dl_count : 0 }, options.meta);
		this.hashTags	= options.hashTags || new Set();
		this.fileName	= options.fileName;
		this.storageTag	= options.storageTag;
		this.fileSha256	= options.fileSha256;
	}

	static loadBasicEntry(fileId, dest, cb) {
		dest = dest || {};

		fileDb.get(
			`SELECT ${FILE_TABLE_MEMBERS.join(', ')}
			FROM file
			WHERE file_id=?
			LIMIT 1;`,
			[ fileId ],
			(err, file) => {
				if(err) {
					return cb(err);
				}

				if(!file) {
					return cb(Errors.DoesNotExist('No file is available by that ID'));
				}

				//	assign props from |file|
				FILE_TABLE_MEMBERS.forEach(prop => {
					dest[_.camelCase(prop)] = file[prop];
				});

				return cb(null, dest);
			}
		);
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
				}
			],
			err => {
				return cb(err);
			}
		);
	}

	persist(isUpdate, cb) {
		if(!cb && _.isFunction(isUpdate)) {
			cb = isUpdate;
			isUpdate = false;
		}

		const self = this;

		async.waterfall(
			[
				function check(callback) {
					if(isUpdate && !self.fileId) {
						return callback(Errors.Invalid('Cannot update file entry without an existing "fileId" member'));
					}
					return callback(null);
				},
				function calcSha256IfNeeded(callback) {
					if(self.fileSha256) {
						return callback(null);
					}

					if(isUpdate) {
						return callback(Errors.MissingParam('fileSha256 property must be set for updates!'));
					}

					readFile(self.filePath, (err, data) => {
						if(err) {
							return callback(err);
						}

						const sha256 = crypto.createHash('sha256');
						sha256.update(data);
						self.fileSha256 = sha256.digest('hex');
						return callback(null);
					});
				},
				function startTrans(callback) {
					return fileDb.beginTransaction(callback);
				},
				function storeEntry(trans, callback) {
					if(isUpdate) {
						trans.run(
							`REPLACE INTO file (file_id, area_tag, file_sha256, file_name, storage_tag, desc, desc_long, upload_timestamp)
							VALUES(?, ?, ?, ?, ?, ?, ?, ?);`,
							[ self.fileId, self.areaTag, self.fileSha256, self.fileName, self.storageTag, self.desc, self.descLong, getISOTimestampString() ],
							err => {
								return callback(err, trans);
							}
						);
					} else {
						trans.run(
							`REPLACE INTO file (area_tag, file_sha256, file_name, storage_tag, desc, desc_long, upload_timestamp)
							VALUES(?, ?, ?, ?, ?, ?, ?);`,
							[ self.areaTag, self.fileSha256, self.fileName, self.storageTag, self.desc, self.descLong, getISOTimestampString() ],
							function inserted(err) {	//	use non-arrow func for 'this' scope / lastID
								if(!err) {
									self.fileId = this.lastID;
								}
								return callback(err, trans);
							}
						);
					}
				},
				function storeMeta(trans, callback) {
					async.each(Object.keys(self.meta), (n, next) => {
						const v = self.meta[n];
						return FileEntry.persistMetaValue(self.fileId, n, v, trans, next);
					},
					err => {
						return callback(err, trans);
					});
				},
				function storeHashTags(trans, callback) {
					const hashTagsArray = Array.from(self.hashTags);
					async.each(hashTagsArray, (hashTag, next) => {
						return FileEntry.persistHashTag(self.fileId, hashTag, trans, next);
					},
					err => {
						return callback(err, trans);
					});
				}
			],
			(err, trans) => {
				//	:TODO: Log orig err
				if(trans) {
					trans[err ? 'rollback' : 'commit'](transErr => {
						return cb(transErr ? transErr : err);
					});
				} else {
					return cb(err);
				}
			}
		);
	}

	static getAreaStorageDirectoryByTag(storageTag) {
		const storageLocation = (storageTag && Config.fileBase.storageTags[storageTag]);

		//	absolute paths as-is
		if(storageLocation && '/' === storageLocation.charAt(0)) {
			return storageLocation;
		}

		//	relative to |areaStoragePrefix|
		return paths.join(Config.fileBase.areaStoragePrefix, storageLocation || '');
	}

	get filePath() {
		const storageDir = FileEntry.getAreaStorageDirectoryByTag(this.storageTag);
		return paths.join(storageDir, this.fileName);
	}

	static quickCheckExistsByPath(fullPath, cb) {
		fileDb.get(
			`SELECT COUNT() AS count
			FROM file
			WHERE file_name = ?
			LIMIT 1;`,
			[ paths.basename(fullPath) ],
			(err, rows) => {
				return err ? cb(err) : cb(null, rows.count > 0 ? true : false);
			}
		);
	}

	static persistUserRating(fileId, userId, rating, cb) {
		return fileDb.run(
			`REPLACE INTO file_user_rating (file_id, user_id, rating)
			VALUES (?, ?, ?);`,
			[ fileId, userId, rating ],
			cb
		);
	}

	static persistMetaValue(fileId, name, value, transOrDb, cb) {
		if(!_.isFunction(cb) && _.isFunction(transOrDb)) {
			cb = transOrDb;
			transOrDb = fileDb;
		}

		return transOrDb.run(
			`REPLACE INTO file_meta (file_id, meta_name, meta_value)
			VALUES (?, ?, ?);`,
			[ fileId, name, value ],
			cb
		);
	}

	static incrementAndPersistMetaValue(fileId, name, incrementBy, cb) {
		incrementBy = incrementBy || 1;
		fileDb.run(
			`UPDATE file_meta
			SET meta_value = meta_value + ?
			WHERE file_id = ? AND meta_name = ?;`,
			[ incrementBy, fileId, name ],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	loadMeta(cb) {
		fileDb.each(
			`SELECT meta_name, meta_value
			FROM file_meta
			WHERE file_id=?;`,
			[ this.fileId ],
			(err, meta) => {
				if(meta) {
					const conv = FILE_WELL_KNOWN_META[meta.meta_name];
					this.meta[meta.meta_name] = conv ? conv(meta.meta_value) : meta.meta_value;
				}
			},
			err => {
				return cb(err);
			}
		);
	}

	static persistHashTag(fileId, hashTag, transOrDb, cb) {
		if(!_.isFunction(cb) && _.isFunction(transOrDb)) {
			cb = transOrDb;
			transOrDb = fileDb;
		}

		transOrDb.serialize( () => {
			transOrDb.run(
				`INSERT OR IGNORE INTO hash_tag (hash_tag)
				VALUES (?);`,
				[ hashTag ]
			);

			transOrDb.run(
				`REPLACE INTO file_hash_tag (hash_tag_id, file_id)
				VALUES (
					(SELECT hash_tag_id
					FROM hash_tag
					WHERE hash_tag = ?),
					?
				);`,
				[ hashTag, fileId ],
				err => {
					return cb(err);
				}
			);
		});
	}

	loadHashTags(cb) {
		fileDb.each(
			`SELECT ht.hash_tag_id, ht.hash_tag
			FROM hash_tag ht
			WHERE ht.hash_tag_id IN (
				SELECT hash_tag_id
				FROM file_hash_tag
				WHERE file_id=?
			);`,
			[ this.fileId ],
			(err, hashTag) => {
				if(hashTag) {
					this.hashTags.add(hashTag.hash_tag);
				}
			},
			err => {
				return cb(err);
			}
		);
	}

	loadRating(cb) {
		fileDb.get(
			`SELECT AVG(fur.rating) AS avg_rating
			FROM file_user_rating fur
			INNER JOIN file f
				ON f.file_id = fur.file_id
				AND f.file_id = ?`,
			[ this.fileId ],
			(err, result) => {
				if(result) {
					this.userRating = result.avg_rating;
				}
				return cb(err);
			}
		);
	}

	setHashTags(hashTags) {
		if(_.isString(hashTags)) {
			this.hashTags = new Set(hashTags.split(/[\s,]+/));
		} else if(Array.isArray(hashTags)) {
			this.hashTags = new Set(hashTags);
		} else if(hashTags instanceof Set) {
			this.hashTags = hashTags;
		}
	}

	static get WellKnownMetaValues()  {
		return Object.keys(FILE_WELL_KNOWN_META);
	}

	static findFileBySha(sha, cb) {
		//	full or partial SHA-256
		fileDb.all(
			`SELECT file_id
			FROM file
			WHERE file_sha256 LIKE "${sha}%"
			LIMIT 2;`,	//	limit 2 such that we can find if there are dupes
			(err, fileIdRows) => {
				if(err) {
					return cb(err);
				}

				if(!fileIdRows || 0 === fileIdRows.length) {
					return cb(Errors.DoesNotExist('No matches'));
				}

				if(fileIdRows.length > 1) {
					return cb(Errors.Invalid('SHA is ambiguous'));
				}

				const fileEntry = new FileEntry();
				return fileEntry.load(fileIdRows[0].file_id, err => {
					return cb(err, fileEntry);
				});
			}
		);
	}

	static findByFileNameWildcard(wc, cb) {
		//	convert any * -> % and ? -> _ for SQLite syntax - see https://www.sqlite.org/lang_expr.html
		wc = wc.replace(/\*/g, '%').replace(/\?/g, '_');

		fileDb.all(
			`SELECT file_id
			FROM file
			WHERE file_name LIKE "${wc}"
			`,
			(err, fileIdRows) => {
				if(err) {
					return cb(err);
				}

				if(!fileIdRows || 0 === fileIdRows.length) {
					return cb(Errors.DoesNotExist('No matches'));
				}

				const entries = [];
				async.each(fileIdRows, (row, nextRow) => {
					const fileEntry = new FileEntry();
					fileEntry.load(row.file_id, err => {
						if(!err) {
							entries.push(fileEntry);
						}
						return nextRow(err);
					});
				},
				err => {
					return cb(err, entries);
				});
			}
		);
	}

	static findFiles(filter, cb) {
		filter = filter || {};

		let sql;
		let sqlWhere = '';
		let sqlOrderBy;
		const sqlOrderDir = 'ascending' === filter.order ? 'ASC' : 'DESC';

		if(moment.isMoment(filter.newerThanTimestamp)) {
			filter.newerThanTimestamp = getISOTimestampString(filter.newerThanTimestamp);
		}

		function getOrderByWithCast(ob) {
			if( [ 'dl_count', 'est_release_year', 'byte_size' ].indexOf(filter.sort) > -1 ) {
				return `ORDER BY CAST(${ob} AS INTEGER)`;
			}

			return `ORDER BY ${ob}`;
		}

		function appendWhereClause(clause) {
			if(sqlWhere) {
				sqlWhere += ' AND ';
			} else {
				sqlWhere += ' WHERE ';
			}
			sqlWhere += clause;
		}

		if(filter.sort && filter.sort.length > 0) {
			if(Object.keys(FILE_WELL_KNOWN_META).indexOf(filter.sort) > -1) {	//	sorting via a meta value?
				sql =
					`SELECT DISTINCT f.file_id
					FROM file f, file_meta m`;

				appendWhereClause(`f.file_id = m.file_id AND m.meta_name = "${filter.sort}"`);

				sqlOrderBy = `${getOrderByWithCast('m.meta_value')} ${sqlOrderDir}`;
			} else {
				//	additional special treatment for user ratings: we need to average them
				if('user_rating' === filter.sort) {
					sql =
						`SELECT DISTINCT f.file_id,
							(SELECT IFNULL(AVG(rating), 0) rating 
							FROM file_user_rating 
							WHERE file_id = f.file_id)
							AS avg_rating
						FROM file f`;

					sqlOrderBy = `ORDER BY avg_rating ${sqlOrderDir}`;
				} else {
					sql =
						`SELECT DISTINCT f.file_id
						FROM file f`;

					sqlOrderBy = getOrderByWithCast(`f.${filter.sort}`) +  ' ' + sqlOrderDir;
				}
			}
		} else {
			sql =
				`SELECT DISTINCT f.file_id
				FROM file f`;

			sqlOrderBy = `${getOrderByWithCast('f.file_id')} ${sqlOrderDir}`;
		}

		if(filter.areaTag && filter.areaTag.length > 0) {
			if(Array.isArray(filter.areaTag)) {
				const areaList = filter.areaTag.map(t => `"${t}"`).join(', ');
				appendWhereClause(`f.area_tag IN(${areaList})`);
			} else {
				appendWhereClause(`f.area_tag = "${filter.areaTag}"`);
			}
		}

		if(filter.metaPairs && filter.metaPairs.length > 0) {

			filter.metaPairs.forEach(mp => {
				if(mp.wildcards) {
					//	convert any * -> % and ? -> _ for SQLite syntax - see https://www.sqlite.org/lang_expr.html
					mp.value = mp.value.replace(/\*/g, '%').replace(/\?/g, '_');
					appendWhereClause(
						`f.file_id IN (
							SELECT file_id 
							FROM file_meta 
							WHERE meta_name = "${mp.name}" AND meta_value LIKE "${mp.value}"
						)`
					);
				} else {
					appendWhereClause(
						`f.file_id IN (
							SELECT file_id 
							FROM file_meta 
							WHERE meta_name = "${mp.name}" AND meta_value = "${mp.value}"
						)`
					);
				}
			});
		}

		if(filter.storageTag && filter.storageTag.length > 0) {
			appendWhereClause(`f.storage_tag="${filter.storageTag}"`);
		}

		if(filter.terms && filter.terms.length > 0) {
			//	note the ':' in MATCH expr., see https://www.sqlite.org/cvstrac/wiki?p=FullTextIndex
			appendWhereClause(
				`f.file_id IN (
					SELECT rowid
					FROM file_fts
					WHERE file_fts MATCH ":${sanatizeString(filter.terms)}"
				)`
			);
		}

		if(filter.tags && filter.tags.length > 0) {
			//	build list of quoted tags; filter.tags comes in as a space and/or comma separated values
			const tags = filter.tags.replace(/,/g, ' ').replace(/\s{2,}/g, ' ').split(' ').map( tag => `"${sanatizeString(tag)}"` ).join(',');

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

		if(_.isString(filter.newerThanTimestamp) && filter.newerThanTimestamp.length > 0) {
			appendWhereClause(`DATETIME(f.upload_timestamp) > DATETIME("${filter.newerThanTimestamp}", "+1 seconds")`);
		}

		if(_.isNumber(filter.newerThanFileId)) {
			appendWhereClause(`f.file_id > ${filter.newerThanFileId}`);
		}

		sql += `${sqlWhere} ${sqlOrderBy}`;

		if(_.isNumber(filter.limit)) {
			sql += ` LIMIT ${filter.limit}`;
		}

		sql += ';';

		fileDb.all(sql, (err, rows) => {
			if(err) {
				return cb(err);
			}
			if(!rows || 0 === rows.length) {
				return cb(null, []);	//	no matches
			}
			return cb(null, rows.map(r => r.file_id));
		});
	}

	static removeEntry(srcFileEntry, options, cb) {
		if(!_.isFunction(cb) && _.isFunction(options)) {
			cb = options;
			options = {};
		}

		async.series(
			[
				function removeFromDatabase(callback) {
					fileDb.run(
						`DELETE FROM file
						WHERE file_id = ?;`,
						[ srcFileEntry.fileId ],
						err => {
							return callback(err);
						}
					);
				},
				function optionallyRemovePhysicalFile(callback) {
					if(true !== options.removePhysFile) {
						return callback(null);
					}

					unlink(srcFileEntry.filePath, err => {
						return callback(err);
					});
				}
			],
			err => {
				return cb(err);
			}
		);
	}

	static moveEntry(srcFileEntry, destAreaTag, destStorageTag, destFileName, cb) {
		if(!cb && _.isFunction(destFileName)) {
			cb = destFileName;
			destFileName = srcFileEntry.fileName;
		}

		const srcPath	= srcFileEntry.filePath;
		const dstDir	= FileEntry.getAreaStorageDirectoryByTag(destStorageTag);

		if(!dstDir) {
			return cb(Errors.Invalid('Invalid storage tag'));
		}

		const dstPath	= paths.join(dstDir, destFileName);

		async.series(
			[
				function movePhysFile(callback) {
					if(srcPath === dstPath) {
						return callback(null);	//	don't need to move file, but may change areas
					}

					fse.move(srcPath, dstPath, err => {
						return callback(err);
					});
				},
				function updateDatabase(callback) {
					fileDb.run(
						`UPDATE file
						SET area_tag = ?, file_name = ?, storage_tag = ?
						WHERE file_id = ?;`,
						[ destAreaTag, destFileName, destStorageTag, srcFileEntry.fileId ],
						err => {
							return callback(err);
						}
					);
				}
			],
			err => {
				return cb(err);
			}
		);
	}
};
