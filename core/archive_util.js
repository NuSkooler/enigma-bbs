/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const stringFormat = require('./string_format.js');
const Errors = require('./enig_error.js').Errors;
const resolveMimeType = require('./mime_util.js').resolveMimeType;
const Events = require('./events.js');

//  base/modules
const fs = require('graceful-fs');
const _ = require('lodash');
const pty = require('node-pty');
const paths = require('path');

let archiveUtil;

class Archiver {
    constructor(config) {
        this.compress = config.compress;
        this.decompress = config.decompress;
        this.list = config.list;
        this.extract = config.extract;
    }

    ok() {
        return this.canCompress() && this.canDecompress();
    }

    can(what) {
        if (!_.has(this, [what, 'cmd']) || !_.has(this, [what, 'args'])) {
            return false;
        }

        return (
            _.isString(this[what].cmd) &&
            Array.isArray(this[what].args) &&
            this[what].args.length > 0
        );
    }

    canCompress() {
        return this.can('compress');
    }
    canDecompress() {
        return this.can('decompress');
    }
    canList() {
        return this.can('list');
    } //  :TODO: validate entryMatch
    canExtract() {
        return this.can('extract');
    }
}

module.exports = class ArchiveUtil {
    constructor() {
        this.archivers = {};
        this.longestSignature = 0;
    }

    //  singleton access
    static getInstance(hotReload = true) {
        if (!archiveUtil) {
            archiveUtil = new ArchiveUtil();
            archiveUtil.init(hotReload);
        }
        return archiveUtil;
    }

    init(hotReload = true) {
        this.reloadConfig();
        if (hotReload) {
            Events.on(Events.getSystemEvents().ConfigChanged, () => {
                this.reloadConfig();
            });
        }
    }

    reloadConfig() {
        const config = Config();
        if (_.has(config, 'archives.archivers')) {
            Object.keys(config.archives.archivers).forEach(archKey => {
                const archConfig = config.archives.archivers[archKey];
                const archiver = new Archiver(archConfig);

                if (!archiver.ok()) {
                    //  :TODO: Log warning - bad archiver/config
                }

                this.archivers[archKey] = archiver;
            });
        }

        if (_.isObject(config.fileTypes)) {
            const updateSig = ft => {
                ft.sig = Buffer.from(ft.sig, 'hex');
                ft.offset = ft.offset || 0;

                //  :TODO: this is broken: sig is NOT this long, it's sig.length long; offset needs to allow for -negative values as well
                const sigLen = ft.offset + ft.sig.length;
                if (sigLen > this.longestSignature) {
                    this.longestSignature = sigLen;
                }
            };

            Object.keys(config.fileTypes).forEach(mimeType => {
                const fileType = config.fileTypes[mimeType];
                if (Array.isArray(fileType)) {
                    fileType.forEach(ft => {
                        if (ft.sig) {
                            updateSig(ft);
                        }
                    });
                } else if (fileType.sig) {
                    updateSig(fileType);
                }
            });
        }
    }

    getArchiver(mimeTypeOrExtension, justExtention) {
        const mimeType = resolveMimeType(mimeTypeOrExtension);

        if (!mimeType) {
            //  lookup returns false on failure
            return;
        }

        const config = Config();
        let fileType = _.get(config, ['fileTypes', mimeType]);

        if (Array.isArray(fileType)) {
            if (!justExtention) {
                //  need extention for lookup; ambiguous as-is :(
                return;
            }
            //  further refine by extention
            fileType = fileType.find(ft => justExtention === ft.ext);
        }

        if (!_.isObject(fileType)) {
            return;
        }

        if (fileType.archiveHandler) {
            return _.get(config, ['archives', 'archivers', fileType.archiveHandler]);
        }
    }

    haveArchiver(archType) {
        return this.getArchiver(archType) ? true : false;
    }

    //  :TODO: implement me:
    /*
    detectTypeWithBuf(buf, cb) {
    }
    */

    detectType(path, cb) {
        const closeFile = fd => {
            fs.close(fd, () => {
                /* sadface */
            });
        };

        fs.open(path, 'r', (err, fd) => {
            if (err) {
                return cb(err);
            }

            const buf = Buffer.alloc(this.longestSignature);
            fs.read(fd, buf, 0, buf.length, 0, (err, bytesRead) => {
                if (err) {
                    closeFile(fd);
                    return cb(err);
                }

                const archFormat = _.findKey(Config().fileTypes, fileTypeInfo => {
                    const fileTypeInfos = Array.isArray(fileTypeInfo)
                        ? fileTypeInfo
                        : [fileTypeInfo];
                    return fileTypeInfos.find(fti => {
                        if (!fti.sig || !fti.archiveHandler) {
                            return false;
                        }

                        const lenNeeded = fti.offset + fti.sig.length;

                        if (bytesRead < lenNeeded) {
                            return false;
                        }

                        const comp = buf.slice(fti.offset, fti.offset + fti.sig.length);
                        return fti.sig.equals(comp);
                    });
                });

                closeFile(fd);
                return cb(archFormat ? null : Errors.General('Unknown type'), archFormat);
            });
        });
    }

    spawnHandler(proc, action, cb) {
        //  pty.js doesn't currently give us a error when things fail,
        //  so we have this horrible, horrible hack:
        let err;
        proc.once('data', d => {
            if (_.isString(d) && d.startsWith('execvp(3) failed.')) {
                err = Errors.ExternalProcess(`${action} failed: ${d.trim()}`);
            }
        });

        proc.once('exit', exitCode => {
            return cb(
                exitCode
                    ? Errors.ExternalProcess(
                          `${action} failed with exit code: ${exitCode}`
                      )
                    : err
            );
        });
    }

    compressTo(archType, archivePath, files, workDir, cb) {
        const archiver = this.getArchiver(archType, paths.extname(archivePath));

        if (!archiver) {
            return cb(Errors.Invalid(`Unknown archive type: ${archType}`));
        }

        if (!cb && _.isFunction(workDir)) {
            cb = workDir;
            workDir = null;
        }

        const fmtObj = {
            archivePath: archivePath,
            fileList: files.join(' '), //  :TODO: probably need same hack as extractTo here!
        };

        //  :TODO: DRY with extractTo()
        const args = archiver.compress.args.map(arg => {
            return '{fileList}' === arg ? arg : stringFormat(arg, fmtObj);
        });

        const fileListPos = args.indexOf('{fileList}');
        if (fileListPos > -1) {
            //  replace {fileList} with 0:n sep file list arguments
            args.splice.apply(args, [fileListPos, 1].concat(files));
        }

        let proc;
        try {
            proc = pty.spawn(archiver.compress.cmd, args, this.getPtyOpts(workDir));
        } catch (e) {
            return cb(
                Errors.ExternalProcess(
                    `Error spawning archiver process "${
                        archiver.compress.cmd
                    }" with args "${args.join(' ')}": ${e.message}`
                )
            );
        }

        return this.spawnHandler(proc, 'Compression', cb);
    }

    extractTo(archivePath, extractPath, archType, fileList, cb) {
        let haveFileList;

        if (!cb && _.isFunction(fileList)) {
            cb = fileList;
            fileList = [];
            haveFileList = false;
        } else {
            haveFileList = true;
        }

        const archiver = this.getArchiver(archType, paths.extname(archivePath));

        if (!archiver) {
            return cb(Errors.Invalid(`Unknown archive type: ${archType}`));
        }

        const fmtObj = {
            archivePath: archivePath,
            extractPath: extractPath,
        };

        let action = haveFileList ? 'extract' : 'decompress';
        if ('extract' === action && !_.isObject(archiver[action])) {
            //  we're forced to do a full decompress
            action = 'decompress';
            haveFileList = false;
        }

        //  we need to treat {fileList} special in that it should be broken up to 0:n args
        const args = archiver[action].args.map(arg => {
            return '{fileList}' === arg ? arg : stringFormat(arg, fmtObj);
        });

        const fileListPos = args.indexOf('{fileList}');
        if (fileListPos > -1) {
            //  replace {fileList} with 0:n sep file list arguments
            args.splice.apply(args, [fileListPos, 1].concat(fileList));
        }

        let proc;
        try {
            proc = pty.spawn(archiver[action].cmd, args, this.getPtyOpts(extractPath));
        } catch (e) {
            return cb(
                Errors.ExternalProcess(
                    `Error spawning archiver process "${
                        archiver[action].cmd
                    }" with args "${args.join(' ')}": ${e.message}`
                )
            );
        }

        return this.spawnHandler(proc, haveFileList ? 'Extraction' : 'Decompression', cb);
    }

    listEntries(archivePath, archType, cb) {
        const archiver = this.getArchiver(archType, paths.extname(archivePath));

        if (!archiver) {
            return cb(Errors.Invalid(`Unknown archive type: ${archType}`));
        }

        const fmtObj = {
            archivePath: archivePath,
        };

        const args = archiver.list.args.map(arg => stringFormat(arg, fmtObj));

        let proc;
        try {
            proc = pty.spawn(archiver.list.cmd, args, this.getPtyOpts());
        } catch (e) {
            return cb(
                Errors.ExternalProcess(
                    `Error spawning archiver process "${
                        archiver.list.cmd
                    }" with args "${args.join(' ')}": ${e.message}`
                )
            );
        }

        let output = '';
        proc.onData(data => {
            //  :TODO: hack for: execvp(3) failed.: No such file or directory

            output += data;
        });

        proc.once('exit', exitCode => {
            if (exitCode) {
                return cb(
                    Errors.ExternalProcess(`List failed with exit code: ${exitCode}`)
                );
            }

            const entryGroupOrder = archiver.list.entryGroupOrder || {
                byteSize: 1,
                fileName: 2,
            };

            const entries = [];
            const entryMatchRe = new RegExp(archiver.list.entryMatch, 'gm');
            let m;
            while ((m = entryMatchRe.exec(output))) {
                entries.push({
                    byteSize: parseInt(m[entryGroupOrder.byteSize]),
                    fileName: m[entryGroupOrder.fileName].trim(),
                });
            }

            return cb(null, entries);
        });
    }

    getPtyOpts(cwd) {
        const opts = {
            name: 'enigma-archiver',
            cols: 80,
            rows: 24,
            env: process.env,
        };
        if (cwd) {
            opts.cwd = cwd;
        }
        //  :TODO: set cwd to supplied temp path if not sepcific extract
        return opts;
    }
};
