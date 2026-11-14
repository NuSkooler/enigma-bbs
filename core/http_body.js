'use strict';

const { AsyncResource } = require('async_hooks');

exports.readBody = readBody;
exports.readTextBody = readTextBody;
exports.isTooLarge = isTooLarge;
exports.ErrorCodes = { TooLarge: 'ENTITY_TOO_LARGE', Aborted: 'ECONNABORTED' };

//
//  Shared, bounded HTTP request body reader.
//
//  readBody(req, maxBytes, cb)
//      req      - IncomingMessage (or any EventEmitter emitting data/end/error/close)
//      maxBytes - most bytes accepted; the connection is closed (after the
//                 caller has had a chance to respond) once exceeded
//      cb       - cb(err, Buffer). Called exactly once, in the caller's async context.
//                 err.code === 'ENTITY_TOO_LARGE' when over the cap (respond 413);
//                 err.code === 'ECONNABORTED' if the client went away before the end.
//
//  readTextBody(req, maxBytes, cb) is the same but yields a UTF-8 string, decoded
//  once from the whole body (so multi-byte characters split across chunks survive).
//
function readBody(req, maxBytes, cb) {
    cb = AsyncResource.bind(cb);
    const chunks = [];
    let total = 0;
    let done = false;

    const finish = (err, result) => {
        if (done) {
            return;
        }
        done = true;
        return cb(err, result);
    };

    req.on('data', chunk => {
        if (done) {
            return;
        }
        //  a stream with setEncoding() applied hands us strings
        if (typeof chunk === 'string') {
            chunk = Buffer.from(chunk);
        }
        total += chunk.length;
        if (total > maxBytes) {
            const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
            err.code = exports.ErrorCodes.TooLarge;
            //  Report first so the caller can write its 413; then close the
            //  connection once that response has been flushed.
            finish(err);
            setImmediate(() => {
                if (req.socket && typeof req.socket.destroySoon === 'function') {
                    req.socket.destroySoon();
                } else if (typeof req.destroy === 'function') {
                    req.destroy();
                }
            });
            return;
        }
        chunks.push(chunk);
    });

    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', err => finish(err));
    req.on('close', () => {
        const err = new Error('Request closed before body was complete');
        err.code = exports.ErrorCodes.Aborted;
        finish(err);
    });
}

function readTextBody(req, maxBytes, cb) {
    readBody(req, maxBytes, (err, buf) => {
        if (err) {
            return cb(err);
        }
        return cb(null, buf.toString('utf8'));
    });
}

function isTooLarge(err) {
    return !!err && err.code === exports.ErrorCodes.TooLarge;
}
