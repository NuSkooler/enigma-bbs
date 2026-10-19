/* jslint node: true */
'use strict';

/**
 * amiga_door.js — ENiGMA½ Amiga door emulation module
 *
 * Runs an AmiExpress (/X) XIM door, an /X ARexx (AIM) door, a Paragon (TIM)
 * door or a plain AmigaDOS CLI (stdio) door inside an embedded Amiga emulator (enigma-vamiga, the vAmiga core as
 * WebAssembly) in a worker thread, and bridges the caller to it. No external
 * emulator, Kickstart or Workbench is required: the emulator package bundles
 * the AROS ROM.
 *
 * Amiga doors are clients of a live BBS node, not standalone programs, so the
 * door image boots a small host shim (axshim, misc/amiga_door/) that
 * impersonates an /X node for the door. ENiGMA hands the shim the user block
 * over the emulated serial port when the session starts (the drop file
 * analogue) and gets an exit report back; see
 * core/amiga_door/protocol.js and misc/amiga_door/README.md (Protocol).
 *
 * A CLI door (doorType: 'cli') reads and writes its standard input and
 * output; the shim is the console handler behind them.
 * Such a door gets no user block: what it knows about the caller is what
 * doorArgs passes on its command line ({name}, {node}, {level}, {timeleft}).
 *
 * An ARexx door (doorType: 'aim', /X's TYPE=AIM) is a script the shim runs
 * with RX, publishing AmiExpress's AERexxControl<node> host port and answering
 * its GETUSER/TRANSMIT/QUERY/... commands from the same user block as XIM
 * doors. It needs ARexx inside the image, which AROS
 * does not have: the image must be built with the sysop's own Workbench 3.1
 * (misc/amiga_door/image/make_image.sh -w).
 *
 * A Paragon door (doorType: 'tim'; Paragon, StarNet and MAX's BBS doors, /X's
 * TYPE=TIM) sends its requests to the BBS's DoorControl<line> port, which the
 * shim publishes; it gets the same user block as an XIM door. Its install
 * notes often ask for an assign or an ENV: variable: |assigns| and |env|.
 *
 * A C-Net ARexx door (doorType: 'cnetrexx', a C-Net Amiga ARexx pfile) is a
 * script the shim hands to ARexx with C-Net's port CNETREXX<node - 1> as its
 * host, answering C-Net's TRANSMIT/GETUSER/PROMPT/... commands and MCI codes
 * from the same user block. Like an AIM door it needs the sysop's Workbench
 * ARexx in the image; pfiles expect PFILES: (and CNET:) assigns, which the
 * shim makes when the image has SYS:PFiles (SYS:CNet), or |assigns|.
 *
 * Sessions restore a snapshot of the booted machine (tens of milliseconds);
 * the first session of a door boots it and fills the snapshot cache.
 * Persistence is "Model A": after a clean door exit the disk chunks the
 * session changed are written into a copy of the image, which is renamed over
 * it, and the door's snapshots are dropped. Sessions are independent copies of
 * the disk, so a persisting session holds its image (activeImages): a second
 * persisting session on the same image, of any door, is refused as nodeMax
 * refuses.
 *
 * Config (menu.hjson):
 *   module: amiga_door
 *   config: {
 *     name:               string   - door name (required; instance tracking key)
 *     image:              string   - path to the door's HDF image (required)
 *     door:               string   - Amiga path of the door executable inside the
 *                                    image (required), e.g. BBS:Doors/DreamSweeper/dreamsweeper.xim
 *     doorType:           string   - xim | aim | tim | cnetrexx | cli (default: xim). xim: an
 *                                    /X door that talks to AEDoorPort<node>; aim: an /X ARexx
 *                                    script (door = the script's Amiga path, run as RX <door>
 *                                    <node>; the image needs ARexx); tim: a Paragon door that
 *                                    talks to DoorControl<line>, run as <door> <line> (line =
 *                                    the node's last digit); cnetrexx: a C-Net ARexx pfile (door
 *                                    = the script's Amiga path, hosted by CNETREXX<node - 1>; the
 *                                    image needs ARexx); cli: a program on Input()/Output()
 *     consoleMode:        string   - cli only: cooked | raw, the console's mode until the
 *                                    door calls SetMode() itself (default: cooked)
 *     doorDir:            string   - door's current directory (default: its own)
 *     doorStack:          number   - door stack size in bytes (default: 32768)
 *     doorArgs:           string   - xim, aim: extra arguments after the node number; tim:
 *                                    after the line; cnetrexx: the script's arguments (C-Net
 *                                    gave pfiles none); cli: the door's whole argument line.
 *                                    {name}, {node}, {level} and {timeleft} are replaced
 *                                    ({name} as one quoted argument)
 *     assigns:            object   - { NAME: 'PATH' }: assigns NAME: for the session, before the
 *                                    door's path is checked (e.g. { MSE: 'BBS:Doors/MSE' })
 *     env:                object   - { NAME: 'value' }: sets the global variable ENV:NAME for
 *                                    the session (ENV: is made in RAM: if the image has none)
 *     panicGraceSeconds:  number   - cnetrexx: seconds from carrier loss (###PANIC) to the
 *                                    script's CTRL-C, 0..25 (default: 10); 0 breaks it before
 *                                    its waiting command is answered (doors that would save
 *                                    "###PANIC" as a player name)
 *     wordWrap:           boolean  - cnetrexx: word-wrap the door's text at the caller's width,
 *                                    as C-Net did (default: true)
 *     mainline:           string   - the /X command line the caller "typed" (BB_MAINLINE;
 *                                    some doors parse it, e.g. Wallhall); default empty
 *     rom:                string   - Kickstart ROM path (default: bundled AROS)
 *     extRom:             string   - extension ROM path (default: bundled AROS ext with
 *                                    the bundled ROM, none otherwise)
 *     cpu:                string   - 68000 | 68010 | 68EC020 (default: 68EC020)
 *     chipKb:             number   - 256 | 512 | 1024 | 2048 (default: 512)
 *     slowKb:             number   - 0..1536, multiple of 256 (default: 512)
 *     fastKb:             number   - 0..8192, multiple of 64 (default: 8192)
 *     overclock:          number   - 1..16 (default: 1)
 *     nodeMax:            number   - max concurrent sessions, 0 = unlimited (default: 0);
 *                                    a persisting door is also one session per image
 *     sharedState:        boolean  - the door writes state all callers share; makes
 *                                    nodeMax 1 when nodeMax is not set (default: false)
 *     tooManyArt:         string   - art shown when nodeMax is reached or the image is busy
 *     minTimeLeftMinutes: number   - refuse to start with less time left today
 *     notEnoughTimeArt:   string   - art shown when minTimeLeftMinutes refuses
 *     encoding:           string   - door output encoding (default: latin1)
 *     amigaConsole:       boolean  - translate Amiga console controls (0x9B, form feed,
 *                                    cursor on/off, off-screen positions) for a PC
 *                                    terminal (default: true with a Latin-1 encoding)
 *     font:               string   - SyncTERM font for the door's duration (default:
 *                                    topaz); 'none' leaves the caller's font alone
 *     persist:            boolean  - write the door's disk changes back (default: true)
 *     persistOn:          [string] - X statuses after which to persist (default: ['ok'] for
 *                                    doorType cli, aim, tim and cnetrexx, ['ok', 'carrier']
 *                                    for xim; an explicit list always wins). carrier,
 *                                    timeout and break persist only when the door ended by
 *                                    itself (the X frame's rc is its return code; -1 or none
 *                                    means the shim gave up on a door still running)
 *     log:                boolean  - log every door request at debug level (default: false)
 *     warpBootSeconds:    number   - first boot runs flat out this long (default: 30)
 *     regTimeoutSeconds:  number   - the door must register (tim: send its first request)
 *                                    within this; 0 = forever (default: 30)
 *     disconnectGraceSeconds: number - after a hangup, time-up or break, how long to wait for
 *                                    the door to finish and the shim to say X before the
 *                                    worker is dropped unsaved (default: 35; the shim's own
 *                                    grace is 30)
 *     inputTimeoutSeconds:number   - a door waiting this long for a key gives up
 *                                    (default: users.idleLogoutSeconds, or the shim's 300)
 *     crlf:               boolean  - LF in door output goes out as CR LF (default: true)
 *     timezoneMinutes:    number   - minutes east of UTC for the Amiga clock (default: host's)
 *   }
 *
 * System settings: doors.amiga.snapshotCacheEntries (config_default.js).
 */

