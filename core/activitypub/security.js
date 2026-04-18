'use strict';

//
//  Pure security utility functions for ActivityPub inbound request validation.
//  Extracted here so they can be unit-tested without instantiating the web handler.
//

const crypto = require('crypto');

//  Maximum age for inbound HTTP-signed requests (replay-attack window).
//  Mastodon uses 12 h; 5 min is a reasonable conservative choice.
const MaxRequestAgeSecs = 5 * 60;
exports.MaxRequestAgeSecs = MaxRequestAgeSecs;

//
//  Validate the Date header of an inbound signed request.
//
//  Returns null when the date is acceptable, or a human-readable reason
//  string when it should be rejected.  The caller is responsible for logging.
//
//  headers     — req.headers (or any object with a lowercase 'date' key)
//  maxAgeSecs  — maximum allowed age in seconds (default: MaxRequestAgeSecs)
//
function validateRequestDate(headers, maxAgeSecs = MaxRequestAgeSecs) {
    const dateHeader = headers['date'];
    if (!dateHeader) {
        return 'missing Date header';
    }

    const requestDate = new Date(dateHeader);
    if (isNaN(requestDate.getTime())) {
        return `unparseable Date header: "${dateHeader}"`;
    }

    const ageMs = Date.now() - requestDate.getTime();
    if (Math.abs(ageMs) > maxAgeSecs * 1000) {
        return `Date header age ${Math.round(ageMs / 1000)}s exceeds ±${maxAgeSecs}s window`;
    }

    return null; // valid
}
exports.validateRequestDate = validateRequestDate;

//
//  Verify the Digest request header against the actual request body.
//
//  Returns true when:
//    - no Digest header is present (verification skipped)
//    - the algorithm is not SHA-256 (unrecognized algorithms are skipped)
//    - the SHA-256 digest of rawBody matches the claimed value
//
//  Returns false when a SHA-256 Digest is present but does not match rawBody.
//
//  digestHeader — value of the Digest request header (string or falsy)
//  rawBody      — Buffer or string containing the raw request body
//
function verifyDigestHeader(digestHeader, rawBody) {
    if (!digestHeader) {
        return true; // no digest to verify
    }

    const match = /^SHA-256=(.+)$/.exec(digestHeader);
    if (!match) {
        return true; // unrecognized algorithm — skip
    }

    const claimedDigest = match[1];
    const actualDigest = crypto.createHash('sha256').update(rawBody).digest('base64');
    return claimedDigest === actualDigest;
}
exports.verifyDigestHeader = verifyDigestHeader;

//
//  Normalize HTTP Signature algorithm names for compatibility with servers
//  that use non-standard algorithm identifiers.
//
//  The 'hs2019' identifier (from draft-ietf-httpbis-message-signatures) is
//  used by GoToSocial and potentially others.  For RSA keys it is functionally
//  equivalent to rsa-sha256 and the http-signature library does not recognise
//  it, so we rewrite it before parsing.
//
//  header — value of the 'signature' or 'authorization' header (string)
//  Returns the (possibly rewritten) header value.
//
function normalizeHttpSigHeader(header) {
    if (!header) return header;
    return header.replace(/algorithm="hs2019"/g, 'algorithm="rsa-sha256"');
}
exports.normalizeHttpSigHeader = normalizeHttpSigHeader;

//
//  Derive the actor URL from an HTTP Signature keyId.
//
//  The ActivityPub ecosystem uses two conventions for key IDs:
//    Fragment style (Mastodon, Pleroma, etc.):
//      https://host/users/alice#main-key  →  https://host/users/alice
//    Path-segment style (GoToSocial, etc.):
//      https://host/users/alice/main-key  →  https://host/users/alice
//      https://host/users/alice/publicKey →  https://host/users/alice
//      https://host/users/alice/keys/1    →  https://host/users/alice
//
//  Returns null when keyId is not a recognisable https?:// URL.
//
const KEY_PATH_RE = /\/(main-key|publicKey|keys\/[^/]+)$/;

function actorIdFromKeyId(keyId) {
    if (!keyId || !/^https?:\/\//i.test(keyId)) {
        return null;
    }
    if (keyId.includes('#')) {
        return keyId.split('#', 1)[0];
    }
    const stripped = keyId.replace(KEY_PATH_RE, '');
    return stripped || keyId;
}
exports.actorIdFromKeyId = actorIdFromKeyId;

//
//  Return true when both URLs share the same hostname (scheme-insensitive).
//  Returns false for any non-parseable input.
//
function hostsMatch(urlA, urlB) {
    try {
        return new URL(urlA).hostname === new URL(urlB).hostname;
    } catch {
        return false;
    }
}
exports.hostsMatch = hostsMatch;

//
//  Verify that a fetched actor's canonical ID belongs to the same hostname as
//  the keyId that was used to sign an inbound request.
//
//  Without this check an attacker could host a key at evil.example and serve
//  an actor JSON claiming id: "https://good.example/users/victim", causing
//  ENiGMA to treat their signed activities as coming from the victim.
//
//  actorId — the `id` field of the fetched Actor object
//  keyId   — the keyId from the HTTP Signature header
//
//  Returns true when the hostnames match (binding is satisfied).
//  Returns false for any mismatch or non-parseable input.
//
function actorDomainMatchesKeyId(actorId, keyId) {
    return hostsMatch(actorId, keyId);
}
exports.actorDomainMatchesKeyId = actorDomainMatchesKeyId;

//
//  Determine whether an inbox operation is permitted to modify an object.
//
//  httpSigValidated  — true when the HTTP signature was cryptographically
//                      verified against the remote actor's public key
//  domainVerifiedOnly — true when the remote actor could not be fetched
//                       (e.g. self-deleted) but domain binding was confirmed
//                       by the caller; only Actor-type objects are allowed
//                       without a full signature in this case
//  objectType        — the `type` field of the object being modified/deleted
//
//  Returns null when the operation is permitted, or a human-readable reason
//  string when it should be refused.
//
function verifyObjectOwner(httpSigValidated, domainVerifiedOnly, objectType) {
    if (httpSigValidated) {
        return null; // cryptographic proof — permit
    }
    if (domainVerifiedOnly && objectType === 'Actor') {
        // Actor self-deletion: fetch failed (actor already removed from remote),
        // but domain binding was confirmed.  Permit cleanup of local state.
        return null;
    }
    return 'HTTP signature required to verify object ownership';
}
exports.verifyObjectOwner = verifyObjectOwner;
