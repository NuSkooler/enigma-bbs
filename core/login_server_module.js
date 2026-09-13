/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config').get;
const logger = require('./logger.js');
const ServerModule = require('./server_module.js').ServerModule;
const clientConns = require('./client_connections.js');
const UserProps = require('./user_property.js');

//  deps
const _ = require('lodash');
const moment = require('moment');

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
        //  Choose initial theme before we have user context
        //
        const preLoginTheme = _.get(Config(), 'theme.preLogin');
        if ('*' === preLoginTheme) {
            client.user.properties[UserProps.ThemeId] = theme.getRandomTheme() || '';
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

        if (maxConnections > 0 && numConnections >= maxConnections) {
            client.term.write('\nAll nodes are busy. Try again later...\n');
            client.end();
            return;
        }

        client.session.serverName = modInfo.name;
        client.session.isSecure = _.isBoolean(client.isSecure)
            ? client.isSecure
            : modInfo.isSecure || false;

        clientConns.addNewClient(client, clientSock);

        client.on('ready', readyOptions => {
            client.startIdleMonitor();

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

    theme.getThemeArt({ client, name: artSpec }, err => {
        if (err) {
            return plainAndEnd(); //  the menu is there; its art is not
        }

        client.menuStack.goto(MenuName, err => {
            if (err) {
                return plainAndEnd();
            }
            return done('menu');
        });
    });
}

module.exports.timeUpLogoff = timeUpLogoff;
