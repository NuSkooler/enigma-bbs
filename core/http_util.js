const { Errors } = require('./enig_error.js');

// deps
const { isString, isObject, truncate, get, has } = require('lodash');
const https = require('https');
const httpSignature = require('http-signature');
const crypto = require('crypto');
const Config = require('./config.js').get;

const TimeoutConfigPath = 'outbound.connectionTimeoutMilliseconds';
const DefaultTimeoutMilliseconds = 5000;

exports.getJson = getJson;
exports.postJson = postJson;

function getJson(url, options, cb) {
    options = Object.assign({}, { method: 'GET' }, options);

    return _makeRequest(url, options, (err, body, res) => {
        if (err) {
            return cb(err);
        }

        if (Array.isArray(options.validContentTypes)) {
            const contentType = res.headers['content-type'] || '';
            if (
                !options.validContentTypes.some(ct => {
                    return contentType.startsWith(ct);
                })
            ) {
                return cb(Errors.HttpError(`Invalid Content-Type: ${contentType}`));
            }
        }

        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            return cb(e);
        }

        return cb(null, parsed, res);
    });
}

function postJson(url, json, options, cb) {
    if (!isString(json)) {
        json = JSON.stringify(json);
    }

    options = Object.assign({}, { method: 'POST', body: json }, options);
    if (
        !options.headers ||
        !Object.keys(options.headers).find(h => h.toLowerCase() === 'content-type')
    ) {
        options.headers['Content-Type'] = 'application/json';
    }

    return _makeRequest(url, options, cb);
}

function _makeRequest(url, options, cb) {
    let defaultTimeout = DefaultTimeoutMilliseconds;
    // Only set to config value if it has one, this allows us to set it
    // to zero, but still have a default if none is set
    if (has(Config(), TimeoutConfigPath)) {
        defaultTimeout = get(Config(), TimeoutConfigPath);
    }

    options = Object.assign({}, options, { timeout: defaultTimeout }); // Let options override default timeout if needed

    if (options.body) {
        options.headers['Content-Length'] = Buffer.from(options.body).length;

        if (options?.sign?.headers?.includes('digest')) {
            options.headers['Digest'] =
                'SHA-256=' +
                crypto.createHash('sha256').update(options.body).digest('base64');
        }
    }

    const req = https.request(url, options, res => {
        let body = [];
        res.on('data', d => {
            body.push(d);
        });

        res.on('end', () => {
            body = Buffer.concat(body).toString();

            if (res.statusCode < 200 || res.statusCode > 299) {
                return cb(
                    Errors.HttpError(
                        `URL ${url} HTTP error ${res.statusCode}: ${truncate(body, {
                            length: 128,
                        })}`
                    )
                );
            }

            return cb(null, body, res);
        });
    });

    if (isObject(options.sign)) {
        try {
            httpSignature.sign(req, options.sign);
        } catch (e) {
            req.destroy();
            return cb(Errors.Invalid(`Invalid signing material: ${e}`));
        }
    }

    req.on('error', err => {
        return cb(err);
    });

    req.on('timeout', () => {
        req.destroy();
        return cb(Errors.Timeout('Timeout making HTTP request'));
    });

    if (options.body) {
        req.write(options.body);
    }
    req.end();
}
