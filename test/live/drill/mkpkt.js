'use strict';

//
//  Write an inbound EchoMail packet into the drill's real inbound directory,
//  as a mailer would. Area tags come from DRILL_AREAS.
//

const paths = require('path');

const ROOT = paths.join(__dirname, '..', '..', '..');
const DRILL = process.argv[2];
const NAME = process.argv[3] || 'drill001.pkt';

//  the packet writer asserts against Config(); it needs nothing else here
require(paths.join(ROOT, 'core/config.js')).get = () => ({
    debug: { assertsEnabled: false },
});

const { Packet, PacketHeader } = require(paths.join(ROOT, 'core/ftn_mail_packet.js'));
const Message = require(paths.join(ROOT, 'core/message.js'));

const header = new PacketHeader();
header.origZone = 21;
header.origNet = 1;
header.origNode = 100;
header.destZone = 21;
header.destNet = 1;
header.destNode = 121;

const areas = (process.env.DRILL_AREAS || 'TST_GEN,TST_BBS,TST_ART,TST_NOISY').split(',');

const messages = areas.map(areaTag => {
    const message = new Message({
        toUserName: 'All',
        fromUserName: 'Remote User',
        subject: `message for ${areaTag}`,
        message: 'Body of the message.',
        areaTag: 'placeholder',
    });
    message.meta.FtnProperty = Object.assign({}, message.meta.FtnProperty, {
        ftn_area: areaTag,
    });
    message.meta.FtnKludge = {
        MSGID: `21:1/100 ${Date.now().toString(16)}${Math.floor(Math.random() * 1e4)}`,
    };
    return message;
});

const out = paths.join(DRILL, 'in', NAME);
new Packet().write(out, header, messages, {}, err => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    //  the writer streams; let it flush before the tosser is told to look
    setTimeout(() => {
        console.log(`inbound: ${NAME} [${areas.join(', ')}]`);
        process.exit(0);
    }, 200);
});
