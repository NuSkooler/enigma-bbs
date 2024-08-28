const Config = require('./config').get;

// deps
const { get, isString } = require('lodash');

exports.getWebDomain = getWebDomain;
exports.getBaseUrl = getBaseUrl;
exports.getFullUrl = getFullUrl;
exports.buildUrl = buildUrl;

function getWebDomain() {
    const config = Config();
    const overridePrefix = get(config, 'contentServers.web.overrideUrlPrefix');
    if (isString(overridePrefix)) {
        const url = new URL(overridePrefix);
        return url.hostname;
    }

    return config.contentServers.web.domain;
}

function getBaseUrl() {
    const config = Config();
    const overridePrefix = get(config, 'contentServers.web.overrideUrlPrefix');
    if (overridePrefix) {
        return overridePrefix;
    }

    let schema;
    let port;
    if (config.contentServers.web.https.enabled) {
        schema = 'https://';
        port =
            443 === config.contentServers.web.https.port
                ? ''
                : `:${config.contentServers.web.https.port}`;
    } else {
        schema = 'http://';
        port =
            80 === config.contentServers.web.http.port
                ? ''
                : `:${config.contentServers.web.http.port}`;
    }

    return `${schema}${config.contentServers.web.domain}${port}`;
}

function getFullUrl(req) {
    const base = getBaseUrl();
    return new URL(`${base}${req.url}`);
}

function buildUrl(pathAndQuery) {
    //
    //  Create a URL such as
    //  https://l33t.codes:44512/ + |pathAndQuery|
    //
    //  Prefer HTTPS over HTTP. Be explicit about the port
    //  only if non-standard. Allow users to override full prefix in config.
    //
    const base = getBaseUrl();
    return `${base}${pathAndQuery}`;
}
