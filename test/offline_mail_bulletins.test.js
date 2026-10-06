'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const iconv = require('iconv-lite');

const configModule = require('../core/config.js');
const {
    offlineMailBulletins,
    bulletinData,
    writeOfflineMailBulletins,
} = require('../core/offline_mail_bulletins.js');

describe('Offline mail bulletins', () => {
    describe('configuration', () => {
        let previousConfig;
        afterEach(() => configModule._popTestConfig(previousConfig));

        const withConfig = offlineMail => {
            previousConfig = configModule._pushTestConfig({
                messageNetworks: { offlineMail },
            });
        };

        it('names each file the way readers look for it, goodbye last', () => {
            withConfig({
                goodbye: '/b/bye.ans',
                hello: '/b/hello.ans',
                news: '/b/news.txt',
                bulletins: ['/b/one.ans', '/b/two.txt'],
            });
            assert.deepEqual(offlineMailBulletins(), [
                { name: 'HELLO', path: '/b/hello.ans' },
                { name: 'BBSNEWS', path: '/b/news.txt' },
                { name: 'BLT-0.1', path: '/b/one.ans' },
                { name: 'BLT-0.2', path: '/b/two.txt' },
                { name: 'GOODBYE', path: '/b/bye.ans' },
            ]);
        });

        it('packs nothing when the board configures none', () => {
            previousConfig = configModule._pushTestConfig({});
            assert.deepEqual(offlineMailBulletins(), []);
        });
    });

    describe('content', () => {
        it('converts UTF-8 text to CP437', () => {
            assert.deepEqual(
                bulletinData(Buffer.from('░▒▓ café', 'utf8')),
                iconv.encode('░▒▓ café', 'cp437')
            );
        });

        it('leaves out a UTF-8 byte order mark', () => {
            assert.equal(
                bulletinData(Buffer.from('\uFEFFNews', 'utf8')).toString(),
                'News'
            );
        });

        it('keeps a file that is already CP437', () => {
            const cp437 = Buffer.from([0xb0, 0xb1, 0xb2, 0x20, 0xdb]);
            assert.deepEqual(bulletinData(cp437), cp437);
        });

        it('ends lines with CRLF', () => {
            assert.equal(
                bulletinData(Buffer.from('a\nb\r\nc')).toString(),
                'a\r\nb\r\nc'
            );
        });

        it('cuts a SAUCE record off at the ^Z', () => {
            const data = Buffer.concat([
                Buffer.from('art'),
                Buffer.from([0x1a]),
                Buffer.from('SAUCE00'),
            ]);
            assert.equal(bulletinData(data).toString(), 'art');
        });
    });

    describe('writing', () => {
        let dir;
        beforeEach(() => {
            dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-bulletins-'));
        });
        afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

        it('writes what it can read and warns about the rest', done => {
            const source = paths.join(dir, 'hello.txt');
            fs.writeFileSync(source, 'Welcome\n');
            const out = fs.mkdtempSync(paths.join(dir, 'out-'));
            const warnings = [];

            writeOfflineMailBulletins(
                out,
                [
                    { name: 'HELLO', path: source },
                    { name: 'BBSNEWS', path: paths.join(dir, 'missing.txt') },
                ],
                warning => warnings.push(warning),
                (err, written) => {
                    assert.equal(err, null);
                    assert.deepEqual(written, ['HELLO']);
                    assert.equal(
                        fs.readFileSync(paths.join(out, 'HELLO')).toString(),
                        'Welcome\r\n'
                    );
                    assert.equal(warnings.length, 1);
                    done();
                }
            );
        });
    });
});
