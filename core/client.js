/* jslint node: true */
'use strict';

/*
    Portions of this code for key handling heavily inspired from the following:
    https://github.com/chjj/blessed/blob/master/lib/keys.js

    chji's blessed is MIT licensed:

    ----/snip/----------------------
    The MIT License (MIT)

    Copyright (c) <year> <copyright holders>

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.
    ----/snip/----------------------
*/
//  ENiGMA½
const term = require('./client_term.js');
const ansi = require('./ansi_term.js');
const User = require('./user.js');
const Config = require('./config.js').get;
const MenuStack = require('./menu_stack.js');
const ACS = require('./acs.js');
const UserTime = require('./user_time.js');
const Events = require('./events.js');
const UserInterruptQueue = require('./user_interrupt_queue.js');
const UserProps = require('./user_property.js');
const { emulationOf } = require('./term');
const DeviceAttributes = require('./term/ansi/device_attributes.js');
const AnsiInput = require('./term/ansi/input_decoder.js');

//  deps
const stream = require('stream');
const _ = require('lodash');

exports.Client = Client;

//
//  DA / CTDA reply parsing lives with the ANSI emulation now; it is still
//  exported from here, where callers have always found it.
//
exports.getCtermVersion = DeviceAttributes.getCtermVersion;
exports.getDeviceAttrVersion = DeviceAttributes.getDeviceAttrVersion;
exports.getTermClientFromDeviceAttr = DeviceAttributes.getTermClientFromDeviceAttr;
exports.getCtermCapabilitiesFromCtda = DeviceAttributes.getCtermCapabilitiesFromCtda;
exports.NamedDeviceAttrClients = DeviceAttributes.NamedDeviceAttrClients; //  exported for tests
exports.CtdaFeatures = DeviceAttributes.CtdaFeatures;
exports.RE_CTDA_RESPONSE = AnsiInput.RE_CTDA_RESPONSE;

function Client(/*input, output*/) {
    stream.call(this);

    const self = this;

    this.user = new User();
    //  Sentinel value before a real theme is loaded.  Exposes get() so the
    //  currentTheme getter below can always call .get() unconditionally.
    this.currentThemeConfig = {
        get: () => ({ info: { name: 'N/A', description: 'None' } }),
    };
    this.lastActivityTime = Date.now();
    this.menuStack = new MenuStack(this);
    this.acs = new ACS({ client: this, user: this.user });
    this.freeTimeDepth = 0; //  > 0 => the 1m tick does not bill time; see beginFreeTime()
    this.interruptQueue = new UserInterruptQueue(this);
    this.clientEnded = false; //  end() teardown runs once; see Client.prototype.end

    Object.defineProperty(this, 'currentTheme', {
        get: () => {
            return this.currentThemeConfig.get();
        },
        set: theme => {
            this.currentThemeConfig = theme;
        },
    });

    Object.defineProperty(this, 'node', {
        get: function () {
            return self.session.id;
        },
    });

    Object.defineProperty(this, 'currentMenuModule', {
        get: function () {
            return self.menuStack.currentModule;
        },
    });

    this.setTemporaryDirectDataHandler = function (handler) {
        this.dataPassthrough = true; //  let implementations do with what they will here
        this.input.removeAllListeners('data');
        this.input.on('data', handler);
    };

    this.restoreDataHandler = function () {
        this.dataPassthrough = false;
        this.input.removeAllListeners('data');
        this.input.on('data', this.dataHandler);
    };

    this.themeChangedListener = function ({ themeId }) {
        if (_.get(self.currentTheme, 'info.themeId') === themeId) {
            self.currentThemeConfig = require('./theme.js')
                .getAvailableThemes()
                .get(themeId);
        }
    };

    Events.on(Events.getSystemEvents().ThemeChanged, this.themeChangedListener);

    //
    //  Input from the terminal is decoded by its emulation (for ANSI see
    //  core/term/ansi/input_decoder.js), which reports key presses and query
    //  replies in stream order. What each one means to the session is
    //  decided here.
    //
    //  The three helpers below are kept for callers that reach for them on
    //  the client; they are ANSI's.
    //
    this.getTermClient = function (deviceAttr) {
        const identified = DeviceAttributes.getTermClientFromDeviceAttr(deviceAttr);
        return identified ? identified.termClient : undefined;
    };

    this.isMouseInput = AnsiInput.isMouseInput;

    this.getKeyComponentsFromCode = AnsiInput.getKeyComponentsFromCode;

    const inputDecoderHost = {
        isNixTerm: () => self.term.isNixTerm(),
    };

    const decodedInputHandlers = {
        'cursor position report': cprArgs => {
            if (self.cprOffset) {
                cprArgs[0] = cprArgs[0] + self.cprOffset;
                cprArgs[1] = cprArgs[1] + self.cprOffset;
            }
            self.emit('cursor position report', cprArgs);
        },

        'device attributes': identified => {
            self.term.termClientVersion = identified.version;
            self.term.termClient = identified.termClient;
            if ('cterm' === identified.termClient) {
                self.term.ctermVersion = identified.version;
            }
        },

        'cterm capability response': response => {
            self.emit('cterm capability response', response);
        },

        'cterm device attributes': caps => {
            Object.assign(self.term.termCapabilities, caps);
            if (self.log) {
                self.log.debug(
                    { termClient: self.term.termClient, ctda: caps.ctda },
                    'CTerm device attributes (CTDA) reported'
                );
            }
            self.emit('cterm device attributes', caps);
        },

        'key press': (ch, key) => {
            if (Config().logging.traceUserKeyboardInput) {
                self.log.trace({ key: key, ch: escape(ch) }, 'User keyboard input'); // jshint ignore:line
            }

            self.lastActivityTime = Date.now();

            if (!self.ignoreInput) {
                self.emit('key press', ch, key);
            }
        },
    };

    const onDecodedInput = (eventName, ...args) => {
        const handler = decodedInputHandlers[eventName];
        if (handler) {
            handler(...args);
        }
    };

    this.on('data', function clientData(data) {
        emulationOf(self.term).inputDecoder.decode(
            data,
            inputDecoderHost,
            onDecodedInput
        );
    });
}

