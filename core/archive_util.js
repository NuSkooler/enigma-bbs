/* jslint node: true */
'use strict';

//  ENiGMA½
const configModule = require('./config.js');
//  read per call: a module-load capture pins whichever config was installed first
const Config = () => configModule.get();
const stringFormat = require('./string_format.js');
const Errors = require('./enig_error.js').Errors;
const { resolveMimeType, findFileTypeByExtension } = require('./mime_util.js');
const Events = require('./events.js');

//  base/modules
const fs = require('graceful-fs');
const _ = require('lodash');
const pty = require('node-pty');
const paths = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream');
const zlib = require('zlib');

let archiveUtil;

function getGzipPayloadName(archivePath) {
    const name = paths.basename(archivePath);
    const payloadName = name.replace(/\.gz$/i, '');
    return !payloadName || '.' === payloadName || '..' === payloadName
        ? `${name}.contents`
        : payloadName;
}

function isTarHeader(buffer) {
    if (buffer.length < 512) {
        return false;
    }

    const header = buffer.subarray(0, 512);
    if (header.every(byte => 0 === byte)) {
        return (
            buffer.length >= 1024 && buffer.subarray(512, 1024).every(byte => 0 === byte)
        );
    }

    const checksumText = header
        .subarray(148, 156)
        .toString('ascii')
        .replace(/\0/g, ' ')
        .trim();
    if (!/^[0-7]+$/.test(checksumText)) {
        return false;
    }

    const expectedChecksum = parseInt(checksumText, 8);
    let actualChecksum = 0;
    header.forEach((byte, index) => {
        actualChecksum += index >= 148 && index < 156 ? 32 : byte;
    });
    return expectedChecksum === actualChecksum;
}

function readGzipTarHeader(archivePath, cb) {
    const input = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();
    const header = Buffer.alloc(1024);
    let headerLength = 0;
    let finished = false;

    const finish = (err, isTar) => {
        if (finished) {
            return;
        }
        finished = true;
        input.destroy();
        gunzip.destroy();
        return cb(err, isTar);
    };

    input.on('error', err => finish(err));
    gunzip.on('error', err => finish(err));
    gunzip.on('data', data => {
        const bytesToCopy = Math.min(data.length, header.length - headerLength);
        data.copy(header, headerLength, 0, bytesToCopy);
        headerLength += bytesToCopy;
        if (headerLength === header.length) {
            finish(null, isTarHeader(header));
        }
    });
    gunzip.on('end', () => finish(null, isTarHeader(header.subarray(0, headerLength))));
    input.pipe(gunzip);
}

