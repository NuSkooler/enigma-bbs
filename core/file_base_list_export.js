/* jslint node: true */
'use strict';

//	ENiGMA½
const stringFormat		= require('./string_format.js');
const FileEntry			= require('./file_entry.js');
const FileArea			= require('./file_base_area.js');
const Config			= require('./config.js').config;
const { Errors }		= require('./enig_error.js');
const {
	splitTextAtTerms,
	isAnsi,
}						= require('./string_util.js');
const AnsiPrep			= require('./ansi_prep.js');

//	deps
const _					= require('lodash');
const async				= require('async');
const fs				= require('graceful-fs');
const paths				= require('path');
const iconv				= require('iconv-lite');
const moment			= require('moment');

module.exports = function exportFileList(filterCriteria, options, cb) {
	options.templateEncoding	= options.templateEncoding || 'utf8';
	options.headerTemplate 		= options.headerTemplate || 'description_export_header_template.asc';
	options.entryTemplate		= options.entryTemplate || 'descripion_export_entry_template.asc';
	options.tsFormat			= options.tsFormat || 'YYYY-MM-DD';
	options.descWidth			= options.descWidth || 45;	//	FILE_ID.DIZ spec

	const state = {
		total	: 0,
		current	: 0,
		step	: 'preparing',
		status	: 'Preparing',
	};

	const updateProgress = _.isFunction(options.progress) ?
		progCb => {
			return options.progress(state, progCb);
		} :
		progCb => {
			return progCb(null);
		}
		;

	async.waterfall(
		[
			function readTemplateFiles(callback) {
				updateProgress(err => {
					if(err) {
						return callback(err);
					}

					const templateFiles = [ options.headerTemplate, options.entryTemplate ];
					async.map(templateFiles, (template, nextTemplate) => {
						template = paths.isAbsolute(template) ? template : paths.join(Config.paths.misc, template);

						fs.readFile(template, (err, data) => {
							return nextTemplate(err, data);
						});
					}, (err, templates) => {
						if(err) {
							return Errors.General(err.message);
						}

						//	decode + ensure DOS style CRLF
						templates = templates.map(tmp => iconv.decode(tmp, options.templateEncoding).replace(/\r?\n/g, '\r\n') );

						//	Look for the first {fileDesc} (if any) in 'entry' template & find indentation requirements
						let descIndent = 0;
						splitTextAtTerms(templates[1]).some(line => {
							const pos = line.indexOf('{fileDesc}');
							if(pos > -1) {
								descIndent = pos;
								return true;	//	found it!
							}
							return false;	//	keep looking
						});

						return callback(null, templates[0], templates[1], descIndent);
					});
				});
			},
			function findFiles(headerTemplate, entryTemplate, descIndent, callback) {
				state.step		= 'gathering';
				state.status	= 'Gathering files for supplied criteria';
				updateProgress(err => {
					if(err) {
						return callback(err);
					}

					FileEntry.findFiles(filterCriteria, (err, fileIds) => {
						if(0 === fileIds.length) {
							return callback(Errors.General('No results for criteria', 'NORESULTS'));
						}

						return callback(err, headerTemplate, entryTemplate, descIndent, fileIds);
					});
				});
			},
			function buildListEntries(headerTemplate, entryTemplate, descIndent, fileIds, callback) {
				const formatObj = {
					totalFileCount	: fileIds.length,
				};

				let current		= 0;
				let listBody	= '';
				const totals	= { fileCount : fileIds.length, bytes : 0 };
				state.total		= fileIds.length;

				state.step		= 'file';

				async.eachSeries(fileIds, (fileId, nextFileId) => {
					const fileInfo = new FileEntry();
					current += 1;

					fileInfo.load(fileId, err => {
						if(err) {
							return nextFileId(null);	//	failed, but try the next
						}

						totals.bytes += fileInfo.meta.byte_size;

						const appendFileInfo = () => {
							listBody += stringFormat(entryTemplate, formatObj);

							state.current	= current;
							state.status	= `Processing ${fileInfo.fileName}`;
							state.fileInfo	= formatObj;

							updateProgress(err => {
								return nextFileId(err);
							});
						};

						const area = FileArea.getFileAreaByTag(fileInfo.areaTag);

						formatObj.fileId		= fileId;
						formatObj.areaName		= _.get(area, 'name') || 'N/A';
						formatObj.areaDesc		= _.get(area, 'desc') || 'N/A';
						formatObj.userRating	= fileInfo.userRating || 0;
						formatObj.fileName		= fileInfo.fileName;
						formatObj.fileSize		= fileInfo.meta.byte_size;
						formatObj.fileDesc		= fileInfo.desc || '';
						formatObj.fileDescShort	= formatObj.fileDesc.slice(0, options.descWidth);
						formatObj.fileSha256	= fileInfo.fileSha256;
						formatObj.fileCrc32		= fileInfo.meta.file_crc32;
						formatObj.fileMd5		= fileInfo.meta.file_md5;
						formatObj.fileSha1		= fileInfo.meta.file_sha1;
						formatObj.uploadBy		= fileInfo.meta.upload_by_username || 'N/A';
						formatObj.fileUploadTs	= moment(fileInfo.uploadTimestamp).format(options.tsFormat);
						formatObj.fileHashTags	= fileInfo.hashTags.size > 0 ? Array.from(fileInfo.hashTags).join(', ') : 'N/A';
						formatObj.currentFile	= current;
						formatObj.progress		= Math.floor( (current / fileIds.length) * 100 );

						if(isAnsi(fileInfo.desc)) {
							AnsiPrep(
								fileInfo.desc,
								{
									cols			: Math.min(options.descWidth, 79 - descIndent),
									forceLineTerm	: true,				//	ensure each line is term'd
									asciiMode		: true,				//	export to ASCII
									fillLines		: false,			//	don't fill up to |cols|
									indent			: descIndent,
								},
								(err, desc) => {
									if(desc) {
										formatObj.fileDesc = desc;
									}
									return appendFileInfo();
								}
							);
						} else {
							const indentSpc = descIndent > 0 ? ' '.repeat(descIndent) : '';
							formatObj.fileDesc = splitTextAtTerms(formatObj.fileDesc).join(`\r\n${indentSpc}`) + '\r\n';
							return appendFileInfo();
						}
					});
				}, err => {
					return callback(err, listBody, headerTemplate, totals);
				});
			},
			function buildHeader(listBody, headerTemplate, totals, callback) {
				//	header is built last such that we can have totals/etc.

				let filterAreaName;
				let filterAreaDesc;
				if(filterCriteria.areaTag) {
					const area 		= FileArea.getFileAreaByTag(filterCriteria.areaTag);
					filterAreaName	= _.get(area, 'name') || 'N/A';
					filterAreaDesc	= _.get(area, 'desc') || 'N/A';
				} else {
					filterAreaName	= '-ALL-';
					filterAreaDesc	= 'All areas';
				}

				const headerFormatObj = {
					nowTs			: moment().format(options.tsFormat),
					boardName		: Config.general.boardName,
					totalFileCount	: totals.fileCount,
					totalFileSize	: totals.bytes,
					filterAreaTag	: filterCriteria.areaTag || '-ALL-',
					filterAreaName	: filterAreaName,
					filterAreaDesc	: filterAreaDesc,
					filterTerms		: filterCriteria.terms || '(none)',
					filterHashTags	: filterCriteria.tags || '(none)',
				};

				listBody = stringFormat(headerTemplate, headerFormatObj) + listBody;
				return callback(null, listBody);
			},
			function done(listBody, callback) {
				delete state.fileInfo;
				state.step 		= 'finished';
				state.status	= 'Finished processing';
				updateProgress( () => {
					return callback(null, listBody);
				});
			}
		], (err, listBody) => {
			return cb(err, listBody);
		}
	);
};
