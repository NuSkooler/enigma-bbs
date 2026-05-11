'use strict';

const { strict: assert } = require('assert');

const {
    encodeCursor,
    decodeCursor,
    paginationMeta,
} = require('../core/rest/util.js');

describe('rest_util', function () {

    describe('encodeCursor() / decodeCursor()', function () {
        it('round-trips a messageId cursor', function () {
            const payload = { messageId: 42 };
            const cursor = encodeCursor(payload);
            assert.ok(typeof cursor === 'string');
            assert.ok(cursor.length > 0);
            const decoded = decodeCursor(cursor);
            assert.deepEqual(decoded, payload);
        });

        it('round-trips a fileId cursor', function () {
            const payload = { fileId: 999 };
            const decoded = decodeCursor(encodeCursor(payload));
            assert.deepEqual(decoded, payload);
        });

        it('uses URL-safe base64 (no + or /)', function () {
            // Encode many payloads to exercise the character space
            for (let i = 0; i < 50; i++) {
                const c = encodeCursor({ messageId: i * 1000 });
                assert.ok(!c.includes('+'), 'cursor must not contain +');
                assert.ok(!c.includes('/'), 'cursor must not contain /');
            }
        });

        it('decodeCursor returns null for garbage input', function () {
            assert.equal(decodeCursor('not-a-cursor'), null);
            assert.equal(decodeCursor(''), null);
            assert.equal(decodeCursor(null), null);
            assert.equal(decodeCursor(undefined), null);
        });

        it('decodeCursor returns null for valid base64 but invalid JSON', function () {
            const bad = Buffer.from('not json').toString('base64url');
            assert.equal(decodeCursor(bad), null);
        });
    });

    describe('paginationMeta()', function () {
        it('returns data and meta with count', function () {
            const data = [1, 2, 3];
            const result = paginationMeta(data, null);
            assert.deepEqual(result.data, data);
            assert.equal(result.meta.count, 3);
            assert.equal(result.meta.nextCursor, null);
        });

        it('includes nextCursor when provided', function () {
            const cursor = encodeCursor({ messageId: 10 });
            const result = paginationMeta([], cursor);
            assert.equal(result.meta.nextCursor, cursor);
        });

        it('handles empty data', function () {
            const result = paginationMeta([], null);
            assert.equal(result.meta.count, 0);
            assert.deepEqual(result.data, []);
        });
    });
});
