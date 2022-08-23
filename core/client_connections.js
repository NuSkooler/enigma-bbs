/* jslint node: true */
'use strict';

//  ENiGMA½
const logger = require('./logger.js');
const Events = require('./events.js');
const UserProps = require('./user_property.js');

//  deps
const _ = require('lodash');
const moment = require('moment');
const hashids = require('hashids/cjs');

exports.getActiveConnections = getActiveConnections;
exports.getActiveConnectionList = getActiveConnectionList;
exports.addNewClient = addNewClient;
exports.removeClient = removeClient;
exports.getConnectionByUserId = getConnectionByUserId;
exports.getConnectionByNodeId = getConnectionByNodeId;

const clientConnections = [];
exports.clientConnections = clientConnections;

const AllConnections = { authUsersOnly: false, visibleOnly: false, availOnly: false };
exports.AllConnections = AllConnections;

const UserVisibleConnections = {
    authUsersOnly: false,
    visibleOnly: true,
    availOnly: false,
};
exports.UserVisibleConnections = UserVisibleConnections;

const UserMessageableConnections = {
    authUsersOnly: true,
    visibleOnly: true,
    availOnly: true,
};
exports.UserMessageableConnections = UserMessageableConnections;

function getActiveConnections(
    options = { authUsersOnly: true, visibleOnly: true, availOnly: false }
) {
    return clientConnections.filter(conn => {
        if (options.authUsersOnly && !conn.user.isAuthenticated()) {
            return false;
        }
        if (options.visibleOnly && !conn.user.isVisible()) {
            return false;
        }
        if (options.availOnly && !conn.user.isAvailable()) {
            return false;
        }

        return true;
    });
}

function getActiveConnectionList(
    options = { authUsersOnly: true, visibleOnly: true, availOnly: false }
) {
    const now = moment();

    return _.map(getActiveConnections(options), ac => {
        let action;
        try {
            //  attempting to fetch a bad menu stack item can blow up/assert
            action = _.get(ac, 'currentMenuModule.menuConfig.desc', 'Unknown');
        } catch (e) {
            action = 'Unknown';
        }

        const entry = {
            node: ac.node,
            authenticated: ac.user.isAuthenticated(),
            userId: ac.user.userId,
            action: action,
            serverName: ac.session.serverName,
            isSecure: ac.session.isSecure,
            isVisible: ac.user.isVisible(),
            isAvailable: ac.user.isAvailable(),
            remoteAddress: ac.friendlyRemoteAddress(),
        };

        //
        //  There may be a connection, but not a logged in user as of yet
        //
        entry.text = ac.user?.username || 'N/A';
        entry.userName = ac.user?.username || 'N/A';
        entry.realName = ac.user?.getProperty(UserProps.RealName) || 'N/A';
        entry.location = ac.user?.getProperty(UserProps.Location) || 'N/A';
        entry.affils = entry.affiliation =
            ac.user?.getProperty(UserProps.Affiliations) || 'N/A';

        if (ac.user.isAuthenticated()) {
            // :TODO: track pre-auth time so we can properly track this
            const diff = now.diff(
                moment(ac.user.properties[UserProps.LastLoginTs]),
                'minutes'
            );
            entry.timeOn = moment.duration(diff, 'minutes');
        }

        return entry;
    });
}

function addNewClient(client, clientSock) {
    //
    //  Find a node ID "slot"
    //
    let nodeId;
    for (nodeId = 1; nodeId < Number.MAX_SAFE_INTEGER; ++nodeId) {
        const existing = clientConnections.find(client => nodeId === client.node);
        if (!existing) {
            break; //  available slot
        }
    }

    client.session.id = nodeId;
    const remoteAddress = (client.remoteAddress = clientSock.remoteAddress);
    //  create a unique identifier one-time ID for this session
    client.session.uniqueId = new hashids('ENiGMA½ClientSession').encode([
        nodeId,
        moment().valueOf(),
    ]);

    // kludge to refresh process update stats at first client
    if (clientConnections.length < 1) {
        setTimeout(() => {
            const StatLog = require('./stat_log');
            const SysProps = require('./system_property');
            StatLog.getSystemStat(SysProps.ProcessTrafficStats);
        }, 3000); // slight pause to wait for updates
    }

    clientConnections.push(client);
    clientConnections.sort((c1, c2) => c1.session.id - c2.session.id);

    //  Create a client specific logger
    //  Note that this will be updated @ login with additional information
    client.log = logger.log.child({ nodeId, sessionId: client.session.uniqueId });

    const connInfo = {
        remoteAddress: remoteAddress,
        friendlyRemoteAddress: client.friendlyRemoteAddress(),
        serverName: client.session.serverName,
        isSecure: client.session.isSecure,
    };

    if (client.log.debug()) {
        connInfo.port = clientSock.localPort;
        connInfo.family = clientSock.localFamily;
    }

    client.log.info(
        connInfo,
        `Client connected on node ${nodeId} (${connInfo.serverName}/${connInfo.port})`
    );

    Events.emit(Events.getSystemEvents().ClientConnected, {
        client: client,
        connectionCount: clientConnections.length,
    });

    return nodeId;
}

function removeClient(client) {
    client.end();

    const i = clientConnections.indexOf(client);
    if (i > -1) {
        clientConnections.splice(i, 1);

        logger.log.info(
            {
                connectionCount: clientConnections.length,
                nodeId: client.node,
            },
            `Client disconnected from node ${client.node}`
        );

        if (client.user && client.user.isValid()) {
            const minutesOnline = moment().diff(
                moment(client.user.properties[UserProps.LastLoginTs]),
                'minutes'
            );
            Events.emit(Events.getSystemEvents().UserLogoff, {
                user: client.user,
                minutesOnline,
            });
        }

        Events.emit(Events.getSystemEvents().ClientDisconnected, {
            client: client,
            connectionCount: clientConnections.length,
        });
    }
}

function getConnectionByUserId(userId) {
    return getActiveConnections(AllConnections).find(ac => userId === ac.user.userId);
}

function getConnectionByNodeId(nodeId) {
    return getActiveConnections(AllConnections).find(ac => nodeId == ac.node);
}
