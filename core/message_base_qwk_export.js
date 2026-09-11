//  ENiGMA½
const MessageBaseOfflineExport = require('./message_base_offline_export.js');
const { QWKPacketWriter } = require('./qwk_mail_packet.js');
const Config = require('./config.js').get;

//  deps
const _ = require('lodash');

const UserProperties = {
    ExportOptions: 'qwk_export_options',
    ExportAreas: 'qwk_export_msg_areas',
};

exports.moduleInfo = {
    name: 'QWK Export',
    desc: 'Exports a QWK Packet for download',
    author: 'NuSkooler',
};

exports.getModule = class MessageBaseQWKExport extends MessageBaseOfflineExport {
    constructor(options) {
        super(options);

        this.config.bbsID =
            this.config.bbsID || _.get(Config(), 'messageNetworks.qwk.bbsID', 'ENIGMA');
    }

    get packetFormatName() {
        return 'QWK';
    }

    get userProperties() {
        return UserProperties;
    }

    defaultExportOptions() {
        return {
            enableQWKE: true,
            enableHeadersExtension: true,
            enableAtKludges: true,
            archiveFormat: 'application/zip',
        };
    }

    noResultsMenuName() {
        return 'qwkExportNoResults';
    }

    createPacketWriter(options) {
        return new QWKPacketWriter(
            Object.assign(options, {
                bbsID: this.config.bbsID,
            })
        );
    }
};
