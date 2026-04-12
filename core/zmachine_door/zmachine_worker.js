/* jslint node: true */
'use strict';

/**
 * zmachine_worker.js
 *
 * Worker thread that runs a single ifvms.js Z-Machine VM for one active BBS
 * session. Spawned by zmachine_door.js via worker_threads. Communicates with
 * the main thread via parentPort for I/O, save, and lifecycle events.
 *
 * Each Z-Machine session needs its own worker because glkote-term's glkapi.js
 * holds module-level state — multiple VMs in the same thread would clobber
 * each other. Workers provide clean per-session isolation. This was verified
 * in the Z-Machine POC (smoke-d-worker.js).
 *
 * Color & style support:
 *   - Phase A: Glk text styles (bold/italic/header/etc.) map to ANSI SGR
 *     via our WorkerGlkOte subclass. Works for any game that uses glk_set_style.
 *   - Phase B: Garglk color extensions — monkey-patches the Glk object to
 *     implement garglk_set_zcolors_stream + glk_gestalt(0x1100), tracks per-
 *     window z-colors, and emits ANSI 16-color escapes for games like Photopia.
 *
 * workerData shape:
 * {
 *   gamePath:          string   - path to the .z3/.z5/.z8 file
 *   preloadedAutosave: Buffer   - pre-fetched autosave data, or null for fresh start
 * }
 *
 * parentPort protocol (worker → parent):
 *   { type: 'ready', signature: string }        - VM initialized, game started
 *   { type: 'output', data: string }            - text output from the VM
 *   { type: 'input_mode', mode: 'char'|'line' } - VM switched input mode
 *   { type: 'save', signature, data: Buffer }   - VM wants to persist an autosave
 *   { type: 'stopped', elapsed: number }        - VM halted cleanly
 *   { type: 'error', message: string }          - fatal error
 *
 * parentPort protocol (parent → worker):
 *   { type: 'input', data: string }             - text input from the user
 *   { type: 'char_input', key: string }         - single keystroke (char mode)
 *   { type: 'stop' }                            - graceful shutdown request
 */

const { workerData, parentPort } = require('worker_threads');
const { readFileSync } = require('fs');
const { PassThrough } = require('stream');
const readline = require('readline');

const GlkOteLib = require('glkote-term');
const MuteStream = require('mute-stream');
const ifvms = require('ifvms');
//  ZVMDispatch implements Glk's "dispatch" interface — required at runtime
//  when do_vm_autosave is enabled, but ifvms only auto-creates the
//  window.GiDispa instance in browsers. In Node.js we must instantiate it
//  ourselves and pass it in via options.GiDispa.
const ZVMDispatch = require('ifvms/src/zvm/dispatch.js');

const t0 = Date.now();

//  ─── Load the game file synchronously ─────────────────────────────────────
let gameData;
try {
    gameData = readFileSync(workerData.gamePath);
} catch (err) {
    parentPort.postMessage({
        type: 'error',
        message: `Cannot read game file: ${err.message}`,
    });
    process.exit(1);
}

//  ─── Create custom streams that stand in for a real terminal ──────────────
const clientInput = new PassThrough();
const rawOutput = new PassThrough();

//  Both ends must be non-TTY so DumbGlkOte skips raw mode and cursor escapes.
clientInput.isTTY = false;
rawOutput.isTTY = false;
clientInput.setRawMode = () => clientInput;

//  MuteStream wraps stdout — mirrors glkote-term/tests/zvm.js reference pattern.
const stdout = new MuteStream();
stdout.pipe(rawOutput);

//  Forward all VM output directly to the main thread byte-for-byte. The BBS
//  client will render it as-is. glkote-term uses ANSI cursor save/restore
//  escapes only on TTY streams, and we've set isTTY=false so those are skipped.
rawOutput.on('data', chunk => {
    parentPort.postMessage({
        type: 'output',
        data: chunk.toString('utf8'),
    });
});

//  ─── Readline interface (DumbGlkOte uses this for line-mode input) ────────
const rl = readline.createInterface({
    input: clientInput,
    output: stdout,
    prompt: '',
    terminal: false,
});

