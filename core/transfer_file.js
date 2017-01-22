/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule		= require('./menu_module.js').MenuModule;
const Config			= require('./config.js').config;
const stringFormat		= require('./string_format.js');
const Errors			= require('./enig_error.js').Errors;
const DownloadQueue		= require('./download_queue.js');
const StatLog			= require('./stat_log.js');
const FileEntry			= require('./file_entry.js');

//	deps
const async			= require('async');
const _				= require('lodash');
const pty			= require('ptyw.js');
const temp			= require('temp').track();	//	track() cleans up temp dir/files for us
const paths			= require('path');
const fs			= require('fs');
const fse			= require('fs-extra');

/*
	Resources

	ZModem
		* http://gallium.inria.fr/~doligez/zmodem/zmodem.txt
		* https://github.com/protomouse/synchronet/blob/master/src/sbbs3/zmodem.c
*/

exports.moduleInfo = {
	name	: 'Transfer file',
	desc	: 'Sends or receives a file(s)',
	author	: 'NuSkooler',
};

exports.getModule = class TransferFileModule extends MenuModule {
	constructor(options) {
		super(options);

		this.config = this.menuConfig.config || {};

		//
		//	Most options can be set via extraArgs or config block
		//
		if(options.extraArgs) {
			if(options.extraArgs.protocol) {
				this.protocolConfig = Config.fileTransferProtocols[options.extraArgs.protocol];
			}

			if(options.extraArgs.direction) {
				this.direction = options.extraArgs.direction;
			}

			if(options.extraArgs.sendQueue) {
				this.sendQueue = options.extraArgs.sendQueue;	
			}

			if(options.extraArgs.recvFileName) {
				this.recvFileName = options.extraArgs.recvFiles;
			}

			if(options.extraArgs.recvDirectory) {
				this.recvDirectory = options.extraArgs.recvDirectory;
			}
		} else {
			if(this.config.protocol) {
				this.protocolConfig = Config.fileTransferProtocols[this.config.protocol];
			}

			if(this.config.direction) {
				this.direction = this.config.direction;
			}

			if(this.config.sendQueue) {
				this.sendQueue = this.config.sendQueue;
			}

			if(this.config.recvFileName) {
				this.recvFileName = this.config.recvFileName;
			}

			if(this.config.recvDirectory) {
				this.recvDirectory = this.config.recvDirectory;
			}
		}

		this.protocolConfig = this.protocolConfig || Config.fileTransferProtocols.zmodem8kSz;	//	try for *something*
		this.direction		= this.direction || 'send';
		this.sendQueue		= this.sendQueue || [];

		//	Ensure sendQueue is an array of objects that contain at least a 'path' member
		this.sendQueue = this.sendQueue.map(item => {
			if(_.isString(item)) {
				return { path : item };
			} else {
				return item;
			}			
		});

		this.sentFileIds = [];
	}

	isSending() {
		return ('send' === this.direction);
	}

	restorePipeAfterExternalProc() {
		if(!this.pipeRestored) {
			this.pipeRestored = true;

			this.client.restoreDataHandler();
		}
	}

	sendFiles(cb) {
		//	:TODO: built in/native protocol support

		if(this.protocolConfig.external.supportsBatch) {
			const allFiles = this.sendQueue.map(f => f.path);
			this.executeExternalProtocolHandlerForSend(allFiles, err => {
				if(err) {
					this.client.log.warn( { files : allFiles, error : err.message }, 'Error sending file(s)' );
				} else {
					const sentFiles = [];
					this.sendQueue.forEach(f => {
						f.sent = true;
						sentFiles.push(f.path);
						
					});

					this.client.log.info( { sentFiles : sentFiles }, `Successfully sent ${sentFiles.length} file(s)` );
				}
				return cb(err);
			});
		} else {
			//	:TODO: we need to prompt between entries such that users can prepare their clients
			async.eachSeries(this.sendQueue, (queueItem, next) => {
				this.executeExternalProtocolHandlerForSend(queueItem.path, err => {
					if(err) {
						this.client.log.warn( { file : queueItem.path, error : err.message }, 'Error sending file' );
					} else {
						queueItem.sent = true;

						this.client.log.info( { sentFile : queueItem.path }, 'Successfully sent file' );
					}
					return next(err);
				});
			}, err => {				
				return cb(err);
			});
		}		
	}

	moveFileWithCollisionHandling(src, dst, cb) {
		//
		//	Move |src| -> |dst| renaming to file(1).ext, file(2).ext, etc. 
		//	in the case of collisions.
		//
		const dstPath		= paths.dirname(dst);
		const dstFileExt	= paths.extname(dst);
		const dstFileSuffix	= paths.basename(dst, dstFileExt);

		let renameIndex		= 0;
		let movedOk			= false;
		let tryDstPath;

		async.until(
			() => movedOk,	//	until moved OK
			(cb) => {
				if(0 === renameIndex) {
					//	try originally supplied path first
					tryDstPath = dst;
				} else {
					tryDstPath = paths.join(dstPath, `${dstFileSuffix}(${renameIndex})${dstFileExt}`);
				}

				fse.move(src, tryDstPath, err => {
					if(err) {
						if('EEXIST' === err.code) {
							renameIndex += 1;
							return cb(null);	//	keep trying
						}

						return cb(err);
					}

					movedOk = true;
					return cb(null, tryDstPath);
				});
			},
			(err, finalPath) => {
				return cb(err, finalPath);
			}
		);
	}

	recvFiles(cb) {
		this.executeExternalProtocolHandlerForRecv( (err, tempWorkingDir) => {
			if(err) {
				return cb(err);
			}

			this.recvFilePaths = [];

			if(this.recvFileName) {
				//	file name specified - we expect a single file in |tempWorkingDir|
				
				//	:TODO: support non-blind: Move file to dest path, add to recvFilePaths, etc.

				return cb(null);
			} else {
				//
				//	blind recv (upload) - files in |tempWorkingDir| should be named appropriately already
				//	move files to |this.recvDirectory|
				//
				fs.readdir(tempWorkingDir, (err, files) => {
					if(err) {
						return cb(err);
					}

					async.each(files, (file, nextFile) => {
						this.moveFileWithCollisionHandling(
							paths.join(tempWorkingDir, file),
							paths.join(this.recvDirectory, file),
							(err, destPath) => {
								if(err) {
									this.client.log.warn(
										{ tempWorkingDir : tempWorkingDir, recvDirectory : this.recvDirectory, file : file, error : err.message }, 
										'Failed to move upload file to destination directory'
									);
								} else {
									this.recvFilePaths.push(destPath);
								}

								return nextFile(null);	//	don't pass along err; try next
							}
						);
					}, () => {
						return cb(null);
					});
					
				});
			}
		});
	}

	pathWithTerminatingSeparator(path) {
		if(path && paths.sep !== path.charAt(path.length - 1)) {
			path = path + paths.sep;
		}
		return path;
	}

	prepAndBuildSendArgs(filePaths, cb) {
		const external		= this.protocolConfig.external;
		const externalArgs	= external[`${this.direction}Args`];
		const self			= this;
		let tempWorkingDir;

		async.waterfall(
			[
				function getTempFileListPath(callback) {
					const hasFileList = externalArgs.find(ea => (ea.indexOf('{fileListPath}') > -1) );
					if(!hasFileList) {
						temp.mkdir('enigdl-', (err, tempDir) => {
							if(err) {
								return callback(err);
							}

							tempWorkingDir = self.pathWithTerminatingSeparator(tempDir);
							return callback(null, null);
						});
					} else {
						temp.open( { prefix : 'enigdl-', suffix : '.txt' }, (err, tempFileInfo) => {
							if(err) {
								return callback(err);	//	failed to create it 
							}

							tempWorkingDir = self.pathWithTerminatingSeparator(paths.dirname(tempFileInfo.path));

							fs.write(tempFileInfo.fd, filePaths.join('\n'));
							fs.close(tempFileInfo.fd, err => {
								return callback(err, tempFileInfo.path);
							});
						});
					}
				},
				function createArgs(tempFileListPath, callback) {
					//	initial args: ignore {filePaths} as we must break that into it's own sep array items
					const args = externalArgs.map(arg => {
						return '{filePaths}' === arg ? arg : stringFormat(arg, {
							fileListPath	: tempFileListPath || '',
						});
					});

					const filePathsPos = args.indexOf('{filePaths}');
					if(filePathsPos > -1) {
						//	replace {filePaths} with 0:n individual entries in |args|
						args.splice.apply( args, [ filePathsPos, 1 ].concat(filePaths) );
					}

					return callback(null, args);
				}
			], 
			(err, args) => {
				return cb(err, args, tempWorkingDir);
			}
		);
	}

	prepAndBuildRecvArgs(cb) {
		const self = this;

		async.waterfall(
			[
				function getTempRecvPath(callback) {
					temp.mkdir('enigrcv-', (err, tempWorkingDir) => {
						tempWorkingDir = self.pathWithTerminatingSeparator(tempWorkingDir);
						return callback(err, tempWorkingDir);
					});
				},
				function createArgs(tempWorkingDir, callback) {
					const externalArgs	= self.protocolConfig.external[`${self.direction}Args`];
					const args			= externalArgs.map(arg => stringFormat(arg, {
						uploadDir		: tempWorkingDir,
						fileName		: self.recvFileName || '',
					}));

					return callback(null, args, tempWorkingDir);
				}
			],
			(err, args, tempWorkingDir) => {
				return cb(err, args, tempWorkingDir);
			}
		);
	}

	executeExternalProtocolHandler(args, tempWorkingDir, cb) {
		const external	= this.protocolConfig.external;
		const cmd		= external[`${this.direction}Cmd`];

		this.client.log.debug(
			{ cmd : cmd, args : args, tempDir : tempWorkingDir, direction : this.direction },
			'Executing external protocol'
		);

		const externalProc = pty.spawn(cmd, args, {
			cols	: this.client.term.termWidth,
			rows	: this.client.term.termHeight,
			cwd		: tempWorkingDir,				
		});

		this.client.setTemporaryDataHandler(data => {
			//	needed for things like sz/rz
			if(external.escapeTelnet) {
				const tmp = data.toString('binary').replace(/\xff{2}/g, '\xff');	//	de-escape
				externalProc.write(new Buffer(tmp, 'binary'));
			} else {
				externalProc.write(data);
			}
		});
		
		//this.client.term.output.pipe(externalProc);		

		externalProc.on('data', data => {
			//	needed for things like sz/rz
			if(external.escapeTelnet) {
				const tmp = data.toString('binary').replace(/\xff/g, '\xff\xff');	//	escape
				this.client.term.rawWrite(new Buffer(tmp, 'binary'));
			} else {
				this.client.term.rawWrite(data);
			}
		});

		externalProc.once('close', () => {
			return this.restorePipeAfterExternalProc();
		});

		externalProc.once('exit', (exitCode) => {
			this.client.log.debug( { cmd : cmd, args : args, exitCode : exitCode }, 'Process exited' );
			
			this.restorePipeAfterExternalProc();
			externalProc.removeAllListeners();

			return cb(exitCode ? Errors.ExternalProcess(`Process exited with exit code ${exitCode}`, 'EBADEXIT') : null);
		});	
	}

	executeExternalProtocolHandlerForSend(filePaths, cb) {
		if(!Array.isArray(filePaths)) {
			filePaths = [ filePaths ];
		}

		this.prepAndBuildSendArgs(filePaths, (err, args, tempWorkingDir) => {
			if(err) {
				return cb(err);
			}

			this.executeExternalProtocolHandler(args, tempWorkingDir, err => {
				return cb(err);
			});		
		});
	}

	executeExternalProtocolHandlerForRecv(cb) {
		this.prepAndBuildRecvArgs( (err, args, tempWorkingDir) => {
			if(err) {
				return cb(err);
			}

			this.executeExternalProtocolHandler(args, tempWorkingDir, err => {
				return cb(err, tempWorkingDir);
			});
		});
	}

	getMenuResult() {
		if(this.isSending()) {
			return { sentFileIds : this.sentFileIds };
		} else {
			return { recvFilePaths : this.recvFilePaths };
		}		
	}

	updateSendStats(cb) {
		let downloadBytes 	= 0;
		let downloadCount	= 0;
		let fileIds			= [];

		async.each(this.sendQueue, (queueItem, next) => {
			if(!queueItem.sent) {
				return next(null);
			}

			if(queueItem.fileId) {
				fileIds.push(queueItem.fileId);
			}

			if(_.isNumber(queueItem.byteSize)) {
				downloadCount += 1;
				downloadBytes += queueItem.byteSize;
				return next(null);
			}

			//	we just have a path - figure it out
			fs.stat(queueItem.path, (err, stats) => {
				if(err) {
					this.client.log.warn( { error : err.message, path : queueItem.path }, 'File stat failed' );
				} else {
					downloadCount += 1;
					downloadBytes += stats.size;
				}

				return next(null);
			});
		}, () => {
			//	All stats/meta currently updated via fire & forget - if this is ever a issue, we can wait for callbacks
			StatLog.incrementUserStat(this.client.user, 'dl_total_count', downloadCount);
			StatLog.incrementUserStat(this.client.user, 'dl_total_bytes', downloadBytes);
			StatLog.incrementSystemStat('dl_total_count', downloadCount);
			StatLog.incrementSystemStat('dl_total_bytes', downloadBytes);

			fileIds.forEach(fileId => {
				FileEntry.incrementAndPersistMetaValue(fileId, 'dl_count', 1);
			});
			
			return cb(null);
		});
	}
	
	updateRecvStats(cb) {
		let uploadBytes	= 0;
		let uploadCount	= 0;

		async.each(this.recvFilePaths, (filePath, next) => {
			//	we just have a path - figure it out
			fs.stat(filePath, (err, stats) => {
				if(err) {
					this.client.log.warn( { error : err.message, path : filePath }, 'File stat failed' );
				} else {
					uploadCount	+= 1;
					uploadBytes += stats.size;
				}

				return next(null);
			});
		}, () => {
			StatLog.incrementUserStat(this.client.user, 'ul_total_count', uploadCount);
			StatLog.incrementUserStat(this.client.user, 'ul_total_bytes', uploadBytes);
			StatLog.incrementSystemStat('ul_total_count', uploadCount);
			StatLog.incrementSystemStat('ul_total_bytes', uploadBytes);

			return cb(null);
		});
	}

	initSequence() {
		const self = this;

		//	:TODO: break this up to send|recv

		async.series(
			[
				function validateConfig(callback) {
					if(self.isSending()) {
						if(!Array.isArray(self.sendQueue)) {
							self.sendQueue = [ self.sendQueue ];  
						}
					}

					return callback(null);
				},
				function transferFiles(callback) {
					if(self.isSending()) {
						self.sendFiles( err => {
							if(err) {
								return callback(err);
							}

							const sentFileIds = [];
							self.sendQueue.forEach(queueItem => {
								if(queueItem.sent && queueItem.fileId) {
									sentFileIds.push(queueItem.fileId);
								}
							});

							if(sentFileIds.length > 0) {
								//	remove items we sent from the D/L queue
								const dlQueue = new DownloadQueue(self.client);
								dlQueue.removeItems(sentFileIds);

								self.sentFileIds = sentFileIds;
							}

							return callback(null);
						});
					} else {
						self.recvFiles( err => {
							return callback(err);
						});
					}
				},
				function cleanupTempFiles(callback) {
					temp.cleanup( err => {
						if(err) {
							self.client.log.warn( { error : err.message }, 'Failed to clean up temporary file/directory(s)' );
						}
						return callback(null);	//	ignore err
					});
				},
				function updateUserAndSystemStats(callback) {
					if(self.isSending()) {
						return self.updateSendStats(callback);
					} else {
						return self.updateRecvStats(callback);
					}
				}
			],
			err => {
				if(err) {
					self.client.log.warn( { error : err.message }, 'File transfer error');
				}

				return self.prevMenu();
				/*

				//	Wait for a key press - attempt to avoid issues with some terminals after xfer
				//	:TODO: display ANSI if it exists else prompt -- look @ Obv/2 for filename
				self.client.term.pipeWrite('|00|07\nTransfer(s) complete. Press a key\n');
				self.client.waitForKeyPress( () => {
					return self.prevMenu();
				});
				*/
			}
		);
	}
};
