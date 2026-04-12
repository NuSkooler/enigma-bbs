'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock
//
const configModule = require('../core/config.js');
configModule.get = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
    contentServers: {
        web: {
            domain: 'test.example.com',
            https: { enabled: true, port: 443 },
        },
    },
});

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
//  In-memory AP DB
//
const dbModule = require('../core/database.js');
const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

//
//  Force fresh module loads so all AP modules see our stubs.
//
[
    '../core/web_util.js',
    '../core/activitypub/endpoint.js',
    '../core/activitypub/object.js',
    '../core/activitypub/activity.js',
    '../core/activitypub/collection.js',
    '../core/activitypub/actor.js',
    '../core/activitypub/follow_util.js',
].forEach(m => delete require.cache[require.resolve(m)]);

const ActivityPubObject = require('../core/activitypub/object.js');
const Actor = require('../core/activitypub/actor.js');
const Collection = require('../core/activitypub/collection.js');
const {
    sendFollowRequest,
    sendUnfollowRequest,
    acceptFollowRequest,
    rejectFollowRequest,
} = require('../core/activitypub/follow_util.js');

// ─── schema ───────────────────────────────────────────────────────────────────

before(() => {
    _apDb.exec(`
        CREATE TABLE IF NOT EXISTS collection (
            collection_id   VARCHAR NOT NULL,
            name            VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            owner_actor_id  VARCHAR NOT NULL,
            object_id       VARCHAR NOT NULL,
            object_json     VARCHAR NOT NULL,
            is_private      INTEGER NOT NULL,
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
});

beforeEach(() => {
    _apDb.exec('DELETE FROM collection_object_meta; DELETE FROM collection;');

    //  Stub sendTo: skip all HTTP signing/delivery; return 202 success.
    ActivityPubObject.prototype.sendTo = (inbox, user, cb) =>
        cb(null, '', { statusCode: 202 });

    //  Stub Actor.fromLocalUser: return a minimal local actor without touching User DB.
    Actor.fromLocalUser = (user, cb) =>
        cb(null, {
            id: LOCAL_ACTOR_ID,
            inbox: `${LOCAL_ACTOR_ID}/inbox`,
        });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const LOCAL_ACTOR_ID = 'https://test.example.com/ap/users/bob';
const REMOTE_ACTOR_ID = 'https://remote.example.com/users/alice';

//  Minimal local user stub — follow_util.js reads ActivityPubActorId property.
function makeLocalUser(actorId = LOCAL_ACTOR_ID) {
    return {
        username: 'bob',
        getProperty: prop => {
            if (prop === 'activitypub_actor_id') return actorId;
            if (prop === 'private_key_activitypub_sign_rsa_pem') return 'dummy-key';
            return null;
        },
    };
}

//  Minimal remote actor stub.
function makeRemoteActor(id = REMOTE_ACTOR_ID) {
    return {
        id,
        inbox: `${id}/inbox`,
        preferredUsername: 'alice',
        type: 'Person',
    };
}

//  Count rows in a named collection for a given owner_actor_id.
function collectionCount(name, ownerActorId) {
    return _apDb
        .prepare(
            'SELECT COUNT(*) AS n FROM collection WHERE name = ? AND owner_actor_id = ?'
        )
        .get(name, ownerActorId).n;
}

function p(fn, ...args) {
    return new Promise((resolve, reject) =>
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    );
}

// ─── sendFollowRequest ────────────────────────────────────────────────────────

describe('sendFollowRequest()', function () {
    it('adds the remote actor to the local Following collection', async () => {
        const user = makeLocalUser();
        const remoteActor = makeRemoteActor();
        await p(sendFollowRequest, user, remoteActor);

        assert.equal(collectionCount('following', LOCAL_ACTOR_ID), 1);
    });

    it('calls sendTo (delivers the Follow activity to the remote inbox)', async () => {
        let deliveredTo = null;
        ActivityPubObject.prototype.sendTo = (inbox, user, cb) => {
            deliveredTo = inbox;
            cb(null, '', { statusCode: 202 });
        };

        const user = makeLocalUser();
        const remoteActor = makeRemoteActor();
        await p(sendFollowRequest, user, remoteActor);

        assert.equal(deliveredTo, remoteActor.inbox, 'Follow delivered to remote inbox');
    });

    it('errors when local user is missing ActivityPubActorId', done => {
        const user = { username: 'broken', getProperty: () => null };
        sendFollowRequest(user, makeRemoteActor(), err => {
            assert.ok(err, 'should error');
            done();
        });
    });
});

// ─── sendUnfollowRequest ──────────────────────────────────────────────────────

describe('sendUnfollowRequest()', function () {
    async function setupFollowing(user, remoteActor) {
        await p(sendFollowRequest, user, remoteActor);
    }

    it('removes the actor from the Following collection', async () => {
        const user = makeLocalUser();
        const remoteActor = makeRemoteActor();
        await setupFollowing(user, remoteActor);
        assert.equal(collectionCount('following', LOCAL_ACTOR_ID), 1);

        await p(sendUnfollowRequest, user, remoteActor);
        assert.equal(collectionCount('following', LOCAL_ACTOR_ID), 0);
    });

    it('delivers an Undo activity to the remote inbox', async () => {
        let deliveredType = null;
        //  First call is Follow from setup; second call is Undo from unfollow.
        let callCount = 0;
        ActivityPubObject.prototype.sendTo = function (inbox, user, cb) {
            callCount++;
            if (callCount === 2) {
                deliveredType = this.type;
            }
            cb(null, '', { statusCode: 202 });
        };

        const user = makeLocalUser();
        const remoteActor = makeRemoteActor();
        await p(sendFollowRequest, user, remoteActor);
        await p(sendUnfollowRequest, user, remoteActor);

        assert.equal(deliveredType, 'Undo', 'Undo activity should be delivered');
    });

    it('errors when local user is missing ActivityPubActorId', done => {
        const user = { username: 'broken', getProperty: () => null };
        sendUnfollowRequest(user, makeRemoteActor(), err => {
            assert.ok(err, 'should error');
            done();
        });
    });
});

// ─── acceptFollowRequest ──────────────────────────────────────────────────────

describe('acceptFollowRequest()', function () {
    function makeFollowRequest() {
        return {
            id: 'https://remote.example.com/activities/follow-1',
            type: 'Follow',
            actor: REMOTE_ACTOR_ID,
            object: LOCAL_ACTOR_ID,
        };
    }

    it('adds the remote actor to the local Followers collection', async () => {
        const user = makeLocalUser();
        const remoteActor = makeRemoteActor();
        const request = makeFollowRequest();

        await p(acceptFollowRequest, user, remoteActor, request);
        assert.equal(collectionCount('followers', LOCAL_ACTOR_ID), 1);
    });

    it('delivers an Accept activity to the remote inbox', async () => {
        let deliveredType = null;
        ActivityPubObject.prototype.sendTo = function (inbox, user, cb) {
            deliveredType = this.type;
            cb(null, '', { statusCode: 202 });
        };

        const user = makeLocalUser();
        await p(acceptFollowRequest, user, makeRemoteActor(), makeFollowRequest());
        assert.equal(deliveredType, 'Accept');
    });

    it('removes the follow request from FollowRequests collection after accepting', async () => {
        const user = makeLocalUser();
        const remoteActor = makeRemoteActor();
        const request = makeFollowRequest();

        //  Pre-seed a follow request entry
        await p(Collection.addFollowRequest.bind(Collection), user, request);
        assert.equal(collectionCount('followRequests', LOCAL_ACTOR_ID), 1);

        await p(acceptFollowRequest, user, remoteActor, request);
        assert.equal(collectionCount('followRequests', LOCAL_ACTOR_ID), 0);
    });
});

// ─── rejectFollowRequest ──────────────────────────────────────────────────────

describe('rejectFollowRequest()', function () {
    function makeFollowRequest() {
        return {
            id: 'https://remote.example.com/activities/follow-2',
            type: 'Follow',
            actor: REMOTE_ACTOR_ID,
            object: LOCAL_ACTOR_ID,
        };
    }

    it('delivers a Reject activity to the remote inbox', async () => {
        let deliveredType = null;
        ActivityPubObject.prototype.sendTo = function (inbox, user, cb) {
            deliveredType = this.type;
            cb(null, '', { statusCode: 202 });
        };

        const user = makeLocalUser();
        await p(rejectFollowRequest, user, makeRemoteActor(), makeFollowRequest());
        assert.equal(deliveredType, 'Reject');
    });

    it('removes the follow request from FollowRequests collection after rejecting', async () => {
        const user = makeLocalUser();
        const request = makeFollowRequest();

        //  Pre-seed
        await p(Collection.addFollowRequest.bind(Collection), user, request);
        assert.equal(collectionCount('followRequests', LOCAL_ACTOR_ID), 1);

        await p(rejectFollowRequest, user, makeRemoteActor(), request);
        assert.equal(collectionCount('followRequests', LOCAL_ACTOR_ID), 0);
    });

    it('does not add the actor to Followers when rejecting', async () => {
        const user = makeLocalUser();
        await p(rejectFollowRequest, user, makeRemoteActor(), makeFollowRequest());
        assert.equal(collectionCount('followers', LOCAL_ACTOR_ID), 0);
    });
});
