/* jslint node: true */
'use strict';

//
//  Sparse metadata for the configuration schema.
//
//  core/config_default.js already supplies shape, type and default for most of
//  the tree, mechanically and with no chance of drifting. This file adds only
//  what a default *value* cannot tell us:
//
//    * |openMap|: the keys here are sysop data -- area tags, network names,
//      node addresses -- not setting names. An unrecognised key in one of
//      these is content, never a typo, and must not be reported.
//
//    * Paths the code reads that config_default.js never declares. Without an
//      entry, a perfectly legitimate setting reads as an unknown key. These
//      are not optional polish; see the plan's §0.2.
//
//    * |type| for a node whose default is null, {} or [] and so carries no
//      type at all. Inference deliberately gives up on those rather than
//      guessing; declaring a type here restores checking.
//
//    * |description| / |enum| / |min| / |max| for settings a human has to
//      reason about. Sparse by design and grown over time -- see the plan.
//
//  Keys are dotted paths. A "*" segment matches exactly one open map key, so
//  "messageConferences.*.areas" describes the areas block of every conference.
//
//  Everything here is optional: a node with no entry still gets shape, type
//  and default from config_default.js. Nothing in this file is required for
//  the schema to build.
//

module.exports = {
    //  ── Message conferences and areas ────────────────────────────────────
    //  Conference tags and area tags are chosen by the sysop.
    messageConferences: { openMap: true },
    'messageConferences.*.areas': { openMap: true },

    //  ── File base ────────────────────────────────────────────────────────
    'fileBase.storageTags': {
        openMap: true,
        value: { type: 'string' },
        description: 'Maps a storage tag to a directory holding that area\'s files.',
    },
    //
    //  The two areas shipped in config_default.js are exemplars, not a key
    //  list: a real area also carries acs, hashTags, sort and friends. The
    //  derived value shape therefore types the keys it knows and tolerates
    //  the rest.
    //
    'fileBase.areas': { openMap: true },

    //  ── Message networks ─────────────────────────────────────────────────
    //
    //  Absent from config_default.js in its entirety, so every level has to
    //  be declared. The key sets below are closed because they are short and
    //  fully enumerable from the code that reads them -- and because a typo
    //  in a network name is one of the failure modes this whole effort exists
    //  to catch.
    //
    messageNetworks: { type: 'object', closedKeys: true },
    'messageNetworks.ftn': { type: 'object', closedKeys: true },
    'messageNetworks.ftn.networks': { openMap: true },
    'messageNetworks.ftn.areas': { openMap: true },
    'messageNetworks.ftn.netMail': { type: 'object', closedKeys: true },
    'messageNetworks.ftn.netMail.aliases': { openMap: true },
    'messageNetworks.ftn.areaFixStatusPhrases': { type: 'object' },
    'messageNetworks.qwk': { type: 'object', closedKeys: true },
    'messageNetworks.qwk.areas': { openMap: true },
    'messageNetworks.qwk.bbsID': { type: 'string' },

    //  ── FTN BSO scanner/tosser ───────────────────────────────────────────
    'scannerTossers.ftn_bso.nodes': { openMap: true },
    'scannerTossers.ftn_bso.ticAreas': { openMap: true },
    'scannerTossers.ftn_bso.netMail.routes': { openMap: true },
    'scannerTossers.ftn_bso.binkp.nodes': { openMap: true },
    'scannerTossers.ftn_bso.binkp.tempDir': { type: 'string' },

    //  ── Content servers ──────────────────────────────────────────────────
    //
    //  Handler names come from modules discovered on disk, so a mod may add
    //  its own -- see core/web_handler_module.js:17-18. The template's
    //  restApi block is one of these.
    //
    'contentServers.web.handlers': { openMap: true },

    'contentServers.nntp.allowPosts': { type: 'boolean' },
    //
    //  Documented at config_default.js:435 as confTag -> [ areaTag, ... ].
    //  Its default is {}, so it is also one of the untyped nodes below.
    //
    'contentServers.nntp.publicMessageConferences': {
        openMap: true,
        value: { type: 'array', items: { type: 'string' } },
        description:
            'Conferences and areas exposed to anonymous NNTP users, as confTag -> [ areaTag, ... ].',
    },

    'contentServers.gopher.exposedConfAreas': { openMap: true },
    'contentServers.gopher.messageConferences': {
        openMap: true,
        description: 'Deprecated; use exposedConfAreas.',
    },

    //  ── Login servers ────────────────────────────────────────────────────
    'loginServers.webSocket.proxied': {
        type: 'boolean',
        description: 'Trust X-Forwarded-For when behind a reverse proxy.',
    },
    'loginServers.ssh.privateKeyPass': { type: 'string' },

    //  ── Chat servers ─────────────────────────────────────────────────────
    //  Present in the config template but not in the defaults.
    'chatServers.mrc.infoDesc': { type: 'string' },
    'chatServers.mrc.infoSsh': { type: 'string' },
    'chatServers.mrc.infoSysop': { type: 'string' },
    'chatServers.mrc.infoTelnet': { type: 'string' },
    'chatServers.mrc.infoWeb': { type: 'string' },

    //  ── Miscellaneous open maps ──────────────────────────────────────────
    fileTypes: { openMap: true }, //  keyed by MIME type
    'archives.archivers': { openMap: true },
    fileTransferProtocols: { openMap: true },
    'eventScheduler.events': { openMap: true },
    infoExtractUtils: { openMap: true },

    //  ── Untyped nodes (default is null / {} and tells us nothing) ────────
    //
    //  null is the documented "unset" sentinel for both of these, so it stays
    //  legal alongside the declared type -- see core/client_term.js:92 and
    //  core/scanner_tossers/email.js:172-173.
    //
    'term.forceOutputEncoding': {
        type: 'string',
        nullable: true,
        description: 'Force an output encoding rather than autodetecting; null to autodetect.',
    },
    'email.outbound.fromDomain': {
        type: 'string',
        nullable: true,
        description: 'Domain used for generated From addresses; null falls back to defaultFrom.',
    },

    //  ── Validation's own knob ────────────────────────────────────────────
    //  Two valued on purpose: nothing ever refuses to boot, so no 'strict'.
    'general.configValidation': {
        type: 'string',
        enum: ['warn', 'off'],
        description:
            'Report configuration problems at startup and on reload, or stay silent.',
    },

    //  ── Root ─────────────────────────────────────────────────────────────
    includes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional hjson files merged into this configuration.',
    },
};
