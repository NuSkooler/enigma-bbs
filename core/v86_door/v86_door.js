/* jslint node: true */
'use strict';

/**
 * v86_door.js — ENiGMA½ native x86/DOS door emulation module
 *
 * Boots a FreeDOS disk image in a v86 x86 emulator (worker thread) and bridges
 * the user's connection to the emulated COM1 port. No external emulator required.
 *
 * The emulator runs in a worker_threads Worker to avoid blocking ENiGMA's event loop.
 * A 1.44MB FAT12 floppy image containing the drop file is built in memory and
 * mounted as A: in FreeDOS. The op's AUTOEXEC.BAT copies it to the door directory.
 *
 * Config (menu.hjson):
 *   module: v86_door
 *   config: {
 *     name:         string   - door name (required, used for node count tracking)
 *     image:        string   - path to FreeDOS door disk image (required)
 *     dropFileType: string   - DORINFO | DOOR | DOOR32 (optional, default: none)
 *     nodeMax:      number   - max concurrent sessions, 0 = unlimited (default: 0)
 *     tooManyArt:   string   - art file to show when nodeMax exceeded (optional)
 *     memoryMb:     number   - guest RAM in MB (default: 64)
 *     biosPath:     string   - path to SeaBIOS image (default: {enigma_root}/bios/seabios.bin)
 *     vgaBiosPath:  string   - path to VGA BIOS image (default: {enigma_root}/bios/vgabios.bin)
 *   }
 *
 * Drop file filename on A: drive:
 *   DORINFO → DORINFOx.DEF (x = node-based suffix, per DORINFO spec)
 *   DOOR    → DOOR.SYS
 *   DOOR32  → door32.sys
 *
 * BIOS files are not bundled with the v86 npm package. install.sh downloads them automatically
 * to misc/v86_bios/. To download manually:
 *   curl -fL https://github.com/copy/v86/raw/master/bios/seabios.bin -o misc/v86_bios/seabios.bin
 *   curl -fL https://github.com/copy/v86/raw/master/bios/vgabios.bin -o misc/v86_bios/vgabios.bin
 */

