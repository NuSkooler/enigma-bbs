/* jslint node: true */
'use strict';

/**
 * zmachine_door.js — ENiGMA½ native Z-Machine interactive fiction door
 *
 * Runs Z-Machine IF games (Zork, Adventure, Anchorhead, Lost Pig, etc.) in a
 * worker thread via ifvms.js + glkote-term. No external emulator, no serial
 * port bridge, no drop file — just pipe client text through a Glk-based
 * interpreter.
 *
 * Persistence (autosave/restore across sessions) is deferred to a follow-up
 * phase. ifvms.js's built-in do_vm_autosave path is incompatible with the
 * terminal-oriented DumbGlkOte (it expects GlkOte.save_allstate() which only
 * exists in the browser GlkOte). A dedicated zmachine_db.js module is
 * included and the schema is provisioned, but the current MVP starts games
 * fresh each session. See vault notes for the persistence design options.
 *
 * Architecture mirrors v86_door.js since they share a lot of boilerplate
 * (worker spawn/lifecycle, instance tracking, client I/O bridging). Future
 * refactor will extract a shared WorkerDoorModule base class — see vault
 * notes for the DRY plan.
 *
 * Config (menu.hjson):
 *   module: zmachine_door
 *   config: {
 *     name:       string  - door name (required, used for node count tracking)
 *     game_path:  string  - path to .z3/.z5/.z8/.zblorb file (required)
 *     nodeMax:    number  - max concurrent sessions, 0 = unlimited (default: 0)
 *     tooManyArt: string  - art file to show when nodeMax exceeded (optional)
 *   }
 */

