/* jslint node: true */
'use strict';

//  ENiGMA½
const baseClient                    = require('../../client.js');
const Log                           = require('../../logger.js').log;
const LoginServerModule             = require('../../login_server_module.js');
const Config                        = require('../../config.js').get;
const EnigAssert                    = require('../../enigma_assert.js');
const { stringFromNullTermBuffer }  = require('../../string_util.js');

//  deps
const net           = require('net');
const buffers       = require('buffers');
const { Parser }    = require('binary-parser');
const util          = require('util');

//var debug = require('debug')('telnet');

const ModuleInfo = exports.moduleInfo = {
    name        : 'Telnet',
    desc        : 'Telnet Server',
    author      : 'NuSkooler',
    isSecure    : false,
    packageName : 'codes.l33t.enigma.telnet.server',
};

exports.TelnetClient    = TelnetClient;

//
//  Telnet Protocol Resources
//  * http://pcmicro.com/netfoss/telnet.html
//  * http://mud-dev.wikidot.com/telnet:negotiation
//

/*
    TODO:
    * Document COMMANDS -- add any missing
    * Document OPTIONS -- add any missing
    * Internally handle OPTIONS:
        * Some should be emitted generically
        * Some should be handled internally -- denied, handled, etc.
        *

    * Allow term (ttype) to be set by environ sub negotiation

    * Process terms in loop.... research needed

    * Handle will/won't
    * Handle do's, ..
    * Some won't should close connection

    * Options/Commands we don't understand shouldn't crash the server!!


*/

const COMMANDS = {
    SE      : 240,  //  End of Sub-Negotation Parameters
    NOP     : 241,  //  No Operation
    DM      : 242,  //  Data Mark
    BRK     : 243,  //  Break
    IP      : 244,  //  Interrupt Process
    AO      : 245,  //  Abort Output
    AYT     : 246,  //  Are You There?
    EC      : 247,  //  Erase Character
    EL      : 248,  //  Erase Line
    GA      : 249,  //  Go Ahead
    SB      : 250,  //  Start Sub-Negotiation Parameters
    WILL    : 251,  //
    WONT    : 252,
    DO      : 253,
    DONT    : 254,
    IAC     : 255,  //  (Data Byte)
};

//
//  Resources:
//      * http://www.faqs.org/rfcs/rfc1572.html
//
const SB_COMMANDS = {
    IS      : 0,
    SEND    : 1,
    INFO    : 2,
};

