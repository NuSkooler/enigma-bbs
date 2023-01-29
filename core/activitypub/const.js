exports.ActivityStreamsContext = 'https://www.w3.org/ns/activitystreams';
exports.PublicCollectionId = 'https://www.w3.org/ns/activitystreams#Public';
exports.ActivityStreamMediaType = 'application/activity+json';

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
    Tombstone: 'Tombstone',
};
exports.WellKnownActivity = WellKnownActivity;

const WellKnownActivityTypes = Object.values(WellKnownActivity);
exports.WellKnownActivityTypes = WellKnownActivityTypes;

exports.WellKnownRecipientFields = ['audience', 'bcc', 'bto', 'cc', 'to'];

//  Signatures utilized in HTTP signature generation
exports.HttpSignatureSignHeaders = [
    '(request-target)',
    'host',
    'date',
    'digest',
    'content-type',
];
