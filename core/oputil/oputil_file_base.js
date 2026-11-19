/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode = require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes = require('./oputil_common.js').ExitCodes;
const argv = require('./oputil_common.js').argv;
const initConfigAndDatabases = require('./oputil_common.js').initConfigAndDatabases;
const getHelpFor = require('./oputil_help.js').getHelpFor;
const {
    getAreaAndStorage,
    looksLikePattern,
    getConfigPath,
    getAnswers,
    writeConfig,
} = require('./oputil_common.js');
const Errors = require('../enig_error.js').Errors;
const FileScanner = require('../file_scanner.js');
const { replaceInvisibleFormatChars } = require('../string_util.js');
const {
    AreaListFormat,
    parseAreaList,
    describeFormat,
    buildFileAreaImportRecords,
} = require('../area_import.js');

const async = require('async');
const fs = require('graceful-fs');
const paths = require('path');
const _ = require('lodash');
const moment = require('moment');
const inq = require('inquirer');
const { glob } = require('glob');
const hjson = require('hjson');
const { mkdirs } = require('fs-extra');

exports.handleFileBaseCommand = handleFileBaseCommand;

/*
	:TODO:

	Global options:
		--yes: assume yes
		--no-prompt: try to avoid user input

	Prompt for import and description before scan
		* Only after finding duplicate-by-path
		* Default to filename -> desc if auto import

*/

let fileArea; //	required during init

function finalizeEntryAndPersist(isUpdate, fileEntry, descHandler, cb) {
    async.series(
        [
            function getDescFromHandlerIfNeeded(callback) {
                if (
                    fileEntry.desc &&
                    fileEntry.descSrc != 'fileName' &&
                    fileEntry.desc.length > 0 &&
                    !argv['desc-file']
                ) {
                    return callback(null); //	we have a desc already and are NOT overriding with desc file
                }

                if (!descHandler) {
                    return callback(null); //	not much we can do!
                }

                const desc = descHandler.getDescription(fileEntry.fileName);
                if (desc) {
                    fileEntry.desc = desc;
                }
                return callback(null);
            },
            function getDescFromUserIfNeeded(callback) {
                if (fileEntry.desc && fileEntry.desc.length > 0) {
                    return callback(null);
                }

                const getDescFromFileName =
                    require('../../core/file_base_area.js').getDescFromFileName;
                const descFromFile = getDescFromFileName(fileEntry.fileName);

                if (false === argv.prompt) {
                    fileEntry.desc = descFromFile;
                    return callback(null);
                }

                const questions = [
                    {
                        name: 'desc',
                        message: `Description for ${fileEntry.fileName}:`,
                        type: 'input',
                        default: descFromFile,
                    },
                ];

                inq.prompt(questions).then(answers => {
                    fileEntry.desc = answers.desc;
                    return callback(null);
                });
            },
            function persist(callback) {
                fileEntry.persist(isUpdate, err => {
                    return callback(err);
                });
            },
        ],
        err => {
            return cb(err);
        }
    );
}

const SCAN_EXCLUDE_FILENAMES = ['DESCRIPT.ION', 'FILES.BBS', 'ALLFILES.TXT'];

function loadDescHandler(path, cb) {
    const handlerClassFromFileName = {
        'descript.ion': require('../../core/descript_ion_file.js'),
        'files.bbs': require('../../core/files_bbs_file.js'),
    }[paths.basename(path).toLowerCase()];

    if (!handlerClassFromFileName) {
        return cb(
            Errors.DoesNotExist(`No handlers registered for ${paths.basename(path)}`)
        );
    }

    handlerClassFromFileName.createFromFile(path, (err, descHandler) => {
        return cb(err, descHandler);
    });
}

//
//  Try to find a suitable description handler by
//  checking for common filenames.
//
function findSuitableDescHandler(basePath, cb) {
    const commonFiles = ['FILES.BBS', 'DESCRIPT.ION'];

    async.eachSeries(
        commonFiles,
        (fileName, nextFileName) => {
            loadDescHandler(paths.join(basePath, fileName), (err, handler) => {
                if (!err && handler) {
                    return cb(null, handler);
                }
                return nextFileName(null);
            });
        },
        () => {
            return cb(Errors.DoesNotExist('No suitable description handler available'));
        }
    );
}