function readGzipPayloadSize(archivePath, cb) {
    fs.stat(archivePath, (err, stats) => {
        if (err) {
            return cb(err);
        }
        if (stats.size < 4) {
            return cb(null, 0);
        }

        fs.open(archivePath, 'r', (err, fd) => {
            if (err) {
                return cb(err);
            }
            const trailer = Buffer.alloc(4);
            fs.read(fd, trailer, 0, trailer.length, stats.size - trailer.length, err => {
                fs.close(fd, () => {});
                if (err) {
                    return cb(err);
                }
                return cb(null, trailer.readUInt32LE(0));
            });
        });
    });
}

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
                //  |sig| may list alternatives, all at the same |offset|
                ft.sig = _.castArray(ft.sig).map(sig => Buffer.from(sig, 'hex'));
                ft.offset = ft.offset || 0;

                //  :TODO: allow a negative offset (from EOF) for trailer signatures
                const sigLen = ft.offset + _.max(ft.sig.map(sig => sig.length));
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
            fileType = findFileTypeByExtension(fileType, justExtention);
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

                let archFormat = _.findKey(Config().fileTypes, fileTypeInfo => {
                    const fileTypeInfos = Array.isArray(fileTypeInfo)
                        ? fileTypeInfo
                        : [fileTypeInfo];
                    return fileTypeInfos.find(fti => {
                        if (!fti.sig || !fti.archiveHandler) {
                            return false;
                        }

                        return fti.sig.some(sig => {
                            const lenNeeded = fti.offset + sig.length;
                            if (bytesRead < lenNeeded) {
                                return false;
                            }

                            return sig.equals(buf.slice(fti.offset, lenNeeded));
                        });
                    });
                });

                closeFile(fd);
                archFormat = archFormat || this.detectTypeByExtension(path);
                return cb(archFormat ? null : Errors.General('Unknown type'), archFormat);
            });
        });
    }

    //
    //  Some formats (C64 Lynx, D64) have no signature at a fixed offset. Their
    //  file types carry |ext| and no |sig|, and are only considered once no
    //  signature has matched. Listing tells whether the file really is one.
    //
    detectTypeByExtension(path) {
        const ext = paths.extname(path).toLowerCase();
        return _.findKey(Config().fileTypes, fileTypeInfo =>
            _.castArray(fileTypeInfo).some(
                fti => fti.archiveHandler && !fti.sig && fti.ext && ext === fti.ext
            )
        );
    }

    //
    //  Finds the file an extraction wrote for archive entry |entryName| in |dir|.
    //
    //  Archivers disagree on keeping an entry's path -- unzip and tar do; 7za e,
    //  unrar e and arj e flatten it -- so both places are tried. The name comes
    //  from the uploaded archive and may climb out with "..", or the archive may
    //  hold a symbolic link: only a regular file whose real path lies inside |dir|
    //  is ever returned, so nothing outside the extraction can be read through it.
    //
    static findExtractedFile(dir, entryName, cb) {
        fs.realpath(dir, (err, root) => {
            if (err) {
                return cb(err);
            }

            const candidates = _.uniq([
                paths.join(root, entryName),
                paths.join(root, paths.basename(entryName)),
            ]);

            const isInside = path => path.startsWith(root + paths.sep);

            const tryNext = index => {
                if (index >= candidates.length) {
                    return cb(
                        Errors.DoesNotExist(`No extracted file for entry "${entryName}"`)
                    );
                }

                const candidate = candidates[index];
                if (!isInside(candidate)) {
                    return tryNext(index + 1);
                }

                fs.realpath(candidate, (err, real) => {
                    if (err || !isInside(real)) {
                        return tryNext(index + 1);
                    }

                    fs.lstat(real, (err, stats) => {
                        return !err && stats.isFile()
                            ? cb(null, real)
                            : tryNext(index + 1);
                    });
                });
            };

            return tryNext(0);
        });
    }

    spawnHandler(proc, action, cb) {
        //  pty.js doesn't currently give us a error when things fail,
        //  so we have this horrible, horrible hack:
        let err;
        proc.onData(d => {
            if (_.isString(d) && d.startsWith('execvp(3) failed.')) {
                err = Errors.ExternalProcess(`${action} failed: ${d.trim()}`);
            }
        });

        proc.onExit(exitEvent => {
            return cb(
                exitEvent.exitCode
                    ? Errors.ExternalProcess(
                          `${action} failed with exit code: ${exitEvent.exitCode}`
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
        };

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

        const extractWithArchiver = () => {
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
                proc = pty.spawn(
                    archiver[action].cmd,
                    args,
                    this.getPtyOpts(extractPath)
                );
            } catch (e) {
                return cb(
                    Errors.ExternalProcess(
                        `Error spawning archiver process "${
                            archiver[action].cmd
                        }" with args "${args.join(' ')}": ${e.message}`
                    )
                );
            }

            return this.spawnHandler(
                proc,
                haveFileList ? 'Extraction' : 'Decompression',
                cb
            );
        };

        const expectedGzipName = getGzipPayloadName(archivePath);
        if (
            'application/gzip' === archType &&
            haveFileList &&
            1 === fileList.length &&
            expectedGzipName === fileList[0]
        ) {
            return readGzipTarHeader(archivePath, (err, isTar) => {
                if (err) {
                    return cb(Errors.ExternalProcess(`Gzip read failed: ${err.message}`));
                }
                if (isTar) {
                    return extractWithArchiver();
                }

                const outputPath = paths.join(extractPath, expectedGzipName);
                return fs.open(outputPath, 'wx', 0o600, (err, fd) => {
                    if (err) {
                        return cb(
                            Errors.ExternalProcess(
                                `Gzip extraction failed: ${err.message}`
                            )
                        );
                    }

                    return pipeline(
                        fs.createReadStream(archivePath),
                        zlib.createGunzip(),
                        fs.createWriteStream(outputPath, { fd: fd, autoClose: true }),
                        err => {
                            if (err) {
                                fs.unlink(outputPath, () => {});
                                return cb(
                                    Errors.ExternalProcess(
                                        `Gzip extraction failed: ${err.message}`
                                    )
                                );
                            }
                            return cb(null);
                        }
                    );
                });
            });
        }

        return extractWithArchiver();
    }

    listEntries(archivePath, archType, cb) {
        const archiver = this.getArchiver(archType, paths.extname(archivePath));

        if (!archiver) {
            return cb(Errors.Invalid(`Unknown archive type: ${archType}`));
        }

        const listWithArchiver = () => {
            const fmtObj = {
                archivePath: archivePath,
            };

            const args = archiver.list.args.map(arg => stringFormat(arg, fmtObj));

            if ('json' === archiver.list.outputFormat) {
                return this.listJsonEntries(archiver.list.cmd, args, cb);
            }

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

            proc.onExit(exitEvent => {
                if (exitEvent.exitCode) {
                    return cb(
                        Errors.ExternalProcess(
                            `List failed with exit code: ${exitEvent.exitCode}`
                        )
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
        };

        if ('application/gzip' !== archType) {
            return listWithArchiver();
        }

        return readGzipTarHeader(archivePath, (err, isTar) => {
            if (err) {
                return cb(Errors.ExternalProcess(`Gzip read failed: ${err.message}`));
            }
            if (isTar) {
                return listWithArchiver();
            }

            return readGzipPayloadSize(archivePath, (err, byteSize) => {
                if (err) {
                    return cb(Errors.ExternalProcess(`Gzip read failed: ${err.message}`));
                }
                return cb(null, [
                    {
                        byteSize: byteSize,
                        fileName: getGzipPayloadName(archivePath),
                    },
                ]);
            });
        });
    }

    //
    //  A listing in the JSON form `unarc list --json` prints:
    //  { entries : [ { name, kind, size, ... } ] }
    //
    //  It is parsed whole, so it is read without a pty: one would merge the
    //  archiver's stderr into it.
    //
    listJsonEntries(cmd, args, cb) {
        const options = { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 1000 };
        execFile(cmd, args, options, (err, stdout) => {
            if (err) {
                return cb(Errors.ExternalProcess(`List failed: ${err.message}`));
            }

            let listing;
            try {
                listing = JSON.parse(stdout);
            } catch (e) {
                return cb(Errors.Invalid(`List output is not JSON: ${e.message}`));
            }

            if (!Array.isArray(listing.entries)) {
                return cb(Errors.Invalid('List output has no entries'));
            }

            const entries = listing.entries
                .filter(entry => 'directory' !== entry.kind)
                .map(entry => ({ byteSize: entry.size, fileName: entry.name }));

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
