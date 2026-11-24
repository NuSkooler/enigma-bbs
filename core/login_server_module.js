/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config').get;
const logger = require('./logger.js');
const ServerModule = require('./server_module.js').ServerModule;
const clientConns = require('./client_connections.js');
const UserProps = require('./user_property.js');
const { selectClientEmulation } = require('./term/select.js');
const { DEFAULT_EMULATION } = require('./term');

//  deps
const _ = require('lodash');
const moment = require('moment');

const AllNodesBusyMessage = 'All nodes are busy. Try again later...';

//
//  The "all nodes are busy" refusal can come from an optional art file,
//  BUSY.ASC, looked for as any art is with no user yet: the pre-login theme
//  (theme.preLogin, when it names one theme that is there), then the
//  default theme (theme.default), then the general art directory. Without
//  one, the message is AllNodesBusyMessage. Each transport shows it as it
//  can: a terminal (telnet, WebSocket) gets it as written, pipe colour codes
//  rendered; SSH shows it as plain text (see SSHClient.toInstructionText()).
//
//  A refusal must not wait on the disk, nor may a flood of connections turn
//  into a flood of reads: the message is kept, and read again in the
//  background at most every BusyMessageRefreshMs, once a connection comes
//  in after that, one read at a time. A file added, changed or removed is
//  therefore seen within about that long. Any connection does it, so the
//  message is ready by the time the board is full. A read that has not
//  finished after BusyMessageRefreshMs is given up on, and its answer, if
//  it ever comes, ignored.
//
const BusyArtName = 'BUSY.ASC';
const BusyMessageRefreshMs = 60 * 1000;

const busyMessage = {
    message: null, //  from BUSY.ASC; null for none
    loadedAt: 0, //  Date.now() of the last read, 0 for never
    loadingSince: 0, //  Date.now() the read under way started, 0 for none
    loadId: 0, //  the read under way, or the last one
};

function getAllNodesBusyMessage() {
    return busyMessage.message || AllNodesBusyMessage;
}

//
//  The theme to look for BUSY.ASC in before the default theme: the
//  pre-login theme an ANSI caller would get, when that is one theme ('*',
//  a random pick, is not) and, once the themes are loaded, one that is
//  available. Undefined otherwise. An id that names no theme directory is
//  only a lookup that finds nothing, before the default theme.
//
function getBusyArtThemeId(theme) {
    const preLogin = theme.getThemeSetting(DEFAULT_EMULATION, 'preLogin');
    if (!_.isString(preLogin) || 0 === preLogin.length || '*' === preLogin) {
        return undefined;
    }

    let available;
    try {
        available = theme.getAvailableThemes();
    } catch (err) {
        return preLogin; //  themes not loaded yet
    }
    return available && !available.has(preLogin) ? undefined : preLogin;
}

//
//  Read BUSY.ASC again if it has not been read in BusyMessageRefreshMs (or
//  |force|), unless a read is already under way. |cb|, optional, is called
//  once this read, or the one under way, is done (or at once if none is
//  needed).
//
const busyMessageWaiters = [];

function refreshAllNodesBusyMessage(options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }
    options = options || {};

    if (cb) {
        busyMessageWaiters.push(cb);
    }

    const done = () => {
        busyMessageWaiters.splice(0).forEach(waiter => waiter(null));
    };

    const now = Date.now();
    if (
        busyMessage.loadingSince > 0 &&
        now - busyMessage.loadingSince < BusyMessageRefreshMs
    ) {
        return; //  the read under way calls |cb|
    }

    const fresh =
        busyMessage.loadedAt > 0 && now - busyMessage.loadedAt < BusyMessageRefreshMs;
    if (fresh && !options.force && 0 === busyMessage.loadingSince) {
        return done();
    }

    const loadId = ++busyMessage.loadId;
    busyMessage.loadingSince = now;

    //  late, as in prepareClient()
    const theme = require('./theme.js');

    //  once per read, and only for the read under way
    const loaded = text => {
        if (loadId !== busyMessage.loadId || 0 === busyMessage.loadingSince) {
            return;
        }
        busyMessage.loadingSince = 0;
        busyMessage.loadedAt = Date.now();
        busyMessage.message = _.isString(text)
            ? text.replace(/\r\n/g, '\n').trimEnd() || null
            : null;
        return done();
    };

    //  no client: there is no user yet, so no theme of theirs. Nor is a
    //  missing file worth more than getThemeArt()'s own debug line.
    try {
        const artOpts = {
            name: BusyArtName,
            themeId: getBusyArtThemeId(theme),
            readSauce: false,
        };
        theme.getThemeArt(artOpts, (err, artInfo) => {
            return loaded(err ? null : _.get(artInfo, 'data'));
        });
    } catch (err) {
        logger.log.debug({ error: err.message }, `Cannot read ${BusyArtName}`);
        return loaded(null);
    }
}

