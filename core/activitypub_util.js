const { WellKnownLocations } = require('./servers/content/web');

exports.buildSelfUrl = buildSelfUrl;

function buildSelfUrl(webServer, user, relPrefix) {
    return webServer.buildUrl(
        WellKnownLocations.Internal + `${relPrefix}${user.username}`
    );
}
