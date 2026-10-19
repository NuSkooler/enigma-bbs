/* jslint node: true */
/* eslint-disable no-console */
'use strict';

/**
 * oputil_amiga_console.js: `oputil amiga-door console`, an interactive test
 * drive for one Amiga door, like `oputil v86 console`.
 *
 * Boots an image with enigma-vamiga in this process (no running ENiGMA, no
 * worker), sends the shim the `s` (session) frame a caller would get, puts the
 * terminal in raw mode and wires it to the emulated serial port: keystrokes
 * go to the door, the door's output comes back with the shim's control
 * frames removed, the Amiga console's CSI and form feed translated and the
 * text converted to UTF-8. The shim's `X` frame ends the session and its
 * summary is printed. Ctrl+] hangs up and quits.
 *
 * The image is the emulator's disk (enigma-vamiga 0.2.0's file-backed disk):
 * the door's writes go into it as the door makes them, and at the end, however
 * the session ended, the image is synced. --no-persist keeps every write in the
 * emulator, so the image is left exactly as it was.
 *
 * Mirrors core/amiga_door/amiga_worker.js (boot, hello, `s`, the final sync).
 */

const protocol = require('../amiga_door/protocol.js');
const { HostLink, AmigaConsoleTranslator } = require('../amiga_door/host_link.js');
const { checkPackage } = require('../amiga_door/vamiga_package.js');

const fs = require('fs');
const iconv = require('iconv-lite');

//  The types every shim knows. Any other name (tim, cnetrexx, ...) is passed
//  on: the shim on the image runs it if it supports it, and otherwise ends
//  the session with error=unknown door type.
const DOOR_TYPES = ['xim', 'cli', 'aim'];
const DOOR_TYPE_NAME = /^[a-z][a-z0-9]{0,15}$/;
const CONSOLE_MODES = ['cooked', 'raw'];
const QUIT_KEY = 0x1d; //  Ctrl+]

//  as amiga_worker.js
const SettleFrames = 150;
const DefaultWarpBootSeconds = 30;
const BootTimeoutMs = 180 * 1000;
const HangupWaitMs = 15 * 1000;
const MaxInputQueueBytes = 64 * 1024;

class ConsoleError extends Error {}

exports.ConsoleError = ConsoleError;
exports.buildConsoleSession = buildConsoleSession;
exports.runConsole = runConsole;
exports.DOOR_TYPES = DOOR_TYPES;
exports.formatExit = formatExit;
exports.formatDisk = formatDisk;

//  The `s` frame keys for a test caller. `opts` are oputil's options, all
//  optional apart from `door`.
function buildConsoleSession(opts, now = Date.now()) {
    const door = opts.door === undefined || opts.door === true ? '' : String(opts.door);
    if (!door) {
        throw new ConsoleError(
            'console needs --door PATH (e.g. --door BBS:Doors/X/x.xim)'
        );
    }
    const type =
        opts.type === undefined ? 'xim' : opts.type === true ? '' : String(opts.type);
    if (!DOOR_TYPE_NAME.test(type)) {
        throw new ConsoleError(
            `--type must be a door type: ${DOOR_TYPES.join(', ')} or another type ` +
                'the shim on the image supports'
        );
    }
    const mode = opts.consoleMode === undefined ? 'cooked' : String(opts.consoleMode);
    if (!CONSOLE_MODES.includes(mode)) {
        throw new ConsoleError(
            `--console-mode must be one of ${CONSOLE_MODES.join(', ')}`
        );
    }
    const int = (name, value, dflt, min, max) => {
        if (value === undefined) return dflt;
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) {
            throw new ConsoleError(
                `--${name} must be a whole number from ${min} to ${max}`
            );
        }
        return n;
    };
    const text = (name, value, dflt) => {
        if (value === undefined) return dflt;
        if (value === true) throw new ConsoleError(`--${name} needs a value`);
        return String(value);
    };

    const name = text('user', opts.user, 'Test Caller');
    const timeleft = int('timeleft', opts.timeleft, 60, 0, 546);
    const keys = {
        version: protocol.PROTOCOL_VERSION,
        type,
        console: 'cli' === type ? mode : undefined,
        door,
        dir: text('door-dir', opts.doorDir, undefined),
        args: text('args', opts.args, undefined),
        node: 1,
        slot: 1,
        name,
        realname: name,
        location: text('location', opts.location, 'Nowhere'),
        level: int('level', opts.level, 10, 0, 255),
        timeleft,
        timeused: 0,
        timelimit: timeleft,
        calls: 1,
        posts: 0,
        uploads: 0,
        downloads: 0,
        ulbytes: 0,
        dlbytes: 0,
        expert: 0,
        ansi: 1,
        rows: int('rows', opts.rows, 24, 1, 255),
        cols: int('cols', opts.cols, 80, 1, 255),
        bbsname: 'ENiGMA console',
        sysop: 'SysOp',
        mainline: text('mainline', opts.mainline, ''),
        log: 0,
        crlf: 1,
        tz: -new Date(now).getTimezoneOffset(),
        now: Math.floor(now / 1000),
    };
    for (const k of Object.keys(keys)) {
        if (undefined === keys[k]) delete keys[k];
    }
    return keys;
}

