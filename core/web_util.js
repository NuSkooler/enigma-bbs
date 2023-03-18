const Config = require('./config').get;

// deps
const { get, isString } = require('lodash');

exports.getWebDomain = getWebDomain;

function getWebDomain() {
    const config = Config();
    const overridePrefix = get(config, 'contentServers.web.overrideUrlPrefix');
    if (isString(overridePrefix)) {
        const url = new URL(overridePrefix);
        return url.hostname;
    }

    return config.contentServers.web.domain;
}