function scanFileAreaForChanges(areaInfo, options, cb) {
    const storageLocations = fileArea.getAreaStorageLocations(areaInfo).filter(sl => {
        return options.areaAndStorageInfo.find(asi => {
            return !asi.storageTag || sl.storageTag === asi.storageTag;
        });
    });

    //  Option 1B: sort flat locations before wildcard so their base dirs can be
    //  registered as exclusions, preventing WC scans from duplicating those files.
    storageLocations.sort((a, b) => {
        if (a.isWildcard === b.isWildcard) {
            return 0;
        }
        return a.isWildcard ? 1 : -1; //  flat first
    });

    //  Populated as flat locations are scanned; WC scans skip files under these paths.
    const excludedDirs = new Set();

    function updateTags(fe) {
        if (Array.isArray(options.tags)) {
            fe.hashTags = new Set(options.tags);
        } else if (areaInfo.hashTags) {
            //  no explicit tags; merge in defaults, if any
            fe.hashTags = areaInfo.hashTags;
        }
    }

    const FileEntry = require('../file_entry.js');

    const ignore = require('ignore');

    //  Build an ignore filter from all .enigmaignore files found under baseDir.
    //  Rules are gitignore-style and scoped to the directory containing each file.
    function buildIgnoreFilter(baseDir, relFiles, next) {
        const ignoreFiles = relFiles.filter(rf => paths.basename(rf) === '.enigmaignore');
        if (0 === ignoreFiles.length) {
            return next(null, null);
        }
        const ig = ignore();
        let pending = ignoreFiles.length;
        let errored = false;
        ignoreFiles.forEach(ignFile => {
            const absIgnFile = paths.join(baseDir, ignFile);
            const ignDir = paths.dirname(ignFile); //  relative dir containing this .enigmaignore
            fs.readFile(absIgnFile, 'utf8', (err, content) => {
                if (errored) {
                    return;
                }
                if (!err && content) {
                    //  prefix each non-empty, non-comment rule with the containing subdir
                    content.split('\n').forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('#')) {
                            ig.add(ignDir === '.' ? trimmed : `${ignDir}/${trimmed}`);
                        }
                    });
                }
                if (0 === --pending) {
                    return next(null, ig);
                }
            });
        });
    }

    //  Produce a list of { relFile, relPath } items for a storage location.
    //  - WC tags (isWildcard): recurse all subdirs via glob
    //  - --glob option: use caller-supplied pattern (applies to both flat and WC)
    //  - flat: plain readdir
    //  In all cases relPath is the subdir relative to the storage root, or null for root-level files.
    function getFilesForLocation(storageLoc, next) {
        const pattern = options.glob || (storageLoc.isWildcard ? '**/*' : null);
        if (pattern) {
            //  include .enigmaignore files in the glob so buildIgnoreFilter can read them
            glob(pattern, { cwd: storageLoc.dir, nodir: true, follow: false })
                .then(relFiles => {
                    buildIgnoreFilter(storageLoc.dir, relFiles, (err, ig) => {
                        if (err) {
                            return next(err);
                        }
                        const filtered = relFiles
                            .filter(rf => paths.basename(rf) !== '.enigmaignore')
                            .filter(rf => !ig || !ig.ignores(rf));
                        return next(
                            null,
                            filtered.map(rf => ({
                                relFile: rf,
                                relPath:
                                    paths.dirname(rf) === '.' ? null : paths.dirname(rf),
                            })),
                            true //  fromGlob — skip stat check
                        );
                    });
                })
                .catch(err => {
                    return next(err);
                });
        } else {
            fs.readdir(storageLoc.dir, (err, fileNames) => {
                if (err) {
                    return next(err);
                }
                return next(
                    null,
                    fileNames.map(fn => ({ relFile: fn, relPath: null })),
                    false //  fromGlob
                );
            });
        }
    }

    async.eachSeries(
        storageLocations,
        (storageLoc, nextLocation) => {
            async.waterfall(
                [
                    function initDescFile(callback) {
                        if (options.descFileHandler) {
                            return callback(null, options.descFileHandler); //	we're going to use the global handler
                        }

                        findSuitableDescHandler(storageLoc.dir, (err, descHandler) => {
                            return callback(null, descHandler);
                        });
                    },
                    function scanPhysFiles(descHandler, callback) {
                        const physDir = storageLoc.dir;

                        getFilesForLocation(storageLoc, (err, fileItems, fromGlob) => {
                            if (err) {
                                return callback(err);
                            }

                            async.eachSeries(
                                fileItems,
                                ({ relFile, relPath }, nextFile) => {
                                    const fileName = paths.basename(relFile);
                                    const fullPath = paths.join(physDir, relFile);

                                    if (
                                        SCAN_EXCLUDE_FILENAMES.includes(
                                            fileName.toUpperCase()
                                        )
                                    ) {
                                        console.info(`Excluding ${fullPath}`);
                                        return nextFile(null);
                                    }

                                    //  Option 1B: skip files under any flat tag's base dir
                                    //  when scanning a WC tag — those files are owned by the
                                    //  more-specific flat tag and will be (or were) scanned directly.
                                    if (storageLoc.isWildcard && excludedDirs.size > 0) {
                                        const isExcluded = [...excludedDirs].some(
                                            excDir =>
                                                fullPath.startsWith(excDir + paths.sep)
                                        );
                                        if (isExcluded) {
                                            return nextFile(null);
                                        }
                                    }

                                    const doScan = () => {
                                        process.stdout.write(`Scanning ${fullPath}... `);

                                        async.series([
                                            function quickCheck(next) {
                                                if (options['full']) {
                                                    return next(null);
                                                }

                                                FileEntry.quickCheckExistsByPath(
                                                    fullPath,
                                                    storageLoc.storageTag,
                                                    relPath,
                                                    (err, exists) => {
                                                        if (exists) {
                                                            console.info('Dupe');
                                                            return nextFile(null);
                                                        }

                                                        return next(null);
                                                    }
                                                );
                                            },
                                            function fullScan() {
                                                const scanOpts = {
                                                    areaTag: areaInfo.areaTag,
                                                    storageTag: storageLoc.storageTag,
                                                    relPath,
                                                    hashTags: areaInfo.hashTags,
                                                };

                                                //  file (virus) scanning is opt in here
                                                if (options.virusScan) {
                                                    scanOpts.scanSource =
                                                        FileScanner.ScanSources.Oputil;
                                                }

                                                fileArea.scanFile(
                                                    fullPath,
                                                    scanOpts,
                                                    (stepInfo, next) => {
                                                        if (argv.verbose) {
                                                            if (stepInfo.error) {
                                                                console.error(
                                                                    `  error: ${stepInfo.error}`
                                                                );
                                                            } else {
                                                                console.info(
                                                                    `  processing: ${stepInfo.step}`
                                                                );
                                                            }
                                                        }
                                                        return next(null);
                                                    },
                                                    (err, fileEntry, dupeEntries) => {
                                                        if (
                                                            FileScanner.isFileRejected(
                                                                err
                                                            )
                                                        ) {
                                                            return rejectScannedFile(
                                                                fullPath,
                                                                storageLoc.storageTag,
                                                                relPath,
                                                                err,
                                                                options,
                                                                () => nextFile(null)
                                                            );
                                                        }

                                                        if (err) {
                                                            console.info(
                                                                `Error: ${err.message}`
                                                            );
                                                            return nextFile(null); //	try next anyway
                                                        }

                                                        //
                                                        //	We'll update the entry if the following conditions are met:
                                                        //	* We have a single duplicate, and:
                                                        //	* --update was passed or the existing entry's desc,
                                                        //	  longDesc, or est_release_year meta are blank/empty
                                                        //
                                                        if (
                                                            argv.update &&
                                                            1 === dupeEntries.length
                                                        ) {
                                                            const FileEntry = require('../../core/file_entry.js');
                                                            const existingEntry =
                                                                new FileEntry();

                                                            return existingEntry.load(
                                                                dupeEntries[0].fileId,
                                                                err => {
                                                                    if (err) {
                                                                        console.info(
                                                                            'Dupe (cannot update)'
                                                                        );
                                                                        return nextFile(
                                                                            null
                                                                        );
                                                                    }

                                                                    //
                                                                    //	Update only if tags or desc changed
                                                                    //
                                                                    const optTags =
                                                                        Array.isArray(
                                                                            options.tags
                                                                        )
                                                                            ? new Set(
                                                                                  options.tags
                                                                              )
                                                                            : existingEntry.hashTags;
                                                                    const tagsEq =
                                                                        _.isEqual(
                                                                            optTags,
                                                                            existingEntry.hashTags
                                                                        );

                                                                    let descSauceCompare;
                                                                    if (
                                                                        existingEntry.meta
                                                                            .desc_sauce
                                                                    ) {
                                                                        descSauceCompare =
                                                                            JSON.stringify(
                                                                                existingEntry
                                                                                    .meta
                                                                                    .desc_sauce
                                                                            );
                                                                    }

                                                                    if (
                                                                        tagsEq &&
                                                                        fileEntry.desc ===
                                                                            existingEntry.desc &&
                                                                        fileEntry.descLong ===
                                                                            existingEntry.descLong &&
                                                                        fileEntry.meta
                                                                            .est_release_year ===
                                                                            existingEntry
                                                                                .meta
                                                                                .est_release_year &&
                                                                        fileEntry.meta
                                                                            .desc_sauce ===
                                                                            descSauceCompare
                                                                    ) {
                                                                        console.info(
                                                                            'Dupe'
                                                                        );
                                                                        return nextFile(
                                                                            null
                                                                        );
                                                                    }

                                                                    console.info(
                                                                        'Dupe (updating)'
                                                                    );

                                                                    //	don't allow overwrite of values if new version is blank
                                                                    existingEntry.desc =
                                                                        fileEntry.desc ||
                                                                        existingEntry.desc;
                                                                    existingEntry.descLong =
                                                                        fileEntry.descLong ||
                                                                        existingEntry.descLong;

                                                                    if (
                                                                        fileEntry.meta
                                                                            .est_release_year
                                                                    ) {
                                                                        existingEntry.meta.est_release_year =
                                                                            fileEntry.meta.est_release_year;
                                                                    }

                                                                    if (
                                                                        fileEntry.meta
                                                                            .desc_sauce
                                                                    ) {
                                                                        existingEntry.meta.desc_sauce =
                                                                            fileEntry.meta.desc_sauce;
                                                                    }

                                                                    updateTags(
                                                                        existingEntry
                                                                    );

                                                                    finalizeEntryAndPersist(
                                                                        true,
                                                                        existingEntry,
                                                                        descHandler,
                                                                        err => {
                                                                            return nextFile(
                                                                                err
                                                                            );
                                                                        }
                                                                    );
                                                                }
                                                            );
                                                        } else if (
                                                            dupeEntries.length > 0
                                                        ) {
                                                            console.info('Dupe');
                                                            return nextFile(null);
                                                        }

                                                        console.info('Done!');
                                                        updateTags(fileEntry);

                                                        finalizeEntryAndPersist(
                                                            false,
                                                            fileEntry,
                                                            descHandler,
                                                            err => {
                                                                return nextFile(err);
                                                            }
                                                        );
                                                    }
                                                );
                                            },
                                        ]);
                                    }; //  end doScan

                                    if (fromGlob) {
                                        //  glob results are files-only; no stat needed
                                        doScan();
                                    } else {
                                        fs.stat(fullPath, (err, stats) => {
                                            if (err) {
                                                //	:TODO: Log me!
                                                return nextFile(null); //	always try next file
                                            }
                                            if (!stats.isFile()) {
                                                return nextFile(null);
                                            }
                                            doScan();
                                        });
                                    }
                                },
                                err => {
                                    return callback(err);
                                }
                            );
                        });
                    },
                    function scanDbEntries(callback) {
                        //	:TODO: Look @ db entries for area that were *not* processed above

                        //  Register flat location dirs so subsequent WC scans skip them
                        if (!storageLoc.isWildcard) {
                            excludedDirs.add(storageLoc.dir);
                        }

                        return callback(null);
                    },
                ],
                err => {
                    return nextLocation(err);
                }
            );
        },
        err => {
            return cb(err);
        }
    );
}

function dumpAreaInfo(areaInfo, areaAndStorageInfo, cb) {
    console.info(`areaTag: ${areaInfo.areaTag}`);
    console.info(`name: ${areaInfo.name}`);
    console.info(`desc: ${areaInfo.desc}`);

    areaInfo.storage.forEach(si => {
        console.info(`storageTag: ${si.storageTag} => ${si.dir}`);
    });
    console.info('');

    return cb(null);
}

