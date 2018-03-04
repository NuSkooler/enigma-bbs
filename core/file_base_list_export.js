/* jslint node: true */
'use strict';

//	ENiGMA½
const { MenuModule }	= require('./menu_module.js');
const stringFormat		= require('./string_format.js');
const FileEntry			= require('./file_entry.js');
const FileArea			= require('./file_base_area.js');
const Config			= require('./config.js').config;
const { Errors }		= require('./enig_error.js');
const {
	splitTextAtTerms,
	isAnsi,
	renderSubstr
}						= require('./string_util.js');
const AnsiPrep			= require('./ansi_prep.js');
const Events			= require('./events.js');
const Log				= require('./logger.js').log;
const DownloadQueue		= require('./download_queue.js');

//	deps
const _					= require('lodash');
const async				= require('async');
const fs				= require('graceful-fs');
const fse				= require('fs-extra');
const paths				= require('path');
const iconv				= require('iconv-lite');
const moment			= require('moment');
const uuidv4			= require('uuid/v4');
const yazl				= require('yazl');

/*
	Module config block can contain the following:
	templateEncoding	- encoding of template files (utf8)
	tsFormat			- timestamp format (theme 'short')
	descWidth			- max desc width (45)
	progBarChar			- progress bar character (▒)
	compressThreshold	- threshold to kick in comrpession for lists (1.44 MiB)
	templates			- object containing:
		header			- filename of header template (misc/file_list_header.asc)
		entry			- filename of entry template (misc/file_list_entry.asc)

	Header template variables:
	nowTs, boardName, totalFileCount, totalFileSize,
	filterAreaTag, filterAreaName, filterAreaDesc,
	filterTerms, filterHashTags

	Entry template variables:
	fileId, areaName, areaDesc, userRating, fileName,
	fileSize, fileDesc, fileDescShort, fileSha256, fileCrc32,
	fileMd5, fileSha1, uploadBy, fileUploadTs, fileHashTags,
	currentFile, progress,
*/

exports.moduleInfo = {
	name	: 'File Base List Export',
	desc	: 'Exports file base listings for download',
	author	: 'NuSkooler',
};

const FormIds = {
	main	: 0,
};

const MciViewIds = {
	main : {
		status				: 1,
		progressBar			: 2,

		customRangeStart	: 10,
	}
};

const TEMPLATE_KEYS = [	//	config.templates.*
	'header', 'entry',
];