//
//  Telnet Options
//
//  Resources
//      * http://mars.netanya.ac.il/~unesco/cdrom/booklet/HTML/NETWORKING/node300.html
//      * http://www.networksorcery.com/enp/protocol/telnet.htm
//
const OPTIONS = {
    TRANSMIT_BINARY         : 0,    // http://tools.ietf.org/html/rfc856
    ECHO                    : 1,    //  http://tools.ietf.org/html/rfc857
    //  RECONNECTION : 2
    SUPPRESS_GO_AHEAD       : 3,    // aka 'SGA': RFC 858 @ http://tools.ietf.org/html/rfc858
    //APPROX_MESSAGE_SIZE   : 4
    STATUS                  : 5,    // http://tools.ietf.org/html/rfc859
    TIMING_MARK             : 6, // http://tools.ietf.org/html/rfc860
    //RC_TRANS_AND_ECHO     : 7,    //  aka 'RCTE' @ http://www.rfc-base.org/txt/rfc-726.txt
    //OUPUT_LINE_WIDTH      : 8,
    //OUTPUT_PAGE_SIZE      : 9,    //
    //OUTPUT_CARRIAGE_RETURN_DISP   : 10,   //  RFC 652
    //OUTPUT_HORIZ_TABSTOPS : 11,   //  RFC 653
    //OUTPUT_HORIZ_TAB_DISP : 12,   //  RFC 654
    //OUTPUT_FORMFEED_DISP  : 13,   //  RFC 655
    //OUTPUT_VERT_TABSTOPS  : 14,   //  RFC 656
    //OUTPUT_VERT_TAB_DISP  : 15,   //  RFC 657
    //OUTPUT_LF_DISP        : 16,   //  RFC 658
    //EXTENDED_ASCII        : 17,   //  RFC 659
    //LOGOUT                : 18,   //  RFC 727
    //BYTE_MACRO            : 19,   //  RFC 753
    //DATA_ENTRY_TERMINAL   : 20,   //  RFC 1043
    //SUPDUP                : 21,   //  RFC 736
    //SUPDUP_OUTPUT         : 22,   //  RFC 749
    SEND_LOCATION           : 23,   //  RFC 779
    TERMINAL_TYPE           : 24,   //  aka 'TTYPE': RFC 1091 @ http://tools.ietf.org/html/rfc1091
    //END_OF_RECORD         : 25,   //  RFC 885
    //TACACS_USER_ID        : 26,   //  RFC 927
    //OUTPUT_MARKING        : 27,   //  RFC 933
    //TERMINCAL_LOCATION_NUMBER : 28,   //  RFC 946
    //TELNET_3270_REGIME    : 29,   //  RFC 1041
    WINDOW_SIZE             : 31,   //  aka 'NAWS': RFC 1073 @ http://tools.ietf.org/html/rfc1073
    TERMINAL_SPEED          : 32,   //  RFC 1079 @ http://tools.ietf.org/html/rfc1079
    REMOTE_FLOW_CONTROL     : 33,   //  RFC 1072 @ http://tools.ietf.org/html/rfc1372
    LINEMODE                : 34,   //  RFC 1184 @ http://tools.ietf.org/html/rfc1184
    X_DISPLAY_LOCATION      : 35,   //  aka 'XDISPLOC': RFC 1096 @ http://tools.ietf.org/html/rfc1096
    NEW_ENVIRONMENT_DEP     : 36,   //  aka 'NEW-ENVIRON': RFC 1408 @ http://tools.ietf.org/html/rfc1408 (note: RFC 1572 is an update to this)
    AUTHENTICATION          : 37,   //  RFC 2941 @ http://tools.ietf.org/html/rfc2941
    ENCRYPT                 : 38,   //  RFC 2946 @ http://tools.ietf.org/html/rfc2946
    NEW_ENVIRONMENT         : 39,   //  aka 'NEW-ENVIRON': RFC 1572 @ http://tools.ietf.org/html/rfc1572 (note: update to RFC 1408)
    //TN3270E                   : 40,   //  RFC 2355
    //XAUTH                 : 41,
    //CHARSET               : 42,   //  RFC 2066
    //REMOTE_SERIAL_PORT    : 43,
    //COM_PORT_CONTROL      : 44,   //  RFC 2217
    //SUPRESS_LOCAL_ECHO    : 45,
    //START_TLS             : 46,
    //KERMIT                : 47,   //  RFC 2840
    //SEND_URL              : 48,
    //FORWARD_X             : 49,

    //PRAGMA_LOGON          : 138,
    //SSPI_LOGON            : 139,
    //PRAGMA_HEARTBEAT      : 140

    ARE_YOU_THERE           : 246,  //  aka 'AYT' RFC 854 @ https://tools.ietf.org/html/rfc854

    EXTENDED_OPTIONS_LIST   : 255,  //  RFC 861 (STD 32)
};

//  Commands used within NEW_ENVIRONMENT[_DEP]
const NEW_ENVIRONMENT_COMMANDS = {
    VAR     : 0,
    VALUE   : 1,
    ESC     : 2,
    USERVAR : 3,
};

const IAC_BUF       = Buffer.from([ COMMANDS.IAC ]);
const IAC_SE_BUF    = Buffer.from([ COMMANDS.IAC, COMMANDS.SE ]);

const COMMAND_NAMES = Object.keys(COMMANDS).reduce(function(names, name) {
    names[COMMANDS[name]] = name.toLowerCase();
    return names;
}, {});