function getFileEntries(pattern, cb) {
    //	spec: FILENAME_WC|FILE_ID|SHA|PARTIAL_SHA
    const FileEntry = require('../../core/file_entry.js');

    async.waterfall(
        [
            function tryByFileId(callback) {
                const fileId = parseInt(pattern);
                if (!/^[0-9]+$/.test(pattern) || isNaN(fileId)) {
                    return callback(null, null); //	try SHA
                }

                const fileEntry = new FileEntry();
                fileEntry.load(fileId, err => {
                    return callback(null, err ? null : [fileEntry]);
                });
            },
            function tryByShaOrPartialSha(entries, callback) {
                if (entries) {
                    return callback(null, entries); //	already got it by FILE_ID
                }

                FileEntry.findBySha(pattern, (err, fileEntry) => {
                    return callback(null, fileEntry ? [fileEntry] : null);
                });
            },
            function tryByFileNameWildcard(entries, callback) {
                if (entries) {
                    return callback(null, entries); //	already got by FILE_ID|SHA
                }

                return FileEntry.findByFileNameWildcard(pattern, callback);
            },
        ],
        (err, entries) => {
            return cb(err, entries);
        }
    );
}

function dumpFileInfo(shaOrFileId, cb) {
    async.waterfall(
        [
            function getEntry(callback) {
                getFileEntries(shaOrFileId, (err, entries) => {
                    if (err) {
                        return callback(err);
                    }

                    return callback(null, entries[0]);
                });
            },
            function dumpInfo(fileEntry, callback) {
                const fullPath = paths.join(
                    fileArea.getAreaStorageDirectoryByTag(fileEntry.storageTag),
                    fileEntry.fileName
                );

                console.info(`file_id: ${fileEntry.fileId}`);
                console.info(`sha_256: ${fileEntry.fileSha256}`);
                console.info(`area_tag: ${fileEntry.areaTag}`);
                console.info(`storage_tag: ${fileEntry.storageTag}`);
                console.info(`path: ${fullPath}`);
                console.info(`hashTags: ${Array.from(fileEntry.hashTags).join(', ')}`);
                console.info(`uploaded: ${moment(fileEntry.uploadTimestamp).format()}`);

                _.each(fileEntry.meta, (metaValue, metaName) => {
                    console.info(`${metaName}: ${metaValue}`);
                });

                if (argv['show-desc']) {
                    console.info(`${fileEntry.desc}`);
                }
                console.info('');

                return callback(null);
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function displayFileOrAreaInfo() {
    //	AREA_TAG[@STORAGE_TAG]
    //	SHA256|PARTIAL|FILE_ID|FILENAME_WILDCARD
    //	if sha: dump file info
    //	if area/storage dump area(s) +

    async.series(
        [
            function init(callback) {
                return initConfigAndDatabases(callback);
            },
            function dumpInfo(callback) {
                const sysConfig = require('../../core/config.js').get();
                let suppliedAreas = argv._.slice(2);
                if (!suppliedAreas || 0 === suppliedAreas.length) {
                    suppliedAreas = _.map(
                        sysConfig.fileBase.areas,
                        (areaInfo, areaTag) => areaTag
                    );
                }

                const areaAndStorageInfo = getAreaAndStorage(suppliedAreas);

                fileArea = require('../../core/file_base_area.js');

                async.eachSeries(
                    areaAndStorageInfo,
                    (areaAndStorage, nextArea) => {
                        const areaInfo = fileArea.getFileAreaByTag(
                            areaAndStorage.areaTag
                        );
                        if (areaInfo) {
                            return dumpAreaInfo(areaInfo, areaAndStorageInfo, nextArea);
                        } else {
                            return dumpFileInfo(areaAndStorage.areaTag, nextArea);
                        }
                    },
                    err => {
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            }
        }
    );
}

//
//  A file file scanning rejected: say so, put it where fileBase.scanning says
//  (quarantine or delete), and keep it for the run's one operator notice. It
//  is never imported.
//
//  It is in the storage tree, though, where a later plain "fb scan" would
//  import it unscanned, so failing to move it is loud. An infected file that
//  cannot be quarantined is deleted instead (see applyFailAction()); one
//  that cannot be deleted either fails the run. A held file -- the scanner
//  failed, so it may be clean -- is left where it is, and said to be.
//
function rejectScannedFile(fullPath, storageTag, relPath, rejectedErr, options, cb) {
    const FileEntry = require('../file_entry.js');
    const verdict = rejectedErr.verdict;
    const what =
        FileScanner.Verdicts.Infected === verdict.result
            ? `infected: ${verdict.signature || 'unnamed threat'}`
            : `held, scanner failed: ${verdict.detail || 'unknown error'}`;

    console.info(`Rejected (${verdict.scanner} ${what})`);

    //  only with --full does an existing entry get this far
    FileEntry.quickCheckExistsByPath(fullPath, storageTag, relPath, (err, exists) => {
        if (exists) {
            console.info(
                '  This file already has an entry; once it is moved the entry points at nothing. Remove it with "fb rm".'
            );
        }

        FileScanner.applyFailAction(
            fullPath,
            verdict,
            rejectedErr.scanContext,
            (err, disposition) => {
                if (err) {
                    disposition = { error: err.message, path: fullPath };
                    if (FileScanner.Verdicts.Infected === verdict.result) {
                        process.exitCode = ExitCodes.ERROR;
                        console.error(
                            `  ERROR: ${err.message}. This INFECTED file is still at ${fullPath}; remove it by hand before the next "fb scan".`
                        );
                    } else {
                        console.error(
                            `  Could not quarantine it: ${err.message}. It is still at ${fullPath}, NOT scanned; a plain "fb scan" would import it.`
                        );
                    }
                } else if (disposition.quarantineError) {
                    console.error(
                        `  Could not quarantine it (${disposition.quarantineError}); DELETED it instead`
                    );
                } else if (FileScanner.FailActions.Delete === disposition.action) {
                    console.info('  Deleted');
                } else {
                    console.info(`  Quarantined to ${disposition.path}`);
                }

                options.scanRejections.push({
                    ctx: rejectedErr.scanContext,
                    verdict,
                    disposition,
                });
                return cb(null);
            }
        );
    });
}

function scanFileAreas() {
    const options = {};

    const tags = argv.tags;
    if (tags) {
        options.tags = tags.split(',');
    }

    options.descFile = argv['desc-file']; //	--desc-file or --desc-file PATH
    options['full'] = argv.full;
    options.virusScan = true === argv['virus-scan'];
    options.scanRejections = [];

    options.areaAndStorageInfo = getAreaAndStorage(argv._.slice(2));

    const last = argv._[argv._.length - 1];
    if (options.areaAndStorageInfo.length > 1 && looksLikePattern(last)) {
        options.glob = last;
        options.areaAndStorageInfo.length -= 1;
    }

    async.series(
        [
            function init(callback) {
                return initConfigAndDatabases(callback);
            },
            function initMime(callback) {
                return require('../../core/mime_util.js').startup(callback);
            },
            function checkVirusScan(callback) {
                if (!options.virusScan) {
                    return callback(null);
                }

                if (!FileScanner.isEnabled()) {
                    return callback(
                        Errors.MissingConfig(
                            '--virus-scan needs file scanning enabled (fileBase.scanning.enabled)'
                        )
                    );
                }

                //
                //  Scanners mods provide: only their registerFileScanners()
                //  runs here, never moduleInitialize(). One still missing
                //  after that would hold every file, so refuse instead.
                //
                const modsPath = _.get(
                    require('../../core/config.js').get(),
                    'paths.mods'
                );
                FileScanner.loadModFileScanners(modsPath, err => {
                    if (err) {
                        return callback(err);
                    }

                    FileScanner.getConfigWarnings().forEach(warning => {
                        console.warn(`Warning: ${warning}`);
                    });

                    const missing = FileScanner.getUnavailableScanners(
                        FileScanner.ScanSources.Oputil
                    );
                    if (missing.length > 0) {
                        return callback(
                            Errors.MissingConfig(
                                `--virus-scan: scanner(s) not registered by any mod in ${modsPath}: ${missing.join(
                                    ', '
                                )}. Check the mod exports registerFileScanners(), leave "oputil" out of the entry's "sources", or set onError: accept.`
                            )
                        );
                    }

                    return callback(null);
                });
            },
            function initGlobalDescHandler(callback) {
                //
                //	If options.descFile is a String, it represents a FILE|PATH. We'll init
                //	the description handler now. Else, we'll attempt to look for a description
                //	file in each storage location.
                //
                if (!_.isString(options.descFile)) {
                    return callback(null);
                }

                loadDescHandler(options.descFile, (err, descHandler) => {
                    options.descFileHandler = descHandler;
                    return callback(null);
                });
            },
            function scanAreas(callback) {
                fileArea = require('../../core/file_base_area');

                //  Further expand any wildcards
                let areaAndStorageInfoExpanded = [];
                options.areaAndStorageInfo.forEach(info => {
                    if (info.areaTag.indexOf('*') > -1) {
                        const areas = fileArea.getFileAreasByTagWildcardRule(
                            info.areaTag
                        );
                        areas.forEach(area => {
                            areaAndStorageInfoExpanded.push(
                                Object.assign({}, info, {
                                    areaTag: area.areaTag,
                                })
                            );
                        });
                    } else {
                        areaAndStorageInfoExpanded.push(info);
                    }
                });

                options.areaAndStorageInfo = areaAndStorageInfoExpanded;

                async.eachSeries(
                    options.areaAndStorageInfo,
                    (areaAndStorage, nextAreaTag) => {
                        const areaInfo = fileArea.getFileAreaByTag(
                            areaAndStorage.areaTag
                        );
                        if (!areaInfo) {
                            return nextAreaTag(
                                new Error(
                                    `Invalid file base area tag: ${areaAndStorage.areaTag}`
                                )
                            );
                        }

                        console.info(`Processing area "${areaInfo.name}":`);

                        scanFileAreaForChanges(areaInfo, options, err => {
                            return nextAreaTag(err);
                        });
                    },
                    err => {
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            }

            //
            //  --virus-scan loaded every mod, and a mod may start a timer or
            //  a server just by being loaded, which would keep oputil from
            //  ever exiting. Once the notice is written and the output is
            //  flushed, exit (with process.exitCode as set).
            //
            const finished = () => {
                if (!options.virusScan) {
                    return;
                }
                process.stdout.write('', () => {
                    process.stderr.write('', () => process.exit());
                });
            };

            //  whatever stopped the run, what was rejected is reported, once
            const count = options.scanRejections.length;
            if (0 === count) {
                return finished();
            }
            console.info(
                `${count} file${1 === count ? '' : 's'} rejected by file scanning`
            );
            FileScanner.notifyOperators(
                options.scanRejections,
                { source: FileScanner.ScanSources.Oputil },
                finished
            );
        }
    );
}

//
//  Names and scanner output from the database, often from outside: no
//  control characters on the operator's terminal, and none of the invisible
//  format characters (U+202E RIGHT-TO-LEFT OVERRIDE, zero widths, ...) or
//  line and paragraph separators that would make one line read as another.
//  |maxLength| caps it, with "..." to show it was cut.
//
function consoleText(s, maxLength) {
    const text = replaceInvisibleFormatChars(
        String(_.isUndefined(s) || null === s ? '' : s).replace(
            // eslint-disable-next-line no-control-regex
            /[\x00-\x1f\x7f-\x9f]/g,
            '?'
        ),
        '?'
    );
    if (_.isFinite(maxLength) && text.length > maxLength) {
        return `${text.slice(0, maxLength)}...`;
    }
    return text;
}

//  What a remote field (an uploader's file name, a TIC origin, scanner
//  output) may take up on a listing line
const MAX_REMOTE_FIELD_CHARS = 128;
const remoteText = s => consoleText(s, MAX_REMOTE_FIELD_CHARS);

//
//  virus-scan CRITERIA: each is an area tag (simple wildcards allowed; "*" is
//  every area), AREA_TAG@STORAGE_TAG, or a file ID, SHA-256 (or the start of
//  one) or file name wildcard, as for "fb rm". An area match wins over a file
//  name wildcard. Calls back (err, { areaTags, fileIds }).
//
function resolveVirusScanCriteria(criteria, cb) {
    const FileEntry = require('../../core/file_entry.js');
    const areaTags = [];
    const fileIds = new Set();

    async.eachSeries(
        getAreaAndStorage(criteria),
        (spec, next) => {
            const areaInfo = fileArea.getFileAreaByTag(spec.areaTag);

            if (spec.storageTag) {
                if (!areaInfo) {
                    return next(
                        Errors.DoesNotExist(`No file base area "${spec.areaTag}"`)
                    );
                }
                return FileEntry.findFiles(
                    { areaTag: spec.areaTag, storageTag: spec.storageTag },
                    (err, ids) => {
                        if (err) {
                            return next(err);
                        }
                        ids.forEach(id => fileIds.add(id));
                        return next(null);
                    }
                );
            }

            if (areaInfo) {
                areaTags.push(spec.areaTag);
                return next(null);
            }

            if (
                /[*?]/.test(spec.areaTag) &&
                fileArea.getFileAreasByTagWildcardRule(spec.areaTag).length > 0
            ) {
                areaTags.push(spec.areaTag);
                return next(null);
            }

            getFileEntries(spec.pattern, (err, entries) => {
                if (err || !entries || 0 === entries.length) {
                    return next(
                        Errors.DoesNotExist(`No area or file matches "${spec.pattern}"`)
                    );
                }
                entries.forEach(e => fileIds.add(e.fileId));
                return next(null);
            });
        },
        err => cb(err, { areaTags, fileIds: Array.from(fileIds) })
    );
}

function printRescanResult(result, dryRun) {
    const Rescan = require('../../core/file_base_rescan.js');
    const R = Rescan.RescanResults;
    const v = result.verdict || {};
    let label = result.result;
    let what = '';

    switch (result.result) {
        case R.Infected:
            label = 'INFECTED';
            what = `: ${v.signature || 'unnamed threat'} (${v.scanner})`;
            break;
        case R.Held:
            what = `: could not be checked, ${v.scanner} failed: ${
                v.detail || 'unknown error'
            }`;
            break;
        case R.Missing:
            what = `: missing, ${result.path}`;
            break;
        default:
            if (v.allowlisted) {
                what = ' (allowlisted)';
            } else if (FileScanner.Verdicts.Infected === result.keptResult) {
                label = 'INFECTED';
                what = `: still marked infected (${
                    result.keptSignature || 'unnamed threat'
                }); the scanners had no opinion this time`;
            }
            break;
    }

    if (result.hashChanged) {
        what += ' (changed since import)';
    }

    let line = `  ${label.padEnd(12)}#${String(result.fileId).padEnd(6)}${consoleText(
        result.areaTag
    )}  ${consoleText(result.fileName)}${consoleText(what)}`;

    if ('INFECTED' === label && !dryRun) {
        line += `\n${' '.repeat(14)}remove with: ${Rescan.removeCommand(result.fileId)}`;
        line += `\n${' '.repeat(14)}or, if safe: ${Rescan.markSafeCommand(result.fileId)}`;
    }

    if (result.error) {
        console.error(
            `${line}${line.endsWith(':') ? '' : ':'} ${consoleText(result.error)}`
        );
    } else {
        console.info(line);
    }
}

function parseNonNegativeArg(name, integer) {
    const value = argv[name];
    if (_.isUndefined(value)) {
        return { value: undefined };
    }
    const n = Number(value);
    if (
        true === value ||
        '' === value ||
        !_.isFinite(n) ||
        n < 0 ||
        (integer && !Number.isInteger(n))
    ) {
        return {
            error: Errors.Invalid(
                `--${name} needs a ${integer ? 'whole number' : 'number'}, 0 or more`
            ),
        };
    }
    return { value: n };
}

function virusScanFileBase() {
    //
    //  oputil fb virus-scan CRITERIA [CRITERIA ...] [--older-than DAYS]
    //      [--max N] [--dry-run]
    //
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
    }

    const olderThan = parseNonNegativeArg('older-than', false);
    const max = parseNonNegativeArg('max', true);
    const badArg = olderThan.error || max.error;
    if (badArg) {
        return printUsageAndSetExitCode(badArg.message, ExitCodes.BAD_ARGS);
    }

    const dryRun = true === argv['dry-run'];
    let modsLoaded = false;
    let summary;

    async.series(
        [
            function init(callback) {
                return initConfigAndDatabases(err => {
                    if (!err) {
                        fileArea = require('../../core/file_base_area.js');
                    }
                    return callback(err);
                });
            },
            function loadScanners(callback) {
                if (!FileScanner.isEnabled()) {
                    return callback(
                        Errors.MissingConfig(
                            'virus-scan needs file scanning enabled (fileBase.scanning.enabled)'
                        )
                    );
                }

                //  as for "fb scan --virus-scan": registerFileScanners() only
                const modsPath = _.get(
                    require('../../core/config.js').get(),
                    'paths.mods'
                );
                modsLoaded = true;
                FileScanner.loadModFileScanners(modsPath, err => {
                    if (!err) {
                        FileScanner.getConfigWarnings().forEach(warning => {
                            console.warn(`Warning: ${warning}`);
                        });
                    }
                    return callback(err);
                });
            },
            function scan(callback) {
                const Rescan = require('../../core/file_base_rescan.js');

                //  before resolving criteria: say why it cannot run first
                const notReady = Rescan.getRescanReadyError();
                if (notReady) {
                    return callback(notReady);
                }

                resolveVirusScanCriteria(argv._.slice(2), (err, resolved) => {
                    if (err) {
                        return callback(err);
                    }

                    //  an explicit selection that comes to nothing is nothing,
                    //  never "every area"
                    if (0 === resolved.areaTags.length && 0 === resolved.fileIds.length) {
                        return callback(
                            Errors.DoesNotExist(
                                'Nothing matched the criteria; nothing scanned'
                            )
                        );
                    }

                    console.info(
                        dryRun
                            ? 'Scanning (dry run: nothing will be recorded)...'
                            : 'Scanning (report only: nothing is moved or removed)...'
                    );

                    Rescan.rescanFileBase(
                        {
                            areaTags: resolved.areaTags,
                            fileIds: resolved.fileIds,
                            olderThanDays: olderThan.value,
                            maxFiles: max.value,
                            dryRun,
                            ranBy: 'oputil fb virus-scan',
                            onFileResult: result => printRescanResult(result, dryRun),
                        },
                        (err, s) => {
                            summary = s;
                            if (s) {
                                console.info(Rescan.formatSummary(s));
                            }
                            return callback(err);
                        }
                    );
                });
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            } else if (summary) {
                //  like a virus scanner: non-zero when anything was found
                const R = require('../../core/file_base_rescan.js').RescanResults;
                if (
                    summary.errors > 0 ||
                    summary.stoppedEarly ||
                    summary.counts[R.Held] > 0 ||
                    summary.counts[R.Infected] + summary.stillInfected > 0
                ) {
                    process.exitCode = ExitCodes.ERROR;
                }
            }

            //  a mod may keep the process alive just by being loaded (see
            //  scanFileAreas()): exit once the output is flushed
            if (modsLoaded) {
                process.stdout.write('', () => {
                    process.stderr.write('', () => process.exit());
                });
            }
        }
    );
}

function expandFileTargets(targets, cb) {
    let entries = [];

    //	Each entry may be PATH|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
    const FileEntry = require('../../core/file_entry.js');

    async.eachSeries(
        targets,
        (areaAndStorage, next) => {
            const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);

            if (areaInfo) {
                //	AREA_TAG[@STORAGE_TAG] - all files in area@tag
                const findFilter = {
                    areaTag: areaAndStorage.areaTag,
                };

                if (areaAndStorage.storageTag) {
                    findFilter.storageTag = areaAndStorage.storageTag;
                }

                FileEntry.findFiles(findFilter, (err, fileIds) => {
                    if (err) {
                        return next(err);
                    }

                    async.each(
                        fileIds,
                        (fileId, nextFileId) => {
                            const fileEntry = new FileEntry();
                            fileEntry.load(fileId, err => {
                                if (!err) {
                                    entries.push(fileEntry);
                                }
                                return nextFileId(err);
                            });
                        },
                        err => {
                            return next(err);
                        }
                    );
                });
            } else {
                //	FILENAME_WC|FILE_ID|SHA|PARTIAL_SHA
                //	:TODO: FULL_PATH -> entries
                getFileEntries(areaAndStorage.pattern, (err, fileEntries) => {
                    if (err) {
                        return next(err);
                    }

                    entries = entries.concat(fileEntries);
                    return next(null);
                });
            }
        },
        err => {
            return cb(err, entries);
        }
    );
}

function moveFiles() {
    //
    //	oputil fb move SRC [SRC2 ...] DST
    //
    //	SRC: FILENAME_WC|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
    //	DST: AREA_TAG[@STORAGE_TAG]
    //
    if (argv._.length < 4) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
    }

    const moveArgs = argv._.slice(2);
    const src = getAreaAndStorage(moveArgs.slice(0, -1));
    const dst = getAreaAndStorage(moveArgs.slice(-1))[0];

    let FileEntry;

    async.waterfall(
        [
            function init(callback) {
                return initConfigAndDatabases(err => {
                    if (!err) {
                        fileArea = require('../../core/file_base_area.js');
                    }
                    return callback(err);
                });
            },
            function validateAndExpandSourceAndDest(callback) {
                const areaInfo = fileArea.getFileAreaByTag(dst.areaTag);
                if (areaInfo) {
                    dst.areaInfo = areaInfo;
                } else {
                    return callback(
                        Errors.DoesNotExist('Invalid or unknown destination area')
                    );
                }

                FileEntry = require('../../core/file_entry.js');

                expandFileTargets(src, (err, srcEntries) => {
                    return callback(err, srcEntries);
                });
            },
            function moveEntries(srcEntries, callback) {
                if (!dst.storageTag) {
                    dst.storageTag = dst.areaInfo.storageTags[0];
                }

                const destDir = FileEntry.getAreaStorageDirectoryByTag(dst.storageTag);

                async.eachSeries(
                    srcEntries,
                    (entry, nextEntry) => {
                        const srcPath = entry.filePath;
                        const dstPath = paths.join(destDir, entry.fileName);

                        process.stdout.write(`Moving ${srcPath} => ${dstPath}... `);

                        FileEntry.moveEntry(entry, dst.areaTag, dst.storageTag, err => {
                            if (err) {
                                console.info(`Failed: ${err.message}`);
                            } else {
                                console.info('Done');
                            }
                            return nextEntry(null); //	always try next
                        });
                    },
                    err => {
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            }
        }
    );
}

function removeFiles() {
    //
    //	oputil fb rm|remove|del|delete SRC [SRC2 ...]
    //
    //	SRC: FILENAME_WC|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
    //
    //	AREA_TAG[@STORAGE_TAG] remove all entries matching
    //	supplied area/storage tags
    //
    //	--phys-file removes backing physical file(s)
    //
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
    }

    const removePhysFile = argv['phys-file'];

    const src = getAreaAndStorage(argv._.slice(2));

    async.waterfall(
        [
            function init(callback) {
                return initConfigAndDatabases(err => {
                    if (!err) {
                        fileArea = require('../../core/file_base_area.js');
                    }
                    return callback(err);
                });
            },
            function expandSources(callback) {
                expandFileTargets(src, (err, srcEntries) => {
                    return callback(err, srcEntries);
                });
            },
            function removeEntries(srcEntries, callback) {
                const FileEntry = require('../../core/file_entry.js');

                const extraOutput = removePhysFile ? ' (including physical file)' : '';

                async.eachSeries(
                    srcEntries,
                    (entry, nextEntry) => {
                        process.stdout.write(
                            `Removing ${entry.filePath}${extraOutput}... `
                        );

                        FileEntry.removeEntry(entry, { removePhysFile }, err => {
                            if (err) {
                                console.info(`Failed: ${err.message}`);
                            } else {
                                console.info('Done');
                            }

                            return nextEntry(err);
                        });
                    },
                    err => {
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            }
        }
    );
}

function getFileBaseImportType(path) {
    if (argv.type) {
        return argv.type.toLowerCase();
    }

    return paths.extname(path).substr(1).toLowerCase(); //  zxx, ...
}

function importFileAreas() {
    //
    //  FILEGATE.ZXX "RAID" format currently the only supported format.
    //
    //  See https://web.archive.org/web/20191121002854/http://www.filegate.net/info/filegate.zxx
    //  ...same format as FILEBONE.NA:
    //  http://wiki.mysticbbs.com/doku.php?id=mutil_import_filebone_na
    //
    const importPath = argv._[argv._.length - 1];
    if (argv._.length < 3 || !importPath || 0 === importPath.length) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
    }

    const importType = getFileBaseImportType(importPath);
    if (!['zxx', 'na'].includes(importType)) {
        return console.error(`"${importType}" is not a recognized import file type`);
    }

    const createDirs = argv['create-dirs'];
    //  :TODO: --base-dir (override config base/relative dir; use full paths)

    async.waterfall(
        [
            callback => {
                fs.readFile(importPath, 'utf8', (err, importData) => {
                    if (err) {
                        return callback(err);
                    }

                    //
                    //  The format is worked out from the file's content, not
                    //  its extension. FILEBONE / FileGate "RAID" is the common
                    //  shape, but some networks ship their file echo list as a
                    //  plain "TAG  Description" list -- the same layout their
                    //  *message* list uses -- and nothing in the name says
                    //  which you have.
                    //
                    const parsed = parseAreaList(importData);

                    if (
                        ![AreaListFormat.FileBone, AreaListFormat.NA].includes(
                            parsed.format
                        )
                    ) {
                        return callback(
                            Errors.Invalid(
                                `Nothing to import from "${paths.basename(
                                    importPath
                                )}": ${describeFormat(parsed.format)} ` +
                                    `(${parsed.stats.dataLines} data line(s), ` +
                                    `${parsed.stats.commentLines} comment line(s))`
                            )
                        );
                    }

                    if (AreaListFormat.NA === parsed.format) {
                        //
                        //  A plain "TAG  Description" list is exactly the shape
                        //  a *message* echo list uses, and several networks
                        //  ship both with a .na extension. Nothing in the
                        //  content can tell them apart, so say so and let the
                        //  operator decide at the confirmation prompt below.
                        //
                        console.info('');
                        console.info(
                            `NOTE: "${paths.basename(
                                importPath
                            )}" is a plain "TAG  Description" list, which is also`
                        );
                        console.info(
                            '      how message echo lists are written. Check the areas below'
                        );
                        console.info(
                            '      before proceeding -- this may not be a file echo list.'
                        );
                        console.info('');
                    }

                    const importInfo = buildFileAreaImportRecords(parsed.entries);

                    const skipped = parsed.skipped.concat(importInfo.skipped);
                    skipped.forEach(sk => {
                        console.info(
                            `Skipping line ${sk.lineNumber} (${sk.reason}): ${sk.text}`
                        );
                    });

                    if (0 === importInfo.count) {
                        return callback(new Error('Nothing to import'));
                    }

                    return callback(null, importInfo);
                });
            },
            (importInfo, callback) => {
                return initConfigAndDatabases(err => {
                    return callback(err, importInfo);
                });
            },
            (importInfo, callback) => {
                console.info(`Read to import the following ${importInfo.count} areas:`);
                console.info('');
                _.each(importInfo.areas, (area, areaTag) => {
                    console.info(`${area.name} (${areaTag}):`);
                    const dir = importInfo.storageTags[area.storageTags[0]];
                    console.info(`  storage: ${area.storageTags[0]} => ${dir}`);
                });

                getAnswers(
                    [
                        {
                            name: 'proceed',
                            message: 'Proceed?',
                            type: 'confirm',
                        },
                    ],
                    answers => {
                        if (answers.proceed) {
                            return callback(null, importInfo);
                        }
                        return callback(Errors.General('User canceled'));
                    }
                );
            },
            (importInfo, callback) => {
                fs.readFile(getConfigPath(), 'utf8', (err, configData) => {
                    if (err) {
                        return callback(err);
                    }
                    let config;
                    try {
                        config = hjson.rt.parse(configData);
                    } catch (e) {
                        return callback(e);
                    }
                    return callback(null, importInfo, config);
                });
            },
            (importInfo, config, callback) => {
                const newStorageTagDirs = [];
                _.each(importInfo.areas, (area, areaTag) => {
                    const existingArea = _.get(config, ['fileBase', 'areas', areaTag]);
                    if (existingArea) {
                        return console.info(
                            `Skipping ${area.name}. Area tag "${areaTag}" already exists.`
                        );
                    }

                    const storageTag = area.storageTags[0];
                    const existingStorageTag = _.get(config, [
                        'fileBase',
                        'storageTags',
                        storageTag,
                    ]);
                    if (existingStorageTag) {
                        return console.info(
                            `Skipping ${area.name} (${areaTag}). Storage tag "${storageTag}" already exists`
                        );
                    }

                    const dir = importInfo.storageTags[storageTag];
                    newStorageTagDirs.push(dir);

                    config.fileBase.storageTags[storageTag] = dir;
                    config.fileBase.areas[areaTag] = area;
                });

                return callback(null, newStorageTagDirs, config);
            },
            (newStorageTagDirs, config, callback) => {
                if (!createDirs) {
                    return callback(null, config);
                }

                //
                //  Create all directories
                //
                const prefixDir = config.fileBase.areaStoragePrefix;
                async.eachSeries(
                    newStorageTagDirs,
                    (dir, nextDir) => {
                        const isAbs = paths.isAbsolute(dir);
                        if (!isAbs) {
                            dir = paths.join(prefixDir, dir);
                        }
                        mkdirs(dir, err => {
                            if (!err) {
                                console.log(`Created ${dir}`);
                            }
                            return nextDir(err);
                        });
                    },
                    err => {
                        return callback(err, config);
                    }
                );
            },
            (config, callback) => {
                const written = writeConfig(config, getConfigPath());
                return callback(written ? null : new Error('Failed to write config!'));
            },
        ],
        err => {
            if (err) {
                return console.error(err.reason ? err.reason : err.message);
            }

            console.info('Import complete.');
            console.info(`You may wish to validate changes made to ${getConfigPath()}`);
        }
    );
}

function setFileDescription() {
    //
    //  ./oputil.js fb set-desc CRITERIA # will prompt
    //  ./oputil.js fb set-desc CRITERIA "The new description"
    //
    let fileCriteria;
    let desc;
    if (argv._.length > 3) {
        fileCriteria = argv._[argv._.length - 2];
        desc = argv._[argv._.length - 1];
    } else {
        fileCriteria = argv._[argv._.length - 1];
    }

    async.waterfall(
        [
            callback => {
                return initConfigAndDatabases(callback);
            },
            callback => {
                getFileEntries(fileCriteria, (err, entries) => {
                    if (err) {
                        return callback(err);
                    }

                    if (entries.length > 1) {
                        return callback(Errors.General('Criteria not specific enough.'));
                    }

                    return callback(null, entries[0]);
                });
            },
            (fileEntry, callback) => {
                if (desc) {
                    return callback(null, fileEntry, desc);
                }

                getAnswers(
                    [
                        {
                            name: 'userDesc',
                            message: 'Description:',
                            type: 'editor',
                        },
                    ],
                    answers => {
                        if (!answers.userDesc) {
                            return callback(Errors.General('User canceled'));
                        }
                        return callback(null, fileEntry, answers.userDesc);
                    }
                );
            },
            (fileEntry, newDesc, callback) => {
                fileEntry.desc = newDesc;
                fileEntry.persist(true, err => {
                    //  true=isUpdate
                    return callback(err);
                });
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            } else {
                console.info('Description updated.');
            }
        }
    );
}

//
//  ./oputil.js fb hatch AREA_TAG FILE [args]
//
//  Originate a file into a file echo we carry (#751). AREA_TAG is the *FTN*
//  area tag -- a ticAreas key, i.e. what the echo is called on the network --
//  not the local file base area tag, because that is the thing an operator
//  configuring a hatch is looking at and one local area may carry several
//  echoes.
//
//  The work is in core/tic_hatch.js; this parses arguments and reports. Kept
//  that way deliberately: hatching needs a live ftn_bso instance and the whole
//  TIC forwarding machinery, none of which belongs in a CLI wrapper.
//
function hatchFile() {
    const externalAreaTag = argv._[2];
    const filePath = argv._[3];

    if (!externalAreaTag || !filePath) {
        return printUsageAndSetExitCode(
            getHelpFor('FileBase') + getHelpFor('FileOpsInfo'),
            ExitCodes.BAD_ARGS
        );
    }

    const dryRun = true === argv['dry-run'];

    //
    //  A value flag given with no value is boolean true, and passing that on
    //  writes "Replaces true" into the TIC or hands `true` to a SQL bind. Say
    //  so instead.
    //
    for (const name of ['desc', 'replaces', 'tags', 'storage-tag']) {
        if (undefined !== argv[name] && !_.isString(argv[name])) {
            return printUsageAndSetExitCode(
                `--${name} needs a value`,
                ExitCodes.BAD_ARGS
            );
        }
    }

    //  Repeatable, so a long description keeps its line breaks: FTS-5006 makes
    //  Ldesc explicitly multi-line and the blank lines in one are content.
    const ldesc = []
        .concat(argv.ldesc === undefined ? [] : argv.ldesc)
        .map(l => String(l));

    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            callback => {
                const { hatch } = require('../tic_hatch.js');
                const { getModule } = require('../scanner_tossers/ftn_bso.js');

                hatch(
                    {
                        externalAreaTag,
                        filePath,
                        ftnBso: new getModule(),
                        desc: argv.desc,
                        ldesc,
                        replaces: argv.replaces,
                        storageTag: argv['storage-tag'],
                        hashTags: argv.tags
                            ? new Set(
                                  String(argv.tags)
                                      .split(/[\s,]+/)
                                      .filter(Boolean)
                              )
                            : undefined,
                        dryRun,
                    },
                    callback
                );
            },
        ],
        (err, info) => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                return console.error(err.message);
            }

            console.info(
                `${dryRun ? 'Would hatch' : 'Hatched'} ${info.fileName} into ${
                    info.externalAreaTag
                } (${info.localAreaTag})`
            );
            console.info(`  Origin      ${info.origin.toString('4D')}`);
            console.info(`  Size        ${info.size}`);
            if (info.longFileName !== info.fileName) {
                console.info(`  Long name   ${info.longFileName}`);
            }
            if (info.replaced) {
                console.info(`  Replaces    ${info.replaced.fileName}`);
            }
            console.info(
                `  Downlinks   ${info.downlinks.length} configured for this echo`
            );

            if (dryRun) {
                console.info('');
                console.info('Nothing was written. The TIC would read:');
                info.ticData
                    .split('\r\n')
                    .filter(l => l.length)
                    .forEach(l => console.info(`  ${l}`));
                console.info('');
                console.info(
                    '...plus Created, Crc, From, To, Pw, Path and Seenby, which are'
                );
                console.info(
                    'generated per downlink. Re-run without --dry-run to hatch.'
                );
            }
        }
    );
}

// ── Quarantine and allowlist (#291) ─────────────────────────────────────────

//  Who is at the keyboard, for the log and the allowlist: the OS user
//  running oputil.
function operatorName() {
    try {
        const name = require('os').userInfo().username;
        if (name) {
            return `oputil:${name}`;
        }
    } catch (e) {
        //  no passwd entry, say: fall through
    }
    return 'oputil';
}

//
//  A value option (--area TAG): undefined when not given, an error when given
//  without a value -- minimist makes that `true`, which must never become an
//  area tag or a note.
//
function valueArg(name) {
    const value = argv[name];
    if (_.isUndefined(value)) {
        return { value: undefined };
    }
    //  a string option given without a value is ''
    if ((!_.isString(value) && !_.isNumber(value)) || '' === value) {
        return { error: Errors.Invalid(`--${name} needs a value`) };
    }
    return { value: String(value) };
}

function formatBytes(n) {
    return _.isFinite(n) ? `${n} byte${1 === n ? '' : 's'}` : '? bytes';
}

function printQuarantineItem(item) {
    const sc = item.sidecar || {};
    const when = sc.quarantinedAt || (item.mtime && item.mtime.toISOString());

    console.info(
        `${remoteText(item.quarantineName)}  ${
            item.exists ? formatBytes(item.byteSize) : '(file missing)'
        }  ${remoteText(when || '')}`
    );

    if (!item.sidecar) {
        console.info(
            'ambiguous' === item.sidecarProblem
                ? '    (more than one sidecar claims this file)'
                : '    (no sidecar)'
        );
        return;
    }

    const line = (label, value) =>
        console.info(`    ${label.padEnd(10)}${remoteText(value)}`);

    line('original', sc.originalName || '?');
    let from = sc.source || '?';
    if (sc.user && (sc.user.name || sc.user.id)) {
        from += `, user ${sc.user.name || '?'} #${sc.user.id || '?'}`;
    }
    if (sc.ticInfo && sc.ticInfo.origin) {
        from += `, TIC origin ${sc.ticInfo.origin}`;
    }
    line('from', from);
    line(
        'area',
        sc.areaTag || (sc.ticInfo && sc.ticInfo.passthrough ? '(passthrough TIC)' : '-')
    );
    const result =
        FileScanner.Verdicts.Infected === sc.verdict
            ? `infected: ${sc.signature || 'unnamed threat'}`
            : `${sc.verdict || '?'}: ${sc.detail || ''}`;
    line('scanner', `${sc.scanner || '?'}, ${result}`);
    if (sc.sha256) {
        line('sha-256', sc.sha256);
    }
}

function quarantineList() {
    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            callback => require('../file_quarantine.js').listQuarantine(callback),
        ],
        (err, items) => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                return console.error(err.message);
            }
            const dir = FileScanner.getQuarantinePath();
            if (0 === items.length) {
                return console.info(`Nothing in quarantine (${dir})`);
            }
            items.forEach(printQuarantineItem);
            console.info('');
            console.info(
                `${items.length} item${1 === items.length ? '' : 's'} in ${dir}`
            );
        }
    );
}