const { MenuModule } = require('../menu_module.js');
const { Errors } = require('../enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('../door_util.js');
const Door = require('../door.js');
const theme = require('../theme.js');
const ansi = require('../ansi_term.js');
const UserTime = require('../user_time.js');
const UserProps = require('../user_property.js');
const Events = require('../events.js');
const protocol = require('./protocol.js');
const { AmigaConsoleTranslator } = require('./host_link.js');
const { SnapshotCache, DefaultMaxEntries } = require('./snapshot_cache.js');

//  Late bound: config.js replaces its |get| when the system configuration is
//  created, so capturing it at require time would pin whichever was first.
const configModule = require('../config.js');
const Config = () => configModule.get();

//  deps
const async = require('async');
const _ = require('lodash');
const paths = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const WORKER_PATH = paths.join(__dirname, 'amiga_worker.js');

//  shim protocol v1: no X within disconnectGraceSeconds of `d` ->
//  drop the worker. The shim gives the door 30 s (CARRIER_GRACE in axshim.c)
//  and then reports X itself; the default leaves room for that X to arrive.
const ShimCarrierGraceSeconds = 30;
//  boot (warp) or restore to the shim having been sent `s`
const ReadyTimeoutMs = 60 * 1000;
//  the worker settles 3 s of Amiga time, copies the image and writes a few
//  chunks; generous. Past it the caller moves on, but the worker is never
//  stopped mid-write: it gets until PersistAbandonMs to finish.
const PersistTimeoutMs = 30 * 1000;
const PersistAbandonMs = 5 * 60 * 1000;
const ResizePollMs = 1000;
const TimePollMs = 5000;
const BackpressurePollMs = 50;

//  The same ceiling drop files use (dropfile.js MaxDropFileMinutes): /X keeps
//  time in seconds, and 546 x 60 fits a signed 16-bit field.
const MaxDoorMinutes = 546;

const CPU_MODELS = ['68000', '68010', '68EC020']; //  enigma-vamiga's CPU_MODELS
const DOOR_TYPES = ['xim', 'aim', 'tim', 'cnetrexx', 'cli'];
//  the ARexx door types: the script's path is the first word of a command line
//  (RX's through the Amiga shell for aim, ARexx's own for cnetrexx)
const SCRIPT_DOOR_TYPES = ['aim', 'cnetrexx'];
//  an ARexx door's script goes on a command line: an absolute Amiga path
//  (VOLUME:dir/file) with no blanks, quotes or shell characters
const AmigaScriptPath = /^[^\s":;<>|*`$]+:[^\s":;<>|*`$]*[^\s":;<>|*`$/]$/;
//  an XIM or CLI door's path goes on the command line in quotes: nothing that
//  ends the quotes, is the shell's escape character or substitutes
const QuotedPathUnsafe = /["*`$;<>|]/;
//  control characters, C0 and C1, which no session value may carry
const ControlChars = /[\x00-\x1f\x7f-\x9f]/;
const CONSOLE_MODES = ['cooked', 'raw'];
//  assigns / env names: what the shim takes (AssignLock / SetVar), no ':' '/' ';' '='
const AmigaName = /^[A-Za-z0-9_.-]{1,30}$/;
//  The shim's buffers (axshim.c): a session value keeps 199 bytes (kv val[200]),
//  the door's command line 299 (LN.cmd[300]) and an ARexx door's runs RX_CMD.
const MaxValueLength = 199;
const MaxCommandLength = 299;
const RxCommand = 'SYS:Rexxc/RX';
//  For checking doorArgs at config time: the widest {node}, {level} and
//  {timeleft} can be, and the least room {name} must have (quotes and a few
//  characters; it is cut to fit at session time)
const PlaceholderWidths = { node: 5, level: 5, timeleft: 3, name: 10 };
const CHIP_KB = [256, 512, 1024, 2048];
const EXIT_STATUSES = ['ok', 'carrier', 'timeout', 'break', 'error'];

//  Every key this module reads from its config block (see the header)...
const ConfigKeys = [
    'name',
    'image',
    'door',
    'doorType',
    'consoleMode',
    'doorDir',
    'doorStack',
    'doorArgs',
    'assigns',
    'env',
    'panicGraceSeconds',
    'wordWrap',
    'mainline',
    'rom',
    'extRom',
    'cpu',
    'chipKb',
    'slowKb',
    'fastKb',
    'overclock',
    'nodeMax',
    'sharedState',
    'tooManyArt',
    'minTimeLeftMinutes',
    'notEnoughTimeArt',
    'encoding',
    'amigaConsole',
    'font',
    'persist',
    'persistOn',
    'log',
    'warpBootSeconds',
    'regTimeoutSeconds',
    'disconnectGraceSeconds',
    'inputTimeoutSeconds',
    'crlf',
    'timezoneMinutes',
];
//  ...and the ones MenuModule reads from any menu's config block
const MenuConfigKeys = [
    'cls',
    'interrupt',
    'menuFlags',
    'art',
    'encodedAs',
    'nextTimeout',
    'pause',
    'pausePosition',
    'pausePrompt',
    'dateFormat',
    'dateTimeFormat',
    'timeFormat',
];

const Defaults = {
    doorType: 'xim',
    consoleMode: 'cooked',
    cpu: '68EC020',
    chipKb: 512,
    slowKb: 512,
    fastKb: 8192,
    overclock: 1,
    nodeMax: 0,
    encoding: 'latin1',
    font: 'topaz',
    persist: true,
    persistOn: ['ok', 'carrier'],
    sharedState: false,
    log: false,
    warpBootSeconds: 30,
    regTimeoutSeconds: 30,
    disconnectGraceSeconds: ShimCarrierGraceSeconds + 5,
    crlf: true,
};

//  Track active instances per door name (mirrors abracadabra / v86_door)
const activeDoorInstances = {};

//  Booted-machine snapshots shared by every session in this process
const snapshotCache = new SnapshotCache();

//
//  Images held by a persisting session: real path -> { name, node }. A
//  session that persists writes back the chunks that differ from the disk it
//  started with; two of them on one image would each undo the other's
//  directory and allocation blocks. So while one runs, every other persisting
//  session on that image -- of any door -- is refused.
//
const activeImages = new Map();

//  enigma-vamiga's compiled WebAssembly module, compiled once per process
let compiledModulePromise = null;

function getCompiledModule() {
    if (!compiledModulePromise) {
        compiledModulePromise = Promise.resolve()
            .then(() => require('enigma-vamiga').VAmiga.compile())
            .catch(err => {
                compiledModulePromise = null; //  let a later session try again
                throw err;
            });
    }
    return compiledModulePromise;
}

function imageKey(image) {
    try {
        return fs.realpathSync(image);
    } catch (e) {
        return paths.resolve(image);
    }
}

function snapshotCacheEntries() {
    const n = _.get(Config(), 'doors.amiga.snapshotCacheEntries');
    return Number.isInteger(n) && n >= 0 ? n : DefaultMaxEntries;
}

// ─── Config ───────────────────────────────────────────────────────────────────

//  Minutes east of UTC, as the shim's `tz` wants it
function hostTimezoneMinutes() {
    return -new Date().getTimezoneOffset();
}

function isLatin1(encoding) {
    const e = String(encoding || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    return ['latin1', 'iso88591', 'l1', 'binary', 'cp819', 'ibm819'].includes(e);
}

//
//  Validate a door's config block and fill in defaults. Returns
//  { config, problems, warnings }: |problems| lists everything wrong (empty
//  when the config is usable), so a sysop sees every mistake in one log line;
//  |warnings| lists keys nothing reads, with a likely meaning when there is
//  one (a misspelt persistOn is otherwise silently the default).
//
//  A CLI, ARexx, Paragon or C-Net door is sent a break on a hangup, so a
//  return code does not prove it finished its writes; an XIM door only sees
//  carrier-lost replies to its input requests. Hence 'carrier' is a default
//  persistOn status for XIM doors only.
//
const DefaultPersistOn = {
    xim: ['ok', 'carrier'],
    cli: ['ok'],
    aim: ['ok'],
    tim: ['ok'],
    cnetrexx: ['ok'],
};
const AROS_MAX_FFS_BLOCKS = 4066;

function normalizeConfig(raw) {
    const c = Object.assign({}, raw || {});
    const problems = [];
    const warnings = [];
    const rawCpu = c.cpu;

    const unknown = Object.keys(c).filter(
        k => !k.startsWith('_') && !ConfigKeys.includes(k) && !MenuConfigKeys.includes(k)
    );
    if (unknown.length > 0) {
        //  late: only needed when there is something to say
        const { suggestKey } = require('../config/validate.js');
        for (const key of unknown) {
            const near = suggestKey(key, ConfigKeys);
            warnings.push(
                near
                    ? `unknown key "${key}"; did you mean "${near}"?`
                    : `unknown key "${key}"`
            );
        }
    }

    const isInt = v => Number.isInteger(v);
    const intIn = (key, min, max, extra) => {
        const v = c[key];
        if (!isInt(v) || v < min || v > max || (extra && !extra(v))) {
            return false;
        }
        return true;
    };

    for (const key of ['name', 'image', 'door']) {
        if (!_.isString(c[key]) || 0 === c[key].trim().length) {
            problems.push(`"${key}" is required (a string)`);
        }
    }

    //  door type
    if (undefined === c.doorType) {
        c.doorType = Defaults.doorType;
    } else if (!DOOR_TYPES.includes(c.doorType)) {
        problems.push(`"doorType" must be one of ${DOOR_TYPES.join(', ')}`);
    }
    if (undefined === c.consoleMode) {
        c.consoleMode = Defaults.consoleMode;
    } else if (!CONSOLE_MODES.includes(c.consoleMode)) {
        problems.push(`"consoleMode" must be one of ${CONSOLE_MODES.join(', ')}`);
    } else if ('cli' !== c.doorType) {
        problems.push('"consoleMode" applies to doorType "cli" only');
    }
    if (
        SCRIPT_DOOR_TYPES.includes(c.doorType) &&
        _.isString(c.door) &&
        !AmigaScriptPath.test(c.door)
    ) {
        problems.push(
            `"door" for doorType "${c.doorType}" must be the script's absolute Amiga path ` +
                '(e.g. BBS:Doors/KickBox.Rexx) without blanks, quotes or shell characters'
        );
    }
    for (const key of ['panicGraceSeconds', 'wordWrap']) {
        if (undefined !== c[key] && 'cnetrexx' !== c.doorType) {
            problems.push(`"${key}" applies to doorType "cnetrexx" only`);
        }
    }
    if (undefined !== c.panicGraceSeconds && !intIn('panicGraceSeconds', 0, 25)) {
        problems.push('"panicGraceSeconds" must be an integer from 0 to 25');
    }
    if (undefined !== c.wordWrap && !_.isBoolean(c.wordWrap)) {
        problems.push('"wordWrap" must be true or false');
    }

    for (const key of [
        'doorDir',
        'doorArgs',
        'mainline',
        'rom',
        'extRom',
        'tooManyArt',
        'notEnoughTimeArt',
    ]) {
        if (undefined !== c[key] && !_.isString(c[key])) {
            problems.push(`"${key}" must be a string`);
        }
    }

    //  everything that ends up in the `s` frame must be a single line of
    //  Latin-1 that fits the shim's value buffer
    for (const key of ['door', 'doorDir', 'doorArgs', 'mainline']) {
        if (!_.isString(c[key])) {
            continue;
        }
        if (/[\r\n]/.test(c[key])) {
            problems.push(`"${key}" must not contain a line break`);
        } else if (ControlChars.test(c[key])) {
            problems.push(`"${key}" must not contain control characters`);
        }
        if (/[^\x00-\xff]/.test(c[key])) {
            problems.push(`"${key}" must be ISO-8859-1 (Latin-1) text`);
        }
        //  doorArgs: checked filled in, below
        if ('doorArgs' !== key && c[key].length > MaxValueLength) {
            problems.push(
                `"${key}" is longer than the shim's ${MaxValueLength} characters`
            );
        }
    }
    if (
        ['xim', 'tim', 'cli'].includes(c.doorType) &&
        _.isString(c.door) &&
        QuotedPathUnsafe.test(c.door)
    ) {
        problems.push(
            '"door" must not contain the Amiga shell characters " * ` $ ; < > |'
        );
    }

    if (_.isString(c.doorArgs)) {
        const unknown = (c.doorArgs.match(/\{[^}]*\}/g) || []).filter(
            p => !Object.prototype.hasOwnProperty.call(ArgSubstitutions, p.slice(1, -1))
        );
        if (unknown.length > 0) {
            problems.push(
                `"doorArgs" has unknown placeholders ${unknown.join(' ')} (known: ${Object.keys(
                    ArgSubstitutions
                )
                    .map(k => `{${k}}`)
                    .join(' ')})`
            );
        } else if (_.isString(c.door) && DOOR_TYPES.includes(c.doorType)) {
            //  at its shortest, with every placeholder filled in
            const least = c.doorArgs.replace(/\{([a-z]+)\}/g, (m, key) =>
                'x'.repeat(PlaceholderWidths[key])
            );
            const command = commandLength(c, least, 'x'.repeat(PlaceholderWidths.node));
            if (least.length > MaxValueLength || command > MaxCommandLength) {
                problems.push(
                    `"door" and "doorArgs" make a command line of at least ${command} characters ` +
                        `(arguments ${least.length}) with the placeholders filled in; the shim takes ` +
                        `${MaxCommandLength} (arguments ${MaxValueLength})`
                );
            }
        }
    }

    //  assigns and env: NAME=VALUE pairs joined with ';' into one `s` value
    for (const [key, what] of [
        ['assigns', 'an Amiga path'],
        ['env', 'a value'],
    ]) {
        const v = c[key];
        if (undefined === v) {
            continue;
        }
        if (!_.isPlainObject(v)) {
            problems.push(`"${key}" must be an object of NAME: ${what}`);
            continue;
        }
        for (const [name, value] of Object.entries(v)) {
            const bare = 'assigns' === key ? name.replace(/:$/, '') : name;
            if (!AmigaName.test(bare)) {
                problems.push(
                    `"${key}" name "${name}" must be 1 to 30 letters, digits, '_', '.' or '-'`
                );
            }
            if (
                !_.isString(value) ||
                ('assigns' === key && 0 === value.length) ||
                /[;\r\n]/.test(value) ||
                ControlChars.test(value) ||
                /[^\x00-\xff]/.test(value)
            ) {
                problems.push(
                    `"${key}.${name}" must be ${what}: Latin-1 text without ';' or control characters`
                );
            }
        }
        const joined = sessionPairs(v, 'assigns' === key);
        if (joined && joined.length > MaxValueLength) {
            problems.push(
                `"${key}" makes ${joined.length} characters; the shim takes ${MaxValueLength}`
            );
        }
    }

    if (undefined !== c.doorStack && !intIn('doorStack', 4096, 1024 * 1024)) {
        problems.push('"doorStack" must be an integer from 4096 to 1048576 (bytes)');
    }

    //  machine
    c.cpu = undefined === c.cpu ? Defaults.cpu : String(c.cpu).toUpperCase();
    if (!CPU_MODELS.includes(c.cpu)) {
        problems.push(`"cpu" must be one of ${CPU_MODELS.join(', ')}, got "${rawCpu}"`);
    }
    for (const key of ['chipKb', 'slowKb', 'fastKb', 'overclock']) {
        if (undefined === c[key]) {
            c[key] = Defaults[key];
        }
    }
    if (!CHIP_KB.includes(c.chipKb)) {
        problems.push(`"chipKb" must be one of ${CHIP_KB.join(', ')}`);
    }
    if (!intIn('slowKb', 0, 1536, v => 0 === v % 256)) {
        problems.push('"slowKb" must be 0 to 1536, a multiple of 256');
    }
    if (!intIn('fastKb', 0, 8192, v => 0 === v % 64)) {
        problems.push(
            '"fastKb" must be 0 to 8192, a multiple of 64 (the core supports at most 8 MB of fast RAM)'
        );
    }
    if (!intIn('overclock', 1, 16)) {
        problems.push('"overclock" must be an integer from 1 to 16');
    }
    if (
        !c.rom &&
        isInt(c.chipKb) &&
        isInt(c.slowKb) &&
        isInt(c.fastKb) &&
        c.chipKb + c.slowKb + c.fastKb < 1024
    ) {
        problems.push(
            'the AROS ROM needs at least 1 MB of RAM in total (chip + slow + fast)'
        );
    }

    //  A stock AROS ROM corrupts an FFS volume of more than one bitmap block
    //  (4066 blocks) when the guest writes. The ROM bundled with enigma-vamiga
    //  0.1.2 and later carries the fix, so only a ROM supplied through |rom|
    //  (which may be a stock build) is warned about; oputil's create is what
    //  refuses
    if (c.rom && 'string' === typeof c.image) {
        let imageBytes = 0;
        try {
            imageBytes = fs.statSync(c.image).size;
        } catch (e) {
            //  a missing image is reported by checkFiles
        }
        if (imageBytes > AROS_MAX_FFS_BLOCKS * 512) {
            warnings.push(
                `image ${c.image} is ${Math.round(imageBytes / 1024)} KB, over ` +
                    `${(AROS_MAX_FFS_BLOCKS * 512) / 1024} KB; if this ROM is a stock ` +
                    'AROS build, keep the image at 2032 KB or less, or use the fixed ROM ' +
                    'bundled with enigma-vamiga 0.1.2 and later'
            );
        }
    }

    //  node and time limits
    if (undefined !== c.sharedState && !_.isBoolean(c.sharedState)) {
        problems.push('"sharedState" must be true or false');
    }
    c.sharedState = true === c.sharedState;
    if (undefined === c.nodeMax || null === c.nodeMax) {
        c.nodeMax = c.sharedState ? 1 : Defaults.nodeMax;
    } else if (!intIn('nodeMax', 0, Number.MAX_SAFE_INTEGER)) {
        problems.push('"nodeMax" must be a whole number (0 = unlimited)');
    }
    if (
        undefined !== c.minTimeLeftMinutes &&
        !intIn('minTimeLeftMinutes', 0, Number.MAX_SAFE_INTEGER)
    ) {
        problems.push('"minTimeLeftMinutes" must be a whole number of minutes');
    }

    //  terminal
    c.encoding = undefined === c.encoding ? Defaults.encoding : c.encoding;
    if (!_.isString(c.encoding) || !iconv.encodingExists(c.encoding)) {
        problems.push(`"encoding" "${c.encoding}" is not an encoding iconv-lite knows`);
    }
    if (undefined === c.amigaConsole) {
        c.amigaConsole = isLatin1(c.encoding);
    } else if (!_.isBoolean(c.amigaConsole)) {
        problems.push('"amigaConsole" must be true or false');
    }
    c.font = undefined === c.font ? Defaults.font : c.font;
    if (!_.isString(c.font)) {
        problems.push('"font" must be a SyncTERM font name or alias, or "none"');
    } else if (
        'none' !== c.font.toLowerCase() &&
        !ansi.setSyncTermFontWithAlias(c.font)
    ) {
        problems.push(
            `"font" "${c.font}" is not a SyncTERM font name or alias (or "none")`
        );
    }

    //  persistence
    if (undefined === c.persist) {
        c.persist = Defaults.persist;
    } else if (!_.isBoolean(c.persist)) {
        problems.push('"persist" must be true or false');
    }
    if (undefined === c.persistOn) {
        c.persistOn = (DefaultPersistOn[c.doorType] || Defaults.persistOn).slice();
    } else {
        const list = _.isString(c.persistOn) ? [c.persistOn] : c.persistOn;
        if (!Array.isArray(list) || !list.every(s => EXIT_STATUSES.includes(s))) {
            problems.push(
                `"persistOn" must be a list of exit statuses (${EXIT_STATUSES.join(', ')})`
            );
        } else {
            c.persistOn = list.slice();
        }
    }

    //  shim session options
    for (const key of ['log', 'crlf']) {
        if (undefined === c[key]) {
            c[key] = Defaults[key];
        } else if (!_.isBoolean(c[key])) {
            problems.push(`"${key}" must be true or false`);
        }
    }
    for (const [key, min, max] of [
        ['warpBootSeconds', 0, 3600],
        ['disconnectGraceSeconds', 1, 3600],
        ['regTimeoutSeconds', 0, 86400],
    ]) {
        if (undefined === c[key]) {
            c[key] = Defaults[key];
        } else if (!intIn(key, min, max)) {
            problems.push(`"${key}" must be an integer from ${min} to ${max}`);
        }
    }
    if (undefined !== c.inputTimeoutSeconds && !intIn('inputTimeoutSeconds', 1, 86400)) {
        problems.push('"inputTimeoutSeconds" must be an integer from 1 to 86400');
    }
    if (undefined !== c.timezoneMinutes && !intIn('timezoneMinutes', -720, 840)) {
        problems.push(
            '"timezoneMinutes" must be an integer from -720 to 840 (minutes east of UTC)'
        );
    }

    return { config: c, problems, warnings };
}

//
//  doorArgs placeholders. The argument line goes through the Amiga shell, so a
//  value from the user record must not be able to quote, redirect, comment,
//  substitute (` and $) or add keywords: {name} keeps only characters the
//  shell treats as plain text and is passed as one quoted argument (so "Joe
//  ACCESS 255" stays a name and cannot become a ReadArgs keyword). The numbers
//  are numbers.
//
const ShellUnsafe = /["*`$;<>|\\\x00-\x1f\x7f-\x9f]/g;

//
//  A string from the user record or the system for the `s` frame: one line
//  of Latin-1 the shim can hold. Composed first (e + combining acute is é),
//  then control characters (C0, C1) become blanks and anything Latin-1 lacks
//  a '?'. A line break would not even encode, and C1 bytes such as 0x9B are
//  terminal controls once a door prints them.
//
function userText(value) {
    return String(undefined === value || null === value ? '' : value)
        .normalize('NFC')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .replace(/[^\x00-\xff]/gu, '?')
        .slice(0, MaxValueLength);
}

//  |max|: the most characters the quoted argument may take, quotes included;
//  a longer value is cut, never the quotes
function quoteArg(value, max = Infinity) {
    let s = String(value)
        .normalize('NFC')
        .replace(/[^\x00-\xff]/gu, '?') //  the s frame is Latin-1
        .replace(ShellUnsafe, '_');
    if (s.length + 2 > max) {
        s = s.slice(0, Math.max(0, max - 2));
    }
    return `"${s}"`;
}

//  The length of the command line the shim builds (axshim.c launch()) for
//  |args| on node |node|
function commandLength(config, args, node) {
    const door = String(config.door || '').length;
    const nodeLen = String(node).length;
    switch (config.doorType) {
        case 'cli': //  "door" args
            return door + 3 + args.length;
        case 'aim': //  SYS:Rexxc/RX door node[ args]
            return (
                RxCommand.length + 1 + door + 1 + nodeLen + (args ? 1 + args.length : 0)
            );
        case 'tim': //  "door" line[ args]; the line is one digit
            return door + 3 + 1 + (args ? 1 + args.length : 0);
        case 'cnetrexx': //  door[ args], the RexxMsg's command; no port number
            return door + (args ? 1 + args.length : 0);
        default: //  "door" node args
            return door + 3 + nodeLen + 1 + args.length;
    }
}

const ArgSubstitutions = {
    name: ({ client, nameMax }) => quoteArg(client.user.getSanitizedName(), nameMax),
    node: ({ client }) => String(client.node),
    level: ({ client }) => String(client.user.getLegacySecurityLevel()),
    timeleft: ({ timeLeft }) => String(timeLeft),
};

//
//  |config|, when given, bounds the result to what the shim takes: {name} is
//  cut (inside its quotes) so that the arguments and the whole command line
//  fit. Everything else in the line was checked at config time.
//
function expandDoorArgs(template, ctx, config) {
    if (!template) {
        return template;
    }
    const fill = (c, skipName) =>
        template.replace(/\{([a-z]+)\}/g, (match, key) => {
            if (!Object.prototype.hasOwnProperty.call(ArgSubstitutions, key)) {
                return match;
            }
            return skipName && 'name' === key ? '' : ArgSubstitutions[key](c);
        });

    const names = (template.match(/\{name\}/g) || []).length;
    if (!config || 0 === names) {
        return fill(ctx, false);
    }
    const rest = fill(ctx, true);
    const room = Math.min(
        MaxValueLength - rest.length,
        MaxCommandLength - commandLength(config, rest, ctx.client.node)
    );
    return fill(Object.assign({}, ctx, { nameMax: Math.floor(room / names) }), false);
}

//  |assigns| / |env| as the shim's `assign` / `env` value: NAME=VALUE;NAME=VALUE
function sessionPairs(pairs, stripColon) {
    if (!_.isPlainObject(pairs) || 0 === Object.keys(pairs).length) {
        return undefined;
    }
    return Object.entries(pairs)
        .map(([name, value]) => `${stripColon ? name.replace(/:$/, '') : name}=${value}`)
        .join(';');
}

//  Statuses that mean the session was cut short from our side; the door's
//  disk is only safe to keep if the door itself ended (a return code, not -1).
const CutShortStatuses = ['carrier', 'timeout', 'break'];

function endedByItself(keys) {
    const raw = keys ? keys.rc : undefined;
    //  only a plain integer is a return code; '', ' ', null and junk are not
    if (!/^-?\d+$/.test(String(raw))) {
        return false;
    }
    return -1 !== Number(raw);
}

function persistDecision(config, status, keys) {
    if (true !== config.persist) {
        return { persist: false, why: 'persist is off' };
    }
    if (!(config.persistOn || []).includes(status)) {
        return { persist: false };
    }
    if (CutShortStatuses.includes(status) && !endedByItself(keys)) {
        return {
            persist: false,
            cutShort: true,
            why: `the door had not ended by itself (rc ${
                keys && undefined !== keys.rc ? keys.rc : 'absent'
            }); the shim gave up on it`,
        };
    }
    return { persist: true };
}

function shouldPersist(config, status, keys) {
    return persistDecision(config, status, keys).persist;
}

//
//  The `s` frame: the user block the shim answers DT_* requests from, plus
//  the door to run and session options. `now` is added by the worker when the
//  frame is actually sent.
//
function buildSessionKeys(client, config) {
    const user = client.user;
    const prop = name => user.getProperty(name);
    const num = name => parseInt(prop(name), 10) || 0;
    const unix = ts => {
        const ms = ts ? Date.parse(ts) : NaN;
        return isNaN(ms) ? undefined : Math.floor(ms / 1000);
    };

    const timeLeft = UserTime.getTimeLeftMinutes(client);
    const allowed = UserTime.getAllowedMinutesToday(client);
    const clampMinutes = m => Math.min(null === m ? Infinity : m, MaxDoorMinutes);
    const cli = 'cli' === config.doorType;
    const cnet = 'cnetrexx' === config.doorType;

    let args = expandDoorArgs(
        config.doorArgs,
        { client, timeLeft: clampMinutes(timeLeft) },
        config
    );
    if (args && args.length > MaxValueLength) {
        //  only past the config-time check's assumptions (a huge node number)
        (client.log || { warn: () => {} }).warn(
            { name: config.name, length: args.length },
            `Amiga door arguments are longer than ${MaxValueLength} characters; cut short`
        );
        args = args.slice(0, MaxValueLength);
    }

    let inputTimeout = config.inputTimeoutSeconds;
    if (undefined === inputTimeout) {
        const idle = _.get(Config(), 'users.idleLogoutSeconds');
        inputTimeout = idle > 0 ? idle : undefined; //  else the shim's 300
    }

    //  late: stat_log reads the system database
    const StatLog = require('../stat_log.js');
    const SysProps = require('../system_property.js');

    return {
        version: protocol.PROTOCOL_VERSION,
        type: config.doorType || Defaults.doorType,
        console: cli ? config.consoleMode || Defaults.consoleMode : undefined,
        door: config.door,
        dir: config.doorDir,
        stack: config.doorStack,
        args,
        assign: sessionPairs(config.assigns, true),
        env: sessionPairs(config.env, false),
        node: client.node,
        //  C-Net: GETUSER 39/40, FINDACCOUNT; account 1 is C-Net's sysop, as ENiGMA's
        account: cnet ? user.userId : undefined,
        panicgrace: cnet ? config.panicGraceSeconds : undefined,
        wrap: cnet && false === config.wordWrap ? 0 : undefined,
        name: userText(user.getSanitizedName()),
        realname: userText(user.getSanitizedName('real')),
        location: userText(prop(UserProps.Location)),
        level: user.getLegacySecurityLevel(),
        timeleft: clampMinutes(timeLeft),
        timeused: UserTime.getTimeUsedTodayMinutes(user),
        timelimit: clampMinutes(allowed),
        calls: num(UserProps.LoginCount),
        posts: num(UserProps.MessagePostCount),
        uploads: num(UserProps.FileUlTotalCount),
        downloads: num(UserProps.FileDlTotalCount),
        ulbytes: num(UserProps.FileUlTotalBytes),
        dlbytes: num(UserProps.FileDlTotalBytes),
        laston: unix(prop(UserProps.PrevLoginTs) || prop(UserProps.LastLoginTs)),
        expert: 0,
        ansi: 1,
        rows: client.term.termHeight || 24,
        cols: client.term.termWidth || 80,
        bbsname: userText(_.get(Config(), 'general.boardName') || 'ENiGMA'),
        sysop: userText(StatLog.getSystemStat(SysProps.SysOpUsername) || 'SysOp'),
        mainline: config.mainline || '',
        timeout: inputTimeout,
        log: config.log ? 1 : 0,
        regtimeout: config.regTimeoutSeconds,
        crlf: config.crlf ? 1 : 0,
        tz: _.isNumber(config.timezoneMinutes)
            ? config.timezoneMinutes
            : hostTimezoneMinutes(),
        slot: 1,
    };
}

// ─── Session ──────────────────────────────────────────────────────────────────

//
//  One door session: the worker's messages, the caller's input, the host
//  frames ENiGMA sends (t, d, w, e), the exit and persist decision.
//
//  Emits 'firstOutput' once, then 'done' exactly once with
//  { status, keys, persisted, error, reason }.
//
class AmigaDoorSession extends EventEmitter {
    constructor({
        client,
        config,
        worker,
        cacheKey,
        cache,
        sessionKeys,
        rawOutput,
        timeouts,
    }) {
        super();
        //  overridable for tests only
        this.timeouts = Object.assign(
            {
                ready: ReadyTimeoutMs,
                exitAfterDisconnect:
                    1000 *
                    (config.disconnectGraceSeconds || Defaults.disconnectGraceSeconds),
                persist: PersistTimeoutMs,
                persistAbandon: PersistAbandonMs,
            },
            timeouts
        );
        this.client = client;
        this.log = client.log;
        this.config = config;
        this.worker = worker;
        this.cacheKey = cacheKey;
        this.cache = cache;
        this.rawOutput = !!rawOutput;
        this.encoding = config.encoding;
        //  Amiga console controls mean something only in an Amiga door's
        //  Latin-1; in CP437 0x9B is a cent sign and 0x0C a character too
        this.translator = config.amigaConsole
            ? new AmigaConsoleTranslator({
                  rows: client.term.termHeight,
                  cols: client.term.termWidth,
              })
            : null;
        //  streaming, so a multibyte character split across chunks survives
        this.decoder = this.rawOutput ? null : iconv.getDecoder(this.encoding);

        this.lastTimeLeft = sessionKeys ? sessionKeys.timeleft : undefined;
        this.lastSize = sessionKeys
            ? { rows: sessionKeys.rows, cols: sessionKeys.cols }
            : null;

        this.ready = false;
        this.disconnectReason = null; //  set once `d` has been sent
        this.exitInfo = null; //  the X frame, once seen
        this.persisting = false; //  a persist has been asked for and not answered
        this.persistTmp = null;
        this.finished = false;
        this.closed = false;
        this.firstOutput = true;
        this.timers = {};

        this.backpressure = Door.parseBackpressureSettings(
            _.get(Config(), 'doors.outputBackpressure'),
            this.log
        );
        this.outputPausedAt = 0;
        this.outputStats = { pauses: 0, pausedMs: 0 };
    }

    start() {
        this.onWorkerMessageBound = msg => this.onWorkerMessage(msg);
        this.onWorkerErrorBound = err => {
            this.workerGone = true; //  an uncaught error ends the thread
            this.finish({ error: `worker thread error: ${err.message}` });
        };
        this.onWorkerExitBound = code => {
            this.workerGone = true;
            if (!this.finished) {
                this.finish({ error: `worker exited unexpectedly (code ${code})` });
            }
        };
        this.worker.on('message', this.onWorkerMessageBound);
        this.worker.on('error', this.onWorkerErrorBound);
        this.worker.on('exit', this.onWorkerExitBound);

        //  kept: client.end() clears term.output before leave() reaches us
        this.inputSource = this.client.term.output;
        this.onInputBound = data => this.onInput(data);
        if (this.inputSource) {
            this.inputSource.on('data', this.onInputBound);
        }

        this.onTimeUpBound = () => this.disconnect('timeup');
        this.client.on('time up', this.onTimeUpBound);

        this.onClientDisconnectedBound = evt => {
            if (
                _.get(evt, 'client.session.uniqueId') ===
                _.get(this.client, 'session.uniqueId')
            ) {
                this.disconnect('hangup');
            }
        };
        Events.on(
            Events.getSystemEvents().ClientDisconnected,
            this.onClientDisconnectedBound
        );

        this.timers.ready = setTimeout(() => {
            this.finish({
                error: `the emulator did not become ready within ${this.timeouts.ready} ms`,
            });
        }, this.timeouts.ready);

        return this;
    }

    post(msg) {
        if (!this.finished) {
            this.worker.postMessage(msg);
        }
    }

    sendFrame(type, keys) {
        this.post({ type: 'frame', frame: { type, keys } });
    }

    onInput(data) {
        if (this.disconnectReason || this.exitInfo || this.finished) {
            return;
        }
        this.post({ type: 'input', data });
    }

    onWorkerMessage(msg) {
        if (this.finished) {
            return;
        }

        switch (msg.type) {
            case 'snapshot':
                return this.onSnapshot(msg);
            case 'ready':
                return this.onReady(msg);
            case 'output':
                return this.writeOutput(
                    Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.length)
                );
            case 'frame':
                return this.onFrame(msg.frame);
            case 'exit':
                return this.onExit(msg);
            case 'persisted':
                return this.onPersisted(msg);
            case 'error':
                return this.onWorkerError(msg);
            default:
                return;
        }
    }

    onSnapshot(msg) {
        if (!this.cache || !this.cacheKey) {
            return;
        }
        this.cache.maxEntries = snapshotCacheEntries();
        const stored = this.cache.set(this.cacheKey, msg.snapshot);
        this.log.info(
            {
                name: this.config.name,
                bytes: msg.snapshot.length,
                snapshotMs: Math.round(msg.ms),
                cached: !!stored,
                entries: this.cache.size,
            },
            stored
                ? 'Amiga door snapshot cached'
                : 'Amiga door snapshot not cached (doors.amiga.snapshotCacheEntries is 0)'
        );
    }

    onReady(msg) {
        this.ready = true;
        clearTimeout(this.timers.ready);
        this.log.info(
            {
                name: this.config.name,
                restored: msg.restored,
                readyMs: Math.round(msg.ms),
                restoreMs: null === msg.restoreMs ? undefined : +msg.restoreMs.toFixed(1),
                shim: _.get(msg, 'hello.shim'),
                wasmMemoryBytes: _.get(msg, 'stats.wasmMemoryBytes'),
            },
            msg.restored
                ? 'Amiga door restored from snapshot; session started'
                : 'Amiga door booted; session started'
        );

        this.timers.resize = setInterval(() => this.checkResize(), ResizePollMs);
        this.timers.time = setInterval(() => this.checkTimeLeft(), TimePollMs);
    }

    onFrame(frame) {
        const keys = frame.keys || {};
        switch (frame.type) {
            case 'H':
                return this.log.debug(
                    { name: this.config.name, hello: keys },
                    'Amiga shim hello'
                );

            case 'L':
                return this.log.info(
                    { name: this.config.name, door: keys.door },
                    'Amiga door launched'
                );

            case 'C':
                if (this.config.log) {
                    this.log.debug(
                        {
                            name: this.config.name,
                            cmd: keys.cmd,
                            verb: keys.verb, //  ARexx doors
                            data: keys.data,
                            len: keys.len,
                            str: keys.str,
                        },
                        'Amiga door request'
                    );
                }
                return;

            case 'E':
                //  JH_EF: handing the editor to ENiGMA's FSE is future work
                this.log.info(
                    { name: this.config.name, file: keys.file },
                    'Amiga door asked for the message editor; refused'
                );
                return this.sendFrame('e', { status: 'refused' });

            default:
                return;
        }
    }

    onExit(msg) {
        this.exitInfo = msg;
        clearTimeout(this.timers.disconnect);
        this.stopPolling();

        const status = msg.status;
        const decision = persistDecision(this.config, status, msg.keys);
        const persist = decision.persist;
        const logFn = 'error' === status ? this.log.warn : this.log.info;
        logFn.call(
            this.log,
            {
                name: this.config.name,
                exit: msg.keys,
                inputDropped: msg.inputDropped || undefined,
                persist,
                notPersistedBecause: decision.why,
            },
            `Amiga door exited (status=${status})`
        );

        if (!persist) {
            if (decision.cutShort) {
                this.log.info(
                    {
                        name: this.config.name,
                        image: this.config.image,
                        status,
                        rc: msg.keys ? msg.keys.rc : undefined,
                    },
                    `Amiga door disk changes NOT persisted: ${decision.why}`
                );
            }
            return this.finish({ status, keys: msg.keys, persisted: false });
        }

        this.startPersist(status, msg.keys);
    }

    //
    //  The worker writes the changes into a copy of the image beside it and
    //  renames the copy over the image. A persist that overruns
    //  timeouts.persist ends the session for the caller, but the worker is
    //  left to finish (a rename is atomic, a half-written copy is not the
    //  image) until timeouts.persistAbandon; only then is it stopped and its
    //  copy removed.
    //
    startPersist(status, keys) {
        let target = this.config.image;
        try {
            target = fs.realpathSync(this.config.image);
        } catch (e) {
            //  the worker reports a missing image
        }
        this.persistTmp = `${target}.${process.pid}.${Date.now()}.persist`;
        this.persisting = true;
        this.timers.persist = setTimeout(() => {
            this.log.warn(
                { name: this.config.name, image: this.config.image },
                `Amiga door persist did not finish within ${this.timeouts.persist} ms; letting it finish in the background`
            );
            this.finish({
                status,
                keys,
                persisted: false,
                error: `persist did not finish within ${this.timeouts.persist} ms`,
            });
        }, this.timeouts.persist);
        this.post({ type: 'persist', path: this.config.image, tmp: this.persistTmp });
    }

    persistSettled() {
        this.persisting = false;
    }

    onPersisted(msg) {
        clearTimeout(this.timers.persist);
        this.persistSettled();

        if (msg.refused) {
            //  someone wrote the image under this session: its changes were
            //  measured against a disk that is no longer there
            const dropped = this.cache
                ? this.cache.invalidateImage(this.config.image)
                : 0;
            this.log.warn(
                {
                    name: this.config.name,
                    image: this.config.image,
                    reason: msg.refused,
                    snapshotsDropped: dropped,
                },
                'Amiga door disk changes NOT persisted: the image changed during the session'
            );
            return this.finish({
                status: this.exitInfo.status,
                keys: this.exitInfo.keys,
                persisted: false,
                refused: msg.refused,
            });
        }

        let invalidated = 0;
        if (msg.chunks > 0 && this.cache) {
            invalidated = this.cache.invalidateImage(this.config.image);
        }
        this.log.info(
            {
                name: this.config.name,
                image: this.config.image,
                chunks: msg.chunks,
                bytes: msg.bytes,
                persistMs: Math.round(msg.ms),
                snapshotsDropped: invalidated,
            },
            msg.chunks > 0
                ? 'Amiga door disk changes persisted'
                : 'Amiga door left its disk unchanged'
        );
        this.finish({
            status: this.exitInfo.status,
            keys: this.exitInfo.keys,
            persisted: true,
            chunks: msg.chunks,
        });
    }

    onWorkerError(msg) {
        const err = { name: this.config.name, error: msg.message, code: msg.code };
        if (msg.during) {
            err.during = msg.during;
        }
        if (false === msg.fatal) {
            return this.log.warn(err, 'Amiga door worker problem');
        }
        if ('persist' === msg.during) {
            this.persistSettled(); //  the worker removed its copy
        }
        this.log.warn(err, 'Amiga door worker error');
        this.finish({
            status: this.exitInfo ? this.exitInfo.status : undefined,
            keys: this.exitInfo ? this.exitInfo.keys : undefined,
            persisted: false,
            error: msg.message,
            code: msg.code,
        });
    }

    //
    //  End the session from our side: hangup, timeup or break. The shim answers
    //  with X once the door has gone (or after its own 30 s grace); we give it
    //  disconnectGraceSeconds (35 by default, so the shim's X arrives) and
    //  then drop the worker regardless. The X decides persisting as usual
    //  (an XIM door's default persistOn keeps what it saved on a hangup);
    //  without one nothing is persisted.
    //
    disconnect(reason) {
        if (this.finished || this.disconnectReason || this.exitInfo) {
            return;
        }
        this.disconnectReason = reason;
        this.stopPolling();
        this.resumeOutput();

        this.log.info(
            { name: this.config.name, reason },
            `Ending Amiga door session (d reason=${reason})`
        );

        if (!this.ready) {
            return this.finish({ persisted: false, reason });
        }

        this.sendFrame('d', { reason });
        this.timers.disconnect = setTimeout(() => {
            this.log.info(
                { name: this.config.name, reason },
                `No X within ${this.timeouts.exitAfterDisconnect} ms of d; dropping the Amiga door worker`
            );
            this.finish({ persisted: false, reason });
        }, this.timeouts.exitAfterDisconnect);
    }

    writeOutput(bytes) {
        //  after `d` the caller is gone or being shown something else
        if (this.disconnectReason || !this.client.term.output) {
            return;
        }

        if (this.firstOutput) {
            this.firstOutput = false;
            this.emit('firstOutput');
        }

        if (this.translator) {
            bytes = this.translator.push(bytes);
        }
        this._writeTranslated(bytes);
        this.checkBackpressure();
    }

    //  A sequence the door never finished is shown as it is.
    flushOutput() {
        if (this.disconnectReason || !this.client.term.output) {
            return;
        }
        if (this.translator) {
            this._writeTranslated(this.translator.flush());
        }
        if (this.decoder) {
            const tail = this.decoder.end();
            this.decoder = null;
            if (tail) {
                this.client.term.write(tail, false);
            }
        }
    }

    _writeTranslated(bytes) {
        if (!bytes.length) {
            return;
        }
        if (this.rawOutput) {
            this.client.term.rawWrite(bytes);
        } else {
            const text = this.decoder ? this.decoder.write(bytes) : '';
            if (text) {
                this.client.term.write(text, false);
            }
        }
    }

    checkResize() {
        const rows = this.client.term.termHeight;
        const cols = this.client.term.termWidth;
        if (!(rows > 0 && cols > 0)) {
            return;
        }
        if (this.lastSize && rows === this.lastSize.rows && cols === this.lastSize.cols) {
            return;
        }
        this.lastSize = { rows, cols };
        if (this.translator) {
            this.translator.setSize(rows, cols);
        }
        this.log.debug(
            { name: this.config.name, rows, cols },
            'Amiga door window resized (w)'
        );
        this.sendFrame('w', { rows, cols });
    }

    checkTimeLeft() {
        const timeLeft = UserTime.getTimeLeftMinutes(this.client);
        if (null === timeLeft) {
            return; //  unlimited: the shim keeps the ceiling it was given
        }
        const minutes = Math.min(timeLeft, MaxDoorMinutes);
        if (minutes === this.lastTimeLeft) {
            return;
        }
        this.lastTimeLeft = minutes;
        this.log.debug(
            { name: this.config.name, timeLeft: minutes },
            'Amiga door time left changed (t)'
        );
        this.sendFrame('t', { timeleft: minutes });
    }

    stopPolling() {
        clearInterval(this.timers.resize);
        clearInterval(this.timers.time);
    }

    //
    //  Output back-pressure, as door.js does for a pty: past
    //  doors.outputBackpressure.highWaterBytes of unsent output we stop the
    //  emulator (the door's writes then simply wait, as a real one's would on
    //  a slow line), and start it again under lowWaterBytes.
    //
    outputBacklog() {
        const output = this.client.term.output;
        const rawSocket = this.client.rawSocket;
        let backlog = (output && output.writableLength) || 0;
        if (rawSocket && rawSocket !== output) {
            backlog += rawSocket.writableLength || 0;
        }
        return backlog;
    }

    checkBackpressure() {
        if (!this.backpressure || this.outputPausedAt) {
            return;
        }
        const backlog = this.outputBacklog();
        if (backlog < this.backpressure.high) {
            return;
        }
        this.post({ type: 'pause' });
        this.outputPausedAt = Date.now();
        this.outputStats.pauses += 1;
        this.log.debug({ backlog }, 'Caller is behind; pausing Amiga door');

        this.timers.backpressure = setInterval(() => {
            if (this.outputBacklog() <= this.backpressure.low) {
                this.resumeOutput();
            }
        }, BackpressurePollMs);
    }

    resumeOutput() {
        if (!this.outputPausedAt) {
            return;
        }
        clearInterval(this.timers.backpressure);
        const pausedMs = Date.now() - this.outputPausedAt;
        this.outputStats.pausedMs += pausedMs;
        this.outputPausedAt = 0;
        this.post({ type: 'resume' });
        this.log.debug({ pausedMs }, 'Caller caught up; resuming Amiga door');
    }

    finish(result) {
        if (this.finished) {
            return;
        }
        this.resumeOutput();
        this.finished = true;

        for (const t of Object.values(this.timers)) {
            clearTimeout(t);
            clearInterval(t);
        }

        this.worker.removeListener('message', this.onWorkerMessageBound);
        this.worker.removeListener('error', this.onWorkerErrorBound);
        this.worker.removeListener('exit', this.onWorkerExitBound);
        //  a late 'error' from a worker we no longer listen to must not
        //  become an unhandled one
        this.worker.on('error', () => {});
        if (this.inputSource) {
            this.inputSource.removeListener('data', this.onInputBound);
        }
        this.client.removeListener('time up', this.onTimeUpBound);
        Events.removeListener(
            Events.getSystemEvents().ClientDisconnected,
            this.onClientDisconnectedBound
        );

        //  Model A: a worker is never reused (shim protocol v1)
        if (this.persisting && !this.workerGone) {
            this.awaitPersistThenClose();
        } else {
            this.close();
        }

        if (this.outputStats.pauses > 0) {
            this.log.info(
                Object.assign({ name: this.config.name }, this.outputStats),
                'Amiga door output backpressure summary'
            );
        }

        this.emit('done', Object.assign({ reason: this.disconnectReason }, result));
    }

    //  Stop the worker; 'closed' once it is gone. Nothing of the session is
    //  left after that.
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.abandonTimer);
        let terminated;
        try {
            terminated = this.worker.terminate();
        } catch (e) {
            //  already gone
        }
        const tmp = this.persisting ? this.persistTmp : null;
        this.persistSettled();
        Promise.resolve(terminated)
            .catch(() => {})
            .then(() => {
                if (tmp) {
                    //  stopped mid-persist: its copy is not the image, and goes
                    fs.unlink(tmp, () => {});
                }
                this.emit('closed');
            });
    }

    //  The session is over but the worker is still writing the image: let it
    //  finish (or give up on it after timeouts.persistAbandon).
    awaitPersistThenClose() {
        const onMessage = msg => {
            if (
                'persisted' === msg.type ||
                ('error' === msg.type && msg.fatal !== false)
            ) {
                this.log.info(
                    {
                        name: this.config.name,
                        image: this.config.image,
                        chunks: msg.chunks,
                        refused: msg.refused,
                        error: 'error' === msg.type ? msg.message : undefined,
                    },
                    'Amiga door persist finished after the session ended'
                );
                if ('persisted' === msg.type && msg.chunks > 0 && this.cache) {
                    this.cache.invalidateImage(this.config.image);
                }
                done();
            }
        };
        const done = () => {
            this.worker.removeListener('message', onMessage);
            this.worker.removeListener('exit', done);
            this.close();
        };
        this.worker.on('message', onMessage);
        this.worker.on('exit', done);
        this.abandonTimer = setTimeout(() => {
            this.log.warn(
                { name: this.config.name, image: this.config.image },
                `Amiga door persist did not finish within ${this.timeouts.persistAbandon} ms; stopping the worker, the image is unchanged`
            );
            done();
        }, this.timeouts.persistAbandon);
    }
}