const COMMAND_IMPLS = {};
[ 'do', 'dont', 'will', 'wont', 'sb' ].forEach(function(command) {
    const code = COMMANDS[command.toUpperCase()];
    COMMAND_IMPLS[code] = function(bufs, i, event) {
        if(bufs.length < (i + 1)) {
            return MORE_DATA_REQUIRED;
        }
        return parseOption(bufs, i, event);
    };
});

//  :TODO: See TooTallNate's telnet.js: Handle COMMAND_IMPL for IAC in binary mode

//  Create option names such as 'transmit binary' -> OPTIONS.TRANSMIT_BINARY
const OPTION_NAMES = Object.keys(OPTIONS).reduce(function(names, name) {
    names[OPTIONS[name]] = name.toLowerCase().replace(/_/g, ' ');
    return names;
}, {});

function unknownOption(bufs, i, event) {
    Log.warn( { bufs : bufs, i : i, event : event }, 'Unknown Telnet option');
    event.buf = bufs.splice(0, i).toBuffer();
    return event;
}

const OPTION_IMPLS = {};
//  :TODO: fill in the rest...
OPTION_IMPLS.NO_ARGS                        =
OPTION_IMPLS[OPTIONS.ECHO]                  =
OPTION_IMPLS[OPTIONS.STATUS]                =
OPTION_IMPLS[OPTIONS.LINEMODE]              =
OPTION_IMPLS[OPTIONS.TRANSMIT_BINARY]       =
OPTION_IMPLS[OPTIONS.AUTHENTICATION]        =
OPTION_IMPLS[OPTIONS.TERMINAL_SPEED]        =
OPTION_IMPLS[OPTIONS.REMOTE_FLOW_CONTROL]   =
OPTION_IMPLS[OPTIONS.X_DISPLAY_LOCATION]    =
OPTION_IMPLS[OPTIONS.SEND_LOCATION]         =
OPTION_IMPLS[OPTIONS.ARE_YOU_THERE]         =
OPTION_IMPLS[OPTIONS.SUPPRESS_GO_AHEAD]     = function(bufs, i, event) {
    event.buf = bufs.splice(0, i).toBuffer();
    return event;
};

OPTION_IMPLS[OPTIONS.TERMINAL_TYPE] = function(bufs, i, event) {
    if(event.commandCode !== COMMANDS.SB) {
        OPTION_IMPLS.NO_ARGS(bufs, i, event);
    } else {
        //  We need 4 bytes header + data + IAC SE
        if(bufs.length < 7) {
            return MORE_DATA_REQUIRED;
        }

        const end = bufs.indexOf(IAC_SE_BUF, 5);    //  look past header bytes
        if(-1 === end) {
            return MORE_DATA_REQUIRED;
        }

        let ttypeCmd;
        try {
            ttypeCmd = new Parser()
                .uint8('iac1')
                .uint8('sb')
                .uint8('opt')
                .uint8('is')
                .array('ttype', {
                    type        : 'uint8',
                    readUntil   : b => 255 === b,   //  255=COMMANDS.IAC
                })
                //  note we read iac2 above
                .uint8('se')
                .parse(bufs.toBuffer());
        } catch(e) {
            Log.debug( { error : e }, 'Failed parsing TTYP telnet command');
            return event;
        }

        EnigAssert(COMMANDS.IAC === ttypeCmd.iac1);
        EnigAssert(COMMANDS.SB === ttypeCmd.sb);
        EnigAssert(OPTIONS.TERMINAL_TYPE === ttypeCmd.opt);
        EnigAssert(SB_COMMANDS.IS === ttypeCmd.is);
        EnigAssert(ttypeCmd.ttype.length > 0);
        //  note we found IAC_SE above

        //  some terminals such as NetRunner provide a NULL-terminated buffer
        //  slice to remove IAC
        event.ttype = stringFromNullTermBuffer(ttypeCmd.ttype.slice(0, -1), 'ascii');

        bufs.splice(0, end);
    }

    return event;
};

