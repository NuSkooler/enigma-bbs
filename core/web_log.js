const Logger = require('./logger');
const Config = require('./config').get;

//  deps
const paths = require('path');
const bunyan = require('bunyan');
const { get } = require('lodash');

module.exports = class WebLog {
    static createWebLog() {
        const config = Config();
        const logPath = config.paths.logs;
        const rotatingFile = get(config, 'contentServers.web.logging.rotatingFile');

        rotatingFile.path = paths.join(logPath, rotatingFile.fileName);

        const serializers = Logger.standardSerializers();
        serializers.req = bunyan.stdSerializers.req;
        serializers.res = bunyan.stdSerializers.res;

        const webLog = bunyan.createLogger({
            name: 'ENiGMA½ BBS[Web]',
            streams: [rotatingFile],
            serializers,
        });

        return webLog;
    }
};
