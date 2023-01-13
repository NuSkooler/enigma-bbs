const { Errors } = require('./enig_error');
const { getAddressedToInfo } = require('./mail_util');
const Message = require('./message');
const { getJson } = require('./http_util');

// deps

exports.queryWebFinger = queryWebFinger;

function queryWebFinger(account, cb) {
    // ex: @NuSkooler@toot.community -> https://toot.community/.well-known/webfinger with acct:NuSkooler resource
    const addrInfo = getAddressedToInfo(account);
    if (
        addrInfo.flavor !== Message.AddressFlavor.ActivityPub &&
        addrInfo.flavor !== Message.AddressFlavor.Email
    ) {
        return cb(Errors.Invalid(`Cannot WebFinger "${account.remote}"; Missing domain`));
    }

    const domain = addrInfo.remote.slice(addrInfo.remote.lastIndexOf('@') + 1);
    if (!domain) {
        return cb(Errors.Invalid(`Cannot WebFinger "${account.remote}"; Missing domain`));
    }

    const resource = encodeURIComponent(`acct:${account.slice(1)}`); // we need drop the initial '@' prefix
    const webFingerUrl = `https://${domain}/.well-known/webfinger?resource=${resource}`;
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
