/* jslint node: true */
'use strict';

const { MenuModule } = require('./menu_module.js');
const DropFile = require('./dropfile.js');
const Door = require('./door.js');
const theme = require('./theme.js');
const ansi = require('./ansi_term.js');
const { Errors } = require('./enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util.js');
const UserTime = require('./user_time.js');
const Log = require('./logger').log;
const Config = require('./config.js').get;

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
            "tooManyArt"    : "toomany-lord.ans",
            "minTimeLeftMinutes" : 15,
            "notEnoughTimeArt"   : "notime-lord.ans"
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

    get doorIo() {
        return this.config.io || 'stdio';
    }

    //
    //  What the *door* is handed, which only follows |io| when the process we
    //  spawn IS the door. Put an emulator in between -- QEMU bridging
    //  {srvPort} to a guest COM port, say -- and the door sees a serial line
    //  rather than a socket; those setups say so with |commType|.
    //
    getDropFileCommType() {
        const defaultCommType = this.defaultDropFileCommType();
        const commType = _.isString(this.config.commType)
            ? this.config.commType.toLowerCase()
            : '';

        if (!commType) {
            return defaultCommType;
        }

        //
        //  A BBSDEV.DRP type is passed through even when it is wrong: DropFile
        //  owns that judgement, and it refuses the file rather than coercing
        //  the door onto a channel it was not given.
        //
        if (
            !this.isBbsDevDropFile() &&
            !DropFile.validCommTypes(this.config.dropFileType).includes(commType)
        ) {
            this.client.log.warn(
                { name: this.config.name, commType: this.config.commType },
                `Invalid door "commType"; using "${defaultCommType}"`
            );
            return defaultCommType;
        }

        return commType;
    }

    //
    //  BBSDEV.DRP separates a door on standard streams from one on the local
    //  console, so an |io: stdio| door says so by name. The legacy formats
    //  have no such token and report 'local' for both.
    //
    defaultDropFileCommType() {
        if ('socket' === this.doorIo) {
            return 'socket';
        }
        return this.isBbsDevDropFile() ? 'stdio' : 'local';
    }

    isBbsDevDropFile() {
        return 'BBSDEV' === (this.config.dropFileType || '').toUpperCase();
    }

    //
    //  BBSDEV.DRP is discovered through the environment, not an argument: the
    //  door reads BBSDEV_DRP itself, so the path is neither quoted nor shell
    //  escaped. A sysop's |env| still replaces our own environment, as it
    //  always has; the variable is added to whichever one the door gets.
    //
    doorEnvironment(env) {
        if (!this.dropFile || 'BBSDEV' !== this.dropFile.fileType) {
            return env;
        }

        return Object.assign({}, env || process.env, {
            BBSDEV_DRP: this.dropFile.fullPath,
        });
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
                function validateTimeRemaining(callback) {
                    //
                    //  Refuse to *start* a door there is not time for rather
                    //  than killing one mid-run: the drop file states the
                    //  budget and the door is expected to honour it. No
                    //  package enforces inside a door, and neither do we.
                    //
                    //  Opt-in per door: with no |minTimeLeftMinutes| there is
                    //  no check at all, and an unlimited user always passes.
                    //
                    const minTimeLeft = self.config.minTimeLeftMinutes;
                    if (UserTime.hasTimeFor(self.client, minTimeLeft)) {
                        return callback(null);
                    }

                    const timeLeft = UserTime.getTimeLeftMinutes(self.client);
                    self.client.log.info(
                        { name: self.config.name, timeLeft, minTimeLeft },
                        `Not enough time remaining for door "${self.config.name}"`
                    );

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
                function prepareDoor(callback) {
                    self.doorInstance = new Door(self.client);
                    return self.doorInstance.prepare(self.doorIo, callback);
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
                        commType: self.getDropFileCommType(),
                        commParams: self.config.commParams,
                        //  the same value runDoor() hands Door as
                        //  |exeInfo.encoding|, so line 12 of a BBSDEV.DRP
                        //  names the encoding the door's bytes are read with
                        encoding: self.config.encoding,
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
            preCmd: this.config.preCmd,
            preCmdArgs: this.config.preCmdArgs,
            cwd: this.config.cwd || paths.dirname(this.config.cmd),
            args: this.config.args,
            io: this.doorIo,
            encoding: this.config.encoding || 'cp437',
            node: this.client.node,
            env: this.doorEnvironment(this.config.env),
        };

        exeInfo.dropFileDir = DropFile.dropFileDirectory(
            Config().paths.dropFiles,
            this.client
        );
        exeInfo.userAreaDir = paths.join(
            exeInfo.dropFileDir,
            this.client.user.getSanitizedName(),
            this.config.name.toLowerCase()
        );

        if (this.dropFile) {
            exeInfo.dropFile = this.dropFile.fileName;
            exeInfo.dropFilePath = this.dropFile.fullPath;
        }

        this._makeDropDirs([exeInfo.dropFileDir, exeInfo.userAreaDir], err => {
            if (err) {
                Log.warn(
                    `Failed creating directory ${exeInfo.dropFilePath}: ${err.message}`
                );
            }

            const doorTracking = trackDoorRunBegin(this.client, this.config.name);

            this.doorInstance.run(exeInfo, err => {
                if (err) {
                    Log.error(`Error running "${this.config.name}": ${err.message}`);
                }

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
                        ansi.goto(
                            this.client.term.termHeight,
                            this.client.term.termWidth
                        ) +
                        ansi.setScrollRegion() +
                        ansi.goto(this.client.term.termHeight, 0) +
                        '\r\n\r\n'
                );

                //  Pass an explicit no-op cb. autoNextMenu's chain forwards
                //  this through handleNext → callModuleMenuMethod, and an
                //  undefined cb here used to crash the BBS via unguarded
                //  cb(null) calls in system_menu_method.js (e.g. logoff).
                this.autoNextMenu(() => {});
            });
        });
    }

    _makeDropDirs(dirs, cb) {
        async.forEach(
            dirs,
            (dir, nextDir) => {
                fs.mkdir(dir, { recursive: true }, nextDir);
            },
            cb
        );
    }

    leave() {
        super.leave();
        this.decrementActiveDoorNodeInstances();
    }

    finishedLoading() {
        this.runDoor();
    }
};
