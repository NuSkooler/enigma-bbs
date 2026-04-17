const { Errors } = require('./enig_error');
const { getAddressedToInfo } = require('./mail_util');
const Message = require('./message');
const { getJson } = require('./http_util');

// deps

exports.queryWebFinger = queryWebFinger;

function queryWebFinger(query, cb) {
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
        host = acctMatch[2];   //  may include :port
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
            return next(null, json);
        });
    };

    //  Try HTTPS first (required by the WebFinger spec). If the connection is
    //  refused fall back to HTTP — useful for local dev servers (e.g. GoToSocial
    //  running without TLS) and instances behind a plain-HTTP proxy.
    tryFetch('https', (err, json) => {
        if (!err) {
            return cb(null, json);
        }
        if (!['ECONNREFUSED', 'ECONNRESET', 'EPROTO'].includes(err.code)) {
            return cb(err);
        }
        tryFetch('http', cb);
    });
}
