/* jslint node: true */
'use strict';

const stringFormat = require('./string_format.js');
const { Errors } = require('./enig_error.js');
const Events = require('./events');
const Config = require('./config.js').get;

//  deps
const pty = require('node-pty');
const decode = require('iconv-lite').decode;
const createServer = require('net').createServer;
const paths = require('path');
const _ = require('lodash');
const async = require('async');

//
//  Output backpressure. A door can produce far faster than its caller drains
//  -- a sixel game on a slow link, or a terminal slow to render -- and
//  term.write() never waits, so without this every byte is queued in memory
//  and the caller falls ever further behind. Past |highWaterBytes| of backlog
//  we stop reading the door: its own write() then blocks in the kernel and it
//  runs at the caller's pace. We start reading again under |lowWaterBytes|.
//  Input to the door is never held back.
//
const BackpressurePollMs = 50;

module.exports = class Door {
    constructor(client) {
        this.client = client;
        this.restored = false;
        this.backpressure = null; //  { high, low } once run(); null = off
        this.outputPausedAt = 0;
        this.outputStats = { pauses: 0, pausedMs: 0, maxBacklog: 0 };
    }

    prepare(ioType, cb) {
        this.io = ioType;

        //  we currently only have to do any real setup for 'socket'
        if ('socket' !== ioType) {
            return cb(null);
        }

        this.sockServer = createServer(conn => {
            conn.once('end', () => {
                return this.restoreIo(conn);
            });

            conn.once('error', err => {
                this.client.log.warn(
                    { error: err.message },
                    'Door socket server connection'
                );
                return this.restoreIo(conn);
            });

            this.sockServer.getConnections((err, count) => {
                //  We expect only one connection from our DOOR/emulator/etc.
                if (!err && count <= 1) {
                    this.doorSockConn = conn;
                    this.client.term.output.pipe(conn);
                    conn.on('data', this.doorDataHandler.bind(this));
                }
            });
        });

        this.sockServer.listen(0, () => {
            return cb(null);
        });
    }

    run(exeInfo, cb) {
        this.encoding = (exeInfo.encoding || 'cp437').toLowerCase();
        this.backpressure = this.backpressureSettings();

        if ('socket' === this.io) {
            if (!this.sockServer) {
                return cb(Errors.UnexpectedState('Socket server is not running'));
            }
        } else if ('stdio' !== this.io) {
            return cb(Errors.Invalid(`"${this.io}" is not a valid io type!`));
        }

        const cwd = exeInfo.cwd || paths.dirname(exeInfo.cmd);

        const formatObj = {
            dropFile: exeInfo.dropFile,
            dropFilePath: exeInfo.dropFilePath,
            dropFileDir: exeInfo.dropFileDir,
            userAreaDir: exeInfo.userAreaDir,
            node: exeInfo.node.toString(),
            srvPort: this.sockServer ? this.sockServer.address().port.toString() : '-1',
            userId: this.client.user.userId.toString(),
            userName: this.client.user.getSanitizedName(),
            termWidth: this.client.term.termWidth,
            termHeight: this.client.term.termHeight,
            cwd: cwd,
        };

        const args = exeInfo.args.map(arg => stringFormat(arg, formatObj));

        const spawnOptions = {
            cols: this.client.term.termWidth,
            rows: this.client.term.termHeight,
            cwd: cwd,
            env: exeInfo.env,
            encoding: null, //  we want to handle all encoding ourself
        };

        async.series(
            [
                callback => {
                    if (!_.isString(exeInfo.preCmd)) {
                        return callback(null);
                    }

                    const preCmdArgs = (exeInfo.preCmdArgs || []).map(arg =>
                        stringFormat(arg, formatObj)
                    );

                    this.client.log.info(
                        { cmd: exeInfo.preCmd, args: preCmdArgs },
                        `Executing external door pre-command (${exeInfo.name})`
                    );

                    try {
                        const prePty = pty.spawn(
                            exeInfo.preCmd,
                            preCmdArgs,
                            spawnOptions
                        );

                        prePty.onExit(exitEvent => {
                            const { exitCode, signal } = exitEvent;
                            this.client.log.info(
                                { exitCode, signal },
                                'Door pre-command exited'
                            );
                            return callback(null);
                        });
                    } catch (e) {
                        return callback(e);
                    }
                },
                callback => {
                    this.client.log.info(
                        { cmd: exeInfo.cmd, args, io: this.io },
                        `Executing external door (${exeInfo.name})`
                    );

                    try {
                        this.doorPty = pty.spawn(exeInfo.cmd, args, spawnOptions);
                    } catch (e) {
                        return cb(e);
                    }

                    //
                    //  PID is launched. Make sure it's killed off if the user disconnects.
                    //
                    Events.once(Events.getSystemEvents().ClientDisconnected, evt => {
                        if (
                            this.doorPty &&
                            this.client.session.uniqueId ===
                                _.get(evt, 'client.session.uniqueId')
                        ) {
                            this.client.log.info(
                                { pid: this.doorPty.pid },
                                'User has disconnected; Killing door process.'
                            );
                            this.doorPty.kill();
                        }
                    });

                    this.client.log.debug(
                        { processId: this.doorPty.pid },
                        'External door process spawned'
                    );

                    const exitHandler = () => {
                        this.stopOutputBackpressure();

                        if (this.sockServer) {
                            this.sockServer.close();
                        }

                        //  we may not get a close
                        if ('stdio' === this.io) {
                            this.restoreIo(this.doorPty);
                        }

                        if (this.doorPty) {
                            this.doorPty.removeAllListeners();
                            delete this.doorPty;
                        }

                        return callback(null);
                    };

                    this.doorPty.on('error', err => {
                        //  EIO is a benign close-time race: the door's PTY
                        //  slave closes before node-pty finishes reading the
                        //  last chunk on the master. The real exit status is
                        //  surfaced via onExit() below.
                        if ('EIO' === err.code) {
                            this.client.log.debug(
                                { error: err.message },
                                'Door PTY EIO on close (benign)'
                            );
                            return;
                        }
                        this.client.log.warn(
                            { error: err.message },
                            'Door exited with error'
                        );
                    });

                    if ('stdio' === this.io) {
                        this.client.log.debug('Using stdio for door I/O');

                        this.client.term.output.pipe(this.doorPty);

                        // dumb hack around node-pty; under nix, if we bail at the
                        // right time, listenerCount will be referenced, but does
                        // not exist!
                        this.doorPty.listenerCount = () => 1;

                        this.doorPty.onData(this.doorDataHandler.bind(this));
                    } else if ('socket' === this.io) {
                        this.client.log.debug(
                            {
                                srvPort: this.sockServer.address().port,
                                srvSocket: this.sockServerSocket,
                            },
                            'Using temporary socket server for door I/O'
                        );
                    }

                    this.doorPty.onExit(exitEvent => {
                        const { exitCode, signal } = exitEvent;
                        this.client.log.info({ exitCode, signal }, 'Door exited');
                        exitHandler();
                    });
                },
            ],
            () => {
                return cb(null);
            }
        );
    }

    doorDataHandler(data) {
        this.client.term.write(decode(data, this.encoding));
        this.checkOutputBackpressure();
    }

    backpressureSettings() {
        return Door.parseBackpressureSettings(
            _.get(Config(), 'doors.outputBackpressure'),
            this.client.log
        );
    }

    //  |settings| is doors.outputBackpressure; null means do not throttle.
    static parseBackpressureSettings(settings, log) {
        if (!settings || !settings.enabled) {
            return null;
        }

        const high = settings.highWaterBytes;
        const low = settings.lowWaterBytes;
        if (!(high > 0) || !(low >= 0) || low >= high) {
            log.warn(
                { highWaterBytes: high, lowWaterBytes: low },
                'Invalid doors.outputBackpressure; door output will not be throttled'
            );
            return null;
        }

        return { high, low };
    }

    //
    //  Bytes written for the caller that have not left this process yet: what
    //  the output stream is holding (for SSH, whatever the caller's window has
    //  not accepted) plus what the TCP socket underneath is holding. For telnet
    //  the two can count the same bytes; that only makes us pause a little
    //  sooner.
    //
    outputBacklog() {
        const output = this.client.term.output;
        const rawSocket = this.client.rawSocket;

        let backlog = (output && output.writableLength) || 0;
        if (rawSocket && rawSocket !== output) {
            backlog += rawSocket.writableLength || 0;
        }

        this.outputStats.maxBacklog = Math.max(this.outputStats.maxBacklog, backlog);
        return backlog;
    }

    doorOutputSource() {
        return 'socket' === this.io ? this.doorSockConn : this.doorPty;
    }

    checkOutputBackpressure() {
        if (!this.backpressure || this.outputPausedAt) {
            return;
        }

        const backlog = this.outputBacklog();
        const source = this.doorOutputSource();
        if (backlog < this.backpressure.high || !source) {
            return;
        }

        source.pause();
        this.outputPausedAt = Date.now();
        this.outputStats.pauses += 1;
        this.client.log.debug({ backlog }, 'Caller is behind; pausing door output');

        this.outputResumeTimer = setInterval(() => {
            if (this.outputBacklog() <= this.backpressure.low) {
                this.resumeDoorOutput();
            }
        }, BackpressurePollMs);
    }

    resumeDoorOutput() {
        if (!this.outputPausedAt) {
            return;
        }

        clearInterval(this.outputResumeTimer);
        delete this.outputResumeTimer;

        const pausedMs = Date.now() - this.outputPausedAt;
        this.outputStats.pausedMs += pausedMs;
        this.outputPausedAt = 0;

        const source = this.doorOutputSource();
        if (source) {
            source.resume();
        }

        this.client.log.debug({ pausedMs }, 'Caller caught up; resuming door output');
    }

    //  The door is gone: never leave a timer running or a source paused.
    stopOutputBackpressure() {
        this.resumeDoorOutput();

        if (this.backpressure && !this.outputStatsLogged) {
            this.outputStatsLogged = true;
            this.client.log.info(
                Object.assign({}, this.outputStats, this.backpressure),
                'Door output backpressure summary'
            );
        }
    }

    restoreIo(piped) {
        if (!this.restored) {
            this.stopOutputBackpressure();

            if (this.doorPty) {
                this.doorPty.kill();
            }

            const output = this.client.term.output;
            if (output) {
                output.unpipe(piped);
                output.resume();
            }
            this.restored = true;
        }
    }
};
