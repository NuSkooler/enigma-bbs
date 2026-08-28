'use strict';

//
//  A mock AreaFix robot.
//
//  It reads the request the board *actually sent* out of the outbound spool,
//  pulls the area tags out of it the way a real conference manager would, and
//  answers in a chosen tosser's dialect.
//
//  This cannot tell you how Mystic words its replies -- nothing local can.
//  What it does tell you is whether the whole loop works against a running
//  board, and which dialects the parser understands. An unrecognized reply is
//  supposed to degrade to "not understood" with the raw line rather than being
//  guessed at, and the `unknown` style below exercises exactly that.
//

const fs = require('fs');
const paths = require('path');

const ROOT = paths.join(__dirname, '..', '..', '..');
const [, , DRILL, style, opName] = process.argv;

require(paths.join(ROOT, 'core/config.js')).get = () => ({
    debug: { assertsEnabled: false },
});

const { Packet, PacketHeader } = require(paths.join(ROOT, 'core/ftn_mail_packet.js'));
const Message = require(paths.join(ROOT, 'core/message.js'));

const STYLES = {
    //  husky areafix.c -- dot fill
    husky: tag => ` ${tag} ${'.'.repeat(Math.max(3, 35 - tag.length))} added`,
    //  SBBSecho -- bare, trailing period
    sbbsecho: tag => `${tag} added.`,
    //  CrashMail II -- "%-30s STATUS", command character echoed back
    crashmail: tag => `+${tag.padEnd(30)}Attached`,
    //  SBBSecho rescan confirmation -- variable tail, matched by prefix
    rescanned: tag => `${tag} rescanned and 42 messages exported.`,
    //  wording none of the three use: must be reported, not guessed
    unknown: tag =>
        ` ${tag} ${'.'.repeat(Math.max(3, 35 - tag.length))} wibbled sideways`,
};

if (!STYLES[style]) {
    console.error(
        `robot: unknown style "${style}"; try ${Object.keys(STYLES).join(', ')}`
    );
    process.exit(2);
}

const walk = dir =>
    fs.existsSync(dir)
        ? fs
              .readdirSync(dir, { withFileTypes: true })
              .flatMap(d =>
                  d.isDirectory()
                      ? walk(paths.join(dir, d.name))
                      : [paths.join(dir, d.name)]
              )
        : [];

//  newest first: nothing drains the spool here, so older requests linger
const packets = walk(paths.join(DRILL, 'out'))
    .filter(f => /\.(pkt|out|cut|hut|dut|iut)$/i.test(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

if (0 === packets.length) {
    console.error('robot: no outbound request in the spool');
    process.exit(2);
}

new Packet({ keepTearAndOrigin: false }).read(
    packets[0],
    (type, data, next) => {
        if ('message' === type) {
            const tags = data.message
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean)
                .map(l => /^[=+%-]?\s*([A-Z0-9_.-]+)/i.exec(l))
                .filter(Boolean)
                .map(m => m[1])
                .filter(t => 'RESCAN' !== t.toUpperCase());

            console.log(
                `robot: read request to=${data.toUserName} password="${data.subject}" tags=${tags.join(',')}`
            );
            reply(tags);
        }
        return next(null);
    },
    err => {
        if (err) {
            console.error('robot: could not read the request:', err.message);
            process.exit(2);
        }
    }
);

function reply(tags) {
    const body = tags
        .map(STYLES[style])
        .concat([
            '',
            'Your linked areas:',
            //  an area we never asked about; must be ignored
            ' SOME_OTHER ....................... General chatter',
        ])
        .join('\r\n');

    const header = new PacketHeader();
    header.origZone = 21;
    header.origNet = 1;
    header.origNode = 100;
    header.destZone = 21;
    header.destNet = 1;
    header.destNode = 121;

    const message = new Message({
        toUserName: opName,
        fromUserName: 'AreaFix',
        subject: 'AreaFix Reply',
        message: body,
        areaTag: 'placeholder',
    });
    message.meta.FtnProperty = Object.assign({}, message.meta.FtnProperty, {
        ftn_attr_flags: Packet.Attribute.Private,
        ftn_orig_node: 100,
        ftn_orig_network: 1,
        ftn_dest_node: 121,
        ftn_dest_network: 1,
    });
    message.meta.FtnKludge = {
        INTL: '21:1/121 21:1/100',
        MSGID: `21:1/100 ${Date.now().toString(16)}`,
    };

    const out = paths.join(DRILL, 'in', `rply${Date.now().toString().slice(-4)}.pkt`);
    new Packet().write(out, header, [message], {}, err => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        setTimeout(() => {
            console.log(`robot: answered in ${style} dialect`);
            process.exit(0);
        }, 200);
    });
}
