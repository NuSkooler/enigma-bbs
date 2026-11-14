'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const http = require('http');

const { readBody, readTextBody, closeAfterResponse } = require('../core/http_body.js');

function fakeReq() {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => {
        req.destroyed = true;
        req.emit('close');
    };
    return req;
}

describe('http_body', function () {
    describe('readBody()', function () {
        it('concatenates chunks into one Buffer', function (done) {
            const req = fakeReq();
            readBody(req, 100, (err, buf) => {
                assert.ifError(err);
                assert.equal(buf.toString(), 'hello world');
                done();
            });
            req.emit('data', Buffer.from('hello '));
            req.emit('data', Buffer.from('world'));
            req.emit('end');
        });

        it('reports ENTITY_TOO_LARGE once and stops reading', function (done) {
            const req = fakeReq();
            let paused = false;
            req.pause = () => (paused = true);
            const calls = [];
            readBody(req, 8, (err, buf) => {
                calls.push({ err, buf });
            });
            req.emit('data', Buffer.alloc(6));
            req.emit('data', Buffer.alloc(6));
            req.emit('data', Buffer.alloc(6)); //  ignored
            req.emit('end');
            req.emit('error', new Error('late'));
            setImmediate(() => {
                assert.equal(calls.length, 1);
                assert.equal(calls[0].err.code, 'ENTITY_TOO_LARGE');
                assert.equal(paused, true);
                //  closing is left to the response (closeAfterResponse())
                assert.equal(req.destroyed, false);
                done();
            });
        });

        it('accepts a body exactly at the limit', function (done) {
            const req = fakeReq();
            readBody(req, 4, (err, buf) => {
                assert.ifError(err);
                assert.equal(buf.length, 4);
                done();
            });
            req.emit('data', Buffer.alloc(4));
            req.emit('end');
        });

        it('calls back once when the client goes away mid-body', function () {
            const req = fakeReq();
            const calls = [];
            readBody(req, 100, (err, buf) => calls.push({ err, buf }));
            req.emit('data', Buffer.from('par'));
            req.emit('close');
            req.emit('end');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].err.code, 'ECONNABORTED');
        });

        it('passes request errors through once', function () {
            const req = fakeReq();
            const calls = [];
            readBody(req, 100, err => calls.push(err));
            req.emit('error', new Error('boom'));
            req.emit('close');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].message, 'boom');
        });

        it('does not report an abort after a normal end', function () {
            const req = fakeReq();
            const calls = [];
            readBody(req, 100, err => calls.push(err));
            req.emit('end');
            req.emit('close');
            assert.equal(calls.length, 1);
            assert.equal(calls[0], null);
        });
    });

    describe('readTextBody()', function () {
        it('round-trips multi-byte UTF-8 split across chunks', function (done) {
            const text = 'café € 😀 テスト';
            const bytes = Buffer.from(text, 'utf8');
            const req = fakeReq();
            readTextBody(req, 1000, (err, out) => {
                assert.ifError(err);
                assert.equal(out, text);
                done();
            });
            //  one byte per chunk splits every multi-byte sequence
            for (const b of bytes) {
                req.emit('data', Buffer.from([b]));
            }
            req.emit('end');
        });
    });

    describe('closeAfterResponse()', function () {
        //  A server whose 413 is written only after a delay, as one read from
        //  disk would be, then the connection closed once it has gone out.
        function startServer(delayMs, cb) {
            const server = http.createServer((req, resp) => {
                readBody(req, 1024, err => {
                    if (!err) {
                        resp.writeHead(200);
                        return resp.end('ok');
                    }
                    closeAfterResponse(resp);
                    setTimeout(() => {
                        resp.writeHead(413, { 'Content-Type': 'text/plain' });
                        resp.end('too large');
                    }, delayMs);
                });
            });
            server.listen(0, '127.0.0.1', () => cb(server));
        }

        function post(port, bytes, cb) {
            const req = http.request(
                { host: '127.0.0.1', port, method: 'POST', path: '/' },
                resp => {
                    let body = '';
                    resp.on('data', c => (body += c));
                    resp.on('end', () => cb(null, resp, body));
                }
            );
            req.on('error', err => cb(err));
            req.end(Buffer.alloc(bytes, 0x61));
        }

        it('delivers a 413 written after a delay, then closes the connection', function (done) {
            startServer(30, server => {
                post(server.address().port, 64 * 1024, (err, resp, body) => {
                    server.close();
                    assert.ifError(err);
                    assert.equal(resp.statusCode, 413);
                    assert.equal(body, 'too large');
                    assert.equal(resp.headers.connection, 'close');
                    done();
                });
            });
        });

        it('leaves an ordinary request alone', function (done) {
            startServer(0, server => {
                post(server.address().port, 10, (err, resp, body) => {
                    server.close();
                    assert.ifError(err);
                    assert.equal(resp.statusCode, 200);
                    assert.equal(body, 'ok');
                    done();
                });
            });
        });

        it('closes at once when the response has already been sent', function () {
            let destroyed = false;
            closeAfterResponse({
                headersSent: true,
                writableFinished: true,
                req: {
                    socket: { destroyed: false, destroySoon: () => (destroyed = true) },
                },
            });
            assert.ok(destroyed);
        });
    });
});
