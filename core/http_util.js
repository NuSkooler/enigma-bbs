const { Errors } = require('./enig_error.js');

// deps
const { isString, isObject, truncate } = require('lodash');
const { https } = require('follow-redirects');
const httpSignature = require('http-signature');
const crypto = require('crypto');

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
    options = Object.assign({}, { timeout: DefaultTimeoutMilliseconds }, options);

    if (options.body) {
        options.headers['Content-Length'] = Buffer.from(options.body).length;

        if (options?.sign?.headers?.includes('digest')) {
            options.headers['Digest'] =
                'SHA-256=' +
                crypto.createHash('sha256').update(options.body).digest('base64');
        }
    }

    let cbCalled = false;
    const cbWrapper = (e, b, r) => {
        if (!cbCalled) {
            cbCalled = true;
            return cb(e, b, r);
        }
    };

    const req = https.request(url, options, res => {
        let body = [];
        res.on('data', d => {
            body.push(d);
        });

        res.on('end', () => {
            body = Buffer.concat(body).toString();

            if (res.statusCode < 200 || res.statusCode > 299) {
                return cbWrapper(
                    Errors.HttpError(
                        `URL ${url} HTTP error ${res.statusCode}: ${truncate(body, {
                            length: 128,
                        })}`
                    )
                );
            }

            return cbWrapper(null, body, res);
        });
    });

    if (isObject(options.sign)) {
        try {
            httpSignature.sign(req, options.sign);
        } catch (e) {
            req.destroy(Errors.Invalid(`Invalid signing material: ${e}`));
        }
    }

    req.on('error', err => {
        return cbWrapper(err);
    });

    req.on('timeout', () => {
        req.destroy(Errors.Timeout('Timeout making HTTP request'));
    });

    if (options.body) {
        req.write(options.body);
    }
    req.end();
}
