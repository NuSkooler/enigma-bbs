exports.ActivityStreamsContext = 'https://www.w3.org/ns/activitystreams';
exports.PublicCollectionId = 'https://www.w3.org/ns/activitystreams#Public';

const WellKnownActivity = {
    Create: 'Create',
    Update: 'Update',
    Delete: 'Delete',
    Follow: 'Follow',
    Accept: 'Accept',
    Reject: 'Reject',
    Add: 'Add',
    Remove: 'Remove',
    Like: 'Like',
    Announce: 'Announce',
    Undo: 'Undo',
};
exports.WellKnownActivity = WellKnownActivity;

const WellKnownActivityTypes = Object.values(WellKnownActivity);
exports.WellKnownActivityTypes = WellKnownActivityTypes;