const { MenuModule }      = require('../menu_module.js');
const { Errors }          = require('../enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('../door_util.js');
const DropFile            = require('../dropfile.js');
const theme               = require('../theme.js');
const { createFloppyWithFiles } = require('./fat_image.js');

//  deps
const async  = require('async');
const _      = require('lodash');
const paths  = require('path');
const { existsSync } = require('fs');
const { Worker }     = require('worker_threads');

const WORKER_PATH   = paths.join(__dirname, 'v86_worker.js');
const ENIGMA_ROOT   = paths.join(__dirname, '..', '..');
const DEFAULT_BIOS_PATH     = paths.join(ENIGMA_ROOT, 'misc', 'v86_bios', 'seabios.bin');
const DEFAULT_VGA_BIOS_PATH = paths.join(ENIGMA_ROOT, 'misc', 'v86_bios', 'vgabios.bin');

//  Track active instances per door name (mirrors abracadabra pattern)
const activeDoorInstances = {};

exports.moduleInfo = {
    name:   'V86Door',
    desc:   'Native x86/DOS Door Emulation via v86',
    author: 'NuSkooler',
};

exports.getModule = class V86DoorModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = options.menuConfig.config || {};
        this.config.nodeMax  = this.config.nodeMax  || 0;
        this.config.memoryMb = this.config.memoryMb || 64;

        this.config.biosPath    = this.config.biosPath    || DEFAULT_BIOS_PATH;
        this.config.vgaBiosPath = this.config.vgaBiosPath || DEFAULT_VGA_BIOS_PATH;
    }

    initSequence() {
        const self = this;
        let clientTerminated = false;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        { name: 'string', image: 'string' },
                        callback
                    );
                },

                function checkBios(callback) {
                    for (const [label, p] of [
                        ['biosPath',    self.config.biosPath],
                        ['vgaBiosPath', self.config.vgaBiosPath],
                    ]) {
                        if (!existsSync(p)) {
                            return callback(
                                Errors.MissingConfig(
                                    `v86_door: ${label} not found: ${p}\n` +
                                    'Download BIOS files from https://github.com/copy/v86/tree/master/bios'
                                )
                            );
                        }
                    }
                    return callback(null);
                },

                function checkImage(callback) {
                    if (!existsSync(self.config.image)) {
                        return callback(
                            Errors.MissingConfig(`v86_door: disk image not found: ${self.config.image}`)
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
                                        callback(Errors.AccessDenied('Too many active instances'))
                                    );
                                }
                            );
                        } else {
                            self.client.term.write('\nToo many active instances. Try again later.\n');
                            self.pausePrompt(() =>
                                callback(Errors.AccessDenied('Too many active instances'))
                            );
                        }
                    } else {
                        self._incrementInstances();
                        return callback(null);
                    }
                },

                function buildFloppy(callback) {
                    const dropFileType = (self.config.dropFileType || '').toUpperCase();
                    if (!dropFileType || dropFileType === 'NONE') {
                        self.floppyBuffer = null;
                        return callback(null);
                    }

                    const dropFile = new DropFile(self.client, { fileType: dropFileType });
                    if (!dropFile.isSupported()) {
                        return callback(
                            Errors.MissingConfig(`v86_door: unsupported dropFileType "${dropFileType}" (use DORINFO, DOOR, or DOOR32)`)
                        );
                    }

                    const contents = dropFile.getContents();
                    const fileName = dropFile.fileName;

                    createFloppyWithFiles([{ name: fileName, content: contents }])
                        .then(img => {
                            self.floppyBuffer = img;
                            return callback(null);
                        })
                        .catch(err => callback(err));
                },

                function runDoor(callback) {
                    const doorTracking = trackDoorRunBegin(self.client, self.config.name);

                    const workerData = {
                        imagePath:   self.config.image,
                        floppyBuffer: self.floppyBuffer || Buffer.alloc(0),
                        memoryMb:    self.config.memoryMb,
                        biosPath:    self.config.biosPath,
                        vgaBiosPath: self.config.vgaBiosPath,
                    };

                    let worker;
                    try {
                        worker = new Worker(WORKER_PATH, { workerData });
                    } catch (err) {
                        trackDoorRunEnd(doorTracking);
                        return callback(err);
                    }

                    //  Client → COM1
                    const onClientData = data => {
                        worker.postMessage({ type: 'input', data });
                    };
                    self.client.term.output.on('data', onClientData);

                    //  Client disconnected
                    self.client.once('end', () => {
                        clientTerminated = true;
                        self.client.log.info(
                            { name: self.config.name },
                            'Client disconnected — terminating v86 worker'
                        );
                        worker.terminate();
                        self.client.term.output.removeListener('data', onClientData);
                    });

                    worker.on('message', msg => {
                        switch (msg.type) {
                            case 'ready':
                                self.client.log.info(
                                    { name: self.config.name },
                                    'v86 emulator ready'
                                );
                                break;

                            case 'output':
                                self.client.term.rawWrite(Buffer.from(msg.data));
                                break;

                            case 'stopped': {
                                const secs = (msg.elapsed / 1000).toFixed(1);
                                self.client.log.info(
                                    { name: self.config.name, elapsed: secs },
                                    'v86 emulator stopped'
                                );
                                self.client.term.output.removeListener('data', onClientData);
                                trackDoorRunEnd(doorTracking);
                                self._decrementInstances();
                                return callback(null);
                            }

                            case 'error':
                                self.client.log.warn(
                                    { name: self.config.name, error: msg.message },
                                    'v86 worker error'
                                );
                                self.client.term.output.removeListener('data', onClientData);
                                trackDoorRunEnd(doorTracking);
                                self._decrementInstances();
                                return callback(new Error(msg.message));

                            default:
                                break;
                        }
                    });

                    worker.on('error', err => {
                        self.client.log.warn(
                            { name: self.config.name, error: err.message },
                            'v86 worker thread error'
                        );
                        self.client.term.output.removeListener('data', onClientData);
                        trackDoorRunEnd(doorTracking);
                        self._decrementInstances();
                        return callback(err);
                    });

                    worker.on('exit', code => {
                        if (code !== 0) {
                            self.client.log.warn(
                                { name: self.config.name, code },
                                'v86 worker exited with non-zero code'
                            );
                        }
                    });
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn({ error: err.message }, 'v86_door error');
                }

                if (!clientTerminated) {
                    self.prevMenu();
                }
            }
        );
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
