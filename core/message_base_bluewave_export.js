/* jslint node: true */
'use strict';

//  ENiGMA½
const MessageBaseOfflineExport = require('./message_base_offline_export.js');
const { BlueWavePacketWriter } = require('./bluewave_mail_packet.js');
const Config = require('./config.js').get;

//  deps
const _ = require('lodash');

const UserProperties = {
    ExportOptions: 'bluewave_export_options',
    ExportAreas: 'bluewave_export_msg_areas',
};

exports.moduleInfo = {
    name: 'Blue Wave Export',
    desc: 'Exports a Blue Wave packet for download',
    author: 'ENiGMA½ Team',
};

exports.getModule = class MessageBaseBlueWaveExport extends MessageBaseOfflineExport {
    constructor(options) {
        super(options);

        this.config.bbsID =
            this.config.bbsID ||
            _.get(Config(), 'messageNetworks.bluewave.bbsID', 'ENIGMA');
    }

    get packetFormatName() {
        return 'Blue Wave';
    }

    get userProperties() {
        return UserProperties;
    }

    createPacketWriter(options) {
        return new BlueWavePacketWriter(
            Object.assign(options, {
                bbsID: this.config.bbsID,
            })
        );
    }

    //  no art ships with this module, so a menu carrying neither view is fine
    requiredViewIds() {
        return [];
    }

    noResultsMenuName() {
        return 'bluewaveExportNoResults';
    }

    //
    //  Blue Wave lists every area the caller can reach, not only those that
    //  had new mail, so a reader can post into a quiet one offline.
    //
    prepareAreaForExport(packetWriter, { areaTag }) {
        packetWriter.addArea(areaTag);
    }
};