require('util').inherits(Client, stream);

Client.prototype.setInputOutput = function (input, output) {
    this.input = input;
    this.output = output;

    this.term = new term.ClientTerminal(this.output);
};

Client.prototype.setTermType = function (termType) {
    this.term.env.TERM = termType;
    this.term.termType = termType;

    this.log.debug({ termType: termType }, 'Set terminal type');
};

Client.prototype.startIdleMonitor = function () {
    //
    //  Never for a session that has ended: end() has already stopped both
    //  monitors, and nothing would ever stop them again. Several modules
    //  restart the idle monitor from leave(), which can run after the end.
    //
    if (this.clientEnded) {
        return;
    }

    //  clear existing, if any
    if (this.idleCheck) {
        this.stopIdleMonitor();
    }

    this.lastActivityTime = Date.now();

    //
    //  Every 1m, check for idle.
    //  We also update minutes spent online the system here,
    //  if we have a authenticated user.
    //
    //
    //  The time budget rides its own interval rather than this one. Several
    //  modules stop the idle monitor for the duration of something that must
    //  not be interrupted -- MRC chat does it for the whole chat session --
    //  and billing a user's daily allowance must not stop with it. Starting
    //  it here rather than at 'ready' means every one of those modules
    //  restores it for free on the way out.
    //
    this.startTimeMonitor();

    this.idleCheck = setInterval(() => {
        const nowMs = Date.now();

        let idleLogoutSeconds;
        if (this.user.isAuthenticated()) {
            idleLogoutSeconds = Config().users.idleLogoutSeconds;

            //
            //  We don't really want to be firing off an event every 1m for
            //  every user, but want at least some updates for various things
            //  such as achievements. Send off every 5m.
            //
            const minOnline = this.user.incrementProperty(
                UserProps.MinutesOnlineTotalCount,
                1
            );
            if (0 === minOnline % 5) {
                Events.emit(Events.getSystemEvents().UserStatIncrement, {
                    user: this.user,
                    statName: UserProps.MinutesOnlineTotalCount,
                    statIncrementBy: 1,
                    statValue: minOnline,
                });
            }
        } else {
            idleLogoutSeconds = Config().users.preAuthIdleLogoutSeconds;
        }

        //  use override value if set
        idleLogoutSeconds = this.idleLogoutSecondsOverride || idleLogoutSeconds;

        if (
            idleLogoutSeconds > 0 &&
            nowMs - this.lastActivityTime >= idleLogoutSeconds * 1000
        ) {
            this.emit('idle timeout', idleLogoutSeconds);
        }
    }, 1000 * 60);
};

//
//  Every 1m, bill a minute of today's budget and act on what is left. This
//  is the only moment the balance can change, so warning and kicking from
//  here is exact rather than merely frequent.
//
//  Deliberately not stopped by stopIdleMonitor(): see startIdleMonitor().
//  It runs for the life of the session and is cleared in end().
//
Client.prototype.startTimeMonitor = function () {
    if (this.timeCheck) {
        return; //  already running
    }

    this.timeCheck = setInterval(() => {
        UserTime.accrueMinute(this);
        UserTime.checkTimeRemaining(this);
    }, 1000 * 60);
};

Client.prototype.stopTimeMonitor = function () {
    if (this.timeCheck) {
        clearInterval(this.timeCheck);
        delete this.timeCheck;
    }
};

//
//  Free time: while the depth is > 0 the 1m tick does not bill the user.
//  A depth rather than a boolean, so a free door that also performs a free
//  download does not un-free itself on the inner end().
//
//  Nothing sets this yet. It exists so that the first exemption is a two
//  line change rather than a restructuring of the accrual path.
//
Client.prototype.beginFreeTime = function () {
    this.freeTimeDepth = (this.freeTimeDepth || 0) + 1;
    return this.freeTimeDepth;
};

