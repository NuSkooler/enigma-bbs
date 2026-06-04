/* jslint node: true */
/* eslint-disable no-console */
'use strict';

/**
 * oputil_v86.js — v86 x86 emulation tools
 *
 * Provides oputil `v86` subcommands for booting raw FreeDOS disk images
 * using the v86 emulator. Does not require a running ENiGMA instance.
 *
 * Commands:
 *   v86 console <image.img> [options]   Boot image, wire COM1 to terminal
 *   v86 desktop <image.img> [options]   Boot image in browser (full VGA)
 *
 * Options:
 *   --bios PATH       SeaBIOS image path (default: misc/v86_bios/seabios.bin)
 *   --vga-bios PATH   VGA BIOS image path (default: misc/v86_bios/vgabios.bin)
 */

const { printUsageAndSetExitCode, argv, ExitCodes } = require('./oputil_common.js');
const { getHelpFor } = require('./oputil_help.js');

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const ENIGMA_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_BIOS_PATH = path.join(ENIGMA_ROOT, 'misc', 'v86_bios', 'seabios.bin');
const DEFAULT_VGA_BIOS_PATH = path.join(ENIGMA_ROOT, 'misc', 'v86_bios', 'vgabios.bin');
const WORKER_PATH = path.join(ENIGMA_ROOT, 'core', 'v86_door', 'v86_worker.js');

exports.handleV86Command = handleV86Command;

// ─── Shared validation ───────────────────────────────────────────────────────

function resolvePaths(imagePath) {
    const biosPath = argv['bios'] || DEFAULT_BIOS_PATH;
    const vgaBiosPath = argv['vga-bios'] || DEFAULT_VGA_BIOS_PATH;

    for (const [label, p] of [
        ['image', imagePath],
        ['bios', biosPath],
        ['vga-bios', vgaBiosPath],
    ]) {
        if (!fs.existsSync(p)) {
            console.error(`v86: ${label} not found: ${p}`);
            if (label !== 'image') {
                console.error(
                    'Download BIOS files: misc/install.sh or see docs/_docs/modding/local-doors-v86.md'
                );
            }
            process.exitCode = ExitCodes.BAD_ARGS;
            return null;
        }
    }

    return { imagePath, biosPath, vgaBiosPath };
}

// ─── console ─────────────────────────────────────────────────────────────────

function cmdConsole(imagePath) {
    const paths = resolvePaths(imagePath);
    if (!paths) return;

    const { createFloppyWithFiles } = require('../v86_door/fat_image.js');

    // v86's Ba() helper checks `buffer instanceof ArrayBuffer`; SAB is not a subtype.
    // Patch before requiring v86 (via the worker) so both types pass.
    Object.defineProperty(ArrayBuffer, Symbol.hasInstance, {
        value(v) {
            return v !== null && typeof v === 'object' &&
                (v.constructor === ArrayBuffer || v.constructor === SharedArrayBuffer);
        },
        configurable: true, writable: true,
    });

    // Load image into SAB so worker can use it and we can flush it back on exit.
    const imageFile = fs.readFileSync(paths.imagePath);
    const imageSab  = new SharedArrayBuffer(imageFile.byteLength);
    new Uint8Array(imageSab).set(imageFile);

    // Inject a RUN.BAT that redirects the DOS shell to COM1 so the
    // terminal becomes an interactive DOS prompt (requires CTTY support).
    const runBat = Buffer.from('CTTY COM1\r\n', 'ascii');
    createFloppyWithFiles([{ name: 'RUN.BAT', content: runBat }])
        .then(floppyBuffer => {
            const workerData = {
                imageSab,
                floppyBuffer,
                memoryMb: argv['memory'] || 64,
                biosPath: paths.biosPath,
                vgaBiosPath: paths.vgaBiosPath,
            };

            const worker = new Worker(WORKER_PATH, { workerData });

            console.error('v86 console: booting — Ctrl+] to exit\n');

            process.stdin.setRawMode?.(true);
            process.stdin.resume();

            process.stdin.on('data', data => {
                // Ctrl+] (0x1D) = exit
                if (data.length === 1 && data[0] === 0x1d) {
                    console.error('\nv86 console: exit');
                    worker.postMessage({ type: 'stop' });
                    return;
                }
                worker.postMessage({ type: 'input', data });
            });

            worker.on('message', msg => {
                switch (msg.type) {
                    case 'output':
                        process.stdout.write(Buffer.from(msg.data));
                        break;

                    case 'stopped':
                        process.stdin.setRawMode?.(false);
                        console.error('\nv86 console: saving image...');
                        fs.writeFileSync(paths.imagePath, Buffer.from(imageSab));
                        console.error(`v86 console: saved to ${paths.imagePath}`);
                        process.exit(0);
                        break;

                    case 'error':
                        console.error(`v86 console: emulator error: ${msg.message}`);
                        process.stdin.setRawMode?.(false);
                        process.exitCode = ExitCodes.ERROR;
                        worker.terminate();
                        break;

                    default:
                        break;
                }
            });

            worker.on('error', err => {
                console.error(`v86 console: worker error: ${err.message}`);
                process.stdin.setRawMode?.(false);
                process.exitCode = ExitCodes.ERROR;
            });

            process.on('SIGINT', () => {
                console.error('\nv86 console: SIGINT — stopping');
                worker.postMessage({ type: 'stop' });
            });
        })
        .catch(err => {
            console.error(`v86 console: ${err.message}`);
            process.exitCode = ExitCodes.ERROR;
        });
}

