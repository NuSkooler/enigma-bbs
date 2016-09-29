/* jslint node: true */
'use strict';

const fileDb	= require('./database.js').dbs.file;
const Errors	= require('./enig_error.js').Errors;

//	deps
const async		= require('async');
const _			= require('lodash');

const FILE_TABLE_MEMBERS	= [ 
	'file_id', 'area_tag', 'file_sha1', 'file_name', 
	'desc', 'desc_long', 'upload_by_username', 'upload_timestamp' 
];

module.exports = class FileEntry {
	constructor(options) {
		options			= options || {};

		this.fileId		= options.fileId || 0;
		this.areaTag	= options.areaTag || '';
		this.meta		= {};
		this.hashTags = new Set();
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

	loadMeta(cb) {
		fileDb.each(
			`SELECT meta_name, meta_value
			FROM file_meta
			WHERE file_id=?;`,
			[ this.fileId ],
			(err, meta) => {
				if(meta) {
					this.meta[meta.meta_name] = meta.meta_value;
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

	static findFiles(criteria, cb) {
		//	:TODO: build search here - return [ fileid1, fileid2, ... ]
		//	free form
		//	areaTag
		//	tags
		//	order by
		//	sort

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

		if(criteria.areaTag) {
			appendWhereClause(`area_tag="${criteria.areaTag}"`);
		}

		if(criteria.search) {
			appendWhereClause(
				`file_id IN (
					SELECT rowid
					FROM file_fts
					WHERE file_fts MATCH "${criteria.search.replace(/"/g,'""')}"
				)`
			);
		}
		
		if(Array.isArray(criteria.hashTags)) {
			appendWhereClause(
				`file_id IN (
					SELECT file_id
					FROM file_hash_tag
					WHERE hash_tag_id IN (
						SELECT hash_tag_id
						FROM hash_tag
						WHERE hash_tag IN (${criteria.hashTags.join(',')})
					)
				)`
			);
		}

		//	:TODO: criteria.orderBy
		//	:TODO: criteria.sort

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
