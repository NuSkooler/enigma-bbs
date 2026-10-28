/* jslint node: true */
'use strict';

//  ENiGMA½
const Message = require('./message.js');
const {
    getAllAvailableMessageAreaTags,
    getLowestMessageIdNewerThanTimestampByArea,
    getHighestMessageIdByArea,
    updateMessageAreaLastReadId,
} = require('./message_area.js');

//  deps
const async = require('async');
const moment = require('moment');

//
//  The areas a caller has selected for an offline mail packet. The export
//  reads them, and the import replaces them from a Blue Wave reply packet's
//  offline configuration -- so they live here rather than in either menu
//  module, which would drag the other's dependencies along.
//
//  One selection serves every format, and where each area's next packet
//  starts is the caller's online lastread pointer, so a message read online,
//  or downloaded in either format, is not packed again.
//

//  [ { areaTag } ], shared by QWK and Blue Wave
const OfflineMailAreasProperty = 'offline_mail_msg_areas';

//
//  Before #928 each format kept its own list, with a "newer than" timestamp
//  per area. Read once, to migrate; left in place so a downgrade still finds
//  them. Blue Wave's comes first: it is the only one a caller could have
//  chosen (from their reader), where QWK's is whatever was visible when they
//  first exported.
//
const LegacyExportAreasProperties = ['bluewave_export_msg_areas', 'qwk_export_msg_areas'];

//  null when |value| is not a stored list
const parseAreaList = value => {
    try {
        const list = JSON.parse(value);
        return Array.isArray(list) ? list.filter(entry => entry && entry.areaTag) : null;
    } catch (e) {
        return null;
    }
};

//  every area |client| can see, and their private mail
const defaultExportAreas = client =>
    getAllAvailableMessageAreaTags(client)
        .concat([Message.WellKnownAreaTags.Private])
        .map(areaTag => ({ areaTag }));

//
//  A legacy timestamp as a lastread ID: one short of the lowest ID newer than
//  it. Not "the highest ID at or before it" -- an import keeps its author's
//  date, so late echomail can carry an older date than messages already
//  exported, and the lowest ID after the stamp is the pointer that loses
//  nothing the timestamp would still have sent. With nothing newer, the area
//  is caught up; an empty area has no pointer to give.
//
const lastReadIdForTimestamp = (areaTag, timestamp, cb) => {
    getLowestMessageIdNewerThanTimestampByArea(areaTag, timestamp, (err, lowestId) => {
        if (err) {
            return cb(err);
        }
        if (lowestId) {
            return cb(null, lowestId - 1);
        }
        return getHighestMessageIdByArea(areaTag, cb);
    });
};

//
//  Moves each legacy timestamp onto the caller's lastread, taking the later
//  of the two formats' for an area. A pointer only ever moves forward, so a
//  caller who has read further online keeps their place.
//
const migrateLegacyPointers = (user, legacyLists, cb) => {
    const latest = new Map();
    legacyLists.forEach(list => {
        (list || []).forEach(({ areaTag, newerThanTimestamp }) => {
            const ts = newerThanTimestamp && moment(newerThanTimestamp);
            if (!ts || !ts.isValid()) {
                return;
            }
            const seen = latest.get(areaTag);
            if (!seen || ts.isAfter(seen)) {
                latest.set(areaTag, ts);
            }
        });
    });

    async.eachSeries(
        [...latest.keys()],
        (areaTag, nextArea) => {
            lastReadIdForTimestamp(areaTag, latest.get(areaTag), (err, lastReadId) => {
                if (err || !lastReadId) {
                    return nextArea(err);
                }
                return updateMessageAreaLastReadId(
                    user.userId,
                    areaTag,
                    lastReadId,
                    false, //  never backwards
                    nextArea
                );
            });
        },
        cb
    );
};

//
//  The areas |client| has selected, as [ { areaTag } ]. A caller who has never
//  chosen gets every area they can see; that is not stored, so it follows
//  the areas they can see until something chooses for them.
//
//  A caller with only the pre-#928 per-format lists is migrated here, on
//  first read: the selection is taken from them and stored, and their
//  timestamps become lastread pointers.
//
const getUserExportAreas = (client, cb) => {
    const user = client.user;

    const stored = parseAreaList(user.getProperty(OfflineMailAreasProperty));
    if (stored) {
        return cb(
            null,
            stored.map(({ areaTag }) => ({ areaTag }))
        );
    }

    const legacyLists = LegacyExportAreasProperties.map(name =>
        parseAreaList(user.getProperty(name))
    );
    const legacySelection = legacyLists.find(list => list);
    if (!legacySelection) {
        return cb(null, defaultExportAreas(client));
    }

    const exportAreas = legacySelection.map(({ areaTag }) => ({ areaTag }));

    //  pointers before the selection: a failure part way leaves the selection
    //  unstored, so the next read tries again, and a pointer moved twice
    //  ends up in the same place
    migrateLegacyPointers(user, legacyLists, err => {
        if (err) {
            return cb(err);
        }

        //  the pointers have moved, so this export can go ahead regardless;
        //  the next read migrates again, and a pointer only moves forward
        user.persistProperty(
            OfflineMailAreasProperty,
            JSON.stringify(exportAreas),
            err => {
                if (err) {
                    client.log.warn(
                        { error: err.message },
                        'Could not store the migrated offline mail areas'
                    );
                } else {
                    client.log.info(
                        { areas: exportAreas.length },
                        'Migrated offline mail areas and scan pointers'
                    );
                }
                return cb(null, exportAreas);
            }
        );
    });
};

//
//  Every area a Blue Wave packet lists for |client|, in the order it lists
//  them. The import accepts an area by the same rule, so a caller cannot turn
//  on anything their packet did not offer.
//
const blueWaveListedAreaTags = client =>
    getAllAvailableMessageAreaTags(client).concat([Message.WellKnownAreaTags.Private]);

module.exports = {
    OfflineMailAreasProperty,
    LegacyExportAreasProperties,
    getUserExportAreas,
    blueWaveListedAreaTags,
};