const rl_opts = { rl, stdin: clientInput, stdout };

//  ─── Dialog (save/restore stubs for MVP) ──────────────────────────────────
//
//  The WorkerDialog class is retained as a seam for Phase 2 persistence. For
//  the MVP, do_vm_autosave is disabled (DumbGlkOte doesn't implement
//  save_allstate/restore_allstate), so Dialog methods are only invoked for
//  user-initiated SAVE/RESTORE commands. Those will be wired up later.
//
class WorkerDialog extends GlkOteLib.DumbGlkOte.Dialog {
    constructor(options) {
        super(options);
        this._preloadedAutosave = workerData.preloadedAutosave;
    }

    //  Phase 2 hooks — currently unused
    autosave_read() {
        const data = this._preloadedAutosave;
        this._preloadedAutosave = null;
        return data;
    }

    autosave_write(signature, snapshot) {
        parentPort.postMessage({
            type: 'save',
            signature: signature,
            data: snapshot ? Buffer.from(snapshot) : null,
        });
    }
}

//  ─── Style → ANSI mapping ─────────────────────────────────────────────────
//
//  Glk has 11 standard style names. ifvms maps Z-machine bold/italic/mono
//  combinations to a subset of them (see ifvms/src/zvm/io.js: style_mappings).
//  We render each style as ANSI SGR:
//
//    mono             -> preformatted
//    italic           -> emphasized
//    italic + mono    -> user2   (arbitrary, ifvms picks this)
//    bold             -> subheader
//    bold + mono      -> user1   (arbitrary, ifvms picks this)
//    bold + italic    -> alert
//    bold + italic+mono -> note
//
//  The ANSI escapes below use basic 16-color / SGR attributes so they work
//  on any BBS terminal.
//
const SGR_RESET = '\x1b[0m';

const STYLE_SGR = {
    //  Glk style name       -> ANSI SGR (prefix to apply, reset at chunk end)
    normal:       '',
    emphasized:   '\x1b[3m',           //  italic
    preformatted: '',                  //  mono — no special rendering
    header:       '\x1b[1;4m',         //  bold + underline
    subheader:    '\x1b[1m',           //  bold
    alert:        '\x1b[1;3m',         //  bold + italic
    note:         '\x1b[1;3m',         //  same as alert for now
    blockquote:   '\x1b[2m',           //  dim
    input:        '\x1b[36m',          //  cyan — for echoed user input (rare)
    user1:        '\x1b[1m',           //  bold (mono+bold)
    user2:        '\x1b[3m',           //  italic (mono+italic)
};

//  ─── GlkOte subclass: style rendering, input mode, shutdown ──────────────
//
//  Responsibilities:
//    1. Override update_content() to render Glk styles as ANSI SGR.
//       Z-machine colors pass through transparently — they're emitted as
//       raw ANSI SGR bytes inside the text stream by our vm.set_colour hook.
//    2. Override update_inputs() to notify main thread of char/line mode.
//    3. Override exit() to terminate the worker cleanly on game quit.
//
class WorkerGlkOte extends GlkOteLib.DumbGlkOte {

    constructor(options) {
        super(options);
        //  Target line width for word wrap. Glkote-term's measure_window
        //  reports 80×25 when not on a TTY, which matches typical BBS size.
        //  We wrap at this width before emitting to the BBS client.
        this.wrapWidth = 80;
        //  Tracks the visible column of the current output line. Persists
        //  across chunks within the same Glk "line" (see `line.append`) and
        //  resets when we emit a newline.
        this._col = 0;
    }

    //  Visible length of a string, discarding ANSI CSI m sequences.
    _visibleLen(s) {
        //  Fast path: no ESC byte means it's all visible.
        if (s.indexOf('\x1b') === -1) return s.length;
        //  Strip CSI ... m sequences.
        return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
    }