//  "status=ok cmds=131 ..." from the X frame's keys, one per line
function formatExit(status, keys) {
    const lines = [`status: ${status}`];
    for (const k of Object.keys(keys || {}).sort()) {
        if ('status' !== k && '' !== keys[k]) lines.push(`${k}: ${keys[k]}`);
    }
    return lines;
}

//
//  What became of the image, one line: |disk| is runConsole()'s, null with
//  --no-persist, else { writes, bytes, error } (the core's writes into the
//  file over the whole run, and why the final sync failed if it did).
//
function formatDisk(image, disk) {
    if (!disk) {
        return `${image} not changed (--no-persist)`;
    }
    const kb = n => `${Math.round(n / 1024)} KB`;
    if (disk.error) {
        return (
            `${image}: the final sync FAILED (${disk.error}); it holds what reached it ` +
            `before (${disk.writes} writes, ${kb(disk.bytes)})`
        );
    }
    if (!disk.writes) {
        return `${image} not changed (the door wrote nothing to its disk)`;
    }
    return `${image} written as the door went: ${disk.writes} writes, ${kb(disk.bytes)}, synced`;
}

//  Resolves with { status, keys, disk, reason } (see formatDisk() for
//  |disk|). Rejects with a ConsoleError for anything that stops the drive
//  before the door ends; the image is synced either way.
async function runConsole(image, opts = {}, io = {}) {
    const stdin = io.stdin || process.stdin;
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    const say = line => stderr.write(`amiga-door console: ${line}\r\n`);

    if (!fs.existsSync(image)) throw new ConsoleError(`no such image: ${image}`);
    const encoding = opts.encoding === undefined ? 'latin1' : String(opts.encoding);
    if (!iconv.encodingExists(encoding)) {
        throw new ConsoleError(
            `--encoding "${encoding}" is not an encoding iconv-lite knows`
        );
    }
    const rows = opts.rows !== undefined ? Number(opts.rows) : stdout.rows || 24;
    const cols = opts.cols !== undefined ? Number(opts.cols) : stdout.columns || 80;
    const session = buildConsoleSession(Object.assign({}, opts, { rows, cols }));
    const persist = false !== opts.persist;
    const warpBootSeconds =
        opts.warp === undefined ? DefaultWarpBootSeconds : Number(opts.warp);
    if (
        !Number.isInteger(warpBootSeconds) ||
        warpBootSeconds < 0 ||
        warpBootSeconds > 3600
    ) {
        throw new ConsoleError('--warp must be a whole number of seconds from 0 to 3600');
    }

    const vamiga = checkPackage();
    if (vamiga.problem) {
        throw new ConsoleError(vamiga.problem);
    }
    const { VAmiga, Pacer } = require('enigma-vamiga');

    let emu;
    try {
        emu = await VAmiga.create({
            //  the image is the disk; --no-persist keeps the writes in the emulator
            hdf: { path: image, mode: 'file' },
            writeThrough: persist ? 'onIdle' : 'never',
            rom: opts.rom ? String(opts.rom) : undefined,
            ext: opts.ext ? String(opts.ext) : undefined,
            warpBootSeconds,
        });
    } catch (e) {
        throw new ConsoleError(e.message);
    }

    return new Promise((resolve, reject) => {
        const link = new HostLink();
        const translator = new AmigaConsoleTranslator({ rows, cols });
        let state = 'booting'; //  booting | warpEnding | session | exited | done
        let inQueue = Buffer.alloc(0);
        let pacer = null;
        let rawWasSet = false;
        let hangupTimer = null;
        let bootTimer = null;

        const queue = bytes => {
            if (inQueue.length + bytes.length > MaxInputQueueBytes) return;
            inQueue = inQueue.length
                ? Buffer.concat([inQueue, bytes])
                : Buffer.from(bytes);
        };

        const restoreTerminal = () => {
            clearTimeout(hangupTimer);
            clearTimeout(bootTimer);
            if (rawWasSet) {
                try {
                    stdin.setRawMode(false);
                } catch (e) {
                    //  gone already
                }
            }
            stdin.removeListener('data', onKey);
            stdin.removeListener('end', onStdinEnd);
            stdout.removeListener('resize', onResize);
            stdin.pause();
        };

        //
        //  However the session ends: let the guest's file system write back
        //  what it buffers, then have the core write the rest into the image
        //  and fsync it. Most of the door's writes are there already
        //  (write-through on idle). Nothing with --no-persist.
        //
        const syncDisk = () => {
            if (!persist) return null;
            try {
                emu.runFrames(SettleFrames);
                emu.serialRead();
            } catch (e) {
                //  a halted machine: sync what the core has
            }
            let error;
            try {
                emu.hdfSync();
            } catch (e) {
                error = e.message;
            }
            const { writes, bytes } = emu.hdfWriteStats;
            return { writes, bytes, error };
        };

        const finish = (err, result) => {
            if ('done' === state) return;
            state = 'done';
            try {
                if (pacer) pacer.stop();
            } catch (e) {
                //  going away
            }
            restoreTerminal();
            const flush = translator.flush();
            if (flush.length) stdout.write(iconv.decode(flush, encoding));
            let disk = null;
            try {
                disk = syncDisk();
            } catch (e) {
                disk = { writes: 0, bytes: 0, error: e.message };
            }
            try {
                emu.destroy();
            } catch (e) {
                //  going away
            }
            if (err) {
                say(formatDisk(image, disk));
                reject(err instanceof ConsoleError ? err : new ConsoleError(err.message));
            } else {
                resolve(Object.assign({ disk }, result));
            }
        };

        const onExit = frame => {
            state = 'exited';
            inQueue = Buffer.alloc(0);
            //  let the last output reach the terminal first
            setImmediate(() =>
                finish(null, {
                    status: frame.keys.status,
                    keys: frame.keys,
                    reason: null,
                })
            );
        };

        const startSession = () => {
            state = 'session';
            clearTimeout(bootTimer);
            //  typeahead from the boot goes after `s`
            const keys = Object.assign({}, session, {
                now: Math.floor(Date.now() / 1000),
            });
            inQueue = Buffer.concat([protocol.encode('s', keys), inQueue]);
            say(`shim ready, starting ${session.door}; Ctrl+] hangs up and quits`);
        };

        const handleFrame = frame => {
            if ('R' === frame.type && 'booting' === state) {
                //  as the worker: end the warp boot, run a frame at real speed
                emu.setOption('AMIGA.WARP_BOOT', 0);
                state = 'warpEnding';
            } else if ('X' === frame.type) {
                onExit(frame);
            }
            //  H, L, C, E and the rest are control frames: not shown
        };

        const onFrame = ({ warping }) => {
            const out = emu.serialRead();
            const shown = [];
            for (const e of link.push(out)) {
                if (e.frame) handleFrame(e.frame);
                else if ('session' === state) shown.push(e.data);
            }
            if (shown.length) {
                const bytes = translator.push(Buffer.concat(shown));
                if (bytes.length) stdout.write(iconv.decode(bytes, encoding));
            }
            if ('warpEnding' === state && !warping) startSession();
            if ('session' === state && inQueue.length) {
                const n = emu.serialWrite(inQueue);
                inQueue = n >= inQueue.length ? Buffer.alloc(0) : inQueue.subarray(n);
            }
        };

        const hangup = why => {
            if ('session' !== state) {
                if ('booting' === state || 'warpEnding' === state) {
                    return finish(null, {
                        status: 'aborted',
                        keys: {},
                        reason: why,
                    });
                }
                return;
            }
            say(`${why}: hanging up`);
            //  as the worker's `d`: the caller's queued input is moot
            inQueue = Buffer.from(protocol.encode('d', { reason: 'hangup' }));
            hangupTimer = setTimeout(
                () =>
                    finish(null, {
                        status: 'aborted',
                        keys: {},
                        reason: `no X within ${HangupWaitMs / 1000} s of the hangup`,
                    }),
                HangupWaitMs
            );
        };

        function onKey(data) {
            if (data.includes(QUIT_KEY)) return hangup('Ctrl+]');
            if ('session' === state || 'warpEnding' === state || 'booting' === state) {
                queue(protocol.escapeData(Buffer.from(data)));
            }
        }
        function onStdinEnd() {
            hangup('end of input');
        }
        function onResize() {
            const r = stdout.rows || rows;
            const c = stdout.columns || cols;
            translator.setSize(r, c);
            if ('session' === state) queue(protocol.encode('w', { rows: r, cols: c }));
        }

        emu.on('message', m => {
            if ('CPU_HALT' === m.name)
                finish(new ConsoleError('the emulated CPU halted'));
        });

        say(`booting ${image}${warpBootSeconds ? ` (warp ${warpBootSeconds} s)` : ''}`);
        if (stdin.isTTY && stdin.setRawMode) {
            stdin.setRawMode(true);
            rawWasSet = true;
        }
        stdin.on('data', onKey);
        stdin.on('end', onStdinEnd);
        stdout.on('resize', onResize);
        stdin.resume();

        bootTimer = setTimeout(
            () =>
                finish(
                    new ConsoleError(
                        `the shim did not report ready within ${BootTimeoutMs / 1000} s`
                    )
                ),
            BootTimeoutMs
        );

        emu.powerOn();
        pacer = new Pacer(emu, {
            onFrame,
            onError: err => finish(err),
        }).start();
    });
}
