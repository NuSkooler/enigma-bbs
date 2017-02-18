/* jslint node: true */
'use strict';

//	ENiGMA½
const Config		= require('./config.js').config;
const stringFormat	= require('./string_format.js');
const Errors		= require('./enig_error.js').Errors;

//	base/modules
const fs		= require('fs');
const _			= require('lodash');
const pty		= require('ptyw.js');

let archiveUtil;

class Archiver {
	constructor(config) {
		this.compress	= config.compress;
		this.decompress	= config.decompress;
		this.list		= config.list;
		this.extract	= config.extract;

		/*this.sig		= new Buffer(config.sig, 'hex');
		this.offset		= config.offset || 0;*/
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

		if(_.has(Config, 'archives.formats')) {
			Object.keys(Config.archives.formats).forEach(fmtKey => {

				Config.archives.formats[fmtKey].sig = new Buffer(Config.archives.formats[fmtKey].sig, 'hex');
				Config.archives.formats[fmtKey].offset = Config.archives.formats[fmtKey].offset || 0;

				const sigLen = Config.archives.formats[fmtKey].offset + Config.archives.formats[fmtKey].sig.length; 
				if(sigLen > this.longestSignature) {
					this.longestSignature = sigLen;
				} 
			});
		}
	}
	
	/*
	getArchiver(archType) {
		if(!archType || 0 === archType.length) {
			return;
		}
		
		archType = archType.toLowerCase();
		return this.archivers[archType];
	}*/

	getArchiver(archType) {
		if(!archType || 0 === archType.length) {
			return;
		}

		if(_.has(Config, [ 'archives', 'formats', archType, 'handler' ] ) &&
			_.has(Config, [ 'archives', 'archivers', Config.archives.formats[archType].handler ] ))
		{
			return Config.archives.archivers[ Config.archives.formats[archType].handler ];
		}
	}
	
	haveArchiver(archType) {
		return this.getArchiver(archType) ? true : false;
	}

	detectTypeWithBuf(buf, cb) {
		//	:TODO: implement me!		
	}

	detectType(path, cb) {
		if(!_.has(Config, 'archives.formats')) {
			return cb(Errors.DoesNotExist('No formats configured'));
		}

		fs.open(path, 'r', (err, fd) => {
			if(err) {
				return cb(err);
			}
			
			const buf = new Buffer(this.longestSignature);
			fs.read(fd, buf, 0, buf.length, 0, (err, bytesRead) => {
				if(err) {
					return cb(err);
				}

				const archFormat = _.findKey(Config.archives.formats, archFormat => {
					const lenNeeded = archFormat.offset + archFormat.sig.length;

					if(bytesRead < lenNeeded) {
						return false;
					}

					const comp = buf.slice(archFormat.offset, archFormat.offset + archFormat.sig.length);
					return (archFormat.sig.equals(comp));
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
			if(_.isString(d) && d.startsWith('execvp(3) failed.: No such file or directory')) {
				err = new Error(`${action} failed: ${d.trim()}`);
			}
		});
		
		proc.once('exit', exitCode => {
			if(exitCode) {
				return cb(new Error(`${action} failed with exit code: ${exitCode}`));
			}
			if(err) {
				return cb(err);
			}
			return cb(null);
		});	
	}

	compressTo(archType, archivePath, files, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(new Error(`Unknown archive type: ${archType}`));
		}

		const fmtObj = {
			archivePath	: archivePath,
			fileList	: files.join(' '),	//	:TODO: probably need same hack as extractTo here!
		};

		const args = archiver.compress.args.map( arg => stringFormat(arg, fmtObj) );
		const proc = pty.spawn(archiver.compress.cmd, args, this.getPtyOpts());

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
			return cb(new Error(`Unknown archive type: ${archType}`));
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

		const proc = pty.spawn(archiver[action].cmd, args, this.getPtyOpts());

		return this.spawnHandler(proc, (haveFileList ? 'Extraction' : 'Decompression'), cb);
	}

	listEntries(archivePath, archType, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(new Error(`Unknown archive type: ${archType}`));			
		}

		const fmtObj = {
			archivePath		: archivePath,
		};

		const args	= archiver.list.args.map( arg => stringFormat(arg, fmtObj) );
		const proc	= pty.spawn(archiver.list.cmd, args, this.getPtyOpts());

		let output = '';
		proc.on('data', data => {
			//	:TODO: hack for: execvp(3) failed.: No such file or directory
			
			output += data;
		});

		proc.once('exit', exitCode => {
			if(exitCode) {
				return cb(new Error(`List failed with exit code: ${exitCode}`));
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
