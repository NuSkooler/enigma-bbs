/* jslint node: true */
'use strict';

const fileDb				= require('./database.js').dbs.file;
const Errors				= require('./enig_error.js').Errors;
const getISOTimestampString	= require('./database.js').getISOTimestampString;
const Config				= require('./config.js').config; 

//	deps
const async					= require('async');
const _						= require('lodash');
const paths					= require('path');

const FILE_TABLE_MEMBERS	= [ 
	'file_id', 'area_tag', 'file_sha256', 'file_name', 'storage_tag',
	'desc', 'desc_long', 'upload_timestamp' 
];

const FILE_WELL_KNOWN_META = {
	//	name -> *read* converter, if any
	upload_by_username	: null,
	upload_by_user_id	: null,
	file_md5			: null,
	file_sha1			: null,
	file_crc32			: null,
	est_release_year	: (y) => parseInt(y) || new Date().getFullYear(),
	dl_count			: (d) => parseInt(d) || 0,
	byte_size			: (b) => parseInt(b) || 0,
	user_rating			: (r) => Math.min(parseInt(r) || 0, 5),
	archive_type		: null,
};

module.exports = class FileEntry {
	constructor(options) {
		options			= options || {};

		this.fileId		= options.fileId || 0;
		this.areaTag	= options.areaTag || '';
		this.meta		= options.meta || {
			//	values we always want
			user_rating	: 0,
			dl_count	: 0,
		};

		this.hashTags	= options.hashTags || new Set();
		this.fileName	= options.fileName;
		this.storageTag	= options.storageTag;
	}

	load(fileId, cb) {
		const self = this;

		async.series(
			[
				function loadBasicEntry(callback) {
					fileDb.get(
						`SELECT ${FILE_TABLE_MEMBERS.join(', ')}
						FROM file
						WHERE file_id=?
						LIMIT 1;`,
						[ fileId ],
						(err, file) => {
							if(err) {
								return callback(err);
							}

							if(!file) {
								return callback(Errors.DoesNotExist('No file is available by that ID'));
							}

							//	assign props from |file|
							FILE_TABLE_MEMBERS.forEach(prop => {
								self[_.camelCase(prop)] = file[prop];
							});

							return callback(null);
						}
					);
				},
				function loadMeta(callback) {
					return self.loadMeta(callback);
				},
				function loadHashTags(callback) {
					return self.loadHashTags(callback);
				}
			],
			err => {
				return cb(err);
			}
		);
	}

	persist(cb) {
		const self = this;

		async.series(
			[
				function startTrans(callback) {
					return fileDb.run('BEGIN;', callback);
				},
				function storeEntry(callback) {
					fileDb.run(
						`REPLACE INTO file (area_tag, file_sha256, file_name, storage_tag, desc, desc_long, upload_timestamp)
						VALUES(?, ?, ?, ?, ?, ?, ?);`,
						[ self.areaTag, self.fileSha256, self.fileName, self.storageTag, self.desc, self.descLong, getISOTimestampString() ],
						function inserted(err) {	//	use non-arrow func for 'this' scope / lastID
							if(!err) {
								self.fileId = this.lastID;
							}
							return callback(err);
						}
					);
				},
				function storeMeta(callback) {
					async.each(Object.keys(self.meta), (n, next) => {
						const v = self.meta[n];
						return FileEntry.persistMetaValue(self.fileId, n, v, next);
					}, 
					err => {
						return callback(err);
					});
				},
				function storeHashTags(callback) {
					const hashTagsArray = Array.from(self.hashTags);
					async.each(hashTagsArray, (hashTag, next) => {
						return FileEntry.persistHashTag(self.fileId, hashTag, next);
					},
					err => {
						return callback(err);
					});					
				}
			],
			err => {
				//	:TODO: Log orig err
				fileDb.run(err ? 'ROLLBACK;' : 'COMMIT;', err => {
					return cb(err);
				});
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

	static persistMetaValue(fileId, name, value, cb) {
		fileDb.run(
			`REPLACE INTO file_meta (file_id, meta_name, meta_value)
			VALUES(?, ?, ?);`,
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

	static persistHashTag(fileId, hashTag, cb) {
		fileDb.serialize( () => {
			fileDb.run(
				`INSERT OR IGNORE INTO hash_tag (hash_tag)
				VALUES (?);`, 
				[ hashTag ]
			);

			fileDb.run(
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

	setHashTags(hashTags) {
		if(_.isString(hashTags)) {
			this.hashTags = new Set(hashTags.split(/[\s,]+/));
		} else if(Array.isArray(hashTags)) {
			this.hashTags = new Set(hashTags);
		} else if(hashTags instanceof Set) {
			this.hashTags = hashTags;
		}
	}

	static getWellKnownMetaValues() { return Object.keys(FILE_WELL_KNOWN_META); }

	static findFiles(filter, cb) {
		filter = filter || {};

		let sql;
		let sqlWhere = '';
		let sqlOrderBy;
		const sqlOrderDir = 'ascending' === filter.order ? 'ASC' : 'DESC';
		
		function getOrderByWithCast(ob) {
			if( [ 'dl_count', 'user_rating', 'est_release_year', 'byte_size' ].indexOf(filter.sort) > -1 ) {
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

		if(filter.sort) {
			if(Object.keys(FILE_WELL_KNOWN_META).indexOf(filter.sort) > -1) {	//	sorting via a meta value?
				sql = 
					`SELECT f.file_id
					FROM file f, file_meta m`;

				appendWhereClause(`f.file_id = m.file_id AND m.meta_name="${filter.sort}"`);

				sqlOrderBy = `${getOrderByWithCast('m.meta_value')} ${sqlOrderDir}`;
			} else {
				sql = 
					`SELECT f.file_id, f.${filter.sort}
					FROM file f`;

				sqlOrderBy = getOrderByWithCast(`f.${filter.sort}`) +  sqlOrderDir;
			}
		} else {
			sql = 
				`SELECT f.file_id
				FROM file`;

			sqlOrderBy = `${getOrderByWithCast('f.file_id')} ${sqlOrderDir}`;
		}
	

		if(filter.areaTag) {
			appendWhereClause(`f.area_tag="${filter.areaTag}"`);
		}

		if(filter.terms) {
			appendWhereClause(
				`f.file_id IN (
					SELECT rowid
					FROM file_fts
					WHERE file_fts MATCH "${filter.terms.replace(/"/g,'""')}"
				)`
			);
		}
		
		if(filter.tags) {
			//	build list of quoted tags; filter.tags comes in as a space separated values
			const tags = filter.tags.split(' ').map( tag => `"${tag}"` ).join(',');

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

		sql += `${sqlWhere} ${sqlOrderBy};`;

		const matchingFileIds = [];
		fileDb.each(sql, (err, fileId) => {
			if(fileId) {
				matchingFileIds.push(fileId.file_id);
			}
		}, err => {
			return cb(err, matchingFileIds);
		});
	}
};
