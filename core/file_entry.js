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
	'file_id', 'area_tag', 'file_sha1', 'file_name', 'storage_tag',
	'desc', 'desc_long', 'upload_timestamp' 
];

const FILE_WELL_KNOWN_META = {
	//	name -> *read* converter, if any
	upload_by_username	: null,
	upload_by_user_id	: null,
	file_md5			: null,
	file_sha256			: null,
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
						`REPLACE INTO file (area_tag, file_sha1, file_name, storage_tag, desc, desc_long, upload_timestamp)
						VALUES(?, ?, ?, ?, ?, ?, ?);`,
						[ self.areaTag, self.fileSha1, self.fileName, self.storageTag, self.desc, self.descLong, getISOTimestampString() ],
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
					return callback(null);
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

	static getWellKnownMetaValues() { return Object.keys(FILE_WELL_KNOWN_META); }

	static findFiles(filter, cb) {
		//	:TODO: build search here - return [ fileid1, fileid2, ... ]
		//	free form
		//	areaTag
		//	tags
		//	order by
		//	sort

		filter = filter || {};

		let sql = 
			`SELECT file_id
			FROM file`;

		let sqlWhere = '';

		function appendWhereClause(clause) {
			if(sqlWhere) {
				sqlWhere += ' AND ';
			} else {
				sqlWhere += ' WHERE ';
			}
			sqlWhere += clause;
		}

		if(filter.areaTag) {
			appendWhereClause(`area_tag="${filter.areaTag}"`);
		}

		if(filter.terms) {
			appendWhereClause(
				`file_id IN (
					SELECT rowid
					FROM file_fts
					WHERE file_fts MATCH "${filter.terms.replace(/"/g,'""')}"
				)`
			);
		}
		
		if(filter.tags) {
			const tags = filter.tags.split(' ');	//	filter stores as sep separated values

			appendWhereClause(
				`file_id IN (
					SELECT file_id
					FROM file_hash_tag
					WHERE hash_tag_id IN (
						SELECT hash_tag_id
						FROM hash_tag
						WHERE hash_tag IN (${tags.join(',')})
					)
				)`
			);
		}

		//	:TODO: filter.orderBy
		//	:TODO: filter.sort

		sql += sqlWhere + ';';
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