const { MenuModule } = require('../menu_module.js');
const { Errors } = require('../enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('../door_util.js');
const theme = require('../theme.js');
const ansi = require('../ansi_term.js');
//  zmachine_db.js is intentionally not required yet — it will be wired up
//  when Phase 2 persistence lands. Schema + helpers already exist.
const zmDb = require('./zmachine_db.js');

//  deps
const async = require('async');
const _ = require('lodash');
const paths = require('path');
const { existsSync, openSync, readSync, closeSync } = require('fs');
const { Worker } = require('worker_threads');

const WORKER_PATH = paths.join(__dirname, 'zmachine_worker.js');

//  Track active instances per door name (mirrors v86_door / abracadabra pattern)
const activeDoorInstances = {};

exports.moduleInfo = {
    name: 'Z-Machine Door',
    desc: 'Native Z-Machine Interactive Fiction Door',
    author: 'NuSkooler',
    packageName: zmDb.MODULE_INFO.packageName,
};

exports.getModule = class ZMachineDoorModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = options.menuConfig.config || {};
        this.config.nodeMax = this.config.nodeMax || 0;
    }

    initSequence() {
        const self = this;
        let clientTerminated = false;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        { name: 'string', game_path: 'string' },
                        callback
                    );
                },

                function checkGameFile(callback) {
                    if (!existsSync(self.config.game_path)) {
                        return callback(
                            Errors.MissingConfig(
                                `zmachine_door: game file not found: ${self.config.game_path}`
                            )
                        );
                    }

                    //  Sanity check the Z-machine version byte. The first byte of
                    //  the z-file header is the version number (ifvms.js supports 3, 4, 5, 8).
                    const SUPPORTED_VERSIONS = [3, 4, 5, 8];
                    try {
                        const fd = openSync(self.config.game_path, 'r');
                        const buf = Buffer.alloc(1);
                        readSync(fd, buf, 0, 1, 0);
                        closeSync(fd);
                        const version = buf[0];
                        if (SUPPORTED_VERSIONS.indexOf(version) < 0) {
                            return callback(
                                Errors.Invalid(
                                    `zmachine_door: unsupported Z-Machine version ${version} (need 3, 4, 5, or 8)`
                                )
                            );
                        }
                    } catch (err) {
                        return callback(
                            Errors.Invalid(
                                `zmachine_door: cannot read game file: ${err.message}`
                            )
                        );
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

                        if (_.isString(self.config.tooManyArt)) {
                            theme.displayThemeArt(
                                { client: self.client, name: self.config.tooManyArt },
                                () => {
                                    self.pausePrompt(() =>
                                        callback(
                                            Errors.AccessDenied(
                                                'Too many active instances'
                                            )
                                        )
                                    );
                                }
                            );
                        } else {
                            self.client.term.write(
                                '\nToo many active instances. Try again later.\n'
                            );
                            self.pausePrompt(() =>
                                callback(Errors.AccessDenied('Too many active instances'))
                            );
                        }
                    } else {
                        self._incrementInstances();
                        return callback(null);
                    }
                },

                function runDoor(callback) {
                    //  Persistence deferred to Phase 2 — spawn with a null
                    //  autosave, game starts fresh. The signature reported
                    //  back by the worker is still logged for diagnostics.
                    self._sessionStartMs = Date.now();
                    self._spawnWorker(null, callback);
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn({ error: err.message }, 'zmachine_door error');
                }

                if (!clientTerminated) {
                    self.prevMenu();
                }
            }
        );

        //  Track disconnect so the outer callback can skip prevMenu()
        this._onClientEndHandler = () => {
            clientTerminated = true;
        };
        this.client.once('end', this._onClientEndHandler);
    }

    _spawnWorker(preloadedAutosave, callback) {
        const self = this;
        const doorTracking = trackDoorRunBegin(self.client, self.config.name);

        const workerData = {
            gamePath: self.config.game_path,
            preloadedAutosave: preloadedAutosave,
        };

        let worker;
        try {
            worker = new Worker(WORKER_PATH, { workerData });
        } catch (err) {
            trackDoorRunEnd(doorTracking);
            self._decrementInstances();
            return callback(err);
        }

        //  Loading spinner — shown until the first game byte arrives.
        //
        //  We keep the spinner visually minimal: clear screen once at the
        //  start so we own the display area cleanly, draw "Loading..."
        //  with a spinning indicator, then when the first output arrives,
        //  erase just the spinner line (NOT a full screen clear) so the
        //  game's content lands on a clean screen without flashing.
        const SPINNER_FRAMES = ['|', '/', '-', '\\'];
        let spinnerIdx = 0;
        let firstOutput = true;
        const doorName = self.config.name;

        self.client.term.write(ansi.resetScreen());
        self.client.term.write(`  Loading ${doorName}... ${SPINNER_FRAMES[0]}`);

        const spinnerInterval = setInterval(() => {
            spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
            self.client.term.rawWrite(
                Buffer.from(
                    `\r  Loading ${doorName}... ${SPINNER_FRAMES[spinnerIdx]}`
                )
            );
        }, 150);

        const stopSpinner = () => {
            if (!firstOutput) return;
            firstOutput = false;
            clearInterval(spinnerInterval);
            //  Erase the spinner line and return cursor to col 0. Leave
            //  the rest of the screen alone — the game will populate it
            //  as it emits output. A full resetScreen() here visibly
            //  flashes and can clip fast-arriving content.
            self.client.term.write('\r\x1b[K');
        };

        //  ── Local line editing + echo ─────────────────────────────────────
        //
        //  The worker runs `readline` with terminal:false (since it talks to
        //  PassThrough streams, not a real TTY), which means no echo and no
        //  backspace handling. BBS users expect server-side echo and local
        //  line editing, so we do both here in the main thread and only
        //  forward completed lines to the worker's VM.
        //
        //  The VM can request either line-mode input (full line with echo and
        //  editing) or character-mode input (single keystroke, no echo — used
        //  by "press any key to continue" prompts in games like Photopia).
        //  The worker posts an `input_mode` message when it changes mode.
        //
        let lineBuffer = '';
        let currentInputMode = 'line';  //  default; worker will announce on init

        //  Write to the client only if the terminal is still attached.
        //  `client.term.output` can be null after a disconnect has started.
        const safeRawWrite = buf => {
            if (self.client && self.client.term && self.client.term.output) {
                try {
                    self.client.term.rawWrite(buf);
                } catch (e) {
                    //  terminal may be tearing down — swallow
                }
            }
        };

        //  ── Pagination ('--MORE--' pauses) ────────────────────────────────
        //
        //  Z-machine games (especially IF) typically emit entire scenes as one
        //  block of text. On a 24-line terminal, that scrolls past unread. We
        //  add server-side "-- MORE --" pauses every N lines and require a
        //  keypress to continue. Reset the counter whenever the VM asks for
        //  input (the user will see the prompt naturally) or when the user
        //  sends a command (they've obviously seen the content).
        //
        const termHeight =
            (self.client.term && self.client.term.termHeight) || 25;
        //  Leave 1 line for the prompt + 1 for a bit of breathing room
        const PAGE_ROWS = Math.max(10, termHeight - 2);
        let _lineCount = 0;
        let _paused = false;
        let _pausedQueue = [];
        //  Reverse-video prompt, long enough to be unmissable. The trailing
        //  space gives a 1-char buffer between the prompt and the edge.
        const MORE_PROMPT =
            '\r\n\x1b[7m  -- More --  Press any key to continue  \x1b[0m';
        //  CR + up 1 line + erase to EOL. The \r\n above means MORE is on
        //  its own line, and we need to undo that line when clearing.
        const CLEAR_MORE = '\r\x1b[K\x1b[1A\x1b[K';

        //  Emit a string of worker output to the client, counting newlines and
        //  pausing at PAGE_ROWS. If already paused, buffers for later flush.
        const emitToClient = data => {
            if (_paused) {
                _pausedQueue.push(data);
                return;
            }
            let pos = 0;
            while (pos < data.length) {
                const nl = data.indexOf('\n', pos);
                if (nl === -1) {
                    //  No more newlines in this chunk — write the rest and return
                    safeRawWrite(Buffer.from(data.slice(pos), 'utf8'));
                    return;
                }
                //  Write up to and including the newline
                safeRawWrite(Buffer.from(data.slice(pos, nl + 1), 'utf8'));
                pos = nl + 1;
                _lineCount++;

                if (_lineCount >= PAGE_ROWS) {
                    //  Pause point
                    safeRawWrite(Buffer.from(MORE_PROMPT, 'utf8'));
                    _paused = true;
                    if (pos < data.length) {
                        _pausedQueue.push(data.slice(pos));
                    }
                    return;
                }
            }
        };

        //  Release the pause, clearing the prompt and flushing buffered output.
        const releasePause = () => {
            if (!_paused) return;
            _paused = false;
            _lineCount = 0;
            safeRawWrite(Buffer.from(CLEAR_MORE, 'utf8'));
            //  Drain queue. Each emitToClient call may repause.
            const queued = _pausedQueue;
            _pausedQueue = [];
            for (let i = 0; i < queued.length; i++) {
                emitToClient(queued[i]);
                if (_paused) {
                    //  Repaused — push remaining items back on the queue
                    for (let j = i + 1; j < queued.length; j++) {
                        _pausedQueue.push(queued[j]);
                    }
                    break;
                }
            }
        };

        //  Called when the VM announces a new input mode. We do NOT force-
        //  flush any pending pause — the pending text (including whatever
        //  prompt the game just emitted) is already in _pausedQueue, and
        //  the user's next keystroke will release the pause and reveal it.
        //  All we need to do here is reset the counter so that when the
        //  pause is released, we start counting fresh for the NEXT batch.
        //
        //  If we instead dumped the queue here, the MORE prompt would
        //  disappear before the user could see it (the worker emits output
        //  and input_mode back-to-back).
        const resetLineCountForInput = () => {
            //  Only reset when we're NOT currently paused. If paused, the
            //  releasePause path will reset naturally when it fires.
            if (!_paused) {
                _lineCount = 0;
            }
        };

        const onClientData = data => {
            //  If we're paused waiting for MORE, any keystroke releases.
            //  Consume the keystroke entirely — don't forward it to the game.
            if (_paused) {
                releasePause();
                return;
            }

            //  In character mode, every keystroke is its own event — we
            //  forward one byte at a time with no echo (the game handles
            //  display). In line mode, we buffer and echo as before.
            if (currentInputMode === 'char') {
                //  Send each byte as a char_input message.
                for (let i = 0; i < data.length; i++) {
                    const byte = data[i];
                    //  Skip the LF after a CR (telnet CRLF pair)
                    if (byte === 0x0a && i > 0 && data[i - 1] === 0x0d) continue;
                    try {
                        worker.postMessage({
                            type: 'char_input',
                            key: String.fromCharCode(byte),
                        });
                    } catch (e) {
                        //  worker gone
                    }
                }
                return;
            }

            //  Line mode
            const echoBytes = [];
            for (let i = 0; i < data.length; i++) {
                const byte = data[i];

                if (byte === 0x08 || byte === 0x7f) {
                    //  Backspace / DEL — erase on screen + drop from buffer
                    if (lineBuffer.length > 0) {
                        lineBuffer = lineBuffer.slice(0, -1);
                        echoBytes.push(0x08, 0x20, 0x08);
                    }
                } else if (byte === 0x0d || byte === 0x0a) {
                    //  Enter — echo CRLF, send completed line to worker
                    echoBytes.push(0x0d, 0x0a);
                    if (echoBytes.length > 0) {
                        safeRawWrite(Buffer.from(echoBytes));
                        echoBytes.length = 0;
                    }
                    try {
                        worker.postMessage({
                            type: 'input',
                            data: lineBuffer + '\n',
                        });
                    } catch (e) {
                        //  worker gone — ignore
                    }
                    lineBuffer = '';
                    //  Skip paired LF after a CR (telnet CRLF pairs)
                    if (byte === 0x0d && i + 1 < data.length && data[i + 1] === 0x0a) {
                        i++;
                    }
                } else if (byte >= 0x20 && byte < 0x7f) {
                    //  Printable ASCII — buffer + echo
                    lineBuffer += String.fromCharCode(byte);
                    echoBytes.push(byte);
                }
                //  Everything else silently dropped
            }
            if (echoBytes.length > 0) {
                safeRawWrite(Buffer.from(echoBytes));
            }
        };

        //  Attach input listener only if term.output exists (it may not if
        //  the client has already disconnected during menu transition).
        if (self.client.term.output) {
            self.client.term.output.on('data', onClientData);
        }

        //  Helper: detach from client.term.output safely, accounting for the
        //  possibility that term.output is already null at the time we call.
        const detachInputListener = () => {
            if (
                self.client &&
                self.client.term &&
                self.client.term.output &&
                typeof self.client.term.output.removeListener === 'function'
            ) {
                self.client.term.output.removeListener('data', onClientData);
            }
        };

        //  Client disconnected mid-game
        const onClientEnd = () => {
            clearInterval(spinnerInterval);
            self.client.log.info(
                { name: self.config.name },
                'Client disconnected — terminating zmachine worker'
            );
            try {
                worker.postMessage({ type: 'stop' });
            } catch (e) {
                //  worker may already be gone
            }
            try {
                worker.terminate();
            } catch (e) {
                //  ignore
            }
            detachInputListener();
        };
        self.client.once('end', onClientEnd);

        //  Cleanup helper shared between success/error/exit paths
        const cleanup = () => {
            clearInterval(spinnerInterval);
            detachInputListener();
            self.client.removeListener('end', onClientEnd);
            trackDoorRunEnd(doorTracking);
            self._decrementInstances();
        };

        worker.on('message', msg => {
            switch (msg.type) {
                case 'ready':
                    self.client.log.info(
                        {
                            name: self.config.name,
                            signature: msg.signature,
                            startupMs: msg.startupMs,
                        },
                        'Z-Machine VM ready'
                    );
                    //  If the worker produced its signature, prefer it over our
                    //  pre-computed one (they should match but just in case).
                    if (msg.signature) {
                        self._sessionSignature = msg.signature;
                    }
                    break;

                case 'output':
                    stopSpinner();
                    //  Route through the paginator. It handles MORE prompts
                    //  and buffering if we're waiting on a keypress.
                    emitToClient(msg.data);
                    break;

                case 'input_mode':
                    //  Worker announced that the VM wants line-mode or
                    //  character-mode input. Update our local routing.
                    //  Reset the line counter too, but DON'T flush a pending
                    //  pause — the queued content is the prompt the user
                    //  needs to see, and it'll drain when they release MORE.
                    if (msg.mode === 'char' || msg.mode === 'line') {
                        currentInputMode = msg.mode;
                        if (msg.mode === 'char') {
                            lineBuffer = '';
                        }
                        resetLineCountForInput();
                    }
                    break;

                case 'save':
                    //  Phase 2: route to zmDb.writeAutosave. Currently the
                    //  worker does not emit save messages (do_vm_autosave is
                    //  disabled), so this case is inert for MVP.
                    break;

                case 'stopped': {
                    const secs = (msg.elapsed / 1000).toFixed(1);
                    self.client.log.info(
                        { name: self.config.name, elapsed: secs },
                        'Z-Machine VM stopped'
                    );
                    cleanup();
                    return callback(null);
                }

                case 'error':
                    self.client.log.warn(
                        { name: self.config.name, error: msg.message },
                        'zmachine worker error'
                    );
                    cleanup();
                    return callback(new Error(msg.message));

                default:
                    break;
            }
        });

        worker.on('error', err => {
            self.client.log.warn(
                { name: self.config.name, error: err.message },
                'zmachine worker thread error'
            );
            cleanup();
            return callback(err);
        });

        worker.on('exit', code => {
            if (code !== 0) {
                self.client.log.warn(
                    { name: self.config.name, code },
                    'zmachine worker exited with non-zero code'
                );
            }
        });
    }

    _incrementInstances() {
        const name = this.config.name;
        activeDoorInstances[name] = (activeDoorInstances[name] || 0) + 1;
        this._instanceIncremented = true;
    }

    _decrementInstances() {
        if (this._instanceIncremented) {
            const name = this.config.name;
            activeDoorInstances[name] = Math.max(
                0,
                (activeDoorInstances[name] || 1) - 1
            );
            this._instanceIncremented = false;
        }
    }
};