    //  Word-wrap aware write. Tracks `this._col` across calls so sequential
    //  styled chunks on the same logical line wrap correctly at word
    //  boundaries. Any ANSI SGR bytes in `text` are treated as zero-width.
    _wrappedWrite(text) {
        if (!text) return;

        //  Split on hard newlines first — each piece becomes its own wrapped
        //  paragraph. Leading/trailing empty pieces represent explicit blank
        //  lines and still need to emit a newline.
        const pieces = text.split('\n');
        for (let p = 0; p < pieces.length; p++) {
            if (p > 0) {
                //  Hard newline from the source
                this.stdout.write('\n');
                this._col = 0;
            }
            let piece = pieces[p];
            if (piece.length === 0) continue;

            //  Word-wrap this piece. Split on spaces so we can fit whole
            //  words up to the wrap width. Preserve leading/trailing
            //  whitespace as actual spaces (they matter in IF formatting).
            //
            //  We use a simple greedy algorithm: emit words until adding
            //  the next word would exceed wrapWidth, then break.
            //
            //  Tokenize into alternating [run of non-space, run of space]
            //  so we handle multi-space indents correctly.
            const tokens = piece.match(/\s+|\S+/g);
            if (!tokens) continue;

            for (const tok of tokens) {
                const vis = this._visibleLen(tok);

                if (/^\s+$/.test(tok)) {
                    //  Whitespace run. If emitting would exceed width,
                    //  eat it and wrap instead of emitting trailing spaces.
                    if (this._col + vis >= this.wrapWidth) {
                        this.stdout.write('\n');
                        this._col = 0;
                        continue;
                    }
                    this.stdout.write(tok);
                    this._col += vis;
                    continue;
                }

                //  Non-space word. If it fits on the current line, emit it.
                if (this._col + vis <= this.wrapWidth) {
                    this.stdout.write(tok);
                    this._col += vis;
                    continue;
                }

                //  Doesn't fit. If we're not at the start of a line, wrap.
                if (this._col > 0) {
                    this.stdout.write('\n');
                    this._col = 0;
                }

                //  Word itself is longer than the whole wrap width — we'd
                //  never fit it on one line. Hard-split it at wrapWidth.
                if (vis > this.wrapWidth) {
                    //  Emit chunks of wrapWidth. ANSI escapes make this
                    //  tricky — for now we just emit the raw text and
                    //  let it overflow. In practice long words are rare.
                    this.stdout.write(tok);
                    this._col = (this._col + vis) % this.wrapWidth;
                    continue;
                }

                //  Fresh line, word fits
                this.stdout.write(tok);
                this._col += vis;
            }
        }
    }

    update_content(data) {
        //  Find the chunk that matches our (single) window, same as base class.
        const myWin = data.filter(c => c.id === this.window.id)[0];
        if (!myWin || !myWin.text) return;

        for (const line of myWin.text) {
            if (!line.append) {
                //  Start a new logical line — emit a real newline and reset
                //  our column tracker.
                this.stdout.write('\n');
                this._col = 0;
            }
            const content = line.content;
            if (!content) continue;

            //  The content array alternates between:
            //    - simple form: [ stylename, text, stylename, text, ... ]
            //    - object form: [ { style, text, hyperlink? }, ... ]
            for (let i = 0; i < content.length; i++) {
                let style = 'normal';
                let text = '';

                if (typeof content[i] === 'string') {
                    style = content[i];
                    i++;
                    text = content[i];
                } else if (content[i] && typeof content[i] === 'object') {
                    style = content[i].style || 'normal';
                    text = content[i].text || '';
                }

                if (!text) continue;

                const sgr = STYLE_SGR[style] || '';
                //  Emit SGR prefix, then the word-wrapped text, then the
                //  reset. The wrap logic treats SGR bytes as zero-width.
                if (sgr) {
                    this.stdout.write(sgr);
                }
                this._wrappedWrite(text);
                if (sgr) {
                    this.stdout.write(SGR_RESET);
                }
            }
        }
    }

