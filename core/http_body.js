'use strict';

const { AsyncResource } = require('async_hooks');

exports.readBody = readBody;
exports.readTextBody = readTextBody;
exports.isTooLarge = isTooLarge;
exports.closeAfterResponse = closeAfterResponse;
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
            //  Stop reading, and report. The caller writes its 413 and closes
            //  the connection once that has gone out (closeAfterResponse());
            //  the timer closes it anyway should no response ever be written.
            if (typeof req.pause === 'function') {
                req.pause();
            }
            finish(err);
            setTimeout(() => destroyConnection(req), UnansweredCloseMs).unref();
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

//  How long a request refused for its size may wait for a response before
//  its connection is closed regardless
const UnansweredCloseMs = 30 * 1000;

function destroyConnection(req) {
    const socket = req.socket;
    if (socket && !socket.destroyed) {
        if (typeof socket.destroySoon === 'function') {
            return socket.destroySoon();
        }
        return socket.destroy();
    }
    if (!socket && typeof req.destroy === 'function' && !req.destroyed) {
        req.destroy();
    }
}

//
//  Close the connection |resp| answers once |resp| has been sent. For a
//  request refused before its body was read through (413): left open, the
//  server would go on reading and discarding the rest of the body. Waiting
//  for 'finish' rather than a timer matters: a responder may do I/O of its
//  own (an error page read from disk) before it writes anything.
//
function closeAfterResponse(resp) {
    if (!resp) {
        return;
    }
    if (!resp.headersSent && typeof resp.setHeader === 'function') {
        resp.setHeader('Connection', 'close');
    }
    const req = resp.req || { socket: resp.socket };
    const close = () => destroyConnection(req);
    if (resp.writableFinished) {
        return close();
    }
    if (typeof resp.once === 'function') {
        resp.once('finish', close);
        resp.once('close', close);
    }
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
