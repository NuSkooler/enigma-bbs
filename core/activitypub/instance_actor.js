'use strict';

//
//  The instance actor (#966): an actor for the board itself, used to sign
//  the GETs ENiGMA makes on its own behalf (fetching the actor that signed
//  an inbox POST, a Note from its origin, ...). Servers that refuse unsigned
//  fetches (Mastodon with authorized fetch, and by default from 5.0 for
//  actor documents; GoToSocial) answer such a GET only when it is signed.
//
//  It never speaks for a user:
//  - it is not a user: no user row, and its id is outside /ap/users/, so
//    userFromActorId() never resolves it (a Follow of it gets 404);
//  - its outbox is empty and nothing is ever attributed to it;
//  - its key signs GETs only: http_util refuses any other request that
//    carries its sign options (InstanceActorSignMarker, const.js).
//
//  As in Mastodon (/actor) and GoToSocial (an account named after the host):
//  type Application, preferredUsername the web domain, so WebFinger finds it
//  as acct:<domain>@<domain>. Every URL is built from the configured base
//  URL per call, as a user's actor id is.
//
//  The key pair is kept in activitypub.sqlite3 (instance_key), made at the
//  first start with ActivityPub enabled (ensureKey(), from the ActivityPub
//  web handler). There is no rotation: delete the row and a new key is made
//  at the next start; remote servers fetch the new key when the old one no
//  longer verifies.
//

const { WellKnownLocations } = require('../servers/content/web');
const { buildUrl, getWebDomain } = require('../web_util');
const { generateActorKeyPair } = require('./key_pair');
const { Errors } = require('../enig_error');
const Endpoints = require('./endpoint');
const { InstanceActorSignMarker } = require('./const');

//  read through the module each time: tests swap the database, config and logger
const apDb = () => require('../database').dbs.activitypub;
const Config = () => require('../config').get();
const Log = () => require('../logger').log;

const KeyName = 'main';

//  After a failed attempt to make the key, the next is made no sooner than
//  this, from the next call that wants the key (a signed fetch, a request
//  for the actor)
const RetryAfterFailureMs = 60 * 1000;
//  "There is no key yet" is believed this long before the table is read again
const MissingRecheckMs = 5 * 1000;

exports.InstanceActorSignMarker = InstanceActorSignMarker;
exports.actorId = actorId;
exports.keyId = keyId;
exports.outboxId = outboxId;
exports.preferredUsername = preferredUsername;
exports.isInstanceActorId = isInstanceActorId;
exports.getKey = getKey;
exports.ensureKey = ensureKey;
exports.fetchSignOptions = fetchSignOptions;
exports.toDocument = toDocument;
exports.emptyOutbox = emptyOutbox;
exports._resetForTests = (options = {}) => {
    loaded = null;
    waiting = null;
    missingUntil = 0;
    nextAttemptAt = 0;
    makesKeys = false;
    keyPairGenerator = options.generator || generateActorKeyPair;
    retryAfterFailureMs = options.retryAfterFailureMs || RetryAfterFailureMs;
    missingRecheckMs =
        undefined === options.missingRecheckMs
            ? MissingRecheckMs
            : options.missingRecheckMs;
};

function actorId() {
    return buildUrl(WellKnownLocations.Internal + '/ap/actor');
}

function keyId() {
    return actorId() + '#main-key';
}

function outboxId() {
    return actorId() + '/outbox';
}

function preferredUsername() {
    return getWebDomain();
}

function isInstanceActorId(id) {
    return typeof id === 'string' && id === actorId();
}

let loaded = null; // the key pair, once read
let missingUntil = 0; // no key: not read again before this
let nextAttemptAt = 0; // after a failed attempt to make it: not before this
let makesKeys = false; // only a process that called ensureKey() makes one
let keyPairGenerator = generateActorKeyPair;
let retryAfterFailureMs = RetryAfterFailureMs;
let missingRecheckMs = MissingRecheckMs;

