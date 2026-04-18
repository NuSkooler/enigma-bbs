'use strict';

//
//  Pure security utility functions for ActivityPub inbound request validation.
//  Extracted here so they can be unit-tested without instantiating the web handler.
//

const crypto = require('crypto');
const net = require('net');

//
//  Read an HTTP request body up to maxBytes, accumulating chunks as they arrive.
//
//  req      — Node.js IncomingMessage (or any EventEmitter emitting 'data'/'end'/'error')
//  maxBytes — maximum number of bytes to accept; request is aborted if exceeded
//  cb       — callback(err, rawBody: Buffer)
//               err.code === 'ENTITY_TOO_LARGE' when the limit is exceeded
//
function readInboxBody(req, maxBytes, cb) {
    const chunks = [];
    let totalBytes = 0;
    let done = false;

    const finish = (err, result) => {
        if (!done) {
            done = true;
            return cb(err, result);
        }
    };

    req.on('data', chunk => {
        if (done) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
            const err = new Error(
                `Request body exceeds limit of ${maxBytes} bytes`
            );
            err.code = 'ENTITY_TOO_LARGE';
            if (typeof req.destroy === 'function') {
                req.destroy();
            }
            return finish(err);
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        return finish(null, Buffer.concat(chunks));
    });

    req.on('error', err => {
        return finish(err);
    });
}
exports.readInboxBody = readInboxBody;

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
//  Blocked hostname suffixes for SSRF protection.
//  Hostnames matching any of these are treated as internal/private.
//
const BLOCKED_HOST_SUFFIXES = [
    'localhost',
    '.local',
    '.internal',
    '.lan',
    '.localhost',
    '.example',     // RFC 2606 reserved
    '.invalid',     // RFC 2606 reserved
    '.test',        // RFC 2606 reserved
];

//
//  IPv4 CIDR ranges that must never be contacted.
//  Each entry is [networkInt, maskInt].
//
const BLOCKED_IPV4_CIDRS = [
    ['0.0.0.0',   8],   // "this" network
    ['10.0.0.0',  8],   // RFC-1918
    ['100.64.0.0', 10], // CGNAT shared address
    ['127.0.0.0', 8],   // loopback
    ['169.254.0.0', 16], // link-local / cloud metadata
    ['172.16.0.0', 12], // RFC-1918
    ['192.0.0.0', 24],  // IETF protocol assignments
    ['192.168.0.0', 16], // RFC-1918
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // RFC 5737 TEST-NET-2
    ['203.0.113.0', 24],  // RFC 5737 TEST-NET-3
    ['224.0.0.0', 4],   // multicast
    ['240.0.0.0', 4],   // reserved / experimental
    ['255.255.255.255', 32], // broadcast
].map(([addr, prefix]) => {
    const parts = addr.split('.').map(Number);
    const network = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return [network, mask];
});

function _isBlockedIPv4(hostname) {
    // hostname may be a bare IPv4 literal
    const parts = hostname.split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map(Number);
    if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return false;
    const addr = (nums[0] << 24 | nums[1] << 16 | nums[2] << 8 | nums[3]) >>> 0;
    // `&` operates on signed int32; `>>> 0` converts back to unsigned for comparison.
    return BLOCKED_IPV4_CIDRS.some(([network, mask]) => ((addr & mask) >>> 0) === network);
}

function _isBlockedIPv6(hostname) {
    // strip brackets if present: [::1] → ::1
    const raw = hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;

    if (!net.isIPv6(raw)) return false;

    // Expand to full form for prefix matching
    const buf = _ipv6ToBuffer(raw);
    if (!buf) return false;

    const first = buf[0];
    const firstTwo = (buf[0] << 8 | buf[1]);

    return (
        raw === '::' ||                 // unspecified
        raw === '::1' ||                // loopback
        (first & 0xe0) === 0x20 && buf[1] === 0x02 || // 2002::/16 6to4
        (firstTwo & 0xffc0) === 0xfe80 || // fe80::/10 link-local
        (firstTwo & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
        (first & 0xfe) === 0xfc ||      // fc00::/7  unique local
        (first & 0xff) === 0xff         // ff00::/8  multicast
    );
}

function _ipv6ToBuffer(addr) {
    try {
        // Node's dns module isn't available here; do a simple expansion.
        // We only need the first two bytes for our prefix checks.
        const groups = addr.split(':');
        const expanded = [];
        for (const g of groups) {
            if (g === '') {
                // double-colon — fill with zeros
                const missing = 8 - groups.filter(x => x !== '').length;
                for (let i = 0; i <= missing; i++) expanded.push(0);
            } else {
                expanded.push(parseInt(g, 16));
            }
        }
        return expanded.map(g => [(g >> 8) & 0xff, g & 0xff]).flat();
    } catch {
        return null;
    }
}

//
//  Check whether a URL is safe to fetch as an outbound ActivityPub request.
//
//  allowHttp  — when true, http:// URLs are permitted (dev/test only);
//               defaults to false (https:// only)
//
//  Returns null when the URL is safe to fetch, or a human-readable reason
//  string when it must be blocked.
//
function isSafeOutboundUrl(urlString, allowHttp = false) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return `unparseable URL: "${urlString}"`;
    }

    const scheme = parsed.protocol; // includes trailing ':'

    //  In dev/test mode (allowHttp=true) plain HTTP is intentional and the
    //  operator is explicitly targeting a local server.  Skip all further
    //  SSRF checks — the flag is an "I know what I'm doing" override.
    if (allowHttp && scheme === 'http:') {
        return null;
    }

    if (scheme === 'https:') {
        // always OK scheme-wise
    } else if (scheme === 'http:') {
        return `http:// not permitted for ActivityPub requests (use https://)`;
    } else {
        return `scheme "${scheme}" not permitted for ActivityPub requests`;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Blocked named hosts
    if (BLOCKED_HOST_SUFFIXES.some(s =>
        hostname === s.replace(/^\./, '') || hostname.endsWith(s)
    )) {
        return `hostname "${hostname}" is a reserved/internal name`;
    }

    // IPv4 literal
    if (_isBlockedIPv4(hostname)) {
        return `IPv4 address "${hostname}" is in a blocked range`;
    }

    // IPv6 literal
    if (_isBlockedIPv6(hostname)) {
        return `IPv6 address "${hostname}" is in a blocked range`;
    }

    return null; // safe
}
exports.isSafeOutboundUrl = isSafeOutboundUrl;

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
