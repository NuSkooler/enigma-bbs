const { WellKnownLocations } = require('../servers/content/web');
const { buildUrl } = require('../web_util');

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

function makeUserUrl(user, relPrefix = ActivityPubUsersPrefix) {
    return buildUrl(WellKnownLocations.Internal + `${relPrefix}${user.username}`);
}

function inbox(user) {
    return makeUserUrl(user, ActivityPubUsersPrefix) + '/inbox';
}

function outbox(user) {
    return makeUserUrl(user, ActivityPubUsersPrefix) + '/outbox';
}

function followers(user) {
    return makeUserUrl(user, ActivityPubUsersPrefix) + '/followers';
}

function following(user) {
    return makeUserUrl(user, ActivityPubUsersPrefix) + '/following';
}

function actorId(user) {
    return makeUserUrl(user, ActivityPubUsersPrefix);
}

function profile(user) {
    return buildUrl(WellKnownLocations.Internal + `/wf/@${user.username}`);
}

function avatar(user, filename) {
    return makeUserUrl(user, '/users/') + `/avatar/${filename}`;
}

function sharedInbox() {
    return buildUrl(WellKnownLocations.Internal + '/ap/shared-inbox');
}

function objectId(objectType) {
    return buildUrl(WellKnownLocations.Internal + `/ap/${UUIDv4()}/${objectType}`);
}