//
//  The stored key pair, { publicKey, privateKey } (PEM), or null when there
//  is none yet (or no table: a database this module never saw). Once read
//  it is kept: the row does not change while the board runs. A missing key
//  is believed for a few seconds, so signing does not read the table every
//  time.
//
//  In the server (which called ensureKey() at startup), a missing key is
//  made again in the background when the last attempt failed and its
//  wait is over; this call still answers null. Any other process (oputil)
//  never makes one.
//
function getKey() {
    if (loaded) {
        return loaded;
    }
    const now = Date.now();
    if (now < missingUntil) {
        return null;
    }
    try {
        loaded = _readKey();
    } catch {
        loaded = null;
    }
    if (loaded) {
        return loaded;
    }
    missingUntil = now + missingRecheckMs;
    if (makesKeys && !waiting && now >= nextAttemptAt) {
        ensureKey(() => {});
    }
    return null;
}

function _readKeyQuietly() {
    try {
        return _readKey();
    } catch {
        return null;
    }
}

function _readKey() {
    const row = apDb()
        .prepare(
            `SELECT public_key_pem, private_key_pem
            FROM instance_key
            WHERE key_name = ?;`
        )
        .get(KeyName);
    return row
        ? { publicKey: row.public_key_pem, privateKey: row.private_key_pem }
        : null;
}

//
//  cb(err, key): the stored key pair, made and stored first if there is
//  none. Calls made while one is being made wait for it. Two processes on
//  one database (the server and another one) both end up with the row that
//  was stored first: INSERT OR IGNORE, then read back. A failure is logged
//  (once per attempt) and the next attempt waits RetryAfterFailureMs (see
//  getKey()). Called by the ActivityPub web handler at startup; from then
//  on this process makes the key when it is missing.
//
let waiting = null;
function ensureKey(cb) {
    makesKeys = true;
    if (!loaded) {
        missingUntil = 0; // read the table now
    }
    const key = loaded || _readKeyQuietly();
    if (key) {
        loaded = key;
        return cb(null, key);
    }
    if (waiting) {
        waiting.push(cb);
        return;
    }
    waiting = [cb];

    keyPairGenerator((err, keys) => {
        if (!err) {
            try {
                apDb()
                    .prepare(
                        `INSERT OR IGNORE INTO instance_key
                            (key_name, public_key_pem, private_key_pem, created_timestamp)
                        VALUES (?, ?, ?, ?);`
                    )
                    .run(
                        KeyName,
                        keys.publicKey,
                        keys.privateKey,
                        new Date().toISOString()
                    );
                loaded = _readKey();
                if (!loaded) {
                    err = Errors.UnexpectedState('The instance key was not stored');
                }
            } catch (e) {
                err = e;
            }
        }

        if (err) {
            loaded = null;
            nextAttemptAt = Date.now() + retryAfterFailureMs;
            try {
                Log().error(
                    { error: err.message, retryInSecs: retryAfterFailureMs / 1000 },
                    'Could not make or store the ActivityPub instance actor key; fetches it would sign go unsigned until it exists'
                );
            } catch {
                //  no logger (a test)
            }
        }

        const callbacks = waiting;
        waiting = null;
        callbacks.forEach(next => next(err || null, err ? null : loaded));
    });
}

//
//  HTTP signature options for a GET signed as the instance actor, or null
//  while there is no key. Like util.signedFetchOptions(): a GET has no body,
//  so no digest.
//
function fetchSignOptions() {
    const key = getKey();
    if (!key) {
        return null;
    }
    return {
        key: key.privateKey,
        keyId: keyId(),
        authorizationHeaderName: 'Signature',
        headers: ['(request-target)', 'host', 'date'],
        [InstanceActorSignMarker]: true,
    };
}

//
//  The actor document served at actorId(), or null while there is no key.
//  The fields Mastodon's instance actor has, less its about-page url.
//
function toDocument() {
    const key = getKey();
    if (!key) {
        return null;
    }
    const id = actorId();
    const domain = preferredUsername();
    let name;
    try {
        name = Config().general.boardName;
    } catch {
        name = undefined;
    }
    return {
        '@context': [
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1',
        ],
        id,
        type: 'Application',
        preferredUsername: domain,
        name: name || domain,
        inbox: Endpoints.sharedInbox(),
        outbox: outboxId(),
        endpoints: {
            sharedInbox: Endpoints.sharedInbox(),
        },
        manuallyApprovesFollowers: true,
        discoverable: false,
        indexable: false,
        publicKey: {
            id: keyId(),
            owner: id,
            publicKeyPem: key.publicKey,
        },
    };
}

function emptyOutbox() {
    return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxId(),
        type: 'OrderedCollection',
        totalItems: 0,
        orderedItems: [],
    };
}
