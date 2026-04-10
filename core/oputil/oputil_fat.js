/* jslint node: true */
/* eslint-disable no-console */
'use strict';

/**
 * oputil_fat.js — FAT disk image management commands
 *
 * Provides oputil `fat` subcommands for inspecting and modifying raw FAT
 * disk images without requiring a running ENiGMA instance or database.
 *
 * Commands:
 *   fat ls   <image.img> [DOS-PATH]       List files in image (alias: dir)
 *   fat cp   <image.img> <src> <dst> ...  Copy local files into image (alias: copy)
 *   fat read <image.img> <dos-path>       Read a file from image to stdout (alias: cat, type)
 */

const { printUsageAndSetExitCode, argv, ExitCodes } = require('./oputil_common.js');
const { getHelpFor } = require('./oputil_help.js');

const { createRequire } = require('module');
const _require = createRequire(__filename);
const fatfs = _require('fatfs');
const { createFileDriverSync } = _require('fatfs-volume-driver');

const fs = require('fs');
const path = require('path');

exports.handleFatCommand = handleFatCommand;

// ─── Mount helpers ────────────────────────────────────────────────────────────

function mountImage(imagePath, readOnly) {
    if (!fs.existsSync(imagePath)) {
        console.error(`fat: image not found: ${imagePath}`);
        process.exitCode = ExitCodes.BAD_ARGS;
        return null;
    }

    try {
        const driver = createFileDriverSync(imagePath, { partitionNumber: 1, readOnly });
        const fatFs = fatfs.createFileSystem(driver);
        return fatFs;
    } catch (err) {
        console.error(`fat: failed to open image: ${err.message}`);
        process.exitCode = ExitCodes.ERROR;
        return null;
    }
}

function awaitReady(fatFs, cb) {
    fatFs.on('error', err => {
        console.error(`fat: failed to mount FAT partition: ${err.message}`);
        console.error('Is this a valid partitioned FAT disk image?');
        process.exitCode = ExitCodes.ERROR;
        cb(err);
    });
    fatFs.on('ready', () => cb(null));
}

function dosPath(p) {
    return (p || '/').replace(/\\/g, '/');
}

// ─── ls / dir ────────────────────────────────────────────────────────────────

// Split a DOS 8.3 filename into { base, ext } for column-aligned display.
function splitDos83(name) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
        return {
            base: name.slice(0, dot).slice(0, 8),
            ext: name.slice(dot + 1).slice(0, 3),
        };
    }
    return { base: name.slice(0, 8), ext: '' };
}

function formatDosDate(d) {
    if (!d) return '         ';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${mm}-${dd}-${yy}`;
}

function formatDosTime(d) {
    if (!d) return '      ';
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    return `${String(h).padStart(2)}:${m}${ampm}`;
}

function printDosListing(imagePath, target, results) {
    const dosDir =
        ('\\' + target.replace(/^\//, '').replace(/\//g, '\\')).toUpperCase() || '\\';

    console.log(` Volume in drive A has no label`);
    console.log(` Directory of A:${dosDir}\n`);

    let fileCount = 0,
        dirCount = 0,
        totalBytes = 0;

    for (const r of results) {
        const { base, ext } = splitDos83(r.name);
        const nameCol = `${base.padEnd(8)} ${ext.padEnd(3)}`;
        const dateStr = formatDosDate(r.mtime);
        const timeStr = formatDosTime(r.mtime);

        if (r.isDir) {
            console.log(`${nameCol}  <DIR>            ${dateStr}  ${timeStr}`);
            dirCount++;
        } else {
            const sizeStr = r.size === null ? '        ?' : String(r.size).padStart(9);
            console.log(`${nameCol}  ${sizeStr}   ${dateStr}  ${timeStr}`);
            fileCount++;
            totalBytes += r.size || 0;
        }
    }

    console.log(
        `\n  ${fileCount} File(s)    ${totalBytes.toLocaleString().padStart(12)} bytes`
    );
    console.log(`  ${dirCount} Dir(s)`);
}

function cmdLs(imagePath, listPath) {
    const fatFs = mountImage(imagePath, true);
    if (!fatFs) return;

    awaitReady(fatFs, err => {
        if (err) return;

        const target = dosPath(listPath || '/');

        fatFs.readdir(target, (err, entries) => {
            if (err) {
                console.error(`fat: cannot list ${target}: ${err.message}`);
                process.exitCode = ExitCodes.ERROR;
                return;
            }

            if (entries.length === 0) {
                console.log(` Volume in drive A has no label`);
                console.log(` Directory of A:${target.toUpperCase()}\n`);
                console.log('  (empty)\n');
                return;
            }

            let pending = entries.length;
            const results = new Array(entries.length);

            entries.forEach((entry, i) => {
                const fullPath = `/${target.replace(/^\//, '')}/${entry}`.replace(
                    '//',
                    '/'
                );
                fatFs.stat(fullPath, (err, st) => {
                    if (err && err.code === 'ISDIR') {
                        results[i] = { name: entry, isDir: true, size: 0, mtime: null };
                    } else if (err) {
                        results[i] = {
                            name: entry,
                            isDir: false,
                            size: null,
                            mtime: null,
                        };
                    } else {
                        results[i] = {
                            name: entry,
                            isDir: st.isDirectory(),
                            size: st.size,
                            mtime: st.mtime || null,
                        };
                    }

                    if (--pending === 0) {
                        // dirs first, then files — both alphabetical
                        results.sort((a, b) => {
                            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        });
                        printDosListing(imagePath, target, results);
                    }
                });
            });
        });
    });
}