    update_inputs(data) {
        //  Detect and notify main thread of input mode changes so it can
        //  route keystrokes appropriately (char mode = send individual
        //  keystrokes; line mode = buffer and send completed lines).
        if (data && data.length) {
            const type = data[0].type;
            if (type === 'char' || type === 'line') {
                try {
                    parentPort.postMessage({ type: 'input_mode', mode: type });
                } catch (e) {
                    //  ignore
                }
            }
        }
        //  Delegate to base class for the actual handler attachment.
        super.update_inputs(data);
    }

    exit() {
        try {
            super.exit();
        } catch (e) {
            //  ignore — we're shutting down anyway
        }
        try {
            parentPort.postMessage({
                type: 'stopped',
                elapsed: Date.now() - t0,
            });
        } catch (e) {
            //  ignore
        }
        //  Give postMessage a tick to flush before exiting.
        setImmediate(() => process.exit(0));
    }
}

//  ─── VM setup ─────────────────────────────────────────────────────────────
const vm = new ifvms.ZVM();
const Glk = GlkOteLib.Glk;

//  ─── Phase B: Z-Machine color via VM method override ─────────────────────
//
//  The naive approach — patching glk_gestalt to advertise Garglk extensions
//  and supplying garglk_set_zcolors_stream — fails because ifvms then tries
//  to apply colors to an upper status window that DumbGlkOte can't provide.
//  We can't supply a working split-window interface on top of a single-
//  window terminal GlkOte.
//
//  Instead, we hook ifvms's set_colour method on the VM instance directly.
//  When the game calls set_colour, we emit an ANSI SGR escape sequence as
//  text into the main window. This becomes part of the normal chunked
//  output flow — our WorkerGlkOte.update_content passes the bytes through
//  untouched since the ESC sequence looks like just more text.
//
//  We need to do this AFTER vm.prepare() (which initializes the VM object
//  structure) but BEFORE Glk.init() (which starts the game). The hook is
//  installed below.

//  Z-machine color number → ANSI SGR code
//  These are the 8 standard z-machine colors (values 2-9 in the set_colour
//  opcode; 0 = "current" no-op, 1 = "default" emits reset).
const Z_COLOUR_FG = {
    0: null,          // current — no change
    1: '\x1b[39m',    // default
    2: '\x1b[30m',    // black
    3: '\x1b[31m',    // red
    4: '\x1b[32m',    // green
    5: '\x1b[33m',    // yellow
    6: '\x1b[34m',    // blue
    7: '\x1b[35m',    // magenta
    8: '\x1b[36m',    // cyan
    9: '\x1b[37m',    // white
    10: '\x1b[37m',   // light grey
    11: '\x1b[90m',   // medium grey (bright black)
    12: '\x1b[90m',   // dark grey
};
const Z_COLOUR_BG = {
    0: null,
    1: '\x1b[49m',
    2: '\x1b[40m',
    3: '\x1b[41m',
    4: '\x1b[42m',
    5: '\x1b[43m',
    6: '\x1b[44m',
    7: '\x1b[45m',
    8: '\x1b[46m',
    9: '\x1b[47m',
    10: '\x1b[47m',
    11: '\x1b[100m',
    12: '\x1b[100m',
};

//  NOTE on autosave:
//  ifvms's do_vm_autosave mechanism calls GlkOte.save_allstate()/restore_allstate()
//  internally, which the terminal-oriented DumbGlkOte does not implement. So we
//  cannot use the built-in autosave path with this stack. Persistence is deferred
//  to a Phase 2 feature — for MVP, games start fresh each session.

const options = {
    vm,
    Dialog: new WorkerDialog(rl_opts),
    Glk,
    //  Use our WorkerGlkOte subclass so we can detect game quit cleanly.
    GlkOte: new WorkerGlkOte(rl_opts),
    //  Glk dispatch instance. ifvms auto-creates this only in the browser
    //  (via window.GiDispa), so in Node.js we must supply it ourselves.
    GiDispa: new ZVMDispatch(),
    //  do_vm_autosave: true intentionally NOT set — incompatible with DumbGlkOte.
};

try {
    vm.prepare(gameData, options);
} catch (err) {
    parentPort.postMessage({
        type: 'error',
        message: `vm.prepare() failed: ${err.message}`,
    });
    process.exit(1);
}

