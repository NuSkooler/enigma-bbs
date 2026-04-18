'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const crypto = require('crypto');

//
//  Config mock — mutable so individual tests can flip the AP enabled flag
//  without reloading modules.  collection.js captures `Config = require('./config').get`
//  at load time; because we set configModule.get = () => TEST_CONFIG (the same
//  object reference), Config() always sees whatever TEST_CONFIG currently contains.
//
const configModule = require('../core/config.js');
const mutableApConfig = {
    enabled: true,
    sharedInbox: { maxAgeDays: 90, maxCount: 10000 },
};
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
    contentServers: {
        web: {
            domain: 'test.example.com',
            https: { enabled: true, port: 443 },
            handlers: {
                activityPub: mutableApConfig,
            },
        },
    },
};
configModule.get = () => TEST_CONFIG;

//
//  Logger stub
//
const LogModule = require('../core/logger.js');
LogModule.log = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
};

//
//  In-memory activitypub DB — injected before requiring collection.js
//
const dbModule = require('../core/database.js');
const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

//  Force a fresh load so collection.js captures our config mock
delete require.cache[require.resolve('../core/web_util.js')];
delete require.cache[require.resolve('../core/activitypub/endpoint.js')];
delete require.cache[require.resolve('../core/activitypub/object.js')];
delete require.cache[require.resolve('../core/activitypub/collection.js')];
const Collection = require('../core/activitypub/collection.js');

const {
    validateRequestDate,
    verifyDigestHeader,
    normalizeHttpSigHeader,
    actorIdFromKeyId,
    hostsMatch,
    verifyObjectOwner,
    MaxRequestAgeSecs,
} = require('../core/activitypub/security.js');

// ─── schema ───────────────────────────────────────────────────────────────────

before(() => {
    _apDb.exec(`
        CREATE TABLE IF NOT EXISTS collection (
            collection_id       VARCHAR NOT NULL,
            name                VARCHAR NOT NULL,
            timestamp           DATETIME NOT NULL,
            owner_actor_id      VARCHAR NOT NULL,
            object_id           VARCHAR NOT NULL,
            object_json         VARCHAR NOT NULL,
            is_private          INTEGER NOT NULL,
            UNIQUE(name, collection_id, object_id)
        );
        CREATE TABLE IF NOT EXISTS collection_object_meta (
            collection_id   VARCHAR NOT NULL,
            name            VARCHAR NOT NULL,
            object_id       VARCHAR NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL,
            UNIQUE(collection_id, object_id, meta_name),
            FOREIGN KEY(name, collection_id, object_id)
                REFERENCES collection(name, collection_id, object_id)
                ON DELETE CASCADE
        );
    `);

    //  Ensure the AP enabled flag is reset to true before each test
    mutableApConfig.enabled = true;
    mutableApConfig.sharedInbox = { maxAgeDays: 90, maxCount: 10000 };
});

