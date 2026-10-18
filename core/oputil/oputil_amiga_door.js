/* jslint node: true */
/* eslint-disable no-console */
'use strict';

/**
 * oputil_amiga_door.js: build and inspect Amiga door images
 *
 * An Amiga door image is a bare FFS partition holding the host shim, the
 * door library, a startup sequence and the doors. These commands build and
 * change one with core/amiga_door/amiga_fs.js: no running ENiGMA, no
 * Python, no amitools.
 *
 * Commands:
 *   amiga-door create  IMAGE [DOORDIR...]   build a door image (make_image.sh in JS)
 *   amiga-door add     IMAGE SRC [DST]      copy a local file or directory in
 *   amiga-door ls      IMAGE [DIR]          list the image (recursively)
 *   amiga-door extract IMAGE SRC DST        copy a file or directory out
 *   amiga-door info    IMAGE                volume name, file system, space
 *   amiga-door console IMAGE --door PATH   test-drive a door on a terminal
 */

const { printUsageAndSetExitCode, argv, ExitCodes } = require('./oputil_common.js');
const { getHelpFor } = require('./oputil_help.js');
const { AmigaVolume, splitPath } = require('../amiga_door/amiga_fs.js');

const fs = require('fs');
const paths = require('path');

const AMIGA_DIR = paths.join(__dirname, '../../misc/amiga_door');

//  What create puts on every image: [source in misc/amiga_door, path in the image]
const BASE_FILES = [
    ['bin/axshim', 'C/axshim'],
    ['bin/AEDoor.library', 'Libs/AEDoor.library'],
    ['image/Startup-Sequence', 'S/Startup-Sequence'],
];

//  What --workbench copies from a Workbench 3.1 disk: ARexx, the libraries it
//  needs and the C: commands scripts run (same list as make_image.sh -w; the
//  same path on the disk and in the image)
const WORKBENCH_FILES = [
    'System/RexxMast',
    'Libs/rexxsyslib.library',
    'Libs/rexxsupport.library',
    'Libs/mathieeedoubbas.library',
    'Libs/mathieeedoubtrans.library',
    'Libs/mathieeesingtrans.library',
    ...['RX', 'RXC', 'RXSET', 'RXLIB', 'HI', 'TS', 'TE', 'TCO', 'TCC', 'WaitForPort'].map(
        n => `Rexxc/${n}`
    ),
    ...[
        'Avail',
        'Copy',
        'Date',
        'Delete',
        'List',
        'MakeDir',
        'Rename',
        'Type',
        'Wait',
    ].map(n => `C/${n}`),
];

const DEFAULT_SIZE = '2000K';

//  The bundled AROS ROM corrupts an FFS volume of more than one bitmap block
//  (4066 blocks, 2032 KB) when the guest writes to it.
const AROS_MAX_BLOCKS = 4066;
const AROS_MAX_SIZE = 2032 * 1024;
const DEFAULT_NAME = 'BBS';
const SIZE_ROUND = 16 * 512; // vAmiga finds a drive geometry for any multiple of 16 blocks
const MAX_SIZE = 2 * 1024 * 1024 * 1024;

class CommandError extends Error {}

exports.handleAmigaDoorCommand = handleAmigaDoorCommand;
exports.parseSize = parseSize;
exports.buildDoorImage = buildDoorImage;
exports.addToVolume = addToVolume;
exports.extractFromVolume = extractFromVolume;
exports.formatListing = formatListing;
exports.doorNameProblem = doorNameProblem;
exports.checkDoorNames = checkDoorNames;
exports.WORKBENCH_FILES = WORKBENCH_FILES;
exports.BASE_FILES = BASE_FILES;

// ─── helpers ─────────────────────────────────────────────────────────────────

//  "4M", "880K", "1G", "8388608" -> bytes, rounded up to a whole drive geometry
function parseSize(value) {
    const m = String(value)
        .trim()
        .match(/^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?$/i);
    if (!m) throw new CommandError(`bad size: ${value} (e.g. 4M, 880K, 1G)`);
    const mult = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[
        m[2].toLowerCase()
    ];
    const bytes = Math.ceil((parseFloat(m[1]) * mult) / SIZE_ROUND) * SIZE_ROUND;
    if (bytes <= 0) throw new CommandError(`bad size: ${value}`);
    if (bytes > MAX_SIZE) throw new CommandError(`size too large: ${value} (at most 2G)`);
    return bytes;
}

