'use strict';

//
//  Pure security utility functions for ActivityPub inbound request validation.
//  Extracted here so they can be unit-tested without instantiating the web handler.
//

const crypto = require('crypto');
const net = require('net');
const { AsyncResource } = require('async_hooks');

//
//  Read an HTTP request body up to maxBytes, accumulating chunks as they arrive.
//
//  req      — Node.js IncomingMessage (or any EventEmitter emitting 'data'/'end'/'error')
//  maxBytes — maximum number of bytes to accept; request is aborted if exceeded
//  cb       — callback(err, rawBody: Buffer)
//               err.code === 'ENTITY_TOO_LARGE' when the limit is exceeded
//
//  cb is called in the caller's async context. A server request's events
//  run in the HTTP parser's, so without this anything after the body read
//  would lose the inbox POST's fetch budget (see fetch_budget.js).
//
function readInboxBody(req, maxBytes, cb) {
    cb = AsyncResource.bind(cb);
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
            const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
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
    //  If no known suffix is stripped, the full keyId URL is returned as the
    //  actor ID.  Non-standard suffixes (e.g. /key, /signing-key, /keys/primary)
    //  will not be recognised.  In that case Actor.fromId() fetches the URL; if
    //  it does not resolve to a valid Actor the request is rejected cleanly.
    //  The domain-binding check in _getAssociatedActors further mitigates any
    //  impersonation risk from exotic key IDs (audit finding #2).
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
    '.example', // RFC 2606 reserved
    '.invalid', // RFC 2606 reserved
    '.test', // RFC 2606 reserved
];

//
//  IPv4 CIDR ranges that must never be contacted.
//  Each entry is [networkInt, maskInt, label].
//
const BLOCKED_IPV4_CIDRS = [
    ['0.0.0.0', 8, '"this" network'],
    ['10.0.0.0', 8, 'RFC-1918 private'],
    ['100.64.0.0', 10, 'CGNAT shared address'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local / cloud metadata'],
    ['172.16.0.0', 12, 'RFC-1918 private'],
    ['192.0.0.0', 24, 'IETF protocol assignments'],
    ['192.0.2.0', 24, 'RFC 5737 TEST-NET-1'],
    ['192.88.99.0', 24, '6to4 relay anycast (deprecated)'],
    ['192.168.0.0', 16, 'RFC-1918 private'],
    ['198.18.0.0', 15, 'benchmarking'],
    ['198.51.100.0', 24, 'RFC 5737 TEST-NET-2'],
    ['203.0.113.0', 24, 'RFC 5737 TEST-NET-3'],
    ['224.0.0.0', 4, 'multicast'],
    ['240.0.0.0', 4, 'reserved / experimental'],
    ['255.255.255.255', 32, 'broadcast'],
].map(([addr, prefix, label]) => {
    const network = _ipv4ToInt(addr);
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return [network, mask, label];
});

//  Dotted-quad IPv4 string -> unsigned 32-bit int, or null if it is not one.
function _ipv4ToInt(str) {
    const parts = str.split('.');
    if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p))) return null;
    const nums = parts.map(Number);
    if (nums.some(n => n > 255)) return null;
    return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

//  Label of the blocked range an IPv4 int falls in, or null.
function _ipv4BlockedRange(addr) {
    // `&` operates on signed int32; `>>> 0` converts back to unsigned for comparison.
    const hit = BLOCKED_IPV4_CIDRS.find(
        ([network, mask]) => (addr & mask) >>> 0 === network
    );
    return hit ? hit[2] : null;
}

//
//  Returns the label of the blocked range |hostname| is in when it is a
//  bare IPv4 literal, else null (including when it is not IPv4 at all).
//
function _isBlockedIPv4(hostname) {
    const addr = _ipv4ToInt(hostname);
    return addr === null ? null : _ipv4BlockedRange(addr);
}

//
//  IPv6 prefixes whose last 32 bits are an IPv4 address: the embedded
//  address is checked against the IPv4 table rather than blocking (or
//  allowing) the prefix as a whole. 64:ff9b::/96 is how an IPv6-only host
//  behind DNS64 reaches every IPv4 server, so it cannot simply be blocked.
//
const IPV6_EMBEDDED_IPV4_PREFIXES = [
    ['::ffff:0:0', 96, 'IPv4-mapped'],
    ['64:ff9b::', 96, 'NAT64'],
];

