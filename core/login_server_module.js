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

module.exports = class LoginServerModule extends ServerModule {
    constructor() {
        super();
    }

    //  :TODO: we need to max connections -- e.g. from config 'maxConnections'

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
        clientSock.on('error', err => {
            logger.log.warn({ modInfo, error: err.message }, 'Client socket error');
        });

        //
        //  Start tracking the client. A session ID aka client ID
        //  will be established in addNewClient() below.
        //
        if (_.isUndefined(client.session)) {
            client.session = {};
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

        client.on('idle timeout', () => {
            client.log.info('User idle timeout expired');

            client.menuStack.goto('idleLogoff', err => {
                if (err) {
                    //  likely just doesn't exist
                    client.term.write('\nIdle timeout expired. Goodbye!\n');
                    client.end();
                }
            });
        });
    }
};
