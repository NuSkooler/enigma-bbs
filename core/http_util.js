const { Errors } = require('./enig_error.js');

// deps
const { isString, isObject, truncate } = require('lodash');
const https = require('https');
const httpSignature = require('http-signature');
const crypto = require('crypto');

exports.getJson = getJson;
exports.postJson = postJson;

function getJson(url, options, cb) {
    const defaultOptions = {
        method: 'GET',
    };

    options = Object.assign({}, defaultOptions, options);

    //  :TODO: signing -- DRY this.

    _makeRequest(url, options, (err, body, res) => {
        if (err) {
            return cb(err);
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

    //  :TODO: DRY this method with _makeRequest()

    const defaultOptions = {
        method: 'POST',
        body: json,
        headers: {
            'Content-Type': 'application/json',
        },
    };

    options = Object.assign({}, defaultOptions, options);

    if (options?.sign?.headers?.includes('digest')) {
        options.headers['Digest'] = `SHA-256=${crypto
            .createHash('sha256')
            .update(json)
            .digest('base64')}`;
    }

    options.headers['Content-Length'] = json.length;

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
                        `HTTP error ${res.statusCode}: ${truncate(body, { length: 128 })}`
                    ),
                    body,
                    res
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

    req.write(json);
    req.end();
}

function _makeRequest(url, options, cb) {
    if (options.body && options?.sign?.headers?.includes('digest')) {
        options.headers['Digest'] = `SHA-256=${crypto
            .createHash('sha256')
            .update(options.body)
            .digest('base64')}`;
    }

    const req = https.request(url, options, res => {
        let body = [];
        res.on('data', d => {
            body.push(d);
        });

        res.on('end', () => {
            body = Buffer.concat(body).toString();

            if (res.statusCode < 200 || res.statusCode > 299) {
                return cb(Errors.HttpError(`HTTP error ${res.statusCode}: ${body}`));
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

    req.end();
}
