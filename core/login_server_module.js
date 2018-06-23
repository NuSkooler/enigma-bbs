/* jslint node: true */
'use strict';

//  ENiGMA½
const conf          = require('./config.js');
const logger        = require('./logger.js');
const ServerModule  = require('./server_module.js').ServerModule;
const clientConns   = require('./client_connections.js');

//  deps
const _         = require('lodash');

module.exports = class LoginServerModule extends ServerModule {
    constructor() {
        super();
    }

    //  :TODO: we need to max connections -- e.g. from config 'maxConnections'

    prepareClient(client, cb) {
        const theme = require('./theme.js');

        //
        //  Choose initial theme before we have user context
        //
        if('*' === conf.config.preLoginTheme) {
            client.user.properties.theme_id = theme.getRandomTheme() || '';
        } else {
            client.user.properties.theme_id = conf.config.preLoginTheme;
        }

        theme.setClientTheme(client, client.user.properties.theme_id);
        return cb(null);   //  note: currently useless to use cb here - but this may change...again...
    }

    handleNewClient(client, clientSock, modInfo) {
        //
        //  Start tracking the client. We'll assign it an ID which is
        //  just the index in our connections array.
        //
        if(_.isUndefined(client.session)) {
            client.session = {};
        }

        client.session.serverName   = modInfo.name;
        client.session.isSecure     = _.isBoolean(client.isSecure) ? client.isSecure : (modInfo.isSecure || false);

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
            logger.log.info({ clientId : client.session.id }, 'Connection error: %s' % err.message);
        });

        client.on('close', err => {
            const logFunc = err ? logger.log.info : logger.log.debug;
            logFunc( { clientId : client.session.id }, 'Connection closed');

            clientConns.removeClient(client);
        });

        client.on('idle timeout', () => {
            client.log.info('User idle timeout expired');

            client.menuStack.goto('idleLogoff', err => {
                if(err) {
                    //  likely just doesn't exist
                    client.term.write('\nIdle timeout expired. Goodbye!\n');
                    client.end();
                }
            });
        });
    }
};