OPTION_IMPLS[OPTIONS.WINDOW_SIZE] = function(bufs, i, event) {
    if(event.commandCode !== COMMANDS.SB) {
        OPTION_IMPLS.NO_ARGS(bufs, i, event);
    } else {
        //  we need 9 bytes
        if(bufs.length < 9) {
            return MORE_DATA_REQUIRED;
        }

        let nawsCmd;
        try {
            nawsCmd = new Parser()
                .uint8('iac1')
                .uint8('sb')
                .uint8('opt')
                .uint16be('width')
                .uint16be('height')
                .uint8('iac2')
                .uint8('se')
                .parse(bufs.splice(0, 9).toBuffer());
        } catch(e) {
            Log.debug( { error : e }, 'Failed parsing NAWS telnet command');
            return event;
        }

        EnigAssert(COMMANDS.IAC === nawsCmd.iac1);
        EnigAssert(COMMANDS.SB === nawsCmd.sb);
        EnigAssert(OPTIONS.WINDOW_SIZE === nawsCmd.opt);
        EnigAssert(COMMANDS.IAC === nawsCmd.iac2);
        EnigAssert(COMMANDS.SE === nawsCmd.se);

        event.cols  = event.columns = event.width = nawsCmd.width;
        event.rows  = event.height = nawsCmd.height;
    }
    return event;
};

//  Build an array of delimiters for parsing NEW_ENVIRONMENT[_DEP]
const NEW_ENVIRONMENT_DELIMITERS = [];
Object.keys(NEW_ENVIRONMENT_COMMANDS).forEach(function onKey(k) {
    NEW_ENVIRONMENT_DELIMITERS.push(NEW_ENVIRONMENT_COMMANDS[k]);
});

//  Handle the deprecated RFC 1408 & the updated RFC 1572:
OPTION_IMPLS[OPTIONS.NEW_ENVIRONMENT_DEP]   =
OPTION_IMPLS[OPTIONS.NEW_ENVIRONMENT]       = function(bufs, i, event) {
    if(event.commandCode !== COMMANDS.SB) {
        OPTION_IMPLS.NO_ARGS(bufs, i, event);
    } else {
        //
        //  We need 4 bytes header + <optional payload> + IAC SE
        //  Many terminals send a empty list:
        //      IAC SB NEW-ENVIRON IS IAC SE
        //
        if(bufs.length < 6) {
            return MORE_DATA_REQUIRED;
        }

        let end = bufs.indexOf(IAC_SE_BUF, 4);  //  look past header bytes
        if(-1 === end) {
            return MORE_DATA_REQUIRED;
        }

        //  :TODO: It's likely that we could do all the env name/value parsing directly in Parser.

        let envCmd;
        try {
            envCmd = new Parser()
                .uint8('iac1')
                .uint8('sb')
                .uint8('opt')
                .uint8('isOrInfo')  //  IS=initial, INFO=updates
                .array('envBlock', {
                    type : 'uint8',
                    readUntil   : b => 255 === b,   //  255=COMMANDS.IAC
                })
                //  note we consume IAC above
                .uint8('se')
                .parse(bufs.splice(0, bufs.length).toBuffer());
        } catch(e) {
            Log.debug( { error : e }, 'Failed parsing NEW-ENVIRON telnet command');
            return event;
        }

        EnigAssert(COMMANDS.IAC === envCmd.iac1);
        EnigAssert(COMMANDS.SB === envCmd.sb);
        EnigAssert(OPTIONS.NEW_ENVIRONMENT === envCmd.opt || OPTIONS.NEW_ENVIRONMENT_DEP === envCmd.opt);
        EnigAssert(SB_COMMANDS.IS === envCmd.isOrInfo || SB_COMMANDS.INFO === envCmd.isOrInfo);

        if(OPTIONS.NEW_ENVIRONMENT_DEP === envCmd.opt) {
            //  :TODO: we should probably support this for legacy clients?
            Log.warn('Handling deprecated RFC 1408 NEW-ENVIRON');
        }

        const envBuf = envCmd.envBlock.slice(0, -1);    //  remove IAC

        if(envBuf.length < 4) { //  TYPE + single char name + sep + single char value
            //  empty env block
            return event;
        }

        const States = {
            Name        : 1,
            Value       : 2,
        };

        let state = States.Name;
        const setVars = {};
        const delVars = [];
        let varName;
        //  :TODO: handle ESC type!!!
        while(envBuf.length) {
            switch(state) {
                case States.Name :
                    {
                        const type = parseInt(envBuf.splice(0, 1));
                        if(![ NEW_ENVIRONMENT_COMMANDS.VAR, NEW_ENVIRONMENT_COMMANDS.USERVAR, NEW_ENVIRONMENT_COMMANDS.ESC ].includes(type)) {
                            return event;   //  fail :(
                        }

                        let nameEnd = envBuf.indexOf(NEW_ENVIRONMENT_COMMANDS.VALUE);
                        if(-1 === nameEnd) {
                            nameEnd = envBuf.length;
                        }

                        varName = envBuf.splice(0, nameEnd);
                        if(!varName) {
                            return event;   //  something is wrong.
                        }

                        varName = Buffer.from(varName).toString('ascii');

                        const next = parseInt(envBuf.splice(0, 1));
                        if(NEW_ENVIRONMENT_COMMANDS.VALUE === next) {
                            state = States.Value;
                        } else {
                            state = States.Name;
                            delVars.push(varName);  //  no value; del this var
                        }
                    }
                    break;

                case States.Value :
                    {
                        let valueEnd = envBuf.indexOf(NEW_ENVIRONMENT_COMMANDS.VAR);
                        if(-1 === valueEnd) {
                            valueEnd = envBuf.indexOf(NEW_ENVIRONMENT_COMMANDS.USERVAR);
                        }
                        if(-1 === valueEnd) {
                            valueEnd = envBuf.length;
                        }

                        let value = envBuf.splice(0, valueEnd);
                        if(value) {
                            value = Buffer.from(value).toString('ascii');
                            setVars[varName] = value;
                        }
                        state = States.Name;
                    }
                    break;
            }
        }

        //  :TODO: Handle deleting previously set vars via delVars
        event.type      = envCmd.isOrInfo;
        event.envVars   = setVars;
    }

    return event;
};