module.exports = class LoginServerModule extends ServerModule {
    constructor() {
        super();
    }

    prepareClient(client, cb) {
        if (client.user.isAuthenticated()) {
            return cb(null);
        }

        const theme = require('./theme.js');

        //
        //  Choose initial theme before we have user context. Both the setting
        //  and a random pick follow the session's terminal emulation; for
        //  ANSI with no theme.emulations block that is theme.preLogin and
        //  every theme, as before (#593).
        //
        const emulation = theme.getSessionEmulation(client);
        const preLoginTheme = theme.getThemeSetting(emulation, 'preLogin');
        if ('*' === preLoginTheme) {
            client.user.properties[UserProps.ThemeId] =
                theme.getRandomTheme(emulation) || '';
        } else {
            client.user.properties[UserProps.ThemeId] = preLoginTheme;
        }

        theme.setClientTheme(client, client.user.properties[UserProps.ThemeId]);
        return cb(null);
    }

    handleNewClient(client, clientSock, modInfo) {
        const maxConnections = _.get(Config(), 'general.maxConnections');
        const numConnections = clientConns.clientConnections.length;

        clientSock.on('error', err => {
            logger.log.warn({ modInfo, error: err.message }, 'Client socket error');
        });

        //
        //  Start tracking the client. A session ID aka client ID
        //  will be established in addNewClient() below.
        //
        if (client.session === undefined) {
            client.session = {};
        }

        client.rawSocket = clientSock;

        if (maxConnections > 0) {
            refreshAllNodesBusyMessage();
        }

        if (maxConnections > 0 && numConnections >= maxConnections) {
            //
            //  The client is not tracked, so it never gets the node logger
            //  addNewClient() gives it. Transport code that runs while it is
            //  turned away (SSH authentication, a terminal type arriving)
            //  still logs through client.log.
            //
            client.log = logger.log.child({
                server: modInfo.name,
                remoteAddress: clientSock.remoteAddress,
                refused: true,
            });
            client.log.info(
                { maxConnections, numConnections },
                'All nodes are busy; refusing connection'
            );
            return client.refuseConnection(getAllNodesBusyMessage());
        }

        client.session.serverName = modInfo.name;
        client.session.isSecure = _.isBoolean(client.isSecure)
            ? client.isSecure
            : modInfo.isSecure || false;

        clientConns.addNewClient(client, clientSock);

        client.on('ready', readyOptions => {
            //
            //  A transport can still report ready for a caller that has
            //  already gone -- telnet's terminal type wait, for one (#999).
            //  There is nobody to serve, and an idle monitor started now
            //  would never be stopped.
            //
            if (client.clientEnded) {
                return client.log.debug('Client ready after it ended; ignoring');
            }

            client.startIdleMonitor();

            //
            //  The terminal type is known by now (the transport waits for
            //  it), and so is the listener the caller came in on: settle
            //  which terminal emulation this session uses before anything is
            //  asked of the terminal.
            //
            selectClientEmulation(client, readyOptions);

            //  Go to module -- use default error handler
            this.prepareClient(client, () => {
                require('./connect.js').connectEntry(client, readyOptions.firstMenu);
            });
        });

        client.on('end', () => {
            clientConns.removeClient(client);
        });

        client.on('error', err => {
            logger.log.info(
                { nodeId: client.node, error: err.message },
                'Connection error'
            );
        });

        client.on('close', err => {
            const logFunc = err ? logger.log.info : logger.log.debug;
            logFunc({ nodeId: client.node }, 'Connection closed');

            clientConns.removeClient(client);
        });

        client.on('idle timeout', idleLogoutSeconds => {
            client.log.info(
                `Node ${client.node} idle timeout of ${moment
                    .duration(idleLogoutSeconds, 'seconds')
                    .humanize()} expired; Kicking`
            );

            client.menuStack.goto('idleLogoff', err => {
                if (err) {
                    //  likely just doesn't exist
                    client.term.write('\nIdle timeout expired. Goodbye!\n');
                    client.end();
                }
            });
        });

        client.on('time up', () => {
            client.log.info(`Node ${client.node} has used its time for today; Kicking`);
            timeUpLogoff(client);
        });
    }
};

//
//  Send the user to the timeUpLogoff menu, or tell them plainly and hang up.
//
//  The art is resolved *before* handing over to the menu, rather than
//  mirroring the idleLogoff pattern above. goto() only errors when the
//  *menu* is missing: where the menu exists and its art does not, MenuModule
//  displays nothing and runs straight on to @systemMethod:logoff, dropping
//  the user in silence with no idea why. That is the common case here, since
//  the shipped template defines timeUpLogoff and no theme ships TIMEUP art.
//
//  :TODO: idleLogoff above has the same silent-drop hole and wants the same
//  treatment, as its own change.
//
const MenuName = 'timeUpLogoff';

function timeUpLogoff(client, cb) {
    const menuUtil = require('./menu_util.js');
    const theme = require('./theme.js');

    const done = how => {
        if (cb) {
            return cb(null, how);
        }
    };

    const plainAndEnd = () => {
        client.term.write('\nYour time for today is up. Goodbye!\n');
        client.end();
        return done('plain');
    };

    //  the menu as the user's theme has it; see menu_util.getMenuConfig()
    const menuConfig = _.get(client.currentTheme, ['menus', MenuName]);
    if (!menuConfig) {
        return plainAndEnd(); //  no such menu
    }

    const artSpec = menuUtil.getResolvedSpec(client, menuConfig.art, 'art');
    if (!_.isString(artSpec)) {
        return plainAndEnd();
    }

    //  the menu shows native art (.seq, .ata) and RIP art too, so it counts as
    //  being there
    theme.getThemeArt(
        { client, name: artSpec, acceptNative: true, acceptRip: true },
        err => {
            if (err) {
                return plainAndEnd(); //  the menu is there; its art is not
            }

            client.menuStack.goto(MenuName, err => {
                if (err) {
                    return plainAndEnd();
                }
                return done('menu');
            });
        }
    );
}

module.exports.timeUpLogoff = timeUpLogoff;
module.exports.AllNodesBusyMessage = AllNodesBusyMessage;
module.exports.BusyArtName = BusyArtName;
module.exports.getAllNodesBusyMessage = getAllNodesBusyMessage;
module.exports.refreshAllNodesBusyMessage = refreshAllNodesBusyMessage;
