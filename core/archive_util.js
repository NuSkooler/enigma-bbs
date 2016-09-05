/* jslint node: true */
'use strict';

//	ENiGMA½
const Config		= require('./config.js').config;
const stringFormat	= require('./string_format.js');

//	base/modules
const fs		= require('fs');
const _			= require('lodash');
const pty		= require('ptyw.js');

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

		let args = _.clone(archiver.compressArgs);	//	don't muck with orig
		for(let i = 0; i < args.length; ++i) {
			args[i] = stringFormat(args[i], {
				archivePath	: archivePath,
				fileList	: files.join(' '),
			});
		}

		let comp = pty.spawn(archiver.compressCmd, args, this.getPtyOpts());

		return this.spawnHandler(comp, 'Compression', cb);
	}

	extractTo(archivePath, extractPath, archType, cb) {
		const archiver = this.getArchiver(archType);
		
		if(!archiver) {
			return cb(new Error(`Unknown archive type: ${archType}`));
		}
		
		let args = _.clone(archiver.decompressArgs);	//	don't muck with orig
		for(let i = 0; i < args.length; ++i) {
			args[i] = stringFormat(args[i], {
				archivePath		: archivePath,
				extractPath		: extractPath,
			});
		}
		
		let comp = pty.spawn(archiver.decompressCmd, args, this.getPtyOpts());

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
