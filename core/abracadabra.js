/* jslint node: true */
'use strict';

const { MenuModule } = require('./menu_module.js');
const DropFile = require('./dropfile.js');
const Door = require('./door.js');
const theme = require('./theme.js');
const ansi = require('./ansi_term.js');
const { Errors } = require('./enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util.js');
const Log = require('./logger').log;

//  deps
const async = require('async');
const assert = require('assert');
const _ = require('lodash');
const paths = require('path');
const fs = require('graceful-fs');

const activeDoorNodeInstances = {};

exports.moduleInfo = {
    name: 'Abracadabra',
    desc: 'External BBS Door Module',
    author: 'NuSkooler',
};

/*
    Example configuration for LORD under DOSEMU:

    {
        config: {
            name: PimpWars
            dropFileType: DORINFO
            cmd: qemu-system-i386
            args: [
                "-localtime",
                "freedos.img",
                "-chardev",
                "socket,port={srvPort},nowait,host=localhost,id=s0",
                "-device",
                "isa-serial,chardev=s0"
            ]
            io: socket
        }
    }

    listen: socket | stdio

    {
        "config" : {
            "name"          : "LORD",
            "dropFileType"  : "DOOR",
            "cmd"           : "/usr/bin/dosemu",
            "args"          : [ "-quiet", "-f", "/etc/dosemu/dosemu.conf", "X:\\PW\\START.BAT {dropfile} {node}" ] ],
            "nodeMax"       : 32,
            "tooManyArt"    : "toomany-lord.ans"
        }
    }

    :TODO: See Mystic & others for other arg options that we may need to support
*/

exports.getModule = class AbracadabraModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = options.menuConfig.config;
        //  :TODO: MenuModule.validateConfig(cb) -- validate config section gracefully instead of asserts! -- { key : type, key2 : type2, ... }
        //  ..  and/or EnigAssert
        assert(_.isString(this.config.name, "Config 'name' is required"));
        assert(_.isString(this.config.cmd, "Config 'cmd' is required"));

        this.config.nodeMax = this.config.nodeMax || 0;
        this.config.args = this.config.args || [];
    }

    incrementActiveDoorNodeInstances() {
        if (activeDoorNodeInstances[this.config.name]) {
            activeDoorNodeInstances[this.config.name] += 1;
        } else {
            activeDoorNodeInstances[this.config.name] = 1;
        }
        this.activeDoorInstancesIncremented = true;
    }

    decrementActiveDoorNodeInstances() {
        if (true === this.activeDoorInstancesIncremented) {
            activeDoorNodeInstances[this.config.name] -= 1;
            this.activeDoorInstancesIncremented = false;
        }
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function validateNodeCount(callback) {
                    if (
                        self.config.nodeMax > 0 &&
                        _.isNumber(activeDoorNodeInstances[self.config.name]) &&
                        activeDoorNodeInstances[self.config.name] + 1 >
                            self.config.nodeMax
                    ) {
                        self.client.log.info(
                            {
                                name: self.config.name,
                                activeCount: activeDoorNodeInstances[self.config.name],
                            },
                            `Too many active instances of door "${self.config.name}"`
                        );

                        if (_.isString(self.config.tooManyArt)) {
                            theme.displayThemeArt(
                                { client: self.client, name: self.config.tooManyArt },
                                function displayed() {
                                    self.pausePrompt(() => {
                                        return callback(
                                            Errors.AccessDenied(
                                                'Too many active instances'
                                            )
                                        );
                                    });
                                }
                            );
                        } else {
                            self.client.term.write(
                                '\nToo many active instances. Try again later.\n'
                            );

                            //  :TODO: Use MenuModule.pausePrompt()
                            self.pausePrompt(() => {
                                return callback(
                                    Errors.AccessDenied('Too many active instances')
                                );
                            });
                        }
                    } else {
                        self.incrementActiveDoorNodeInstances();
                        return callback(null);
                    }
                },
                function prepareDoor(callback) {
                    self.doorInstance = new Door(self.client);
                    return self.doorInstance.prepare(self.config.io || 'stdio', callback);
                },
                function generateDropfile(callback) {
                    if (
                        !self.config.dropFileType ||
                        self.config.dropFileType.toLowerCase() === 'none'
                    ) {
                        return callback(null);
                    }

                    self.dropFile = new DropFile(self.client, {
                        fileType: self.config.dropFileType,
                    });

                    return self.dropFile.createFile(callback);
                },
            ],
            function complete(err) {
                if (err) {
                    self.client.log.warn(
                        { error: err.toString() },
                        'Could not start door'
                    );
                    self.lastError = err;
                    self.prevMenu();
                } else {
                    self.finishedLoading();
                }
            }
        );
    }

    runDoor() {
        this.client.term.write(ansi.resetScreen());

        const exeInfo = {
            name: this.config.name,
            cmd: this.config.cmd,
            cwd: this.config.cwd || paths.dirname(this.config.cmd),
            args: this.config.args,
            io: this.config.io || 'stdio',
            encoding: this.config.encoding || 'cp437',
            node: this.client.node,
            env: this.config.env,
        };

        if (this.dropFile) {
            exeInfo.dropFile = this.dropFile.fileName;
            exeInfo.dropFilePath = this.dropFile.fullPath;
        }

        const doorTracking = trackDoorRunBegin(this.client, this.config.name);

        this.doorInstance.run(exeInfo, () => {
            trackDoorRunEnd(doorTracking);
            this.decrementActiveDoorNodeInstances();

            //  Clean up dropfile, if any
            if (exeInfo.dropFilePath) {
                fs.unlink(exeInfo.dropFilePath, err => {
                    if (err) {
                        Log.warn(
                            { error: err, path: exeInfo.dropFilePath },
                            'Failed to remove drop file.'
                        );
                    }
                });
            }

            //  client may have disconnected while process was active -
            //  we're done here if so.
            if (!this.client.term.output) {
                return;
            }

            //
            //  Try to clean up various settings such as scroll regions that may
            //  have been set within the door
            //
            this.client.term.rawWrite(
                ansi.normal() +
                    ansi.goto(this.client.term.termHeight, this.client.term.termWidth) +
                    ansi.setScrollRegion() +
                    ansi.goto(this.client.term.termHeight, 0) +
                    '\r\n\r\n'
            );

            this.autoNextMenu();
        });
    }

    leave() {
        super.leave();
        this.decrementActiveDoorNodeInstances();
    }

    finishedLoading() {
        this.runDoor();
    }
};
