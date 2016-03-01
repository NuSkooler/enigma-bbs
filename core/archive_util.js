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
	
	haveArchiver(archType) {
		if(!archType) {
			return false;
		}
		
		archType = archType.toLowerCase();
		return archType in this.archivers;
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
		archType = archType.toLowerCase();		
		const archiver = this.archivers[archType];
		
		if(!archiver) {
			cb(new Error('Unknown archive type: ' + archType));
			return;
		}

		let args = _.clone(archiver.compressArgs);	//	don't much with orig
		for(let i = 0; i < args.length; ++i) {
			args[i] = args[i].format({
				archivePath	: archivePath,
				fileList	: files.join(' '),
			});
		}

		let comp = pty.spawn(archiver.compressCmd, args, {
			cols : 80,
			rows : 24,
			//	:TODO: cwd
		});

		comp.on('exit', exitCode => {
			cb(exitCode ? new Error('Compression failed with exit code: ' + exitCode) : null);
		});
	}

	extractTo(archivePath, extractPath, archType, cb) {

	}
}
