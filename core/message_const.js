const WellKnownAreaTags = {
    Invalid: '',
    Private: 'private_mail',
    Bulletin: 'local_bulletin',
};
exports.WellKnownAreaTags = WellKnownAreaTags;

const WellKnownMetaCategories = {
    System: 'System',
    FtnProperty: 'FtnProperty',
    FtnKludge: 'FtnKludge',
    QwkProperty: 'QwkProperty',
    QwkKludge: 'QwkKludge',
    ActivityPub: 'ActivityPub',
};
exports.WellKnownMetaCategories = WellKnownMetaCategories;

//  Category: WellKnownMetaCategories.System ("System")
const SystemMetaNames = {
    LocalToUserID: 'local_to_user_id',
    LocalFromUserID: 'local_from_user_id',
    StateFlags0: 'state_flags0', //  See Message.StateFlags0
    ExplicitEncoding: 'explicit_encoding', //  Explicitly set encoding when exporting/etc.
    ExternalFlavor: 'external_flavor', //  "Flavor" of message - imported from or to be exported to. See Message.AddressFlavor
    RemoteToUser: 'remote_to_user', //  Opaque value depends on external system, e.g. FTN address
    RemoteFromUser: 'remote_from_user', //  Opaque value depends on external system, e.g. FTN address
};
exports.SystemMetaNames = SystemMetaNames;

//  Types for Message.SystemMetaNames.ExternalFlavor meta
const AddressFlavor = {
    Local: 'local', //  local / non-remote addressing
    FTN: 'ftn', //  FTN style
    Email: 'email', //  From email
    QWK: 'qwk', //  QWK packet
    NNTP: 'nntp', // NNTP article POST; often a email address
    ActivityPub: 'activitypub', //  ActivityPub, Mastodon, etc.
};
exports.AddressFlavor = AddressFlavor;

const StateFlags0 = {
    None: 0x00000000,
    Imported: 0x00000001, //  imported from foreign system
    Exported: 0x00000002, //  exported to foreign system
};
exports.StateFlags0 = StateFlags0;

// Category: WellKnownMetaCategories.FtnProperty ("FtnProperty")
const FtnPropertyNames = {
    //  packet header oriented
    FtnOrigNode: 'ftn_orig_node',
    FtnDestNode: 'ftn_dest_node',
    //  :TODO: rename these to ftn_*_net vs network - ensure things won't break, may need mapping
    FtnOrigNetwork: 'ftn_orig_network',
    FtnDestNetwork: 'ftn_dest_network',
    FtnAttrFlags: 'ftn_attr_flags',
    FtnCost: 'ftn_cost',
    FtnOrigZone: 'ftn_orig_zone',
    FtnDestZone: 'ftn_dest_zone',
    FtnOrigPoint: 'ftn_orig_point',
    FtnDestPoint: 'ftn_dest_point',

    //  message header oriented
    FtnMsgOrigNode: 'ftn_msg_orig_node',
    FtnMsgDestNode: 'ftn_msg_dest_node',
    FtnMsgOrigNet: 'ftn_msg_orig_net',
    FtnMsgDestNet: 'ftn_msg_dest_net',

    FtnAttribute: 'ftn_attribute',

    FtnTearLine: 'ftn_tear_line', //  http://ftsc.org/docs/fts-0004.001
    FtnOrigin: 'ftn_origin', //  http://ftsc.org/docs/fts-0004.001
    FtnArea: 'ftn_area', //  http://ftsc.org/docs/fts-0004.001
    FtnSeenBy: 'ftn_seen_by', //  http://ftsc.org/docs/fts-0004.001
};
exports.FtnPropertyNames = FtnPropertyNames;

//  Category: WellKnownMetaCategories.QwkProperty
const QWKPropertyNames = {
    MessageNumber: 'qwk_msg_num',
    MessageStatus: 'qwk_msg_status', //  See http://wiki.synchro.net/ref:qwk for a decent list
    ConferenceNumber: 'qwk_conf_num',
    InReplyToNum: 'qwk_in_reply_to_num', //  note that we prefer the 'InReplyToMsgId' kludge if available
};
exports.QWKPropertyNames = QWKPropertyNames;

// Category: WellKnownMetaCategories.ActivityPub
const ActivityPubPropertyNames = {
    ActivityId: 'activitypub_activity_id', //  Activity ID; FK to AP table entries
    InReplyTo: 'activitypub_in_reply_to', //  Activity ID from 'inReplyTo' field
    NoteId: 'activitypub_note_id', // Note ID specific to Note Activities
};
exports.ActivityPubPropertyNames = ActivityPubPropertyNames;