//  IPv6 ranges that must never be contacted.
const BLOCKED_IPV6_CIDRS = [
    ['::', 128, 'unspecified'],
    ['::1', 128, 'loopback'],
    ['::', 96, 'IPv4-compatible (deprecated)'],
    ['64:ff9b:1::', 48, 'local-use NAT64'],
    ['100::', 64, 'discard-only'],
    ['2001::', 32, 'Teredo'],
    ['2001:db8::', 32, 'documentation'],
    ['2002::', 16, '6to4'],
    ['fc00::', 7, 'unique local'],
    ['fe80::', 10, 'link-local'],
    ['fec0::', 10, 'site-local (deprecated)'],
    ['ff00::', 8, 'multicast'],
];

const _toPrefixes = list =>
    list.map(([addr, bits, label]) => [_ipv6ToBytes(addr), bits, label]);
const IPV6_EMBEDDED_IPV4 = _toPrefixes(IPV6_EMBEDDED_IPV4_PREFIXES);
const BLOCKED_IPV6 = _toPrefixes(BLOCKED_IPV6_CIDRS);

function _inIPv6Prefix(bytes, prefixBytes, bits) {
    for (let i = 0; i < 16 && bits > 0; ++i, bits -= 8) {
        const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
        if ((bytes[i] & mask) !== prefixBytes[i]) return false;
    }
    return true;
}

//
//  Parse an IPv6 address (brackets and a %zone allowed) into its 16 bytes.
//  Handles "::" in any position and an embedded dotted-quad tail
//  (::ffff:1.2.3.4). Returns null when it is not an IPv6 address.
//
function _ipv6ToBytes(str) {
    let addr = str.startsWith('[') && str.endsWith(']') ? str.slice(1, -1) : str;
    addr = addr.replace(/%.*$/, '');
    if (!net.isIPv6(addr)) return null;

    //  rewrite a dotted-quad tail as two hex groups
    const lastColon = addr.lastIndexOf(':');
    const tail = addr.slice(lastColon + 1);
    if (tail.includes('.')) {
        const v4 = _ipv4ToInt(tail);
        if (v4 === null) return null;
        addr = `${addr.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(
            v4 & 0xffff
        ).toString(16)}`;
    }

    const halves = addr.split('::');
    if (halves.length > 2) return null;
    const groupsOf = s => (s === '' ? [] : s.split(':'));
    const head = groupsOf(halves[0]);
    const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
    const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
    if (fill < 0) return null;
    const groups = [...head, ...new Array(fill).fill('0'), ...rest];
    if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) {
        return null;
    }

    const bytes = Buffer.alloc(16);
    groups.forEach((g, i) => bytes.writeUInt16BE(parseInt(g, 16), i * 2));
    return bytes;
}

//
//  Returns the label of the blocked range |hostname| is in when it is an
//  IPv6 literal (bracketed or bare), else null (including when it is not
//  IPv6 at all).
//
function _isBlockedIPv6(hostname) {
    const bytes = _ipv6ToBytes(hostname);
    if (!bytes) return null;

    for (const [prefix, bits, label] of IPV6_EMBEDDED_IPV4) {
        if (_inIPv6Prefix(bytes, prefix, bits)) {
            const range = _ipv4BlockedRange(bytes.readUInt32BE(12));
            return range ? `${label} ${range}` : null;
        }
    }

    const hit = BLOCKED_IPV6.find(([prefix, bits]) => _inIPv6Prefix(bytes, prefix, bits));
    return hit ? hit[2] : null;
}

