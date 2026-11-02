const { Errors } = require('./enig_error');
const { getJson, allowInsecureHttp } = require('./http_util');
const { ErrorReasons } = require('./enig_error');
const { NegativeCache } = require('./activitypub/negative_cache.js');

// deps

exports.queryWebFinger = queryWebFinger;

//  failed lookups, by the https:// URL asked (#966): not repeated for a
//  while; see activitypub/negative_cache.js
const lookupFailures = new NegativeCache();

function queryWebFinger(query, cb) {
    if (typeof query !== 'string' || !query) {
        return cb(Errors.Invalid('Cannot WebFinger a non-string query'));
    }

    //
    //  Accept a variety of formats to query via WebFinger
    //  1) @Username@foo.bar -> query with acct:Username resource
    //  2) http/https URL -> query with resource = URL
    //  3) If not one of the above and a '/' is present in the query,
    //     assume https:// and try #2
    //

    // ex: @NuSkooler@toot.community -> https://toot.community/.well-known/webfinger with acct:NuSkooler resource
    // Also handles @user@host:port (port-specified hosts like local dev servers).
    let resource;
    let host;

    //  Try @user@host[:port] pattern first — more reliable than getAddressedToInfo
    //  for hosts that include a port number (e.g. @bryan@localhost:8181).
    const acctMatch = /^@?([^@]+)@([^@]+)$/.exec(query);
    if (acctMatch) {
        host = acctMatch[2]; //  may include :port
        resource = `acct:${acctMatch[1]}@${host}`;
    } else if (/^https?:\/\/.+$/.test(query)) {
        resource = query;
        try {
            host = new URL(resource).host;
        } catch (e) {
            return cb(Errors.Invalid(`Cannot WebFinger "${query}": ${e.message}`));
        }
    } else {
        //  Bare path/domain — prefix https:// and parse
        resource = `https://${query}`;
        try {
            host = new URL(resource).host;
        } catch (e) {
            return cb(Errors.Invalid(`Cannot WebFinger "${query}": ${e.message}`));
        }
    }

    resource = encodeURIComponent(resource);

    const tryFetch = (scheme, next) => {
        const url = `${scheme}://${host}/.well-known/webfinger?resource=${resource}`;
        getJson(url, {}, (err, json, res) => {
            if (err) {
                return next(err);
            }
            if (res.statusCode !== 200) {
                return next(Errors.DoesNotExist(`Failed to WebFinger URL ${url}`));
            }
            const contentType = res.headers['content-type'] || '';
            if (
                !['application/jrd+json', 'application/json'].some(ct =>
                    contentType.startsWith(ct)
                )
            ) {
                return next(
                    Errors.Invalid(
                        `Invalid Content-Type for WebFinger URL ${url}: ${contentType}`
                    )
                );
            }
            //  the URL that answered, after any redirects (follow-redirects
            //  sets responseUrl): callers check links against its host
            return next(null, json, res.responseUrl || url);
        });
    };

    const failureKey = `https://${host}/.well-known/webfinger?resource=${resource}`;
    const remembered = lookupFailures.get(failureKey);
    if (remembered) {
        return cb(remembered);
    }
    const done = (err, json, answeredBy) => {
        if (err) {
            lookupFailures.set(failureKey, err);
            return cb(err);
        }
        lookupFailures.delete(failureKey);
        return cb(null, json, answeredBy);
    };

    //  Try HTTPS first (required by the WebFinger spec). With
    //  allowInsecureHttp (local dev/test only), fall back to HTTP when the
    //  connection is refused, or when the host resolves to a private address
    //  (https:// refuses those; e.g. GoToSocial without TLS on a LAN name).
    //  Without it there is no point: http:// would be refused anyway, and
    //  that refusal, not the https error, would be what is remembered.
    tryFetch('https', (err, json, answeredBy) => {
        if (!err) {
            return done(null, json, answeredBy);
        }
        const fallBack =
            allowInsecureHttp() &&
            (['ECONNREFUSED', 'ECONNRESET', 'EPROTO'].includes(err.code) ||
                err.reasonCode === ErrorReasons.BlockedAddress);
        if (!fallBack) {
            return done(err);
        }
        tryFetch('http', done);
    });
}