const MORE_DATA_REQUIRED    = 0xfeedface;

function parseBufs(bufs) {
    EnigAssert(bufs.length >= 2);
    EnigAssert(bufs.get(0) === COMMANDS.IAC);
    return parseCommand(bufs, 1, {});
}

function parseCommand(bufs, i, event) {
    const command       = bufs.get(i);  //  :TODO: fix deprecation... [i] is not the same
    event.commandCode   = command;
    event.command       = COMMAND_NAMES[command];

    const handler = COMMAND_IMPLS[command];
    if(handler) {
        return handler(bufs, i + 1, event);
    } else {
        if(2 !== bufs.length) {
            Log.warn( { bufsLength : bufs.length }, 'Expected bufs length of 2');   //  expected: IAC + COMMAND
        }

        event.buf = bufs.splice(0, 2).toBuffer();
        return event;
    }
}

function parseOption(bufs, i, event) {
    const option        = bufs.get(i);  //  :TODO: fix deprecation... [i] is not the same
    event.optionCode    = option;
    event.option        = OPTION_NAMES[option];

    const handler = OPTION_IMPLS[option];
    return handler ? handler(bufs, i + 1, event) : unknownOption(bufs, i + 1, event);
}


function TelnetClient(input, output) {
    baseClient.Client.apply(this, arguments);

    const self  = this;

    let bufs    = buffers();
    this.bufs   = bufs;

    this.sentDont = {}; //  DON'T's we've already sent

    this.setInputOutput(input, output);

    this.negotiationsComplete   = false;    //  are we in the 'negotiation' phase?
    this.didReady               = false;    //  have we emit the 'ready' event?

    this.subNegotiationState = {
        newEnvironRequested : false,
    };

    this.dataHandler = function(b) {
        if(!Buffer.isBuffer(b)) {
            EnigAssert(false, `Cannot push non-buffer ${typeof b}`);
            return;
        }

        bufs.push(b);

        let i;
        while((i = bufs.indexOf(IAC_BUF)) >= 0) {

            //
            //  Some clients will send even IAC separate from data
            //
            if(bufs.length <= (i + 1)) {
                i = MORE_DATA_REQUIRED;
                break;
            }

            EnigAssert(bufs.length > (i + 1));

            if(i > 0) {
                self.emit('data', bufs.splice(0, i).toBuffer());
            }

            i = parseBufs(bufs);

            if(MORE_DATA_REQUIRED === i) {
                break;
            } else if(i) {
                if(i.option) {
                    self.emit(i.option, i); //  "transmit binary", "echo", ...
                }

                self.handleTelnetEvent(i);

                if(i.data) {
                    self.emit('data', i.data);
                }
            }
        }

        if(MORE_DATA_REQUIRED !== i && bufs.length > 0) {
            //
            //  Standard data payload. This can still be "non-user" data
            //  such as ANSI control, but we don't handle that here.
            //
            self.emit('data', bufs.splice(0).toBuffer());
        }
    };

    this.input.on('data', this.dataHandler);

    this.input.on('end', () => {
        self.emit('end');
    });

    this.input.on('error', err => {
        this.connectionDebug( { err : err }, 'Socket error' );
        return self.emit('end');
    });

    this.connectionTrace = (info, msg) => {
        if(Config().loginServers.telnet.traceConnections) {
            const logger = self.log || Log;
            return logger.trace(info, `Telnet: ${msg}`);
        }
    };

    this.connectionDebug = (info, msg) => {
        const logger = self.log || Log;
        return logger.debug(info, `Telnet: ${msg}`);
    };

    this.connectionWarn = (info, msg) => {
        const logger = self.log || Log;
        return logger.warn(info, `Telnet: ${msg}`);
    };

    this.readyNow = () => {
        if(!this.didReady) {
            this.didReady = true;
            this.emit('ready', { firstMenu : Config().loginServers.telnet.firstMenu } );
        }
    };
}

