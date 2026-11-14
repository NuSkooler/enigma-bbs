'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const { readBody, readTextBody } = require('../core/http_body.js');

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

        it('reports ENTITY_TOO_LARGE once, then closes the connection', function (done) {
            const req = fakeReq();
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
                assert.equal(req.destroyed, true);
                assert.equal(calls.length, 1);
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
});