// ─── desktop ─────────────────────────────────────────────────────────────────

//  The HTML page served to the browser. Embedded here to keep the tool
//  self-contained — no extra asset files needed.
const DESKTOP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ENiGMA&#189; v86 Desktop</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #111; color: #ccc; font-family: monospace; display: flex;
       flex-direction: column; align-items: center; padding: 16px; gap: 12px; }
h1 { font-size: 1rem; color: #8f8; letter-spacing: 2px; }
#screen { border: 2px solid #444; cursor: default; line-height: 0; width: 720px; min-height: 400px; background: #000; }
#screen canvas { image-rendering: pixelated; display: block; }
#controls { display: flex; gap: 8px; align-items: center; }
button { background: #333; color: #ccc; border: 1px solid #555; padding: 6px 14px;
         cursor: pointer; font-family: monospace; font-size: 0.9rem; }
button:hover { background: #444; }
#status { font-size: 0.8rem; color: #888; }
details { width: 724px; }
summary { font-size: 0.75rem; color: #666; cursor: pointer; user-select: none; padding: 2px 0; }
summary:hover { color: #999; }
#log { background: #0a0a0a; border: 1px solid #333; padding: 8px;
       font-size: 0.72rem; color: #666; max-height: 120px; overflow-y: auto;
       white-space: pre; margin-top: 4px; }
#log .ok  { color: #6a6; }
#log .err { color: #a66; }
#log .inf { color: #668; }
</style>
</head>
<body>
<h1>ENiGMA&#189; // v86 Desktop</h1>
<div id="screen">
  <div style="white-space:pre;font:14px monospace;line-height:14px"></div>
  <canvas style="display:none"></canvas>
</div>
<div id="controls">
  <button id="btnSave">Save Image</button>
  <button id="btnStop">Stop</button>
  <span id="status">Starting emulator...</span>
</div>
<details>
  <summary>Show details</summary>
  <div id="log"></div>
</details>

<script src="/libv86.js"></script>
<script>
const status = document.getElementById('status');
const logEl  = document.getElementById('log');

function log(msg, cls) {
    const line = document.createElement('span');
    if (cls) line.className = cls;
    line.textContent = new Date().toISOString().slice(11,19) + '  ' + msg + '\\n';
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

// Intercept XHR (v86 uses XHR for WASM/BIOS/image, not fetch)
const _XHRopen = XMLHttpRequest.prototype.open;
const _XHRsend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url) {
    this._logUrl = url;
    return _XHRopen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function() {
    const url = this._logUrl || '?';
    log('XHR  ' + url, 'inf');
    this.addEventListener('load', () => {
        log((this.status < 400 ? 'OK   ' : 'FAIL ') + url + ' (' + this.status + ')', this.status < 400 ? 'ok' : 'err');
    });
    this.addEventListener('error', () => {
        log('ERR  ' + url, 'err');
    });
    return _XHRsend.apply(this, arguments);
};

log('Loading libv86.js...', 'inf');

// Preload the disk image with progress before starting v86.
// async:true (range requests) is unusable over any network — each sector
// read is a separate HTTP round-trip. One full download is far faster.
let emulator;

(async () => {
    try {
        log('Fetching disk image...', 'inf');
        const resp = await fetch('/image');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const total   = parseInt(resp.headers.get('content-length') || '0', 10);
        const reader  = resp.body.getReader();
        const chunks  = [];
        let   received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (total) {
                const pct = Math.round(received / total * 100);
                const mb  = (received / 1048576).toFixed(0);
                const tot = (total    / 1048576).toFixed(0);
                status.textContent = \`Loading image: \${mb} / \${tot} MB (\${pct}%)\`;
            } else {
                status.textContent = \`Loading image: \${(received / 1048576).toFixed(0)} MB...\`;
            }
        }

        log('Image loaded (' + (received / 1048576).toFixed(1) + ' MB) — starting emulator', 'ok');
        status.textContent = 'Starting emulator...';

        // Combine chunks into one ArrayBuffer.
        // Keep a reference to imageData — v86 writes guest disk changes directly
        // into this buffer, so saving imageData.buffer is always correct and current.
        const imageData = new Uint8Array(received);
        let   offset    = 0;
        for (const chunk of chunks) { imageData.set(chunk, offset); offset += chunk.length; }

        emulator = new V86({
            wasm_path:    '/v86.wasm',
            bios:         { url: '/bios/seabios.bin' },
            vga_bios:     { url: '/bios/vgabios.bin' },
            hda:          { buffer: imageData.buffer, async: false },
            boot_order:   786,
            memory_size:  64 * 1024 * 1024,
            vga_memory_size: 2 * 1024 * 1024,
            screen_container: document.getElementById('screen'),
            autostart: true,
        });

        log('V86 instance created', 'inf');

        emulator.add_listener('emulator-loaded', () => {
            status.textContent = 'Booting...';
            log('emulator-loaded — booting', 'ok');
        });
        emulator.add_listener('emulator-started', () => {
            status.textContent = 'Running';
            log('emulator-started — CPU running', 'ok');
        });
        emulator.add_listener('emulator-stopped', () => {
            status.textContent = 'Stopped — save image before closing.';
            log('emulator-stopped — use Save Image to persist changes', 'inf');
        });

        // Save button: POST imageData.buffer to server — server writes it to disk.
        // This avoids the broken internal buffer path and works whether the emulator
        // is running or stopped.
        document.getElementById('btnSave').onclick = async () => {
            status.textContent = 'Saving image to server...';
            log('POSTing image (' + (imageData.byteLength / 1048576).toFixed(1) + ' MB) to /save...', 'inf');
            try {
                const resp = await fetch('/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: imageData,
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                status.textContent = 'Image saved to server.';
                log('Image saved.', 'ok');
            } catch (err) {
                status.textContent = 'Save failed: ' + err.message;
                log('Save error: ' + err.message, 'err');
            }
        };

    } catch (err) {
        status.textContent = 'Error: ' + err.message;
        log('Fatal: ' + err.message, 'err');
    }
})();

document.getElementById('btnStop').onclick = () => {
    if (!emulator) return;
    if (!confirm('Stop the emulator? (Save image first if you want to keep changes.)')) return;
    log('Stop requested — stopping emulator', 'inf');
    emulator.stop();
};

// Server shuts down via Ctrl+C in the terminal.
</script>
</body>
</html>`;

function cmdDesktop(imagePath) {
    const paths = resolvePaths(imagePath);
    if (!paths) return;

    const http = require('http');
    const { execSync } = require('child_process');

    const v86Dir = path.dirname(require.resolve('v86'));
    const libv86 = path.join(v86Dir, 'libv86.js');
    const wasmPath = path.join(v86Dir, 'v86.wasm');

    const PORT = argv['port'] || 18086;
    const HOST = argv['host'] || '127.0.0.1';

    const server = http.createServer((req, res) => {
        // Supports HTTP Range requests (RFC 7233) — required for v86 async disk images.
        // Without this, the browser downloads the entire image before the emulator can start.
        const serve = (filePath, contentType) => {
            try {
                const total = fs.statSync(filePath).size;
                const rangeHdr = req.headers['range'];

                if (rangeHdr) {
                    const match = rangeHdr.match(/bytes=(\d+)-(\d*)/);
                    const start = parseInt(match[1], 10);
                    const end = match[2] ? parseInt(match[2], 10) : total - 1;
                    res.writeHead(206, {
                        'Content-Type': contentType,
                        'Content-Range': `bytes ${start}-${end}/${total}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': end - start + 1,
                    });
                    fs.createReadStream(filePath, { start, end }).pipe(res);
                } else {
                    res.writeHead(200, {
                        'Content-Type': contentType,
                        'Content-Length': total,
                        'Accept-Ranges': 'bytes',
                    });
                    fs.createReadStream(filePath).pipe(res);
                }
            } catch (err) {
                res.writeHead(404);
                res.end('Not found');
            }
        };

        switch (req.url) {
            case '/':
            case '/index.html':
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(DESKTOP_HTML);
                break;

            case '/libv86.js':
                serve(libv86, 'application/javascript');
                break;

            case '/v86.wasm':
                serve(wasmPath, 'application/wasm');
                break;

            case '/bios/seabios.bin':
                serve(paths.biosPath, 'application/octet-stream');
                break;

            case '/bios/vgabios.bin':
                serve(paths.vgaBiosPath, 'application/octet-stream');
                break;

            case '/image':
                serve(paths.imagePath, 'application/octet-stream');
                break;

            case '/save':
                if (req.method !== 'POST') { res.writeHead(405); res.end(); break; }
                {
                    const chunks = [];
                    req.on('data', c => chunks.push(c));
                    req.on('end', () => {
                        const buf = Buffer.concat(chunks);
                        try {
                            fs.writeFileSync(paths.imagePath, buf);
                            console.error(`\nv86 desktop: image saved (${(buf.length / 1048576).toFixed(1)} MB) → ${paths.imagePath}`);
                            res.writeHead(200);
                            res.end('saved');
                        } catch (err) {
                            console.error(`\nv86 desktop: save failed: ${err.message}`);
                            res.writeHead(500);
                            res.end(err.message);
                        }
                    });
                }
                break;

            default:
                res.writeHead(404);
                res.end('Not found');
                break;
        }
    });

    server.listen(PORT, HOST, () => {
        // Always print a localhost URL when bound to loopback — VS Code Remote SSH
        // auto-detects "localhost:PORT" in terminal output and forwards the port,
        // then opens the browser on the local machine through the tunnel.
        const printUrl =
            HOST === '127.0.0.1' || HOST === 'localhost'
                ? `http://localhost:${PORT}`
                : `http://${HOST}:${PORT}`;

        console.error(`v86 desktop: serving at ${printUrl}`);
        console.error(`v86 desktop: image: ${paths.imagePath}`);

        if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
            console.error(
                `\nv86 desktop: NOTE: bound to ${HOST} — accessible from other machines.`
            );
        }

        console.error('\nv86 desktop: press Ctrl+C to stop\n');

        // Open browser — platform detection
        try {
            const platform = process.platform;
            if (platform === 'darwin') {
                execSync(`open "${printUrl}"`);
            } else if (platform === 'win32') {
                execSync(`start "" "${printUrl}"`);
            } else {
                execSync(`xdg-open "${printUrl}"`);
            }
        } catch {
            console.error(
                `v86 desktop: could not auto-open browser — navigate to ${printUrl}`
            );
        }
    });

    process.on('SIGINT', () => {
        console.error('\nv86 desktop: shutting down');
        server.close();
        process.exit(0);
    });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function handleV86Command() {
    if (argv.help) {
        return printUsageAndSetExitCode(getHelpFor('V86'), ExitCodes.SUCCESS);
    }

    const action = argv._[1];
    const imagePath = argv._[2];

    if (!action || !imagePath) {
        return printUsageAndSetExitCode(getHelpFor('V86'), ExitCodes.BAD_ARGS);
    }

    switch (action) {
        case 'console':
            return cmdConsole(imagePath);

        case 'desktop':
            return cmdDesktop(imagePath);

        default:
            return printUsageAndSetExitCode(getHelpFor('V86'), ExitCodes.BAD_COMMAND);
    }
}