function quarantineRelease() {
    //
    //  oputil fb quarantine release NAME [--area TAG] [--name NEWNAME]
    //      [--allow [--note TEXT]] [--no-scan]
    //
    const name = argv._[3];
    if (!name || argv._.length > 4) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.BAD_ARGS);
    }

    const area = valueArg('area');
    const newName = valueArg('name');
    const note = valueArg('note');
    const badArg = area.error || newName.error || note.error;
    if (badArg) {
        return printUsageAndSetExitCode(badArg.message, ExitCodes.BAD_ARGS);
    }
    const allow = true === argv.allow;
    const noScan = false === argv.scan;
    if (note.value && !allow) {
        return printUsageAndSetExitCode(
            '--note is for the allowlist entry; it needs --allow',
            ExitCodes.BAD_ARGS
        );
    }

    let modsLoaded = false;
    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            callback => {
                //
                //  The release scans first, with the scanners mods provide:
                //  as for "fb scan --virus-scan", only their
                //  registerFileScanners() runs. With scanning off there is
                //  nothing to load, and the release says what to do.
                //
                if (noScan || !FileScanner.isEnabled()) {
                    return callback(null);
                }
                modsLoaded = true;
                FileScanner.loadModFileScanners(
                    _.get(require('../../core/config.js').get(), 'paths.mods'),
                    err => callback(err)
                );
            },
            callback =>
                require('../file_quarantine.js').releaseQuarantined(
                    String(name),
                    {
                        operator: operatorName(),
                        areaTag: area.value,
                        fileName: newName.value,
                        allow,
                        note: note.value,
                        noScan,
                    },
                    callback
                ),
        ],
        (err, res) => {
            //  a mod may keep the process alive just by being loaded (see
            //  scanFileAreas()): exit once the output is flushed
            if (modsLoaded) {
                setImmediate(() =>
                    process.stdout.write('', () => {
                        process.stderr.write('', () => process.exit());
                    })
                );
            }

            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(consoleText(err.message));
                if (err.movedBackTo) {
                    console.error(
                        `It is back in quarantine as ${consoleText(err.movedBackTo)}`
                    );
                }
                if (err.allowlistRolledBack) {
                    console.error('Its SHA-256 was taken off the allowlist again');
                } else if (err.allowlistRollbackFailed) {
                    console.error(
                        'Its SHA-256 is still on the allowlist: remove it with "fb mark-safe --remove SHA256"'
                    );
                }
                return;
            }
            const e = res.fileEntry;
            const v = res.verdict;
            console.info(
                v
                    ? `Scanned before release: ${consoleText(v.result)} (${consoleText(
                          v.scanner || _.uniq(v.results.map(r => r.scanner)).join(',')
                      )})`
                    : 'Not scanned before release (--no-scan)'
            );
            console.info(
                `Released ${consoleText(name)} as ${consoleText(res.path)} (file ID ${
                    e.fileId
                }, area ${consoleText(e.areaTag)})`
            );
            if (res.allowlisted) {
                console.info(
                    res.allowlistAdded
                        ? `Added ${res.sha256} to the allowlist`
                        : `${res.sha256} was already on the allowlist`
                );
            } else {
                console.info(
                    'Not added to the allowlist: a later scan or rescan may flag it again (use --allow, or "fb mark-safe", for a false positive)'
                );
            }
            if (res.sidecarError) {
                console.error(
                    `Warning: could not remove its sidecar: ${consoleText(res.sidecarError)}`
                );
            }
        }
    );
}

