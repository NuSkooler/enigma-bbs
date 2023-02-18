const { Collections, WellKnownActivity } = require('./const');
const ActivityPubObject = require('./object');
const UserProps = require('../user_property');
const { Errors } = require('../enig_error');
const Collection = require('./collection');

exports.sendFollowRequest = sendFollowRequest;
exports.sendUnfollowRequest = sendUnfollowRequest;

function sendFollowRequest(fromUser, toActor, webServer, cb) {
    const fromActorId = fromUser.getProperty(UserProps.ActivityPubActorId);
    if (!fromActorId) {
        return cb(
            Errors.MissingProperty(
                `User missing "${UserProps.ActivityPubActorId}" property`
            )
        );
    }

    //  We always add to the following collection;
    //  We expect an async follow up request to our server of
    //  Accept or Reject but it's not guaranteed
    Collection.addFollowing(fromUser, toActor, webServer, true, err => {
        if (err) {
            return cb(err);
        }

        const followRequest = new ActivityPubObject({
            id: ActivityPubObject.makeObjectId(webServer, 'follow'),
            type: WellKnownActivity.Follow,
            actor: fromActorId,
            object: toActor.id,
        });

        return followRequest.sendTo(toActor.inbox, fromUser, webServer, cb);
    });
}

function sendUnfollowRequest(fromUser, toActor, webServer, cb) {
    const fromActorId = fromUser.getProperty(UserProps.ActivityPubActorId);
    if (!fromActorId) {
        return cb(
            Errors.MissingProperty(
                `User missing "${UserProps.ActivityPubActorId}" property`
            )
        );
    }

    //  Always remove from the local collection, notify the remote server
    Collection.removeOwnedById(Collections.Following, fromUser, toActor.inbox, err => {
        if (err) {
            return cb(err);
        }

        const undoRequest = new ActivityPubObject({
            id: ActivityPubObject.makeObjectId(webServer, 'undo'),
            type: WellKnownActivity.Undo,
            actor: fromActorId,
            object: toActor.id,
        });

        return undoRequest.sendTo(toActor.inbox, fromUser, webServer, cb);
    });
}
