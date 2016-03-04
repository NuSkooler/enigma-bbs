/* jslint node: true */
'use strict';

//	ENiGMA½
let Config		= require('./config.js').config;

//	base/modules
let fs			= require('fs');
let _			= require('lodash');
let pty			= require('ptyw.js');

module.exports = class ArchiveUtil {
	
	constructor() {
		this.archivers = {};
		this.longestSignature = 0;
	}

	init() {
		//
		//	Load configuration
		//
		if(_.has(Config, 'archivers')) {
			Object.keys(Config.archivers).forEach(archKey => {
				const arch = Config.archivers[archKey];
				if(!_.isString(arch.sig) || 
					!_.isString(arch.compressCmd) ||
					!_.isString(arch.decompressCmd) ||
					!_.isArray(arch.compressArgs) ||
					!_.isArray(arch.decompressArgs))
				{
					//	:TODO: log warning
					return;
				}

				const archiver = {
					compressCmd		: arch.compressCmd,
					compressArgs	: arch.compressArgs,
					decompressCmd	: arch.decompressCmd,
					decompressArgs	: arch.decompressArgs,
					sig				: new Buffer(arch.sig, 'hex'),
					offset			: arch.offset || 0,
				};
				
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

	detectType(path, cb) {
		fs.open(path, 'r', (err, fd) => {
			if(err) {
				cb(err);
				return;
			}
			
			let buf = new Buffer(this.longestSignature);
			fs.read(fd, buf, 0, buf.length, 0, (err, bytesRead) => {
				if(err) {
					cb(err);
					return;
				}

				//	return first match
				const detected = _.findKey(this.archivers, arch => {
					const lenNeeded = arch.offset + arch.sig.length;
					
					if(buf.length < lenNeeded) {
						return false;
					}

					const comp = buf.slice(arch.offset, arch.offset + arch.sig.length);
					return (arch.sig.equals(comp));
				});

				cb(detected ? null : new Error('Unknown type'), detected);
			});			
		});
	}

	compressTo(archType, archivePath, files, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(new Error(`Unknown archive type: ${archType}`));
		}

		let args = _.clone(archiver.compressArgs);	//	don't muck with orig
		for(let i = 0; i < args.length; ++i) {
			args[i] = args[i].format({
				archivePath	: archivePath,
				fileList	: files.join(' '),
			});
		}

		let comp = pty.spawn(archiver.compressCmd, args, this.getPtyOpts());

		comp.once('exit', exitCode => {
			cb(exitCode ? new Error(`Compression failed with exit code: ${exitCode}`) : null);
		});
	}

	extractTo(archivePath, extractPath, archType, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(new Error(`Unknown archive type: ${archType}`));
		}
		
		let args = _.clone(archiver.decompressArgs);	//	don't muck with orig
		for(let i = 0; i < args.length; ++i) {
			args[i] = args[i].format({
				archivePath		: archivePath,
				extractPath		: extractPath,
			});
		}
		
		let comp = pty.spawn(archiver.decompressCmd, args, this.getPtyOpts());
		
		comp.once('exit', exitCode => {
			cb(exitCode ? new Error(`Decompression failed with exit code: ${exitCode}`) : null);
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
}
