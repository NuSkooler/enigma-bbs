/* jslint node: true */
'use strict';

//	ENiGMA½
const Config		= require('./config.js').config;
const stringFormat	= require('./string_format.js');

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

		this.sig		= new Buffer(config.sig, 'hex');
		this.offset		= config.offset || 0;
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
	canList() { return this.can('list'); }
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
			return archiveUtil;
		}
	}

	init() {
		//
		//	Load configuration
		//
		if(_.has(Config, 'archivers')) {
			Object.keys(Config.archivers).forEach(archKey => {

				const archConfig 	= Config.archivers[archKey];
				const archiver		= new Archiver(archConfig);

				if(!archiver.ok()) {
					//	:TODO: Log warning - bad archiver/config
				}

				this.archivers[archKey] = archiver;

				if(archiver.offset + archiver.sig.length > this.longestSignature) {
					this.longestSignature = archiver.offset + archiver.sig.length;
				}
			});
		}
	}
	
	getArchiver(archType) {
		if(!archType) {
			return;
		}
		
		archType = archType.toLowerCase();
		return this.archivers[archType];
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
				cb(err);
				return;
			}
			
			let buf = new Buffer(this.longestSignature);
			fs.read(fd, buf, 0, buf.length, 0, (err, bytesRead) => {
				if(err) {
					return cb(err);
				}

				//	return first match
				const detected = _.findKey(this.archivers, arch => {
					const lenNeeded = arch.offset + arch.sig.length;
					
					if(bytesRead < lenNeeded) {
						return false;
					}

					const comp = buf.slice(arch.offset, arch.offset + arch.sig.length);
					return (arch.sig.equals(comp));
				});

				cb(detected ? null : new Error('Unknown type'), detected);
			});			
		});
	}

	spawnHandler(comp, action, cb) {
		//	pty.js doesn't currently give us a error when things fail,
		//	so we have this horrible, horrible hack:
		let err;
		comp.once('data', d => {
			if(_.isString(d) && d.startsWith('execvp(3) failed.: No such file or directory')) {
				err = new Error(`${action} failed: ${d.trim()}`);
			}
		});
		
		comp.once('exit', exitCode => {
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
			fileList	: files.join(' '),
		};

		const args = archiver.compress.args.map( arg => stringFormat(arg, fmtObj) );
		const comp = pty.spawn(archiver.compress.cmd, args, this.getPtyOpts());

		return this.spawnHandler(comp, 'Compression', cb);
	}

	extractTo(archivePath, extractPath, archType, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(new Error(`Unknown archive type: ${archType}`));
		}

		const fmtObj = {
			archivePath		: archivePath,
			extractPath		: extractPath,
		};

		const args = archiver.decompress.args.map( arg => stringFormat(arg, fmtObj) );
		const comp = pty.spawn(archiver.decompress.cmd, args, this.getPtyOpts());

		return this.spawnHandler(comp, 'Decompression', cb);
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