function quarantineDelete() {
    //  oputil fb quarantine delete NAME [--yes|--no-prompt]
    const name = argv._[3];
    if (!name || argv._.length > 4) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.BAD_ARGS);
    }
    const Quarantine = () => require('../file_quarantine.js');

    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            callback =>
                Quarantine().findQuarantined(String(name), (err, item) => {
                    if (!err && !item) {
                        err = Errors.DoesNotExist(`No quarantined file named "${name}"`);
                    }
                    return callback(err, item);
                }),
            (item, callback) => {
                if (true === argv.yes || false === argv.prompt) {
                    return callback(null);
                }
                printQuarantineItem(item);
                getAnswers(
                    [
                        {
                            name: 'proceed',
                            message: `Permanently delete ${name} and its sidecar?`,
                            type: 'confirm',
                            default: false,
                        },
                    ],
                    answers =>
                        callback(
                            answers.proceed ? null : Errors.General('Nothing deleted')
                        )
                );
            },
            callback =>
                Quarantine().deleteQuarantined(String(name), operatorName(), callback),
        ],
        (err, res) => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                return console.error(err.message);
            }
            res.removed.forEach(p => console.info(`Deleted ${consoleText(p)}`));
            res.missing.forEach(p => console.info(`Already gone: ${consoleText(p)}`));
            if (0 === res.removed.length) {
                process.exitCode = ExitCodes.ERROR;
                console.error('Nothing was deleted');
            }
        }
    );
}