//  What the amiga_door module refuses in a XIM or CLI door's path (it goes on
//  the shim's command line in quotes): the quote, the shell's wildcard and
//  substitution characters, redirection and pipe, control characters (C0 and
//  C1) and anything that is not Latin-1. Keep in step with QuotedPathUnsafe
//  and ControlChars in core/amiga_door/amiga_door.js.
function doorNameProblem(name) {
    const m = /["*`$;<>|]/.exec(name);
    if (m) return `the character ${m[0]}`;
    if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return 'a control character';
    if (/[^\x00-\xff]/.test(name)) return 'a character outside Latin-1';
    return null;
}

//  Walk a local door directory (the same entries addToVolume copies) and
//  return a warning for each name, the directory's own included, that a
//  `door:` path through it would be refused for.
function checkDoorNames(dir) {
    const warnings = [];
    const check = (name, shown) => {
        const why = doorNameProblem(name);
        if (why) {
            warnings.push(
                `${shown} has ${why} in its name: the amiga_door module will refuse a ` +
                    '`door:` path through it'
            );
        }
    };
    const walk = (full, shown) => {
        let names;
        try {
            names = fs.readdirSync(full).sort();
        } catch (e) {
            return;
        }
        for (const name of names) {
            const child = paths.join(full, name);
            const childShown = `${shown}/${name}`;
            check(name, childShown);
            let st;
            try {
                st = fs.lstatSync(child);
            } catch (e) {
                continue;
            }
            if (st.isDirectory()) walk(child, childShown);
        }
    };
    const base = paths.basename(paths.resolve(dir));
    check(base, `Doors/${base}`);
    walk(dir, `Doors/${base}`);
    return warnings;
}

function openImage(image, options = {}) {
    if (!fs.existsSync(image)) throw new CommandError(`no such image: ${image}`);
    return AmigaVolume.openFile(image, options);
}

//  Write the image next to itself, then move it into place
function saveImage(vol, image) {
    const tmp = `${image}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, vol.toBuffer());
        fs.renameSync(tmp, image);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
    }
}

function amigaJoin(...parts) {
    return parts.filter(p => p && p.length).join('/');
}

//  Copy a local file or directory tree to `dst` in the volume. Keeps empty
//  files and directories and the files' modification times. Returns the
//  number of files written. `seen` catches two local names that are one
//  name to AmigaDOS (which ignores case).
function addToVolume(vol, src, dst, log = () => {}, seen = new Map()) {
    const st = fs.statSync(src);
    //  AmigaDOS folds a-z only (international mode is not used for door images)
    const key = splitPath(dst)
        .join('/')
        .replace(/[a-z]/g, c => c.toUpperCase());
    const clash = seen.get(key);
    if (clash !== undefined && clash !== src) {
        throw new CommandError(
            `${src} and ${clash} are the same name to AmigaDOS (${dst}), which ignores case`
        );
    }
    seen.set(key, src);

    if (st.isDirectory()) {
        vol.mkdir(dst);
        let count = 0;
        const names = fs.readdirSync(src).sort();
        for (const name of names) {
            const full = paths.join(src, name);
            let lst;
            try {
                lst = fs.lstatSync(full);
            } catch (e) {
                continue;
            }
            //  follow links to files; a linked directory could loop
            const target = lst.isSymbolicLink() ? safeStat(full) : lst;
            if (!target || (lst.isSymbolicLink() && target.isDirectory())) {
                log(`  skipped ${full} (a link to a directory, or dangling)`);
                continue;
            }
            if (!target.isDirectory() && !target.isFile()) {
                log(`  skipped ${full} (not a file or directory)`);
                continue;
            }
            count += addToVolume(vol, full, amigaJoin(dst, name), log, seen);
        }
        return count;
    }
    if (!st.isFile()) throw new CommandError(`not a file or directory: ${src}`);
    vol.writeFile(dst, fs.readFileSync(src), { date: st.mtime });
    log(`  ${dst} (${st.size} bytes)`);
    return 1;
}

function safeStat(p) {
    try {
        return fs.statSync(p);
    } catch (e) {
        return null;
    }
}

//  A name from the image, as a local file name. Amiga names cannot hold '/'
//  but may be '.', '..' or hold characters a local file system treats
//  specially; such an entry is not extracted.
function localName(name) {
    if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
        throw new CommandError(`refusing to extract an entry named "${name}"`);
    }
    return name;
}

//  Copy `src` out of the volume to the local path `dst` ("-" for stdout when
//  src is a file). Returns the number of files written.
function extractFromVolume(vol, src, dst, log = () => {}) {
    const st = vol.stat(src);
    if (st.type === 'softlink')
        throw new CommandError(`${src} is a soft link to ${st.target}`);
    if (st.type === 'file') {
        const data = vol.readFile(src);
        if (dst === '-') {
            process.stdout.write(data);
            return 1;
        }
        let out = dst;
        if (fs.existsSync(dst) && fs.statSync(dst).isDirectory()) {
            out = paths.join(dst, localName(st.name));
        }
        fs.writeFileSync(out, data);
        fs.utimesSync(out, st.date, st.date);
        log(`  ${out} (${data.length} bytes)`);
        return 1;
    }
    if (dst === '-') throw new CommandError(`${src || '/'} is a directory`);
    fs.mkdirSync(dst, { recursive: true });
    let count = 0;
    const dirs = [];
    for (const e of vol.list(src, { recursive: true })) {
        const rel = splitPath(e.path).slice(splitPath(src).length);
        const out = paths.join(dst, ...rel.map(localName));
        if (e.type === 'dir') {
            fs.mkdirSync(out, { recursive: true });
            dirs.push([out, e.date]);
        } else if (e.type === 'file') {
            fs.mkdirSync(paths.dirname(out), { recursive: true });
            fs.writeFileSync(out, vol.readFile(e.path));
            fs.utimesSync(out, e.date, e.date);
            log(`  ${out} (${e.size} bytes)`);
            count++;
        } else {
            log(`  skipped ${e.path} (soft link to ${e.target})`);
        }
    }
    //  directory times last: writing into a directory changes its time
    for (const [out, date] of dirs.reverse()) fs.utimesSync(out, date, date);
    return count;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatDate(d) {
    return (
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    );
}

function formatListing(entries) {
    return entries.map(e => {
        let size =
            e.type === 'dir' ? 'DIR' : e.type === 'softlink' ? 'LINK' : String(e.size);
        let line = `${e.protectionString}  ${size.padStart(10)}  ${formatDate(e.date)}  ${
            e.path
        }${e.type === 'dir' ? '/' : ''}`;
        if (e.type === 'softlink') line += ` -> ${e.target}`;
        if (e.comment) line += `  ; ${e.comment}`;
        return line;
    });
}

function files(n) {
    return n === 1 ? '1 file' : `${n} files`;
}

function kb(bytes) {
    return `${Math.round(bytes / 1024).toLocaleString()} KB`;
}

function summary(vol) {
    const i = vol.info();
    return `${i.name}: ${i.fileSystem}, ${kb(i.bytes)}, ${kb(i.freeBytes)} free`;
}

// ─── create ──────────────────────────────────────────────────────────────────

//  Build a door image in memory: the base files, the Workbench files when
//  `workbench` names an ADF, then each door directory as Doors/<name>/.
//  Returns the volume; the caller saves it.
function buildDoorImage(options, log = () => {}, warn = () => {}) {
    const size =
        typeof options.size === 'number' ? options.size : parseSize(options.size);
    const doors = options.doors || [];
    for (const d of doors) {
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
            throw new CommandError(`not a directory: ${d}`);
        }
    }
    for (const [src] of BASE_FILES) {
        if (!fs.existsSync(paths.join(AMIGA_DIR, src))) {
            throw new CommandError(`missing ${paths.join(AMIGA_DIR, src)}`);
        }
    }

    //  read the Workbench files first: a wrong disk fails before anything else
    let wbFiles = [];
    if (options.workbench) {
        if (!fs.existsSync(options.workbench)) {
            throw new CommandError(`no such Workbench disk image: ${options.workbench}`);
        }
        let wb;
        try {
            wb = AmigaVolume.openFile(options.workbench, { readOnly: true });
        } catch (e) {
            throw new CommandError(`${options.workbench}: ${e.message}`);
        }
        const missing = WORKBENCH_FILES.filter(p => !wb.exists(p));
        if (missing.length) {
            throw new CommandError(
                `not on ${options.workbench} (a Workbench 3.1 disk?): ${missing.join(', ')}`
            );
        }
        wbFiles = WORKBENCH_FILES.map(p => [p, wb.readFile(p), wb.stat(p)]);
    }

    const vol = AmigaVolume.create(size, { name: options.name || DEFAULT_NAME });
    const now = new Date();
    try {
        for (const dir of ['C', 'S', 'Libs', 'Doors']) vol.mkdir(dir);
        for (const [src, dst] of BASE_FILES) {
            vol.writeFile(dst, fs.readFileSync(paths.join(AMIGA_DIR, src)), {
                date: now,
            });
            log(`  ${dst}`);
        }
        if (wbFiles.length) {
            for (const [p, data, st] of wbFiles) {
                vol.writeFile(p, data, { date: st.date, protection: st.protection });
            }
            log(`  ${wbFiles.length} files from ${paths.basename(options.workbench)}`);
        }
        const seen = new Map();
        for (const d of doors) {
            const name = paths.basename(paths.resolve(d));
            const count = addToVolume(vol, d, `Doors/${name}`, () => {}, seen);
            log(`  Doors/${name}/ (${files(count)} from ${d})`);
            checkDoorNames(d).forEach(w => warn(w));
        }
    } catch (e) {
        if (e.code === 'ENOSPC') {
            throw new CommandError(
                `the doors do not fit in ${kb(size)}: give a larger --size (${e.message})`
            );
        }
        throw e;
    }
    return vol;
}

function cmdCreate(image) {
    const doors = []
        .concat(argv.doors === undefined || argv.doors === true ? [] : argv.doors)
        .concat(argv._.slice(3))
        .map(String);
    if (argv.doors === true) throw new CommandError('--doors needs a directory');
    if (fs.existsSync(image) && !argv.force) {
        throw new CommandError(`${image} exists (use --force to replace it)`);
    }
    const options = {
        size: argv.size === undefined ? DEFAULT_SIZE : argv.size,
        name: argv.name === undefined ? DEFAULT_NAME : String(argv.name),
        doors,
        workbench: argv.workbench ? String(argv.workbench) : null,
    };
    const size = parseSize(options.size);
    if (size > AROS_MAX_SIZE && !argv['allow-large']) {
        throw new CommandError(
            `${size / 1024}K is more than ${AROS_MAX_SIZE / 1024}K (${AROS_MAX_BLOCKS} blocks of 512 bytes): ` +
                'the AROS ROM that ENiGMA bundles corrupts an FFS volume of more than ' +
                `${AROS_MAX_BLOCKS} blocks when a door writes to it. Use ${AROS_MAX_SIZE / 1024}K ` +
                'or less, or pass --allow-large for an image used with Kickstart 3.1 ' +
                'or a ROM that carries the FFS fix'
        );
    }
    options.size = size;
    console.log(`Creating ${image} (${kb(size)}, volume ${options.name})`);
    const vol = buildDoorImage(
        options,
        line => console.log(line),
        line => console.error(`amiga-door: warning: ${line}`)
    );
    saveImage(vol, image);
    console.log(`\n${summary(vol)}\n`);
    formatListing(vol.list('', { recursive: true })).forEach(l => console.log(l));
    if (options.workbench) {
        console.log(
            '\nThis image holds Workbench files licensed to you: keep it on your own board.'
        );
    }
}

// ─── add / ls / extract / info ───────────────────────────────────────────────

function cmdAdd(image, src, dst) {
    if (!src) throw new CommandError('add needs a local file or directory');
    if (!fs.existsSync(src)) throw new CommandError(`no such file or directory: ${src}`);
    const vol = openImage(image);
    const base = paths.basename(paths.resolve(src));
    let target;
    if (dst === undefined || dst === '' || dst === '/' || /[:/]$/.test(dst)) {
        //  into the root or into the named directory
        target = amigaJoin(...splitPath(dst || ''), base);
    } else if (
        vol.exists(dst) &&
        vol.stat(dst).type === 'dir' &&
        !fs.statSync(src).isDirectory()
    ) {
        target = amigaJoin(...splitPath(dst), base);
    } else {
        target = splitPath(dst).join('/');
    }
    let count;
    try {
        count = addToVolume(vol, src, target, line => console.log(line));
    } catch (e) {
        if (e.code === 'ENOSPC') {
            throw new CommandError(`${image} is full: ${e.message}; nothing was written`);
        }
        throw e;
    }
    saveImage(vol, image);
    console.log(`${files(count)} added. ${summary(vol)}`);
}

function cmdLs(image, dir) {
    const vol = openImage(image, { readOnly: true });
    console.log(summary(vol));
    const entries = vol.list(dir || '', { recursive: true });
    if (entries.length === 0) console.log('  (empty)');
    formatListing(entries).forEach(l => console.log(l));
}

function cmdExtract(image, src, dst) {
    if (src === undefined || dst === undefined) {
        throw new CommandError(
            'extract needs a path in the image and a local destination'
        );
    }
    const vol = openImage(image, { readOnly: true });
    const log = dst === '-' ? () => {} : line => console.log(line);
    const count = extractFromVolume(vol, src, dst, log);
    if (dst !== '-') console.log(`${files(count)} extracted.`);
}

function cmdInfo(image) {
    const vol = openImage(image, { readOnly: true });
    const i = vol.info();
    const yes = b => (b ? 'yes' : 'no');
    console.log(`Volume:          ${i.name}`);
    console.log(
        `File system:     ${i.fileSystem} (${i.dosType}), international ${yes(
            i.international
        )}, directory cache ${yes(i.dirCache)}`
    );
    console.log(
        `Size:            ${i.bytes.toLocaleString()} bytes, ${i.blocks} blocks of ${i.blockSize}`
    );
    console.log(`Used:            ${i.usedBlocks} blocks`);
    console.log(`Free:            ${i.freeBlocks} blocks (${kb(i.freeBytes)})`);
    console.log(`Root block:      ${i.rootBlock}`);
    console.log(`Created:         ${formatDate(i.created)}`);
    console.log(`Last changed:    ${formatDate(i.modified)}`);
    console.log(
        `Files:           ${vol.list('', { recursive: true }).filter(e => e.type === 'file').length}`
    );
    if (i.bitmapRebuilt) {
        console.log(
            'Note:            the block bitmap was marked invalid (AmigaDOS had writes pending);'
        );
        console.log(
            '                 it is rebuilt from the directory tree when the image is changed'
        );
    }
    const problems = vol.check();
    if (problems.length) {
        console.log(`Problems:        ${problems.length}`);
        problems.slice(0, 10).forEach(p => console.log(`  ${p}`));
        process.exitCode = ExitCodes.ERROR;
    }
}

// ─── console ─────────────────────────────────────────────────────────────────

//  Boot IMAGE and play one door on this terminal. Mirrors `oputil v86 console`.
async function cmdConsole(image) {
    const { runConsole, formatExit, ConsoleError } = require('./oputil_amiga_console.js');
    const opts = {
        door: argv.door,
        type: argv.type,
        rom: argv.rom,
        ext: argv.ext,
        user: argv.user,
        location: argv.location,
        level: argv.level,
        timeleft: argv.timeleft,
        rows: argv.rows,
        cols: argv.cols,
        args: argv.args,
        mainline: argv.mainline,
        doorDir: argv['door-dir'],
        consoleMode: argv['console-mode'],
        encoding: argv.encoding,
        warp: argv.warp,
        persist: argv.persist, //  minimist: --no-persist makes it false
    };
    try {
        const res = await runConsole(image, opts);
        process.stderr.write('\x1b[0m\r\n');
        console.error(
            `amiga-door console: door exited\n  ${formatExit(res.status, res.keys).join('\n  ')}`
        );
        if (res.persisted) {
            console.error(
                `amiga-door console: saved to ${image} (${res.persisted.chunksWritten} changed chunks)`
            );
        } else {
            console.error(`amiga-door console: ${image} not changed (${res.reason})`);
        }
        if ('ok' !== res.status) process.exitCode = ExitCodes.ERROR;
    } catch (e) {
        if (e instanceof ConsoleError) {
            process.stderr.write('\x1b[0m\r\n');
            console.error(`amiga-door console: ${e.message}`);
            process.exitCode = ExitCodes.ERROR;
            return;
        }
        throw e;
    } finally {
        //  the emulator is gone; do not wait on anything left on the loop
        setImmediate(() => process.exit());
    }
}

// ─── entry point ─────────────────────────────────────────────────────────────

function handleAmigaDoorCommand() {
    if (argv.help) {
        return printUsageAndSetExitCode(getHelpFor('AmigaDoor'), ExitCodes.SUCCESS);
    }

    const action = argv._[1];
    const image = argv._[2] === undefined ? undefined : String(argv._[2]);
    if (!action || !image) {
        return printUsageAndSetExitCode(getHelpFor('AmigaDoor'), ExitCodes.BAD_ARGS);
    }
    const arg = i => (argv._[i] === undefined ? undefined : String(argv._[i]));

    try {
        switch (action) {
            case 'create':
                return cmdCreate(image);
            case 'add':
                return cmdAdd(image, arg(3), arg(4));
            case 'ls':
            case 'list':
                return cmdLs(image, arg(3));
            case 'extract':
                return cmdExtract(image, arg(3), arg(4));
            case 'info':
                return cmdInfo(image);
            case 'console':
                return cmdConsole(image);
            default:
                return printUsageAndSetExitCode(
                    getHelpFor('AmigaDoor'),
                    ExitCodes.BAD_COMMAND
                );
        }
    } catch (e) {
        if (
            e instanceof CommandError ||
            e.name === 'AmigaFsError' ||
            e.code === 'ENOENT'
        ) {
            console.error(`amiga-door: ${e.message}`);
            process.exitCode = ExitCodes.ERROR;
            return;
        }
        throw e;
    }
}