util.inherits(TelnetClient, baseClient.Client);

///////////////////////////////////////////////////////////////////////////////
//  Telnet Command/Option handling
///////////////////////////////////////////////////////////////////////////////
TelnetClient.prototype.handleTelnetEvent = function(evt) {

    if(!evt.command) {
        return this.connectionWarn( { evt : evt }, 'No command for event');
    }

    //  handler name e.g. 'handleWontCommand'
    const handlerName = `handle${evt.command.charAt(0).toUpperCase()}${evt.command.substr(1)}Command`;

    if(this[handlerName]) {
        //  specialized
        this[handlerName](evt);
    } else {
        //  generic-ish
        this.handleMiscCommand(evt);
    }
};

TelnetClient.prototype.handleWillCommand = function(evt) {
    if('terminal type' === evt.option) {
        //
        //  See RFC 1091 @ http://www.faqs.org/rfcs/rfc1091.html
        //
        this.requestTerminalType();
    } else if('new environment' === evt.option) {
        //
        //  See RFC 1572 @ http://www.faqs.org/rfcs/rfc1572.html
        //
        this.requestNewEnvironment();
    } else {
        //  :TODO: temporary:
        this.connectionTrace(evt, 'WILL');
    }
};

TelnetClient.prototype.handleWontCommand = function(evt) {
    if(this.sentDont[evt.option]) {
        return this.connectionTrace(evt, 'WONT - DON\'T already sent');
    }

    this.sentDont[evt.option] = true;

    if('new environment' === evt.option) {
        this.dont.new_environment();
    } else {
        this.connectionTrace(evt, 'WONT');
    }
};

TelnetClient.prototype.handleDoCommand = function(evt) {
    //  :TODO: handle the rest, e.g. echo nd the like

    if('linemode' === evt.option) {
        //
        //  Client wants to enable linemode editing. Denied.
        //
        this.wont.linemode();
    } else if('encrypt' === evt.option) {
        //
        //  Client wants to enable encryption. Denied.
        //
        this.wont.encrypt();
    } else {
        //  :TODO: temporary:
        this.connectionTrace(evt, 'DO');
    }
};

