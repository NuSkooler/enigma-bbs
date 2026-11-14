'use strict';

const Config = require('../config').get;
const { readTextBody, isTooLarge, closeAfterResponse } = require('../http_body');

exports.jsonResponse = jsonResponse;
exports.problemDetail = problemDetail;
exports.encodeCursor = encodeCursor;
exports.decodeCursor = decodeCursor;
exports.paginationMeta = paginationMeta;
exports.applyCorsHeaders = applyCorsHeaders;
exports.parseJsonBody = parseJsonBody;
exports.API_BASE = '/_enig/api/v1';

function jsonResponse(resp, status, body) {
    const json = JSON.stringify(body);
    resp.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
    });
    return resp.end(json);
}

function problemDetail(resp, status, title, detail, type) {
    const typeUri = type || `${exports.API_BASE}/errors/${status}`;
    return jsonResponse(resp, status, {
        type: typeUri,
        title,
        status,
        detail: detail || title,
    });
}

function encodeCursor(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeCursor(str) {
    try {
        return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function paginationMeta(data, nextCursor) {
    return {
        data,
        meta: {
            count: data.length,
            nextCursor: nextCursor || null,
        },
    };
}

function applyCorsHeaders(req, resp) {
    const config = Config();
    const allowed = config.contentServers?.web?.restApi?.corsAllowedOrigins || [];
    if (!allowed.length) {
        return;
    }

    const origin = req.headers['origin'];
    if (!origin) {
        return;
    }

    if (allowed.includes('*')) {
        resp.setHeader('Access-Control-Allow-Origin', '*');
    } else if (allowed.includes(origin)) {
        resp.setHeader('Access-Control-Allow-Origin', origin);
        resp.setHeader('Vary', 'Origin');
    }

    resp.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    resp.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-ENiGMA-API-Key'
    );
}

const MAX_JSON_BODY = 1024 * 256; // 256 KiB

//  cb(err, body). err.code === 'ENTITY_TOO_LARGE' when over the cap (respond 413).
function parseJsonBody(req, cb, maxBytes = MAX_JSON_BODY) {
    readTextBody(req, maxBytes, (err, text) => {
        if (err) {
            return cb(err);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            return cb(new Error('Invalid JSON'));
        }
        //  outside the try: a throwing handler must not be called a second time
        return cb(null, parsed);
    });
}

//  Respond to a parseJsonBody() error: 413 when over the cap, otherwise 400.
function respondBodyError(resp, err, detail) {
    if (isTooLarge(err)) {
        closeAfterResponse(resp);
        return problemDetail(resp, 413, 'Payload Too Large', err.message);
    }
    return problemDetail(resp, 400, 'Bad Request', detail || err.message);
}
exports.respondBodyError = respondBodyError;
