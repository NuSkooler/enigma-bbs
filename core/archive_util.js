/* jslint node: true */
'use strict';

//	ENiGMA½
const Config			= require('./config.js').config;
const stringFormat		= require('./string_format.js');
const Errors			= require('./enig_error.js').Errors;
const resolveMimeType	= require('./mime_util.js').resolveMimeType;

//	base/modules
const fs		= require('graceful-fs');
const _			= require('lodash');
const pty		= require('ptyw.js');

let archiveUtil;

class Archiver {
	constructor(config) {
		this.compress	= config.compress;
		this.decompress	= config.decompress;
		this.list		= config.list;
		this.extract	= config.extract;
	}

	ok() {
		return this.canCompress() && this.canDecompress(); 
	}

	can(what) {
		if(!_.has(this, [ what, 'cmd' ]) || !_.has(this, [ what, 'args' ])) {
			return false;
		}

		return _.isString(this[what].cmd) && Array.isArray(this[what].args) && this[what].args.length > 0;
	}

	canCompress() { return this.can('compress'); }
	canDecompress() { return this.can('decompress'); }
	canList() { return this.can('list'); }	//	:TODO: validate entryMatch
	canExtract() { return this.can('extract'); }
}

module.exports = class ArchiveUtil {
	
	constructor() {
		this.archivers = {};
		this.longestSignature = 0;
	}

	//	singleton access
	static getInstance() {
		if(!archiveUtil) {
			archiveUtil = new ArchiveUtil();
			archiveUtil.init();
		}
		return archiveUtil;
	}

	init() {
		//
		//	Load configuration
		//
		if(_.has(Config, 'archives.archivers')) {
			Object.keys(Config.archives.archivers).forEach(archKey => {

				const archConfig 	= Config.archives.archivers[archKey];
				const archiver		= new Archiver(archConfig);

				if(!archiver.ok()) {
					//	:TODO: Log warning - bad archiver/config
				}

				this.archivers[archKey] = archiver;
			});
		}

		if(_.isObject(Config.fileTypes)) {
			Object.keys(Config.fileTypes).forEach(mimeType => {
				const fileType = Config.fileTypes[mimeType];
				if(fileType.sig) {
					fileType.sig 	= new Buffer(fileType.sig, 'hex');
					fileType.offset	= fileType.offset || 0;

					//	:TODO: this is broken: sig is NOT this long, it's sig.length long; offset needs to allow for -negative values as well
					const sigLen =fileType.offset + fileType.sig.length;
					if(sigLen > this.longestSignature) {
						this.longestSignature = sigLen;
					}
				}
			});
		}
	}

	getArchiver(mimeTypeOrExtension) {
		mimeTypeOrExtension = resolveMimeType(mimeTypeOrExtension);
		
		if(!mimeTypeOrExtension) {	//	lookup returns false on failure
			return;
		}

		const archiveHandler = _.get( Config, [ 'fileTypes', mimeTypeOrExtension, 'archiveHandler'] );
		if(archiveHandler) {
			return _.get( Config, [ 'archives', 'archivers', archiveHandler ] );
		}
	}
	
	haveArchiver(archType) {
		return this.getArchiver(archType) ? true : false;
	}

	detectTypeWithBuf(buf, cb) {
		//	:TODO: implement me!		
	}

	detectType(path, cb) {
		fs.open(path, 'r', (err, fd) => {
			if(err) {
				return cb(err);
			}
			
			const buf = new Buffer(this.longestSignature);
			fs.read(fd, buf, 0, buf.length, 0, (err, bytesRead) => {
				if(err) {
					return cb(err);
				}

				const archFormat = _.findKey(Config.fileTypes, fileTypeInfo => {
					if(!fileTypeInfo.sig) {
						return false;
					}

					const lenNeeded = fileTypeInfo.offset + fileTypeInfo.sig.length;

					if(bytesRead < lenNeeded) {
						return false;
					}

					const comp = buf.slice(fileTypeInfo.offset, fileTypeInfo.offset + fileTypeInfo.sig.length);
					return (fileTypeInfo.sig.equals(comp));
				});

				return cb(archFormat ? null : Errors.General('Unknown type'), archFormat);
			});			
		});
	}

	spawnHandler(proc, action, cb) {
		//	pty.js doesn't currently give us a error when things fail,
		//	so we have this horrible, horrible hack:
		let err;
		proc.once('data', d => {
			if(_.isString(d) && d.startsWith('execvp(3) failed.')) {
				err = Errors.ExternalProcess(`${action} failed: ${d.trim()}`);
			}
		});
		
		proc.once('exit', exitCode => {
			return cb(exitCode ? Errors.ExternalProcess(`${action} failed with exit code: ${exitCode}`) : err);
		});	
	}

	compressTo(archType, archivePath, files, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(Errors.Invalid(`Unknown archive type: ${archType}`));
		}

		const fmtObj = {
			archivePath	: archivePath,
			fileList	: files.join(' '),	//	:TODO: probably need same hack as extractTo here!
		};

		const args = archiver.compress.args.map( arg => stringFormat(arg, fmtObj) );

		let proc;
		try {
			proc = pty.spawn(archiver.compress.cmd, args, this.getPtyOpts());
		} catch(e) {
			return cb(e);
		}

		return this.spawnHandler(proc, 'Compression', cb);
	}

	extractTo(archivePath, extractPath, archType, fileList, cb) {
		let haveFileList;

		if(!cb && _.isFunction(fileList)) {
			cb = fileList;
			fileList = [];
			haveFileList = false;	
		} else {
			haveFileList = true;
		}

		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(Errors.Invalid(`Unknown archive type: ${archType}`));
		}

		const fmtObj = {
			archivePath		: archivePath,
			extractPath		: extractPath,
		};

		const action = haveFileList ? 'extract' : 'decompress';

		//	we need to treat {fileList} special in that it should be broken up to 0:n args
		const args = archiver[action].args.map( arg => {
			return '{fileList}' === arg ? arg : stringFormat(arg, fmtObj);
		});
		
		const fileListPos = args.indexOf('{fileList}');
		if(fileListPos > -1) {
			//	replace {fileList} with 0:n sep file list arguments
			args.splice.apply(args, [fileListPos, 1].concat(fileList));
		}

		let proc;
		try {
			proc = pty.spawn(archiver[action].cmd, args, this.getPtyOpts());
		} catch(e) {
			return cb(e);
		}

		return this.spawnHandler(proc, (haveFileList ? 'Extraction' : 'Decompression'), cb);
	}

	listEntries(archivePath, archType, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(Errors.Invalid(`Unknown archive type: ${archType}`));			
		}

		const fmtObj = {
			archivePath		: archivePath,
		};

		const args	= archiver.list.args.map( arg => stringFormat(arg, fmtObj) );
		
		let proc;
		try {
			proc = pty.spawn(archiver.list.cmd, args, this.getPtyOpts());
		} catch(e) {
			return cb(e);
		}

		let output = '';
		proc.on('data', data => {
			//	:TODO: hack for: execvp(3) failed.: No such file or directory
			
			output += data;
		});

		proc.once('exit', exitCode => {
			if(exitCode) {
				return cb(Errors.ExternalProcess(`List failed with exit code: ${exitCode}`));
			}

			const entryGroupOrder = archiver.list.entryGroupOrder || { byteSize : 1, fileName : 2 };

			const entries = [];
			const entryMatchRe = new RegExp(archiver.list.entryMatch, 'gm');
			let m;
			while((m = entryMatchRe.exec(output))) {
				entries.push({
					byteSize	: parseInt(m[entryGroupOrder.byteSize]),
					fileName	: m[entryGroupOrder.fileName].trim(),
				});
			}

			return cb(null, entries);
		});	
	}
	
	getPtyOpts() {
		return {
			//	:TODO: cwd
			name	: 'enigma-archiver',
			cols	: 80,
			rows	: 24,
			env		: process.env,	
		};
	}
};