Client.prototype.endFreeTime = function () {
    this.freeTimeDepth = Math.max(0, (this.freeTimeDepth || 0) - 1);
    return this.freeTimeDepth;
};

Client.prototype.stopIdleMonitor = function () {
    if (this.idleCheck) {
        clearInterval(this.idleCheck);
        delete this.idleCheck;
    }
};

Client.prototype.explicitActivityTimeUpdate = function () {
    this.lastActivityTime = Date.now();
};

Client.prototype.overrideIdleLogoutSeconds = function (seconds) {
    this.idleLogoutSecondsOverride = seconds;
};

Client.prototype.restoreIdleLogoutSeconds = function () {
    delete this.idleLogoutSecondsOverride;
};

//
//  end() is reached more than once on a server initiated disconnect, and
//  always has been: end() calls disconnect(), the socket emits 'close',
//  login_server_module's handler calls clientConnections.removeClient(),
//  and removeClient() opens with client.end(). Anything that kicks a user --
//  the idle timeout, "all nodes are busy", @systemMethod:logoff -- goes
//  round that loop.
//
//  So the teardown below has been running twice per kicked session:
//  notably |leave()| on whichever module the user was in, which is a module
//  author's one chance to clean up and is written expecting to be called
//  once. It also wrote MinutesOnlineTotalCount twice.
//
//  The teardown is therefore done once. The transport disconnect is *not*
//  guarded and still runs on every call: closing an already closed socket is
//  a no-op, whereas skipping it would risk leaving one open if a first call
//  threw on its way here -- and removeClient() calling end() is precisely
//  how the system guarantees the connection is gone.
//
Client.prototype.end = function () {
    if (!this.clientEnded) {
        this.clientEnded = true;

        if (this.term) {
            this.term.disconnect();
        }

        Events.removeListener(
            Events.getSystemEvents().ThemeChanged,
            this.themeChangedListener
        );

        //  :TODO: getCurrentModule does not exist (the getter is
        //  menuStack.currentModule), so this never finds a module and no
        //  module's leave() runs here. Fixing it starts every module's leave()
        //  running on disconnect, which wants its own review; it must then
        //  mark the top stack entry |left| so MenuStack._refuseEnded() does
        //  not leave() it a second time.
        const currentModule = this.menuStack.getCurrentModule;

        if (currentModule) {
            currentModule.leave();
        }

        //  persist time online for authenticated users
        if (this.user.isAuthenticated()) {
            this.user.persistProperty(
                UserProps.MinutesOnlineTotalCount,
                this.user.getProperty(UserProps.MinutesOnlineTotalCount)
            );
        }

        this.stopIdleMonitor();
        this.stopTimeMonitor();
    }

    try {
        //
        //  We can end up calling 'end' before TTY/etc. is established, e.g. with SSH
        //
        if (_.isFunction(this.disconnect)) {
            return this.disconnect();
        } else {
            //  legacy fallback
            return this.output.end.apply(this.output, arguments);
        }
    } catch (e) {
        //  ie TypeError
    }
};

Client.prototype.destroy = function () {
    return this.output.destroy.apply(this.output, arguments);
};

Client.prototype.destroySoon = function () {
    return this.output.destroySoon.apply(this.output, arguments);
};

Client.prototype.waitForKeyPress = function (cb) {
    this.once('key press', function kp(ch, key) {
        cb(ch, key);
    });
};

Client.prototype.isLocal = function () {
    //  Came through a reverse proxy (see websocket.js): the address is the
    //  proxy's, or one the proxy passed on, and is no proof of a local caller.
    if (true === this.viaProxy) {
        return false;
    }

    //  :TODO: Handle ipv6 better
    return ['127.0.0.1', '::ffff:127.0.0.1'].includes(this.remoteAddress);
};

Client.prototype.friendlyRemoteAddress = function () {
    if (!this.remoteAddress) {
        return 'N/A';
    }

    //  convert any :ffff: IPv4's to 32bit version
    return this.remoteAddress.replace(/^::ffff:/, '').replace(/^::1$/, 'localhost');
};

///////////////////////////////////////////////////////////////////////////////
//  Default error handlers
///////////////////////////////////////////////////////////////////////////////

//  :TODO: getDefaultHandler(name) -- handlers in default_handlers.js or something
Client.prototype.defaultHandlerMissingMod = function () {
    var self = this;

    function handler(err) {
        self.log.error(err);

        self.term.write(ansi.resetScreen());
        self.term.write('An unrecoverable error has been encountered!\n');
        self.term.write('This has been logged for your SysOp to review.\n');
        self.term.write('\nGoodbye!\n');

        //self.term.write(err);

        //if(miscUtil.isDevelopment() && err.stack) {
        //  self.term.write('\n' + err.stack + '\n');
        //}

        self.end();
    }

    return handler;
};

Client.prototype.terminalSupports = function (query) {
    return emulationOf(this.term).supports(query, this.term);
};
