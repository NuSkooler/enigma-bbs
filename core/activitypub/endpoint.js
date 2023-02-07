const { WellKnownLocations } = require('../servers/content/web');

// deps
const { v4: UUIDv4 } = require('uuid');

exports.makeUserUrl = makeUserUrl;
exports.inbox = inbox;
exports.outbox = outbox;
exports.followers = followers;
exports.following = following;
exports.actorId = actorId;
exports.profile = profile;
exports.avatar = avatar;
exports.sharedInbox = sharedInbox;
exports.objectId = objectId;

const ActivityPubUsersPrefix = '/ap/users/';

function makeUserUrl(webServer, user, relPrefix = ActivityPubUsersPrefix) {
    return webServer.buildUrl(
        WellKnownLocations.Internal + `${relPrefix}${user.username}`
    );
}

function inbox(webServer, user) {
    return makeUserUrl(webServer, user, ActivityPubUsersPrefix) + '/inbox';
}

function outbox(webServer, user) {
    return makeUserUrl(webServer, user, ActivityPubUsersPrefix) + '/outbox';
}

function followers(webServer, user) {
    return makeUserUrl(webServer, user, ActivityPubUsersPrefix) + '/followers';
}

function following(webServer, user) {
    return makeUserUrl(webServer, user, ActivityPubUsersPrefix) + '/following';
}

function actorId(webServer, user) {
    return makeUserUrl(webServer, user, ActivityPubUsersPrefix);
}

function profile(webServer, user) {
    return webServer.buildUrl(WellKnownLocations.Internal + `/wf/@${user.username}`);
}

function avatar(webServer, user, filename) {
    return makeUserUrl(this.webServer, user, '/users/') + `/avatar/${filename}`;
}

function sharedInbox(webServer) {
    return webServer.buildUrl(WellKnownLocations.Internal + '/ap/shared-inbox');
}

function objectId(webServer, objectType) {
    return webServer.buildUrl(
        WellKnownLocations.Internal + `/ap/${UUIDv4()}/${objectType}`
    );
}
