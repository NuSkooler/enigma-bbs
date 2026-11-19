'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

describe('REST request bodies', function () {
    let parseJsonBody;
    let respondBodyError;
    let parseMultipart;

    before(function () {
        ({ parseJsonBody, respondBodyError } = require('../core/rest/util.js'));
        parseMultipart = require('../core/rest/routes/files.js')._parseMultipartBuffer;
    });

    const feed = (chunks, cb, max) => {
        const req = new EventEmitter();
        req.destroy = () => {};
        parseJsonBody(req, cb, max);
        for (const c of chunks) {
            req.emit('data', c);
        }
        req.emit('end');
    };

    it('parses JSON whose multi-byte characters straddle chunks', function (done) {
        const bytes = Buffer.from(JSON.stringify({ message: 'naïve €' }));
        feed(
            [...bytes].map(b => Buffer.from([b])),
            (err, body) => {
                assert.ifError(err);
                assert.equal(body.message, 'naïve €');
                done();
            }
        );
    });

    it('reports invalid JSON', function (done) {
        feed([Buffer.from('{nope')], err => {
            assert.equal(err.message, 'Invalid JSON');
            done();
        });
    });

    it('calls back once for an over-cap body and maps to 413', function (done) {
        const calls = [];
        feed(
            [Buffer.alloc(10, 0x20), Buffer.alloc(10, 0x20)],
            err => calls.push(err),
            15
        );
        setImmediate(() => {
            assert.equal(calls.length, 1);
            let status;
            const resp = {
                writeHead(s) {
                    status = s;
                },
                end() {},
            };
            respondBodyError(resp, calls[0]);
            assert.equal(status, 413);
            done();
        });
    });

    it('does not call a throwing handler a second time', function () {
        let n = 0;
        const req = new EventEmitter();
        parseJsonBody(req, () => {
            n++;
            throw new Error('handler bug');
        });
        req.emit('data', Buffer.from('{}'));
        assert.throws(() => req.emit('end'), /handler bug/);
        assert.equal(n, 1);
    });

    it('refuses an upload declaring more than the cap without reading it', function (done) {
        const parseUpload = require('../core/rest/routes/files.js')._parseMultipartUpload;
        const req = new EventEmitter();
        req.headers = {
            'content-type': 'multipart/form-data; boundary=x',
            'content-length': String(1024 * 1024 * 1024),
        };
        parseUpload(req, {}, null, err => {
            assert.ok(err);
            assert.equal(err.code, 'ENTITY_TOO_LARGE');
            assert.equal(req.listenerCount('data'), 0, 'the body is not read');
            done();
        });
    });

    describe('closeIfBodyUnread()', function () {
        function fakeResp() {
            const resp = new EventEmitter();
            resp.headersSent = false;
            resp.headers = {};
            resp.setHeader = (k, v) => (resp.headers[k.toLowerCase()] = v);
            resp.writableFinished = false;
            return resp;
        }

        it('closes after the response when a declared body was never read', function () {
            const { closeIfBodyUnread } = require('../core/rest/auth.js');
            let closed = false;
            const req = {
                complete: false,
                headers: { 'content-length': String(600 * 1024 * 1024) },
                socket: { destroyed: false, destroySoon: () => (closed = true) },
            };
            const resp = fakeResp();
            resp.req = req;
            closeIfBodyUnread(req, resp);
            assert.equal(resp.headers.connection, 'close');
            assert.equal(closed, false);
            resp.emit('finish');
            assert.equal(closed, true);
        });

        it('leaves a request without a body, or one already read, alone', function () {
            const { closeIfBodyUnread } = require('../core/rest/auth.js');
            for (const req of [
                { complete: false, headers: {} },
                { complete: true, headers: { 'content-length': '10' } },
            ]) {
                const resp = fakeResp();
                closeIfBodyUnread(req, resp);
                assert.equal(resp.headers.connection, undefined);
            }
        });
    });

    describe('multipart parsing', function () {
        const boundary = '--XyZ';
        const build = parts => {
            const bufs = [];
            for (const p of parts) {
                bufs.push(Buffer.from(`${boundary}\r\n${p.headers}\r\n\r\n`));
                bufs.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
                bufs.push(Buffer.from('\r\n'));
            }
            bufs.push(Buffer.from(`${boundary}--\r\n`));
            return Buffer.concat(bufs);
        };

        it('extracts a binary file part and a desc field', function () {
            const content = Buffer.from([0, 1, 2, 255, 13, 10, 45, 45, 200]);
            const buf = build([
                {
                    headers: 'Content-Disposition: form-data; name="desc"',
                    body: ' café file ',
                },
                {
                    headers:
                        'Content-Disposition: form-data; name="file"; filename="../a b.zip"\r\nContent-Type: application/zip',
                    body: content,
                },
            ]);
            const r = parseMultipart(buf, boundary);
            assert.equal(r.fileName, 'a_b.zip');
            assert.deepEqual(r.fileBuffer, content);
            assert.equal(r.desc, 'café file');
        });

        it('returns no file for a body without one', function () {
            const r = parseMultipart(
                build([
                    { headers: 'Content-Disposition: form-data; name="x"', body: 'y' },
                ]),
                boundary
            );
            assert.equal(r.fileBuffer, null);
        });

        it('tolerates a truncated body', function () {
            const r = parseMultipart(
                Buffer.from(`${boundary}\r\nContent-Disp`),
                boundary
            );
            assert.equal(r.fileBuffer, null);
        });

        //  #291 security review: the name becomes a temp file and a stored file
        it('makes an upload name safe on Windows too', function () {
            const safe = require('../core/rest/routes/files.js')._safeUploadFileName;
            assert.equal(safe('NUL'), '_NUL');
            assert.equal(safe('con.txt'), '_con.txt');
            assert.equal(safe('COM1.zip'), '_COM1.zip');
            assert.equal(safe('lpt1'), '_lpt1');
            assert.equal(safe('CONSOLE.TXT'), 'CONSOLE.TXT');
            assert.equal(safe('evil.exe.'), 'evil.exe');
            assert.equal(safe('evil.exe::$DATA'), 'evil.exe___DATA');
            assert.equal(safe('..'), '');
            assert.equal(safe('...'), '');
            assert.equal(safe('../../etc/passwd'), 'passwd');
            assert.equal(safe('a b|c.zip'), 'a_b_c.zip');
        });
    });
});