function quarantineCommand() {
    const action = argv._[2];
    return (
        {
            list: quarantineList,
            ls: quarantineList,
            release: quarantineRelease,
            delete: quarantineDelete,
            del: quarantineDelete,
            rm: quarantineDelete,
        }[action] ||
        (() => printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.BAD_ARGS))
    )();
}

function printAllowlistEntry(e) {
    console.info(consoleText(e.sha256));
    console.info(`    added     ${remoteText(e.addedAt)} by ${remoteText(e.addedBy)}`);
    if (e.originalName) {
        console.info(`    name      ${remoteText(e.originalName)}`);
    }
    if (e.signature) {
        console.info(`    signature ${remoteText(e.signature)}`);
    }
    if (e.note) {
        console.info(`    note      ${remoteText(e.note)}`);
    }
}

//
//  The SHA-256 to allowlist for |target|: a SHA-256 as given, or a file ID's
//  file as it is on disk now. A file that no longer matches its entry's
//  hash is refused: the rescan that flagged it read the bytes on disk, and
//  those are what would have to be allowed. Calls back (err, { sha256,
//  originalName?, signature? }).
//
function resolveMarkSafeTarget(target, cb) {
    const Allowlist = require('../file_scan_allowlist.js');

    if (Allowlist.isValidSha256(target)) {
        return cb(null, { sha256: target.toLowerCase() });
    }
    if (!/^[0-9]+$/.test(target)) {
        return cb(
            Errors.Invalid(
                `"${target}" is neither a file ID nor a SHA-256 (64 hexadecimal digits)`
            )
        );
    }

    const FileEntry = require('../file_entry.js');
    const entry = new FileEntry();
    entry.load(parseInt(target, 10), err => {
        if (err) {
            return cb(Errors.DoesNotExist(`No file entry with ID ${target}`));
        }
        const info = {
            sha256: entry.fileSha256,
            originalName: entry.fileName,
            signature: entry.meta.scan_signature,
        };

        let filePath;
        try {
            filePath = entry.filePath;
        } catch (e) {
            return cb(e);
        }

        const crypto = require('crypto');
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', err => {
            if ('ENOENT' !== err.code) {
                return cb(err);
            }
            //  nothing on disk to check the recorded hash against
            if (true !== argv.force) {
                return cb(
                    Errors.DoesNotExist(
                        `${consoleText(filePath)} is missing, so its SHA-256 cannot be checked. Give the SHA-256 you mean to allow, or --force to use the one recorded for the entry`
                    )
                );
            }
            console.warn(
                `Warning: ${consoleText(filePath)} is missing; using the SHA-256 recorded for the entry (--force)`
            );
            return cb(null, info);
        });
        stream.on('end', () => {
            const actual = hash.digest('hex');
            if (actual !== info.sha256) {
                return cb(
                    Errors.Invalid(
                        `The file has changed since it was imported (its SHA-256 is now ${actual}, the entry says ${info.sha256}). Check it, then give the SHA-256 you mean to allow`
                    )
                );
            }
            return cb(null, info);
        });
    });
}

