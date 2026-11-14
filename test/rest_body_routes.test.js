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

    it('refuses an upload declaring more than the cap, and closes the connection', function (done) {
        const parseUpload = require('../core/rest/routes/files.js')._parseMultipartUpload;
        const req = new EventEmitter();
        req.headers = {
            'content-type': 'multipart/form-data; boundary=x',
            'content-length': String(1024 * 1024 * 1024),
        };
        let closed = false;
        req.socket = { destroySoon: () => (closed = true) };
        let dataListeners = 0;
        const origOn = req.on.bind(req);
        req.on = (ev, fn) => {
            if ('data' === ev) {
                ++dataListeners;
            }
            return origOn(ev, fn);
        };
        parseUpload(req, {}, null, err => {
            assert.ok(err);
            assert.equal(err.code, 'ENTITY_TOO_LARGE');
            assert.equal(dataListeners, 0, 'the body is not read');
            assert.equal(closed, false, 'closed only after the 413 is written');
            setImmediate(() => {
                assert.equal(closed, true);
                done();
            });
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
    });
});