//
//  Check a bare IP address (v4 or v6, as dns.lookup() returns them) against
//  the blocked ranges. Anything that is not an IP address is refused.
//
//  Returns null when the address may be contacted, or a human-readable
//  reason string when it must not be.
//
function isBlockedAddress(ip) {
    if (net.isIPv4(ip)) {
        const range = _isBlockedIPv4(ip);
        return range ? `IPv4 address "${ip}" is in a blocked range (${range})` : null;
    }
    if (_ipv6ToBytes(ip)) {
        const range = _isBlockedIPv6(ip);
        return range ? `IPv6 address "${ip}" is in a blocked range (${range})` : null;
    }
    return `"${ip}" is not an IP address`;
}
exports.isBlockedAddress = isBlockedAddress;

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
    if (
        BLOCKED_HOST_SUFFIXES.some(
            s => hostname === s.replace(/^\./, '') || hostname.endsWith(s)
        )
    ) {
        return `hostname "${hostname}" is a reserved/internal name`;
    }

    // IPv4 literal
    const ipv4Range = _isBlockedIPv4(hostname);
    if (ipv4Range) {
        return `IPv4 address "${hostname}" is in a blocked range (${ipv4Range})`;
    }

    // IPv6 literal (WHATWG URL normalises these, e.g. [::ffff:127.0.0.1]
    // becomes [::ffff:7f00:1], so the embedded IPv4 forms must be decoded)
    const ipv6Range = _isBlockedIPv6(hostname);
    if (ipv6Range) {
        return `IPv6 address "${hostname}" is in a blocked range (${ipv6Range})`;
    }

    return null; // safe
}
exports.isSafeOutboundUrl = isSafeOutboundUrl;

//
//  Determine whether an inbox operation is permitted to modify an object.
//
//  httpSigValidated  — true when the HTTP signature was cryptographically
//                      verified against the remote actor's public key
//  domainVerifiedOnly, objectType — no longer used: domain binding alone
//                      never permits a change. A Delete of an actor that can
//                      no longer be fetched is verified with its origin
//                      instead (see the inbox handler).
//
//  Returns null when the operation is permitted, or a human-readable reason
//  string when it should be refused. Who may change the object is checked
//  separately (verifySignerOwnsObject).
//
function verifyObjectOwner(httpSigValidated) {
    if (httpSigValidated) {
        return null; // cryptographic proof — permit
    }
    return 'HTTP signature required to verify object ownership';
}
exports.verifyObjectOwner = verifyObjectOwner;

//
//  The actor ids an ActivityPub value names. attributedTo (and actor) may be
//  a string id, an object with an id, or an array of either; anything else
//  names no one.
//
function actorIdsOf(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
        .map(v => (typeof v === 'string' ? v : v && v.id))
        .filter(id => typeof id === 'string' && id.length > 0);
}
exports.actorIdsOf = actorIdsOf;

//
//  The owners of a stored collection entry for |objectId|: the attributedTo
//  of the object itself, or, for a stored activity (the Create a Note came
//  in with, an Announce that embeds it), of the embedded object with that id.
//  An empty array means the owner cannot be told, and nothing may change it.
//
function storedObjectOwnerIds(stored, objectId) {
    if (!stored || !objectId) {
        return [];
    }
    if (stored.id === objectId) {
        return actorIdsOf(stored.attributedTo);
    }
    if (stored.object && stored.object.id === objectId) {
        return actorIdsOf(stored.object.attributedTo);
    }
    return [];
}
exports.storedObjectOwnerIds = storedObjectOwnerIds;

//
//  An Update or Delete of an existing object is accepted only from its owner
//  (#964 review): a valid HTTP signature proves who signed, not that the
//  signer may change this object.
//
//  signerId        — id of the actor whose key verified the HTTP signature
//  ownerIds        — the stored object's owners (see storedObjectOwnerIds)
//  activityActorId — the activity's actor; must be the signer as well
//
//  Returns null when permitted, or a reason string.
//
function verifySignerOwnsObject(signerId, ownerIds, activityActorId) {
    if (!signerId) {
        return 'No verified signing actor';
    }
    if (!ownerIds || ownerIds.length === 0) {
        return 'The object has no owner to check the signer against';
    }
    if (!ownerIds.includes(signerId)) {
        return 'The signing actor is not the object owner';
    }
    if (activityActorId !== signerId) {
        return 'The activity actor is not the signing actor';
    }
    return null;
}
exports.verifySignerOwnsObject = verifySignerOwnsObject;

//
//  True when both URLs have the same host (hostname and port). Unlike
//  hostsMatch(), a different port is a different host.
//
function sameHost(urlA, urlB) {
    try {
        return new URL(urlA).host === new URL(urlB).host;
    } catch {
        return false;
    }
}
exports.sameHost = sameHost;