function markSafe() {
    //
    //  oputil fb mark-safe FILE_ID|SHA256 [--note TEXT]
    //  oputil fb mark-safe --list
    //  oputil fb mark-safe --remove SHA256
    //
    const Allowlist = () => require('../file_scan_allowlist.js');
    const note = valueArg('note');
    const remove = valueArg('remove');
    const badArg = note.error || remove.error;
    if (badArg) {
        return printUsageAndSetExitCode(badArg.message, ExitCodes.BAD_ARGS);
    }

    const modes = [true === argv.list, !_.isUndefined(remove.value), argv._.length > 2];
    if (1 !== modes.filter(Boolean).length || argv._.length > 3) {
        return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.BAD_ARGS);
    }

    const done = err => {
        if (err) {
            process.exitCode = ExitCodes.ERROR;
            console.error(err.message);
        }
    };

    initConfigAndDatabases(err => {
        if (err) {
            return done(err);
        }

        if (true === argv.list) {
            return Allowlist().list((err, entries) => {
                if (err) {
                    return done(err);
                }
                if (0 === entries.length) {
                    console.info('The allowlist is empty');
                    return done(null);
                }
                entries.forEach(printAllowlistEntry);
                console.info('');
                console.info(
                    `${entries.length} entr${1 === entries.length ? 'y' : 'ies'}`
                );
                return done(null);
            });
        }

        if (!_.isUndefined(remove.value)) {
            return Allowlist().remove(remove.value, operatorName(), (err, removed) => {
                if (err) {
                    return done(err);
                }
                if (!removed) {
                    return done(
                        Errors.DoesNotExist(`${remove.value} is not on the allowlist`)
                    );
                }
                console.info(`Removed ${removed.sha256} from the allowlist`);
                console.info(
                    'Entries already marked clean by it keep that until they are rescanned'
                );
                return done(null);
            });
        }

        resolveMarkSafeTarget(String(argv._[2]), (err, target) => {
            if (err) {
                return done(err);
            }
            Allowlist().add(
                Object.assign({}, target, {
                    addedBy: operatorName(),
                    note: note.value,
                }),
                (err, res) => {
                    if (err) {
                        return done(err);
                    }
                    console.info(
                        res.added
                            ? `Added ${target.sha256} to the allowlist`
                            : `${target.sha256} was already on the allowlist`
                    );
                    Allowlist().markEntriesSafe(target.sha256, (err, changed) => {
                        if (err) {
                            return done(err);
                        }
                        if (changed.length > 0) {
                            console.info(
                                `Marked clean: file ID ${changed.join(', ')} (was infected)`
                            );
                        }
                        return done(null);
                    });
                }
            );
        });
    });
}

function handleFileBaseCommand() {
    function errUsage() {
        return printUsageAndSetExitCode(
            getHelpFor('FileBase') + getHelpFor('FileOpsInfo'),
            ExitCodes.ERROR
        );
    }

    if (true === argv.help) {
        return errUsage();
    }

    const action = argv._[1];

    return (
        {
            info: displayFileOrAreaInfo,
            scan: scanFileAreas,
            'virus-scan': virusScanFileBase,

            mv: moveFiles,
            move: moveFiles,

            rm: removeFiles,
            remove: removeFiles,
            del: removeFiles,
            delete: removeFiles,

            'import-areas': importFileAreas,

            desc: setFileDescription,
            description: setFileDescription,

            hatch: hatchFile,

            quarantine: quarantineCommand,
            'mark-safe': markSafe,
        }[action] || errUsage
    )();
}