TelnetClient.prototype.handleDontCommand = function(evt) {
    this.connectionTrace(evt, 'DONT');
};

TelnetClient.prototype.handleSbCommand = function(evt) {
    const self = this;

    if('terminal type' === evt.option) {
        //
        //  See RFC 1091 @ http://www.faqs.org/rfcs/rfc1091.html
        //
        //  :TODO: According to RFC 1091 @ http://www.faqs.org/rfcs/rfc1091.html
        //  We should keep asking until we see a repeat. From there, determine the best type/etc.
        self.setTermType(evt.ttype);

        self.negotiationsComplete = true;   //  :TODO: throw in a array of what we've taken care. Complete = array satisified or timeout

        self.readyNow();
    } else if('new environment' === evt.option) {
        //
        //  Handling is as follows:
        //  * Map 'TERM' -> 'termType' and only update if ours is 'unknown'
        //  * Map COLUMNS -> 'termWidth' and only update if ours is 0
        //  * Map ROWS -> 'termHeight' and only update if ours is 0
        //  * Add any new variables, ignore any existing
        //
        Object.keys(evt.envVars || {} ).forEach(function onEnv(name) {
            if('TERM' === name && 'unknown' === self.term.termType) {
                self.setTermType(evt.envVars[name]);
            } else if('COLUMNS' === name && 0 === self.term.termWidth) {
                self.term.termWidth = parseInt(evt.envVars[name]);
                self.clearMciCache();   //  term size changes = invalidate cache
                self.connectionDebug({ termWidth : self.term.termWidth, source : 'NEW-ENVIRON'}, 'Window width updated');
            } else if('ROWS' === name && 0 === self.term.termHeight) {
                self.term.termHeight = parseInt(evt.envVars[name]);
                self.clearMciCache();   //  term size changes = invalidate cache
                self.connectionDebug({ termHeight : self.term.termHeight, source : 'NEW-ENVIRON'}, 'Window height updated');
            } else {
                if(name in self.term.env) {

                    EnigAssert(
                        SB_COMMANDS.INFO === evt.type || SB_COMMANDS.IS === evt.type,
                        'Unexpected type: ' + evt.type
                    );

                    self.connectionWarn(
                        { varName : name, value : evt.envVars[name], existingValue : self.term.env[name] },
                        'Environment variable already exists'
                    );
                } else {
                    self.term.env[name] = evt.envVars[name];
                    self.connectionDebug( { varName : name, value : evt.envVars[name] }, 'New environment variable' );
                }
            }
        });

    } else if('window size' === evt.option) {
        //
        //  Update termWidth & termHeight.
        //  Set LINES and COLUMNS environment variables as well.
        //
        self.term.termWidth     = evt.width;
        self.term.termHeight    = evt.height;

        if(evt.width > 0) {
            self.term.env.COLUMNS = evt.height;
        }

        if(evt.height > 0) {
            self.term.env.ROWS = evt.height;
        }

        self.clearMciCache();   //  term size changes = invalidate cache

        self.connectionDebug({ termWidth : evt.width , termHeight : evt.height, source : 'NAWS' }, 'Window size updated');
    } else {
        self.connectionDebug(evt, 'SB');
    }
};

const IGNORED_COMMANDS = [];
[ COMMANDS.EL, COMMANDS.GA, COMMANDS.NOP, COMMANDS.DM, COMMANDS.BRK ].forEach(function onCommandCode(cc) {
    IGNORED_COMMANDS.push(cc);
});


TelnetClient.prototype.handleMiscCommand = function(evt) {
    EnigAssert(evt.command !== 'undefined' && evt.command.length > 0);

    //
    //  See:
    //  * RFC 854 @ http://tools.ietf.org/html/rfc854
    //
    if('ip' === evt.command) {
        //  Interrupt Process (IP)
        this.log.debug('Interrupt Process (IP) - Ending');

        this.input.end();
    } else if('ayt' === evt.command) {
        this.output.write('\b');

        this.log.debug('Are You There (AYT) - Replied "\\b"');
    } else if(IGNORED_COMMANDS.indexOf(evt.commandCode)) {
        this.log.debug({ evt : evt }, 'Ignoring command');
    } else {
        this.log.warn({ evt : evt }, 'Unknown command');
    }
};