//
//  May |doc|, fetched for |requestedUrl|, be taken (and cached) as that actor?
//  An actor is cached under the id inside the document, so a document must
//  not be able to name an actor it was not fetched from: otherwise a server
//  could serve another server's actor id with its own key, and later
//  signatures "from" that actor would verify with it.
//
//  requestedUrl — the URL asked for
//  fetchedUrl   — the URL that answered, after any redirects
//
//  The id must equal the URL asked for, from the same host that answered.
//  (A key URL answered with its owning actor is only a pointer to that
//  actor, which is fetched from its own URL: see Actor.fromKeyId().)
//
//  Returns null when acceptable, or a reason string.
//
function verifyFetchedActorId(doc, requestedUrl, fetchedUrl) {
    const docId = doc && doc.id;
    if (typeof docId !== 'string' || docId.length === 0) {
        return 'The fetched actor has no id';
    }
    if (!sameHost(fetchedUrl || requestedUrl, requestedUrl)) {
        return `The actor fetch for ${requestedUrl} was redirected to another host`;
    }
    if (docId !== requestedUrl) {
        return `The fetched actor id ${docId} does not match ${requestedUrl}`;
    }
    return null;
}
exports.verifyFetchedActorId = verifyFetchedActorId;

//
//  A Note (or Article) delivered directly by its author: attributed to that
//  one actor, with an id on the author's host. Returns null or a reason.
//
function verifyNoteAuthor(note, authorId) {
    const authors = actorIdsOf(note && note.attributedTo);
    if (authors.length !== 1 || authors[0] !== authorId) {
        return 'The Note is not attributed to the signing actor';
    }
    if (!sameHost(note.id, authorId)) {
        return "The Note id is not on its author's host";
    }
    return null;
}
exports.verifyNoteAuthor = verifyNoteAuthor;

//
//  May |doc|, fetched for |requestedUrl|, be taken as the Note at that URL?
//  The fetch must not have left the URL's host, the id must be that URL, and
//  it must be attributed to one actor on the same host. Returns null or a
//  reason.
//
function verifyFetchedNote(doc, requestedUrl, fetchedUrl) {
    if (!doc || !['Note', 'Article'].includes(doc.type)) {
        return `The object at ${requestedUrl} is not a Note or Article`;
    }
    if (!sameHost(fetchedUrl || requestedUrl, requestedUrl)) {
        return `The fetch of ${requestedUrl} was redirected to another host`;
    }
    if (doc.id !== requestedUrl) {
        return `The object fetched from ${requestedUrl} has another id`;
    }
    const authors = actorIdsOf(doc.attributedTo);
    if (authors.length !== 1 || !sameHost(authors[0], requestedUrl)) {
        return `The Note at ${requestedUrl} is not attributed to an actor on its host`;
    }
    return null;
}
exports.verifyFetchedNote = verifyFetchedNote;

//
//  The owner of |objectId| across every stored row that holds it (the
//  Create it came in with, an Announce that embeds it, ...). Each row that
//  names an owner must name the same one, so a planted row cannot decide or
//  share ownership; a row that does not parse cannot be checked at all.
//  Returns { ownerIds, reason }: ownerIds is empty when no row names one.
//
function storedObjectsOwnerIds(storedObjects, objectId) {
    let ownerIds = [];
    for (const stored of storedObjects || []) {
        if (!stored) {
            return { ownerIds: [], reason: 'A stored copy of the object cannot be read' };
        }
        const ids = [...new Set(storedObjectOwnerIds(stored, objectId))].sort();
        if (ids.length === 0) {
            continue;
        }
        if (ownerIds.length === 0) {
            ownerIds = ids;
        } else if (ids.join('\n') !== ownerIds.join('\n')) {
            return {
                ownerIds: [],
                reason: 'Stored copies of the object name different owners',
            };
        }
    }
    return { ownerIds, reason: null };
}
exports.storedObjectsOwnerIds = storedObjectsOwnerIds;

//  The forms the public collection is addressed by
const PublicAddresses = [
    'https://www.w3.org/ns/activitystreams#Public',
    'as:Public',
    'Public',
];

//
//  True when |obj| (a Note) is addressed to the public in to or cc.
//
function isPublicAddressed(obj) {
    return addressedIds(obj).some(id => PublicAddresses.includes(id));
}
exports.isPublicAddressed = isPublicAddressed;

//  The ids |obj| is addressed to, in to and cc
function addressedIds(obj) {
    return ['to', 'cc'].flatMap(field => actorIdsOf(obj && obj[field]));
}
exports.addressedIds = addressedIds;
