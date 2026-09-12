/* jslint node: true */
'use strict';

//  ENiGMA½
const MessageBaseOfflineExport = require('./message_base_offline_export.js');
const { BlueWavePacketWriter } = require('./bluewave_mail_packet.js');
const Config = require('./config.js').get;

//  deps
const _ = require('lodash');

//
//  What a board needs on a menu before a caller has anywhere to upload a
//  reply packet. The key is the sysop's to add, and an upgraded board has
//  whatever menus it already had.
//
const ImportModuleName = 'message_base_offline_import';

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
                acceptsReplies: this.acceptsReplies(),
            })
        );
    }

    //
    //  The caller's own merged menus, so a board that has not added the
    //  upload does not advertise replies, and one that has does -- without
    //  the sysop configuring the same fact twice.
    //
    acceptsReplies() {
        const menus = _.get(this.client, 'currentTheme.menus');
        if (!_.isObject(menus)) {
            return false;
        }

        return Object.keys(menus).some(
            name => ImportModuleName === _.get(menus[name], 'module')
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