// ─── Menu module ──────────────────────────────────────────────────────────────

exports.moduleInfo = {
    name: 'AmigaDoor',
    desc: 'Amiga Door Emulation via vAmiga',
    author: 'NuSkooler',
};

exports.getModule = class AmigaDoorModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = options.menuConfig.config || {};
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        { name: 'string', image: 'string', door: 'string' },
                        callback
                    );
                },

                function normalize(callback) {
                    const { config, problems, warnings } = normalizeConfig(self.config);
                    if (warnings.length > 0) {
                        self.client.log.warn(
                            { name: self.config.name, warnings },
                            `amiga_door "${self.config.name}": ${warnings.join('; ')}`
                        );
                    }
                    if (problems.length > 0) {
                        return callback(
                            Errors.Invalid(
                                `amiga_door "${self.config.name}": ${problems.join('; ')}`
                            )
                        );
                    }
                    self.config = config;
                    return callback(null);
                },

                function checkFiles(callback) {
                    for (const [label, p] of [
                        ['image', self.config.image],
                        ['rom', self.config.rom],
                        ['extRom', self.config.extRom],
                    ]) {
                        if (p && !fs.existsSync(p)) {
                            return callback(
                                Errors.MissingConfig(
                                    `amiga_door: ${label} not found: ${p}`
                                )
                            );
                        }
                    }
                    return callback(null);
                },

                function validateNodeCount(callback) {
                    const name = self.config.name;
                    if (
                        self.config.nodeMax > 0 &&
                        _.isNumber(activeDoorInstances[name]) &&
                        activeDoorInstances[name] + 1 > self.config.nodeMax
                    ) {
                        self.client.log.info(
                            { name, activeCount: activeDoorInstances[name] },
                            `Too many active instances of door "${name}"`
                        );
                        return self._refuseBusy(callback);
                    }

                    //  checked and taken in one step: nothing runs in between
                    if (!self._holdImage()) {
                        self.client.log.info(
                            {
                                name,
                                image: self.config.image,
                                heldBy: activeImages.get(imageKey(self.config.image)),
                            },
                            `Amiga door image is in use by another session; refusing door "${name}"`
                        );
                        return self._refuseBusy(callback);
                    }

                    self._incrementInstances();
                    return callback(null);
                },

                function validateTimeRemaining(callback) {
                    //  as abracadabra: opt-in per door, unlimited always passes
                    const minTimeLeft = self.config.minTimeLeftMinutes;
                    if (UserTime.hasTimeFor(self.client, minTimeLeft)) {
                        return callback(null);
                    }

                    const timeLeft = UserTime.getTimeLeftMinutes(self.client);
                    self.client.log.info(
                        { name: self.config.name, timeLeft, minTimeLeft },
                        `Not enough time remaining for door "${self.config.name}"`
                    );

                    self._refusalShown = true;
                    const denied = () =>
                        callback(Errors.AccessDenied('Not enough time remaining'));

                    if (_.isString(self.config.notEnoughTimeArt)) {
                        return theme.displayThemeArt(
                            { client: self.client, name: self.config.notEnoughTimeArt },
                            () => self.pausePrompt(denied)
                        );
                    }

                    self.client.term.write(
                        `\nYou need at least ${minTimeLeft} minute(s) remaining today for this. You have ${timeLeft}.\n`
                    );
                    return self.pausePrompt(denied);
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn(
                        { error: err.message },
                        'Could not start Amiga door'
                    );
                    self.lastError = err;
                    self._decrementInstances();
                    self._releaseImage();
                    if (self._refusalShown) {
                        return self.prevMenu(); //  busy or out of time: already said
                    }
                    //  a configuration problem or a missing image or ROM: the
                    //  log has the details, the caller gets the short version
                    self.client.term.write(self._unavailableText());
                    return self.pausePrompt(() => self.prevMenu());
                }
                return self.finishedLoading();
            }
        );
    }

    finishedLoading() {
        this.runDoor();
    }

    _unavailableText() {
        const name = _.isString(this.config.name) ? this.config.name : 'This door';
        return `\n  ${name} could not be run. Please let the sysop know.\n`;
    }

    //  nodeMax reached, or the image busy: the same answer either way
    _refuseBusy(callback) {
        this._refusalShown = true;
        const denied = () => callback(Errors.AccessDenied('Too many active instances'));

        if (_.isString(this.config.tooManyArt)) {
            return theme.displayThemeArt(
                { client: this.client, name: this.config.tooManyArt },
                () => this.pausePrompt(denied)
            );
        }

        this.client.term.write('\nToo many active instances. Try again later.\n');
        return this.pausePrompt(denied);
    }

    //  A persisting door holds its image for the session (see activeImages).
    //  Returns false when another session holds it.
    _holdImage() {
        if (!this.config.persist) {
            return true;
        }
        const key = imageKey(this.config.image);
        if (activeImages.has(key)) {
            return false;
        }
        this._imageHold = { name: this.config.name, node: this.client.node };
        this._imageKey = key;
        activeImages.set(key, this._imageHold);
        return true;
    }

    _releaseImage() {
        if (this._imageHold && activeImages.get(this._imageKey) === this._imageHold) {
            activeImages.delete(this._imageKey);
        }
        this._imageHold = null;
    }

    //  seams for tests: the compiled emulator and the thread it runs in
    _compiledModule() {
        return getCompiledModule();
    }

    _newWorker(workerData) {
        return new Worker(WORKER_PATH, { workerData });
    }

    runDoor() {
        const config = this.config;
        const doorName = config.name;
        const doorTracking = trackDoorRunBegin(this.client, doorName);

        let stat;
        try {
            stat = fs.statSync(config.image);
        } catch (err) {
            return this._doorFinished(doorTracking, { error: err.message });
        }

        const cacheKey = SnapshotCache.keyFor(config.image, stat, config);
        const snapshot = snapshotCache.get(cacheKey) || null;

        //  Loading spinner, shown until the door's first output
        const SPINNER_FRAMES = ['|', '/', '-', '\\'];
        let spinnerIdx = 0;
        this.client.term.write(ansi.resetScreen());
        this.client.term.write(`\n  Loading ${doorName}... ${SPINNER_FRAMES[0]}`);
        this.spinnerInterval = setInterval(() => {
            spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
            this.client.term.rawWrite(
                Buffer.from(`\r  Loading ${doorName}... ${SPINNER_FRAMES[spinnerIdx]}`)
            );
        }, 150);

        let worker = null;
        this._compiledModule()
            .then(wasmModule => {
                if (this.left) {
                    return this._doorFinished(doorTracking, { reason: 'hangup' });
                }

                const sessionKeys = buildSessionKeys(this.client, config);
                const workerData = {
                    module: wasmModule,
                    snapshot,
                    image: config.image,
                    rom: config.rom,
                    extRom: config.extRom,
                    machine: {
                        cpu: config.cpu,
                        chipKb: config.chipKb,
                        slowKb: config.slowKb,
                        fastKb: config.fastKb,
                        overclock: config.overclock,
                    },
                    warpBootSeconds: config.warpBootSeconds,
                    session: sessionKeys,
                };

                worker = this._newWorker(workerData);

                this._switchFont();

                this._attachSession(
                    new AmigaDoorSession({
                        client: this.client,
                        config,
                        worker,
                        cacheKey,
                        cache: snapshotCache,
                        sessionKeys,
                        rawOutput: this.fontSwitched && this._rawOutputOk(),
                    }),
                    doorTracking
                );

                this.client.log.info(
                    {
                        name: doorName,
                        door: config.door,
                        doorType: config.doorType,
                        image: config.image,
                        snapshot: snapshot ? 'restore' : 'boot',
                    },
                    'Starting Amiga door'
                );

                this.session.start();
            })
            .catch(err => {
                this._abandonStartup(worker);
                this._doorFinished(doorTracking, {
                    error: `cannot start the emulator: ${err.message}`,
                    code: err.code,
                });
            });
    }

    //
    //  Something threw after the worker was created: stop the worker (and the
    //  session around it, if one was built) so neither outlives the failure.
    //  The caller's slot and the image hold are released by _doorFinished,
    //  once (both are idempotent), because the session no longer counts as
    //  started.
    //
    _abandonStartup(worker) {
        const session = this.session;
        this.session = null;
        this.sessionStarted = false;
        let stopped = false;
        if (session) {
            session.removeAllListeners('done');
            session.removeAllListeners('closed');
            try {
                session.finish({ error: 'startup failed' });
                stopped = true;
            } catch (e) {
                //  start() had not wired everything up; stop the worker below
            }
        }
        if (worker && !stopped) {
            try {
                Promise.resolve(worker.terminate()).catch(() => {});
            } catch (e) {
                //  already gone
            }
        }
    }

    _attachSession(session, doorTracking) {
        this.sessionStarted = true;
        this.session = session;
        session.once('firstOutput', () => this._stopSpinner(true));
        //  the caller's slot is free once the session is over; the image
        //  once the worker has stopped writing it
        session.once('done', result => {
            this.session = null;
            this._doorFinished(doorTracking, result, session);
        });
        session.once('closed', () => this._releaseImage());
    }

    //  Topaz (or the configured font) for the door's duration, when the
    //  caller's terminal does SyncTERM fonts at all.
    _switchFont() {
        const font = this.config.font;
        if (!font || 'none' === font.toLowerCase()) {
            return;
        }
        if (!this.client.term.syncTermFontsEnabled) {
            return;
        }
        const seq = ansi.setSyncTermFontWithAlias(font);
        if (!seq) {
            return;
        }
        this.client.term.rawWrite(seq);
        this.fontSwitched = true;
        this.client.log.debug(
            { name: this.config.name, font, seq: JSON.stringify(seq) },
            'Switched caller to the door font'
        );
    }

    //
    //  Undo what the door session did to the caller's terminal: the font, the
    //  attributes and any scroll region the door set. Once, and only while
    //  there is a terminal to write to: at the door's end, or from leave()
    //  when time-up or a menu change takes the caller elsewhere first.
    //
    //  Deliberately not from a 'time up' listener of our own: when the theme
    //  has no timeUpLogoff art, login_server_module.js writes a goodbye and
    //  ends the client at once, and a TelnetSocket drops a write still queued
    //  behind another when the socket ends -- writing first would cost the
    //  caller the goodbye. That caller is being hung up; the font is moot.
    //
    _restoreScreen() {
        if (this.screenRestored || !this.sessionStarted || !this.client.term.output) {
            return;
        }
        this.screenRestored = true;
        this._restoreFont();
        this.client.term.rawWrite(ansi.normal() + ansi.setScrollRegion());
    }

    _restoreFont() {
        if (!this.fontSwitched) {
            return;
        }
        this.fontSwitched = false;
        const current = this.client.term.currentSyncFont;
        const restoreTo = current && 'not_set' !== current ? current : 'cp437';
        const seq = ansi.setSyncTermFont(restoreTo);
        if (seq) {
            this.client.term.rawWrite(seq);
            this.client.log.debug(
                { name: this.config.name, font: restoreTo, seq: JSON.stringify(seq) },
                'Restored caller font'
            );
        }
    }

    //
    //  With an Amiga font on screen the terminal draws ISO-8859-1, which is
    //  what the doors write: pass the bytes through. Transcoding them to the
    //  caller's CP437 would put CP437 code points under a Latin-1 font. A
    //  UTF-8 terminal, or a door with some other encoding, is transcoded.
    //
    _rawOutputOk() {
        return (
            isLatin1(this.config.encoding) && 'utf8' !== this.client.term.outputEncoding
        );
    }

    _stopSpinner(clear) {
        if (!this.spinnerInterval) {
            return;
        }
        clearInterval(this.spinnerInterval);
        this.spinnerInterval = null;
        if (clear && this.client.term.output) {
            this.client.term.write(ansi.resetScreen());
        }
    }

    _doorFinished(doorTracking, result, session) {
        this._stopSpinner(false);
        trackDoorRunEnd(doorTracking);
        this._decrementInstances();
        if (!this.sessionStarted) {
            this._releaseImage(); //  no worker ever had it
        }

        if (result.error) {
            this.client.log.warn(
                { name: this.config.name, error: result.error, code: result.code },
                'Amiga door error'
            );
        }

        //  The caller hung up (no terminal), or time-up took them elsewhere
        //  (leave() has already put their screen back): nothing more to show
        if (this.left || !this.client.term.output) {
            return this._restoreScreen();
        }

        if (session) {
            session.flushOutput();
        }
        this._restoreScreen();

        //  and move below whatever the door left, as abracadabra does
        this.client.term.rawWrite(
            ansi.goto(this.client.term.termHeight, this.client.term.termWidth) +
                ansi.goto(this.client.term.termHeight, 0) +
                '\r\n\r\n'
        );

        const failed = result.error || 'error' === result.status;
        if (failed) {
            this.client.term.write(this._unavailableText());
            return this.pausePrompt(() => this.autoNextMenu(() => {}));
        }

        //  explicit no-op cb: see abracadabra.js
        return this.autoNextMenu(() => {});
    }

    leave() {
        super.leave();
        this.left = true;
        this._stopSpinner(false);
        //  before the next menu draws: font and scroll region back
        this._restoreScreen();
        if (this.session) {
            //  the slot and the image are freed when the session is over
            //  (done, closed), not now: the worker still runs until X
            this.session.disconnect(this.client.timeUpEmitted ? 'timeup' : 'hangup');
            return;
        }
        if (!this.sessionStarted) {
            this._decrementInstances();
            this._releaseImage();
        }
    }

    _incrementInstances() {
        const name = this.config.name;
        activeDoorInstances[name] = (activeDoorInstances[name] || 0) + 1;
        this._instanceIncremented = true;
    }

    _decrementInstances() {
        if (this._instanceIncremented) {
            const name = this.config.name;
            activeDoorInstances[name] = Math.max(0, (activeDoorInstances[name] || 1) - 1);
            this._instanceIncremented = false;
        }
    }
};

//  Exported for unit tests only — not part of the public API
exports._test = {
    normalizeConfig,
    shouldPersist,
    buildSessionKeys,
    expandDoorArgs,
    quoteArg,
    userText,
    commandLength,
    sessionPairs,
    isLatin1,
    AmigaDoorSession,
    snapshotCache,
    activeImages,
    activeDoorInstances,
    imageKey,
    Defaults,
    MaxDoorMinutes,
};