beforeEach(() => {
    _apDb.exec('DELETE FROM collection_object_meta; DELETE FROM collection;');
    mutableApConfig.enabled = true;
    mutableApConfig.sharedInbox = { maxAgeDays: 90, maxCount: 10000 };
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const PUBLIC_COLL_ID = 'https://www.w3.org/ns/activitystreams#Public';

function seedSharedInboxItem(id, timestampExpr = "datetime('now')") {
    const obj = {
        id,
        type: 'Create',
        actor: 'https://remote.example.com/users/alice',
        object: {},
    };
    _apDb
        .prepare(
            `INSERT OR IGNORE INTO collection
                (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
             VALUES (?, 'sharedInbox', ${timestampExpr}, ?, ?, ?, 0)`
        )
        .run(PUBLIC_COLL_ID, PUBLIC_COLL_ID, id, JSON.stringify(obj));
}

function sharedInboxCount() {
    return _apDb
        .prepare("SELECT COUNT(*) AS n FROM collection WHERE name = 'sharedInbox'")
        .get().n;
}

// ─── sharedInboxMaintenanceTask — feature flag gating ────────────────────────

describe('Collection.sharedInboxMaintenanceTask() — feature flag', function () {
    it('bails immediately and leaves data intact when AP is disabled', done => {
        seedSharedInboxItem('https://remote.example.com/activities/1');
        seedSharedInboxItem('https://remote.example.com/activities/2');
        assert.equal(sharedInboxCount(), 2, 'precondition: 2 items seeded');

        mutableApConfig.enabled = false;

        Collection.sharedInboxMaintenanceTask([], err => {
            assert.ifError(err);
            assert.equal(
                sharedInboxCount(),
                2,
                'items should be untouched when AP is disabled'
            );
            done();
        });
    });

    it('runs cleanup when AP is enabled — count limit enforced', done => {
        //  Seed 5 items; cap at 2 — 3 should be removed
        for (let i = 1; i <= 5; i++) {
            seedSharedInboxItem(`https://remote.example.com/activities/${i}`);
        }
        assert.equal(sharedInboxCount(), 5, 'precondition: 5 items seeded');

        mutableApConfig.enabled = true;
        mutableApConfig.sharedInbox = { maxAgeDays: 9999, maxCount: 2 };

        Collection.sharedInboxMaintenanceTask([], err => {
            assert.ifError(err);
            assert.equal(
                sharedInboxCount(),
                2,
                'should keep only 2 items after count-trim'
            );
            done();
        });
    });

    it('runs cleanup when AP is enabled — age limit enforced', done => {
        //  Seed 1 old item (31 days ago) and 1 fresh item; maxAgeDays: 30
        seedSharedInboxItem(
            'https://remote.example.com/activities/old',
            "datetime('now', '-31 days')"
        );
        seedSharedInboxItem('https://remote.example.com/activities/fresh');
        assert.equal(sharedInboxCount(), 2, 'precondition: 2 items seeded');

        mutableApConfig.enabled = true;
        mutableApConfig.sharedInbox = { maxAgeDays: 30, maxCount: 99999 };

        Collection.sharedInboxMaintenanceTask([], err => {
            assert.ifError(err);
            assert.equal(
                sharedInboxCount(),
                1,
                'old item should be removed; fresh item kept'
            );
            done();
        });
    });
});

// ─── validateRequestDate ──────────────────────────────────────────────────────

describe('validateRequestDate()', function () {
    it('returns null (valid) for a Date within the allowed window', () => {
        const headers = { date: new Date().toUTCString() };
        assert.equal(validateRequestDate(headers), null);
    });

    it('returns null (valid) for a Date slightly in the past (within window)', () => {
        const past = new Date(Date.now() - 60 * 1000); // 60 s ago
        const headers = { date: past.toUTCString() };
        assert.equal(validateRequestDate(headers), null);
    });

    it('returns null (valid) for a Date slightly in the future (within window)', () => {
        const future = new Date(Date.now() + 60 * 1000); // 60 s ahead
        const headers = { date: future.toUTCString() };
        assert.equal(validateRequestDate(headers), null);
    });

    it('returns a reason string when the Date header is missing', () => {
        const reason = validateRequestDate({});
        assert.ok(typeof reason === 'string', 'should return a reason string');
        assert.ok(reason.toLowerCase().includes('missing'), `reason: "${reason}"`);
    });

    it('returns a reason string for an unparseable Date header', () => {
        const headers = { date: 'not-a-date' };
        const reason = validateRequestDate(headers);
        assert.ok(typeof reason === 'string');
        assert.ok(reason.toLowerCase().includes('unparseable'), `reason: "${reason}"`);
    });

    it('returns a reason string for a Date too far in the past (replay attack)', () => {
        const stale = new Date(Date.now() - (MaxRequestAgeSecs + 60) * 1000);
        const headers = { date: stale.toUTCString() };
        const reason = validateRequestDate(headers);
        assert.ok(typeof reason === 'string', 'stale date should be rejected');
        assert.ok(reason.includes('exceeds'), `reason: "${reason}"`);
    });

    it('returns a reason string for a Date too far in the future', () => {
        const future = new Date(Date.now() + (MaxRequestAgeSecs + 60) * 1000);
        const headers = { date: future.toUTCString() };
        const reason = validateRequestDate(headers);
        assert.ok(typeof reason === 'string', 'far-future date should be rejected');
        assert.ok(reason.includes('exceeds'), `reason: "${reason}"`);
    });

    it('respects a custom maxAgeSecs argument', () => {
        //  10 s ago should be valid with a 60 s window but invalid with a 5 s window
        const headers = { date: new Date(Date.now() - 10 * 1000).toUTCString() };
        assert.equal(
            validateRequestDate(headers, 60),
            null,
            'should be valid within 60 s window'
        );
        assert.ok(
            validateRequestDate(headers, 5),
            'should be invalid outside 5 s window'
        );
    });
});

// ─── verifyDigestHeader ───────────────────────────────────────────────────────

describe('verifyDigestHeader()', function () {
    const BODY = Buffer.from(
        '{"type":"Create","actor":"https://example.com/users/alice"}'
    );
    const CORRECT_DIGEST =
        'SHA-256=' + crypto.createHash('sha256').update(BODY).digest('base64');

    it('returns true when no Digest header is present', () => {
        assert.ok(verifyDigestHeader(null, BODY));
        assert.ok(verifyDigestHeader(undefined, BODY));
        assert.ok(verifyDigestHeader('', BODY));
    });

    it('returns true when the SHA-256 digest matches the body', () => {
        assert.ok(verifyDigestHeader(CORRECT_DIGEST, BODY));
    });

    it('returns false when the SHA-256 digest does not match the body', () => {
        const tampered = Buffer.from(
            '{"type":"Create","actor":"https://evil.example.com/users/mallory"}'
        );
        assert.equal(verifyDigestHeader(CORRECT_DIGEST, tampered), false);
    });

    it('returns false when the digest value is corrupted (wrong base64)', () => {
        const bad = 'SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
        assert.equal(verifyDigestHeader(bad, BODY), false);
    });

    it('returns true for an unrecognized algorithm (skip — no SHA-256 prefix)', () => {
        const md5 = 'MD5=rL0Y20zC+Fzt72VPzMSk2A==';
        assert.ok(
            verifyDigestHeader(md5, BODY),
            'non-SHA-256 algorithms should be skipped'
        );
    });

    it('works with a string body as well as a Buffer', () => {
        const strBody = BODY.toString();
        assert.ok(verifyDigestHeader(CORRECT_DIGEST, strBody));
    });

    it('is sensitive to body content — even a single byte change fails', () => {
        const modified = Buffer.from(BODY);
        modified[0] = modified[0] ^ 0xff; // flip bits in first byte
        assert.equal(verifyDigestHeader(CORRECT_DIGEST, modified), false);
    });
});

// ─── normalizeHttpSigHeader ───────────────────────────────────────────────────

describe('normalizeHttpSigHeader()', function () {
    it('rewrites hs2019 to rsa-sha256', () => {
        const h =
            'keyId="https://example.com/users/alice#main-key",algorithm="hs2019",headers="date",signature="abc"';
        assert.ok(normalizeHttpSigHeader(h).includes('algorithm="rsa-sha256"'));
        assert.ok(!normalizeHttpSigHeader(h).includes('hs2019'));
    });

    it('leaves rsa-sha256 unchanged', () => {
        const h =
            'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="date",signature="abc"';
        assert.equal(normalizeHttpSigHeader(h), h);
    });

    it('handles headers with no algorithm field', () => {
        const h =
            'keyId="https://example.com/users/alice#main-key",headers="date",signature="abc"';
        assert.equal(normalizeHttpSigHeader(h), h);
    });

    it('returns falsy input unchanged', () => {
        assert.equal(normalizeHttpSigHeader(null), null);
        assert.equal(normalizeHttpSigHeader(''), '');
    });
});

// ─── actorIdFromKeyId ─────────────────────────────────────────────────────────

describe('actorIdFromKeyId()', function () {
    it('strips fragment from Mastodon-style keyId', () => {
        assert.equal(
            actorIdFromKeyId('https://mastodon.social/users/alice#main-key'),
            'https://mastodon.social/users/alice'
        );
    });

    it('strips /main-key path segment from GoToSocial-style keyId', () => {
        assert.equal(
            actorIdFromKeyId('http://localhost:8181/users/bryan/main-key'),
            'http://localhost:8181/users/bryan'
        );
    });

    it('strips /publicKey path segment', () => {
        assert.equal(
            actorIdFromKeyId('https://example.com/users/alice/publicKey'),
            'https://example.com/users/alice'
        );
    });

    it('strips /keys/<id> path segment', () => {
        assert.equal(
            actorIdFromKeyId('https://example.com/users/alice/keys/1'),
            'https://example.com/users/alice'
        );
    });

    it('returns the keyId unchanged when no known suffix is present', () => {
        assert.equal(
            actorIdFromKeyId('https://example.com/users/alice'),
            'https://example.com/users/alice'
        );
    });

    it('returns null for non-URL input', () => {
        assert.equal(actorIdFromKeyId('not-a-url'), null);
        assert.equal(actorIdFromKeyId(''), null);
        assert.equal(actorIdFromKeyId(null), null);
    });

    it('returns null for non-http(s) URLs', () => {
        assert.equal(actorIdFromKeyId('ftp://example.com/key'), null);
    });
});

// ─── hostsMatch ───────────────────────────────────────────────────────────────

describe('hostsMatch()', function () {
    it('returns true for identical hostnames', () => {
        assert.equal(
            hostsMatch('https://example.com/users/alice', 'https://example.com/users/alice#main-key'),
            true
        );
    });

    it('returns true when schemes differ but hostnames match', () => {
        assert.equal(
            hostsMatch('http://example.com/users/alice', 'https://example.com/keys/1'),
            true
        );
    });

    it('returns false for different hostnames', () => {
        assert.equal(
            hostsMatch('https://good.example/users/alice', 'https://evil.example/users/alice#main-key'),
            false
        );
    });

    it('returns false when either URL is unparseable', () => {
        assert.equal(hostsMatch('not-a-url', 'https://example.com/users/alice'), false);
        assert.equal(hostsMatch('https://example.com/users/alice', 'not-a-url'), false);
        assert.equal(hostsMatch(null, 'https://example.com/'), false);
        assert.equal(hostsMatch('https://example.com/', null), false);
    });

    it('returns false for two unparseable inputs', () => {
        assert.equal(hostsMatch('bad', 'also-bad'), false);
    });

    it('compares only hostname, not port', () => {
        //  Same hostname, different ports → true (port is not part of the match)
        assert.equal(
            hostsMatch('https://example.com:8080/users/alice', 'https://example.com:443/users/alice'),
            true
        );
    });
});

// ─── verifyObjectOwner ────────────────────────────────────────────────────────

describe('verifyObjectOwner()', function () {
    it('returns null (permit) when httpSigValidated is true', () => {
        assert.equal(verifyObjectOwner(true, false, 'Note'), null);
        assert.equal(verifyObjectOwner(true, false, 'Actor'), null);
        assert.equal(verifyObjectOwner(true, true, 'Note'), null);
    });

    it('returns a reason string when sig is not validated and domainVerifiedOnly is false', () => {
        const reason = verifyObjectOwner(false, false, 'Note');
        assert.ok(typeof reason === 'string' && reason.length > 0, `expected reason string, got: ${reason}`);
    });

    it('returns a reason string when sig is not validated and domainVerifiedOnly is false (Actor)', () => {
        const reason = verifyObjectOwner(false, false, 'Actor');
        assert.ok(typeof reason === 'string' && reason.length > 0);
    });

    it('returns null (permit) for Actor self-deletion with domainVerifiedOnly', () => {
        //  Actor deleted themselves; we verified domain binding; allow cache cleanup.
        assert.equal(verifyObjectOwner(false, true, 'Actor'), null);
    });

    it('returns a reason string for Note deletion with domainVerifiedOnly (Notes always need sig)', () => {
        const reason = verifyObjectOwner(false, true, 'Note');
        assert.ok(typeof reason === 'string' && reason.length > 0,
            'Note delete without valid sig must be refused even with domain binding');
    });

    it('returns a reason string for Article deletion with domainVerifiedOnly', () => {
        const reason = verifyObjectOwner(false, true, 'Article');
        assert.ok(typeof reason === 'string' && reason.length > 0);
    });

    it('returns a reason string when objectType is undefined/null with domainVerifiedOnly', () => {
        const reason = verifyObjectOwner(false, true, undefined);
        assert.ok(typeof reason === 'string' && reason.length > 0);
    });
});
