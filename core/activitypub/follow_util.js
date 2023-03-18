const { Collections, WellKnownActivity } = require('./const');
const ActivityPubObject = require('./object');
const UserProps = require('../user_property');
const { Errors } = require('../enig_error');
const Collection = require('./collection');

exports.sendFollowRequest = sendFollowRequest;
exports.sendUnfollowRequest = sendUnfollowRequest;

function sendFollowRequest(fromUser, toActor, cb) {
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
    const followRequest = new ActivityPubObject({
        id: ActivityPubObject.makeObjectId('follow'),
        type: WellKnownActivity.Follow,
        actor: fromActorId,
        object: toActor.id,
    });

    toActor._followRequest = followRequest;
    Collection.addFollowing(fromUser, toActor, true, err => {
        if (err) {
            return cb(err);
        }

        return followRequest.sendTo(toActor.inbox, fromUser, cb);
    });
}

function sendUnfollowRequest(fromUser, toActor, cb) {
    const fromActorId = fromUser.getProperty(UserProps.ActivityPubActorId);
    if (!fromActorId) {
        return cb(
            Errors.MissingProperty(
                `User missing "${UserProps.ActivityPubActorId}" property`
            )
        );
    }

    //  Fetch previously saved 'Follow'; We're going to Undo it &
    //  need a copy.
    Collection.ownedObjectByNameAndId(
        Collections.Following,
        fromUser,
        toActor.id,
        (err, followedActor) => {
            if (err) {
                return cb(err);
            }

            //  Always remove from the local collection, notify the remote server
            Collection.removeOwnedById(
                Collections.Following,
                fromUser,
                toActor.id,
                err => {
                    if (err) {
                        return cb(err);
                    }

                    const undoRequest = new ActivityPubObject({
                        id: ActivityPubObject.makeObjectId('undo'),
                        type: WellKnownActivity.Undo,
                        actor: fromActorId,
                        object: followedActor._followRequest,
                    });

                    return undoRequest.sendTo(toActor.inbox, fromUser, cb);
                }
            );
        }
    );
}
