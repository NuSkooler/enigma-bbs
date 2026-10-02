/* jslint node: true */
'use strict';

//  ENiGMA½
const Message = require('./message.js');
const { getAllAvailableMessageAreaTags } = require('./message_area.js');

//  deps
const moment = require('moment');

//
//  The areas a caller has selected for an offline mail packet. The export
//  reads them, and the import replaces them from a Blue Wave reply packet's
//  offline configuration -- so they live here rather than in either menu
//  module, which would drag the other's dependencies along.
//

//  where Blue Wave keeps the caller's selection
const BlueWaveExportAreasProperty = 'bluewave_export_msg_areas';

//
//  The areas |client| has selected, from |propertyName|. A caller who has
//  never chosen gets every area they can see, from the beginning.
//
const getUserExportAreas = (client, propertyName) => {
    let exportAreas = client.user.getProperty(propertyName);
    try {
        exportAreas = JSON.parse(exportAreas).map(exportArea => {
            if (exportArea.newerThanTimestamp) {
                exportArea.newerThanTimestamp = moment(exportArea.newerThanTimestamp);
            }
            return exportArea;
        });
    } catch (e) {
        //  default to all public and private without 'since'
        exportAreas = getAllAvailableMessageAreaTags(client).map(areaTag => {
            return { areaTag };
        });

        //  Include user's private area
        exportAreas.push({
            areaTag: Message.WellKnownAreaTags.Private,
        });
    }

    return exportAreas;
};

//
//  Every area a Blue Wave packet lists for |client|, in the order it lists
//  them. The import accepts an area by the same rule, so a caller cannot turn
//  on anything their packet did not offer.
//
const blueWaveListedAreaTags = client =>
    getAllAvailableMessageAreaTags(client).concat([Message.WellKnownAreaTags.Private]);

module.exports = {
    BlueWaveExportAreasProperty,
    getUserExportAreas,
    blueWaveListedAreaTags,
};
