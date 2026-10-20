/* jslint node: true */
'use strict';

//  ENiGMA½
const logger = require('./logger.js');
const { consoleStyle } = require('./server_listen.js');

//  deps
const async = require('async');
const isFunction = require('lodash/isFunction');
const get = require('lodash/get');

const listeningServers = {}; //  packageName -> info

//  How long shutdown() waits for the servers to say they have stopped
//  listening before it gives up on them and carries on
const ListenerCloseTimeoutMs = 1000;

//
//  Where the server modules keep what they listen with, for a module with no
//  shutdown() of its own (none has one yet). Each is close()'d.
//
const ServerFields = [
    'server', //  telnet, ssh, gopher, the MRC multiplexer
    'httpServer', //  web (http)
    'httpsServer', //  web (https)
    'insecure.httpServer', //  websocket (ws://)
    'secure.httpServer', //  websocket (wss://)
    'nntpServer.server', //  nntp: nntp-server keeps its net.Server as .server
    'nntpsServer.server', //  nntps: ...and its tls.Server
];

exports.startup = startup;
exports.shutdown = shutdown;
exports.getServer = getServer;

//  For tests
exports.closeListeners = closeListeners;
exports.ServerFields = ServerFields;
exports.ListenerCloseTimeoutMs = ListenerCloseTimeoutMs;

function startup(cb) {
    console.info(consoleStyle('|07Starting servers...'));
    return startListening(cb);
}

//
//  Stop accepting new connections on every listening server, so that nothing
//  new starts while the rest of the system shuts down. Connections already
//  open are left alone: the shutdown disconnects callers itself.
//
function shutdown(cb) {
    return closeListeners(listeningServers, {}, cb);
}

//
//  Close every server in |servers| (packageName -> { instance, info }), then
//  empty it. A server that has not confirmed within |timeoutMs| is logged and
//  given up on; this always calls back, without an error.
//
function closeListeners(
    servers,
    { timeoutMs = ListenerCloseTimeoutMs, log = logger.log } = {},
    cb
) {
    const names = Object.keys(servers);
    const pending = new Set(names);
    let finished = false;

    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(timer);
        names.forEach(name => delete servers[name]);

        if (pending.size > 0) {
            log.warn(
                { servers: [...pending], timeoutMs },
                'Listening servers did not confirm they stopped; continuing'
            );
        }
        log.info({ servers: names }, 'Stopped listening for new connections');
        return cb(null);
    };

    const timer = setTimeout(finish, timeoutMs);

    names.forEach(name => {
        stopListening(name, servers[name], log, () => {
            pending.delete(name);
            if (0 === pending.size) {
                return finish();
            }
        });
    });

    if (0 === names.length) {
        return finish();
    }
}

function stopListening(name, entry, log, cb) {
    let called = false;
    const done = () => {
        if (!called) {
            called = true;
            return cb();
        }
    };

    const instance = entry && entry.instance;
    try {
        if (instance && isFunction(instance.shutdown)) {
            return instance.shutdown(() => done());
        }

        const found = new Set(
            ServerFields.map(field => get(instance, field)).filter(
                server => server && isFunction(server.close)
            )
        );
        let left = found.size;
        if (0 === left) {
            return done();
        }
        found.forEach(server =>
            closeServer(server, log, name, () => {
                if (0 === --left) {
                    return done();
                }
            })
        );
    } catch (err) {
        log.warn({ err, server: name }, 'Failed to stop listening; continuing');
        return done();
    }
}

//
//  close() stops a server accepting connections at once, but its callback
//  only comes once every connection already open has ended, which may be
//  never as far as this is concerned. So a server that is no longer
//  listening when close() returns counts as stopped; the callback is for
//  anything else.
//
function closeServer(server, log, name, cb) {
    let called = false;
    const done = () => {
        if (!called) {
            called = true;
            return cb();
        }
    };

    try {
        server.close(() => done());
    } catch (err) {
        log.warn({ err, server: name }, 'Failed to stop listening; continuing');
        return done();
    }

    //  net, http, https and tls servers have .listening; an ssh2 Server does
    //  not, but its address() is null once it has stopped
    if (
        false === server.listening ||
        (undefined === server.listening &&
            isFunction(server.address) &&
            null === server.address())
    ) {
        return done();
    }
}

function getServer(packageName) {
    return listeningServers[packageName];
}

function startListening(cb) {
    const moduleUtil = require('./module_util.js'); //  late load so we get Config
    const cats = moduleUtil.moduleCategories;

    async.each(
        [cats.Login, cats.Content, cats.Chat],
        (category, next) => {
            moduleUtil.loadModulesForCategory(
                `${category}Servers`,
                (module, nextModule) => {
                    const moduleInst = new module.getModule();
                    try {
                        async.series(
                            [
                                callback => {
                                    return moduleInst.createServer(callback);
                                },
                                callback => {
                                    listeningServers[module.moduleInfo.packageName] = {
                                        instance: moduleInst,
                                        info: module.moduleInfo,
                                    };

                                    if (!isFunction(moduleInst.beforeListen)) {
                                        return callback(null);
                                    }
                                    moduleInst.beforeListen(err => {
                                        return callback(err);
                                    });
                                },
                                callback => {
                                    return moduleInst.listen(callback);
                                },
                                callback => {
                                    if (!isFunction(moduleInst.afterListen)) {
                                        return callback(null);
                                    }
                                    moduleInst.afterListen(err => {
                                        return callback(err);
                                    });
                                },
                            ],
                            err => {
                                if (err) {
                                    delete listeningServers[
                                        module.moduleInfo.packageName
                                    ];
                                    return nextModule(err);
                                }

                                try {
                                    return nextModule(null);
                                } catch (propagatedErr) {
                                    //  A synchronous throw from downstream startup code
                                    //  propagated back through nextModule(null). nextModule
                                    //  was already called; don't call it again.
                                    logger.log.error(
                                        propagatedErr,
                                        'Error propagated from downstream startup'
                                    );
                                }
                            }
                        );
                    } catch (e) {
                        logger.log.error(e, 'Exception caught creating server!');
                        return nextModule(e);
                    }
                },
                err => {
                    return next(err);
                }
            );
        },
        err => {
            return cb(err);
        }
    );
}