exports.getModule = class FileBaseListExport extends MenuModule {

	constructor(options) {
		super(options);
		this.config = Object.assign({}, _.get(options, 'menuConfig.config'), options.extraArgs);

		this.config.templateEncoding	= this.config.templateEncoding || 'utf8';
		this.config.tsFormat			= this.config.tsFormat || this.client.currentTheme.helpers.getDateTimeFormat('short');
		this.config.descWidth			= this.config.descWidth || 45;	//	ie FILE_ID.DIZ
		this.config.progBarChar			= renderSubstr( (this.config.progBarChar || '▒'), 0, 1);
		this.config.compressThreshold	= this.config.compressThreshold || (1440000);	//	>= 1.44M by default :)
	}

	mciReady(mciData, cb) {
		super.mciReady(mciData, err => {
			if(err) {
				return cb(err);
			}

			async.series(
				[
					(callback) => this.prepViewController('main', FormIds.main, mciData.menu, callback),
					(callback) => this.prepareList(callback),
				],
				err => {
					if(err) {
						if('NORESULTS' === err.reasonCode) {
							return this.gotoMenu(this.menuConfig.config.noResultsMenu || 'fileBaseExportListNoResults');
						}

						return this.prevMenu();
					}
					return cb(err);
				}
			);
		});
	}

	finishedLoading() {
		this.prevMenu();
	}

	prepareList(cb) {
		const self = this;

		const statusView = self.viewControllers.main.getView(MciViewIds.main.status);
		const updateStatus = (status) => {
			if(statusView) {
				statusView.setText(status);
			}
		};

		const progBarView = self.viewControllers.main.getView(MciViewIds.main.progressBar);
		const updateProgressBar = (curr, total) => {
			if(progBarView) {
				const prog = Math.floor( (curr / total) * progBarView.dimens.width );
				progBarView.setText(self.config.progBarChar.repeat(prog));
			}
		};

		async.waterfall(
			[
				function readTemplateFiles(callback) {
					updateStatus('Preparing');

					async.map(TEMPLATE_KEYS, (templateKey, nextKey) => {
						let templatePath = _.get(self.config, [ 'templates', templateKey ]);
						templatePath = templatePath || `file_list_${templateKey}.asc`;
						templatePath = paths.isAbsolute(templatePath) ? templatePath : paths.join(Config.paths.misc, templatePath);

						fs.readFile(templatePath, (err, data) => {
							return nextKey(err, data);
						});
					}, (err, templates) => {
						if(err) {
							return Errors.General(err.message);
						}

						//	decode + ensure DOS style CRLF
						templates = templates.map(tmp => iconv.decode(tmp, self.config.templateEncoding).replace(/\r?\n/g, '\r\n') );

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
				},
				function findFiles(headerTemplate, entryTemplate, descIndent, callback) {
					const filterCriteria = Object.assign({}, self.config.filterCriteria);
					if(!filterCriteria.areaTag) {
						filterCriteria.areaTag = FileArea.getAvailableFileAreaTags(self.client);
					}

					updateStatus('Gathering files for supplied criteria');

					FileEntry.findFiles(filterCriteria, (err, fileIds) => {
						if(0 === fileIds.length) {
							return callback(Errors.General('No results for criteria', 'NORESULTS'));
						}

						return callback(err, headerTemplate, entryTemplate, descIndent, fileIds);
					});
				},
				function buildListEntries(headerTemplate, entryTemplate, descIndent, fileIds, callback) {
					const formatObj = {
						totalFileCount	: fileIds.length,
					};

					let current = 0;
					let listBody = '';
					const totals = { fileCount : fileIds.length, bytes : 0 };

					//	this may take quite a while; temp disable of idle monitor
					self.client.stopIdleMonitor();

					async.eachSeries(fileIds, (fileId, nextFileId) => {
						const fileInfo = new FileEntry();
						current += 1;

						fileInfo.load(fileId, err => {
							if(err) {
								return nextFileId(null);	//	failed, but try the next
							}

							updateStatus(`Processing ${fileInfo.fileName}`);

							totals.bytes += fileInfo.meta.byte_size;

							updateProgressBar(current, fileIds.length);

							const appendFileInfo = () => {
								listBody += stringFormat(entryTemplate, formatObj);

								self.updateCustomViewTextsWithFilter('main', MciViewIds.main.customRangeStart, formatObj);

								return nextFileId(null);
							};

							const area = FileArea.getFileAreaByTag(fileInfo.areaTag);

							formatObj.fileId		= fileId;
							formatObj.areaName		= _.get(area, 'name') || 'N/A';
							formatObj.areaDesc		= _.get(area, 'desc') || 'N/A';
							formatObj.userRating	= fileInfo.userRating || 0;
							formatObj.fileName		= fileInfo.fileName;
							formatObj.fileSize		= fileInfo.meta.byte_size;
							formatObj.fileDesc		= fileInfo.desc || '';
							formatObj.fileDescShort	= formatObj.fileDesc.slice(0, self.config.descWidth);
							formatObj.fileSha256	= fileInfo.fileSha256;
							formatObj.fileCrc32		= fileInfo.meta.file_crc32;
							formatObj.fileMd5		= fileInfo.meta.file_md5;
							formatObj.fileSha1		= fileInfo.meta.file_sha1;
							formatObj.uploadBy		= fileInfo.meta.upload_by_username || 'N/A';
							formatObj.fileUploadTs	= moment(fileInfo.uploadTimestamp).format(self.config.tsFormat);
							formatObj.fileHashTags	= fileInfo.hashTags.size > 0 ? Array.from(fileInfo.hashTags).join(', ') : 'N/A';
							formatObj.currentFile	= current;
							formatObj.progress		= Math.floor( (current / fileIds.length) * 100 );

							if(isAnsi(fileInfo.desc)) {
								AnsiPrep(
									fileInfo.desc,
									{
										cols			: Math.min(self.config.descWidth, 79 - descIndent),
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
						//	re-enable idle monitor
						self.client.startIdleMonitor();

						return callback(err, listBody, headerTemplate, totals);
					});
				},
				function buildHeader(listBody, headerTemplate, totals, callback) {
					//	header is built last such that we can have totals/etc.

					let filterAreaName;
					let filterAreaDesc;
					if(self.config.filterCriteria.areaTag) {
						const area 		= FileArea.getFileAreaByTag(self.config.filterCriteria.areaTag);
						filterAreaName	= _.get(area, 'name') || 'N/A';
						filterAreaDesc	= _.get(area, 'desc') || 'N/A';
					} else {
						filterAreaName	= '-ALL-';
						filterAreaDesc	= 'All areas';
					}

					const headerFormatObj = {
						nowTs			: moment().format(self.config.tsFormat),
						boardName		: Config.general.boardName,
						totalFileCount	: totals.fileCount,
						totalFileSize	: totals.bytes,
						filterAreaTag	: self.config.filterCriteria.areaTag || '-ALL-',
						filterAreaName	: filterAreaName,
						filterAreaDesc	: filterAreaDesc,
						filterTerms		: self.config.filterCriteria.terms || '(none)',
						filterHashTags	: self.config.filterCriteria.tags || '(none)',
					};

					listBody = stringFormat(headerTemplate, headerFormatObj) + listBody;
					return callback(null, listBody);
				},
				function persistList(listBody, callback) {

					updateStatus('Persisting list');

					const sysTempDownloadArea	= FileArea.getFileAreaByTag(FileArea.WellKnownAreaTags.TempDownloads);
					const sysTempDownloadDir	= FileArea.getAreaDefaultStorageDirectory(sysTempDownloadArea);

					fse.mkdirs(sysTempDownloadDir, err => {
						if(err) {
							return callback(err);
						}

						const outputFileName = paths.join(
							sysTempDownloadDir,
							`file_list_${uuidv4().substr(-8)}_${moment().format('YYYY-MM-DD')}.txt`
						);

						fs.writeFile(outputFileName, listBody, 'utf8', err => {
							if(err) {
								return callback(err);
							}

							self.getSizeAndCompressIfMeetsSizeThreshold(outputFileName, (err, finalOutputFileName, fileSize) => {
								return callback(err, finalOutputFileName, fileSize, sysTempDownloadArea);
							});
						});
					});
				},
				function persistFileEntry(outputFileName, fileSize, sysTempDownloadArea, callback) {
					const newEntry = new FileEntry({
						areaTag		: sysTempDownloadArea.areaTag,
						fileName	: paths.basename(outputFileName),
						storageTag	: sysTempDownloadArea.storageTags[0],
						meta		: {
							upload_by_username	: self.client.user.username,
							upload_by_user_id	: self.client.user.userId,
							byte_size			: fileSize,
							session_temp_dl		: 1,	//	download is valid until session is over
						}
					});

					newEntry.desc = 'File List Export';

					newEntry.persist(err => {
						if(!err) {
							//	queue it!
							const dlQueue = new DownloadQueue(self.client);
							dlQueue.add(newEntry);

							//	clean up after ourselves when the session ends
							const thisClientId = self.client.session.id;
							Events.once(Events.getSystemEvents().ClientDisconnected, evt => {
								if(thisClientId === _.get(evt, 'client.session.id')) {
									FileEntry.removeEntry(newEntry, { removePhysFile : true }, err => {
										if(err) {
											Log.warn( { fileId : newEntry.fileId, path : outputFileName }, 'Failed removing temporary session download' );
										} else {
											Log.debug( { fileId : newEntry.fileId, path : outputFileName }, 'Removed temporary session download item' );
										}
									});
								}
							});
						}
						return callback(err);
					});
				},
				function done(callback) {
					updateStatus('Exported list has been added to your download queue');
					return callback(null);
				}
			], err => {
				return cb(err);
			}
		);
	}

	getSizeAndCompressIfMeetsSizeThreshold(filePath, cb) {
		fse.stat(filePath, (err, stats) => {
			if(err) {
				return cb(err);
			}

			if(stats.size < this.config.compressThreshold) {
				//	small enough, keep orig
				return cb(null, filePath, stats.size);
			}

			const zipFilePath = `${filePath}.zip`;

			const zipFile = new yazl.ZipFile();
			zipFile.addFile(filePath, paths.basename(filePath));
			zipFile.end( () => {
				const outZipFile = fs.createWriteStream(zipFilePath);
				zipFile.outputStream.pipe(outZipFile);
				zipFile.outputStream.on('finish', () => {
					//	delete the original
					fse.unlink(filePath, err => {
						if(err) {
							return cb(err);
						}

						//	finally stat the new output
						fse.stat(zipFilePath, (err, stats) => {
							return cb(err, zipFilePath, stats ? stats.size : 0);
						});
					});
				});
			});
		});
	}
};