//  ─── Install set_colour hook on the VM ────────────────────────────────────
//
//  ifvms's set_colour opcode handler takes two numeric z-machine color
//  values (0-12) and converts them to RGB for Garglk. Since we can't use
//  Garglk, we replace the method with one that emits ANSI SGR directly
//  via glk_put_jstring_stream on the main window.
//
//  The method must be attached to the VM instance (not the prototype) and
//  must have access to `this.mainwin` — which is populated during VM.start(),
//  not vm.prepare(). So we defer the actual emission to runtime.
vm.set_colour = function (fg, bg) {
    const parts = [];
    const fgSgr = Z_COLOUR_FG[fg];
    const bgSgr = Z_COLOUR_BG[bg];
    if (fgSgr) parts.push(fgSgr);
    if (bgSgr) parts.push(bgSgr);

    if (parts.length === 0) return;

    //  Emit the SGR directly to the parent as raw output. This bypasses
    //  the glkote accumulator (which for some reason was eating our
    //  escape bytes) and is delivered to the client terminal in-band
    //  with whatever text the game emits next.
    //
    //  Caveat: the timing may be slightly off relative to the VM's next
    //  text emission because glkote buffers output per update cycle. In
    //  practice this works well for games like Photopia that change color
    //  at scene boundaries where no mid-scene text is in flight.
    parentPort.postMessage({
        type: 'output',
        data: parts.join(''),
    });
};

//  ifvms's set_true_colour is also called directly in a few places.
//  Replace it with a no-op so it doesn't try to use Garglk.
vm.set_true_colour = function () {
    //  no-op — we handle color via set_colour above
};

try {
    Glk.init(options);
} catch (err) {
    parentPort.postMessage({
        type: 'error',
        message: `Glk.init() failed: ${err.message}`,
    });
    process.exit(1);
}

//  Report the signature back to the main thread so it can write the final
//  autosave row with the correct key on shutdown.
const signature = vm.get_signature ? vm.get_signature() : null;
parentPort.postMessage({
    type: 'ready',
    signature: signature,
    startupMs: Date.now() - t0,
});

//  ─── Input pump: parent → VM ──────────────────────────────────────────────
//
//  Two input paths:
//    'input'      - line-mode text (complete line, buffered by main thread)
//    'char_input' - single keystroke for character-mode prompts
//
//  For line mode, we write bytes to clientInput and readline emits 'line' events
//  which DumbGlkOte picks up via handle_line_input.
//
//  For character mode, DumbGlkOte attaches a 'keypress' listener to stdin.
//  We synthesize a keypress event by emitting it directly on clientInput with
//  the expected (str, key) signature.
//
parentPort.on('message', msg => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
        case 'input':
            if (typeof msg.data === 'string') {
                clientInput.write(msg.data);
            } else if (Buffer.isBuffer(msg.data)) {
                clientInput.write(msg.data);
            }
            break;

        case 'char_input': {
            //  Synthesize a keypress event. DumbGlkOte.handle_char_input
            //  expects (str, key) where str is the character and key is a
            //  node-readline key descriptor object with a 'name' field.
            const ch = typeof msg.key === 'string' ? msg.key : '';
            if (ch.length > 0) {
                //  For a normal printable key, str = the char, key.name = lowercase char.
                //  For special keys, we pass a name that DumbGlkOte recognizes.
                let keyObj;
                if (ch === '\r' || ch === '\n') {
                    keyObj = { name: 'return' };
                } else if (ch === '\x1b') {
                    keyObj = { name: 'escape' };
                } else if (ch === '\x7f' || ch === '\b') {
                    keyObj = { name: 'backspace' };
                } else if (ch === ' ') {
                    keyObj = { name: 'space' };
                } else {
                    keyObj = { name: ch.toLowerCase() };
                }
                clientInput.emit('keypress', ch, keyObj);
            }
            break;
        }

        case 'stop':
            parentPort.postMessage({
                type: 'stopped',
                elapsed: Date.now() - t0,
            });
            process.exit(0);
            break;

        default:
            break;
    }
});