// ─── read / cat / type ───────────────────────────────────────────────────────

function cmdRead(imagePath, dosFilePath) {
    if (!dosFilePath) {
        return printUsageAndSetExitCode(getHelpFor('Fat'), ExitCodes.BAD_ARGS);
    }

    const fatFs = mountImage(imagePath, true);
    if (!fatFs) return;

    awaitReady(fatFs, err => {
        if (err) return;

        const target = dosPath(dosFilePath);

        fatFs.readFile(target, (err, data) => {
            if (err) {
                console.error(`fat: cannot read ${target}: ${err.message}`);
                process.exitCode = ExitCodes.ERROR;
                return;
            }
            process.stdout.write(data);
        });
    });
}

// ─── cp / copy ───────────────────────────────────────────────────────────────

function cmdCp(imagePath, pairs) {
    if (!pairs || pairs.length === 0 || pairs.length % 2 !== 0) {
        console.error('fat cp: arguments after image must be src/dest pairs');
        return printUsageAndSetExitCode(getHelpFor('Fat'), ExitCodes.BAD_ARGS);
    }

    const fatFs = mountImage(imagePath, false);
    if (!fatFs) return;

    awaitReady(fatFs, err => {
        if (err) return;

        // Process pairs sequentially
        const next = i => {
            if (i >= pairs.length) {
                console.log('Done.');
                return;
            }

            const localSrc = pairs[i];
            const dosDst = dosPath(pairs[i + 1]).replace(/^\//, '');

            if (!fs.existsSync(localSrc)) {
                console.error(`fat cp: source not found: ${localSrc}`);
                process.exitCode = ExitCodes.ERROR;
                return;
            }

            const stat = fs.statSync(localSrc);
            if (stat.isDirectory()) {
                copyDirectory(fatFs, localSrc, dosDst, err => {
                    if (err) {
                        console.error(`fat cp: ${err.message}`);
                        process.exitCode = ExitCodes.ERROR;
                        return;
                    }
                    next(i + 2);
                });
            } else {
                mkdirp(fatFs, path.dirname(dosDst), err => {
                    if (err) {
                        console.error(`fat cp: ${err.message}`);
                        process.exitCode = ExitCodes.ERROR;
                        return;
                    }
                    copyFile(fatFs, localSrc, dosDst, err => {
                        if (err) {
                            console.error(`fat cp: ${err.message}`);
                            process.exitCode = ExitCodes.ERROR;
                            return;
                        }
                        next(i + 2);
                    });
                });
            }
        };

        next(0);
    });
}

function mkdirp(fatFs, dosDir, cb) {
    if (!dosDir || dosDir === '.' || dosDir === '/') return cb(null);

    const parts = dosDir.replace(/\\/g, '/').split('/').filter(Boolean);
    let current = '';

    const next = i => {
        if (i >= parts.length) return cb(null);
        current = current ? `${current}/${parts[i]}` : parts[i];
        fatFs.mkdir(current, err => {
            if (err && err.code !== 'EEXIST') {
                // Non-fatal: log and continue
                console.warn(`  mkdir ${current}: ${err.message}`);
            }
            next(i + 1);
        });
    };

    next(0);
}

function copyFile(fatFs, localPath, dosFilePath, cb) {
    const upper = dosFilePath.toUpperCase();
    const content = fs.readFileSync(localPath);
    console.log(`  ${localPath} \u2192 ${upper} (${content.length} bytes)`);
    fatFs.writeFile(upper, content, err => {
        if (err) return cb(new Error(`Failed to write ${upper}: ${err.message}`));
        cb(null);
    });
}

function copyDirectory(fatFs, localDir, dosDir, cb) {
    console.log(`  ${localDir}/ \u2192 ${dosDir.toUpperCase()}/`);
    mkdirp(fatFs, dosDir, err => {
        if (err) return cb(err);

        const entries = fs.readdirSync(localDir);
        const next = i => {
            if (i >= entries.length) return cb(null);
            const localPath = path.join(localDir, entries[i]);
            const dosDst = `${dosDir}/${entries[i]}`;
            if (fs.statSync(localPath).isDirectory()) {
                copyDirectory(fatFs, localPath, dosDst, err => {
                    if (err) return cb(err);
                    next(i + 1);
                });
            } else {
                copyFile(fatFs, localPath, dosDst, err => {
                    if (err) return cb(err);
                    next(i + 1);
                });
            }
        };

        next(0);
    });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function handleFatCommand() {
    if (argv.help) {
        return printUsageAndSetExitCode(getHelpFor('Fat'), ExitCodes.SUCCESS);
    }

    const action = argv._[1];
    const imagePath = argv._[2];

    if (!action || !imagePath) {
        return printUsageAndSetExitCode(getHelpFor('Fat'), ExitCodes.BAD_ARGS);
    }

    switch (action) {
        case 'ls':
        case 'dir':
            return cmdLs(imagePath, argv._[3]);

        case 'read':
        case 'cat':
        case 'type':
            return cmdRead(imagePath, argv._[3]);

        case 'cp':
        case 'copy':
            return cmdCp(imagePath, argv.3));

        default:
            return printUsageAndSetExitCode(getHelpFor('Fat').slice(ExitCodes.BAD_COMMAND);
    }
}