TelnetClient.prototype.requestTerminalType = function() {
    const buf = Buffer.from( [
        COMMANDS.IAC,
        COMMANDS.SB,
        OPTIONS.TERMINAL_TYPE,
        SB_COMMANDS.SEND,
        COMMANDS.IAC,
        COMMANDS.SE ]);
    this.output.write(buf);
};

const WANTED_ENVIRONMENT_VAR_BUFS = [
    Buffer.from( 'LINES' ),
    Buffer.from( 'COLUMNS' ),
    Buffer.from( 'TERM' ),
    Buffer.from( 'TERM_PROGRAM' )
];

TelnetClient.prototype.requestNewEnvironment = function() {

    if(this.subNegotiationState.newEnvironRequested) {
        this.log.debug('New environment already requested');
        return;
    }

    const self = this;

    const bufs = buffers();
    bufs.push(Buffer.from( [
        COMMANDS.IAC,
        COMMANDS.SB,
        OPTIONS.NEW_ENVIRONMENT,
        SB_COMMANDS.SEND ]
    ));

    for(let i = 0; i < WANTED_ENVIRONMENT_VAR_BUFS.length; ++i) {
        bufs.push(Buffer.from( [ NEW_ENVIRONMENT_COMMANDS.VAR ] ), WANTED_ENVIRONMENT_VAR_BUFS[i] );
    }

    bufs.push(Buffer.from([ NEW_ENVIRONMENT_COMMANDS.USERVAR, COMMANDS.IAC, COMMANDS.SE ]));

    self.output.write(bufs.toBuffer());

    this.subNegotiationState.newEnvironRequested = true;
};

TelnetClient.prototype.banner = function() {
    this.will.echo();

    this.will.suppress_go_ahead();
    this.do.suppress_go_ahead();

    this.do.transmit_binary();
    this.will.transmit_binary();

    this.do.terminal_type();

    this.do.window_size();
    this.do.new_environment();
};

function Command(command, client) {
    this.command    = COMMANDS[command.toUpperCase()];
    this.client     = client;
}

//  Create Command objects with echo, transmit_binary, ...
Object.keys(OPTIONS).forEach(function(name) {
    const code = OPTIONS[name];

    Command.prototype[name.toLowerCase()] = function() {
        const buf = Buffer.alloc(3);
        buf[0]  = COMMANDS.IAC;
        buf[1]  = this.command;
        buf[2]  = code;
        return this.client.output.write(buf);
    };
});

//  Create do, dont, etc. methods on Client
['do', 'dont', 'will', 'wont'].forEach(function(command) {
    const get = function() {
        return new Command(command, this);
    };

    Object.defineProperty(TelnetClient.prototype, command, {
        get             : get,
        enumerable      : true,
        configurable    : true
    });
});

exports.getModule = class TelnetServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        this.server = net.createServer( sock => {
            const client = new TelnetClient(sock, sock);

            client.banner();

            this.handleNewClient(client, sock, ModuleInfo);

            //
            //  Set a timeout and attempt to proceed even if we don't know
            //  the term type yet, which is the preferred trigger
            //  for moving along
            //
            setTimeout( () => {
                if(!client.didReady) {
                    Log.info('Proceeding after 3s without knowing term type');
                    client.readyNow();
                }
            }, 3000);
        });

        this.server.on('error', err => {
            Log.info( { error : err.message }, 'Telnet server error');
        });

        return cb(null);
    }

    listen() {
        const config = Config();
        const port = parseInt(config.loginServers.telnet.port);
        if(isNaN(port)) {
            Log.error( { server : ModuleInfo.name, port : config.loginServers.telnet.port }, 'Cannot load server (invalid port)' );
            return false;
        }

        this.server.listen(port);
        Log.info( { server : ModuleInfo.name, port : port }, 'Listening for connections' );
        return true;
    }
};
