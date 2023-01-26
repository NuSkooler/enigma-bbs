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
    const addrInfo = getAddressedToInfo(query);
    let resource;
    let host;
    if (
        addrInfo.flavor === Message.AddressFlavor.ActivityPub ||
        addrInfo.flavor === Message.AddressFlavor.Email
    ) {
        host = addrInfo.remote.slice(addrInfo.remote.lastIndexOf('@') + 1);
        if (!host) {
            return cb(Errors.Invalid(`Unsure how to WebFinger "${query}"`));
        }
        resource = `acct:${addrInfo.name}@${host}`;
    } else {
        if (!/^https?:\/\/.+$/.test(query)) {
            resource = `https://${query}`;
        } else {
            resource = query;
        }

        try {
            const url = new URL(resource);
            host = url.host;
        } catch (e) {
            return cb(Errors.Invalid(`Cannot WebFinger "${query}": ${e.message}`));
        }
    }

    resource = encodeURIComponent(resource);
    const webFingerUrl = `https://${host}/.well-known/webfinger?resource=${resource}`;
    getJson(webFingerUrl, {}, (err, json, res) => {
        if (err) {
            return cb(err);
        }

        if (res.statusCode !== 200) {
            // only accept 200
            return cb(Errors.DoesNotExist(`Failed to WebFinger URL ${webFingerUrl}`));
        }

        const contentType = res.headers['content-type'] || '';
        if (!contentType.startsWith('application/jrd+json')) {
            return cb(
                Errors.Invalid(
                    `Invalid Content-Type for WebFinger URL ${webFingerUrl}: ${contentType}`
                )
            );
        }

        return cb(null, json);
    });
}
