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

//  Every server that binds reads this the same way; unset means all
//  interfaces.
const BIND_ADDRESS = {
    type: 'string',
    description: 'Interface to bind to. Unset binds every interface.',
};

//  Every port in the tree means the same thing and has the same bounds.
//  Non-privileged ports are the norm here: the documented pattern is to run
//  unprivileged and NAT or forward the well-known port to it.
const PORT = { type: 'number', min: 1, max: 65535 };

const port = description => Object.assign({ description }, PORT);

//
//  Values copied from code rather than referenced, because meta.js is loaded
//  on the configuration path and requiring the modules that own these would
//  drag otplib and friends into it. test/config_meta.test.js asserts each of
//  these still matches its source, so a copy cannot drift unnoticed.
//
const OTP_METHODS = ['googleAuth', 'rfc6238_TOTP', 'rfc4266_HOTP']; //  user_2fa_otp.js
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']; //  bunyan

module.exports = {
    //  ── General ──────────────────────────────────────────────────────────
    'general.boardName': {
        type: 'string',
        description:
            'Name of the board. Also what FTN packets and NNTP responses identify this system as.',
    },
    'general.prettyBoardName': {
        type: 'string',
        description: 'Board name for display; may contain pipe colour codes.',
    },
    'general.telnetHostname': {
        type: 'string',
        description:
            'Hostname shown to users for telnet. Advertised only -- it does not affect what the server binds.',
    },
    'general.sshHostname': {
        type: 'string',
        description:
            'Hostname shown to users for SSH. Advertised only -- it does not affect what the server binds.',
    },
    'general.website': { type: 'string' },
    'general.description': {
        type: 'string',
        description: 'One line describing the board, used where a summary is wanted.',
    },
    'general.closedSystem': {
        type: 'boolean',
        description: 'Refuse new user applications.',
    },
    'general.menuFile': {
        type: 'string',
        description:
            'Menu configuration file. Relative names resolve against the config directory.',
    },
    'general.achievementFile': {
        type: 'string',
        description:
            'Achievement configuration file. Relative names resolve against the config directory.',
    },
    'general.maxConnections': {
        type: 'number',
        min: 0,
        description:
            'Simultaneous connections allowed across every login server. 0 for unlimited.',
    },
    'general.language': {
        type: 'string',
        description:
            "BCP 47 language tag for the board, e.g. 'en-US'. Reported to doors; ENiGMA½ itself is not translated.",
    },

    //  ── Terminal ─────────────────────────────────────────────────────────
    'term.checkUtf8Encoding': {
        type: 'boolean',
        description:
            'Detect UTF-8 by cursor position report. Costs a 2 second connect delay on terminals that do not answer.',
    },
    'term.checkAnsiHomePosition': {
        type: 'boolean',
        description:
            'Detect non-standard positioning by cursor position report. Costs a 3 second connect delay on terminals that do not answer.',
    },
    'term.cp437TermList': {
        type: 'array',
        items: { type: 'string' },
        description: 'Terminal types assumed to be CP437 without probing.',
    },
    'term.utf8TermList': {
        type: 'array',
        items: { type: 'string' },
        description: 'Terminal types assumed to be UTF-8 without probing.',
    },

    //  ── Users ────────────────────────────────────────────────────────────
    'users.usernameMin': { type: 'number', min: 1 },
    'users.usernameMax': { type: 'number', min: 1 },
    'users.usernamePattern': {
        type: 'string',
        description: 'Regular expression, as a string, that a new user name must match.',
    },
    'users.passwordMin': { type: 'number', min: 1 },
    'users.passwordMax': { type: 'number', min: 1 },
    'users.newUserNames': {
        type: 'array',
        items: { type: 'string' },
        description: 'Names that start the new user application instead of a login.',
    },
    'users.badUserNames': {
        type: 'array',
        items: { type: 'string' },
        description: 'Names nobody may apply for.',
    },
    'users.requireActivation': {
        type: 'boolean',
        description: 'New accounts stay inactive until the sysop activates them.',
    },
    'users.preAuthIdleLogoutSeconds': {
        type: 'number',
        min: 0,
        description: 'Idle timeout before login. 0 never disconnects.',
    },
    'users.idleLogoutSeconds': {
        type: 'number',
        min: 0,
        description: 'Idle timeout once logged in. 0 never disconnects.',
    },
    'users.failedLogin.disconnect': {
        type: 'number',
        min: 0,
        description: 'Failed attempts in one session before the connection is dropped. 0 never drops.',
    },
    'users.failedLogin.lockAccount': {
        type: 'number',
        min: 0,
        description: 'Failed attempts before the account is locked. 0 never locks.',
    },
    'users.failedLogin.autoUnlockMinutes': {
        type: 'number',
        min: 0,
        description: 'Unlock a locked account after this long. 0 requires the sysop to unlock it.',
    },
    'users.unlockAtEmailPwReset': {
        type: 'boolean',
        description: 'A successful password reset by email also unlocks a locked account.',
    },
    'users.twoFactorAuth.method': {
        type: 'string',
        enum: OTP_METHODS,
        description: 'One time password scheme offered for two factor authentication.',
    },

    //  ── Theme ────────────────────────────────────────────────────────────
    //
    //  Both accept "*", which picks a random theme per user rather than naming
    //  one -- see core/nua.js and core/servers/login/login_server_module.js.
    //  Nothing here checks the id names a theme that exists; that needs the
    //  theme list, which loads later.
    //
    'theme.default': {
        type: 'string',
        description:
            'Theme for logged in users: a directory name under paths.themes, or "*" to pick one at random.',
    },
    'theme.preLogin': {
        type: 'string',
        description:
            'Theme used before login: a directory name under paths.themes, or "*" to pick one at random.',
    },
    'theme.passwordChar': {
        type: 'string',
        description: 'Character echoed in place of a password.',
    },

    //  ── Logging ──────────────────────────────────────────────────────────
    //  The rotatingFile block is handed to bunyan as a stream definition.
    'logging.rotatingFile.level': {
        type: 'string',
        enum: LOG_LEVELS,
        description: 'Lowest severity written to the log.',
    },
    'logging.rotatingFile.fileName': {
        type: 'string',
        description: 'Log file name, created under paths.logs.',
    },
    'logging.rotatingFile.period': {
        type: 'string',
        description: 'Rotation period, e.g. "1d" or "1w".',
    },
    'logging.rotatingFile.count': {
        type: 'number',
        min: 0,
        description: 'Rotated files to keep.',
    },
    'contentServers.web.logging.rotatingFile.level': {
        type: 'string',
        enum: LOG_LEVELS,
        description: 'Lowest severity written to the web server log.',
    },

    //  ── Message area defaults ────────────────────────────────────────────
    'messageAreaDefaults.maxMessages': {
        type: 'number',
        min: 0,
        description:
            'Messages kept per area before the oldest are trimmed. 0 keeps everything.',
    },
    'messageAreaDefaults.maxAgeDays': {
        type: 'number',
        min: 0,
        description: 'Age at which messages are trimmed. 0 keeps everything.',
    },

    //  ── Stat log ─────────────────────────────────────────────────────────
    'statLog.systemEvents.loginHistoryMax': {
        type: 'number',
        min: -1,
        description: 'Login history entries kept. -1 keeps everything.',
    },

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
    'fileBase.areaStoragePrefix': {
        type: 'string',
        description: 'Directory a relative storage tag path is resolved against.',
    },
    'fileBase.web.expireMinutes': {
        type: 'number',
        min: 1,
        description: 'How long a generated web download link stays valid.',
    },

    //  ── Message networks ─────────────────────────────────────────────────
    //
    //  Absent from config_default.js in its entirety, so every level has to
    //  be declared. The key sets below are closed because they are short and
    //  fully enumerable from the code that reads them -- and because a typo
    //  in a network name is one of the failure modes this whole effort exists
    //  to catch.
    //
    messageNetworks: { type: 'object', closedKeys: true },
    'messageNetworks.originLine': {
        type: 'string',
        description: 'Origin line appended to exported FTN messages.',
    },
    'messageNetworks.ftn': { type: 'object', closedKeys: true },
    'messageNetworks.ftn.networks': { openMap: true },
    'messageNetworks.ftn.areas': { openMap: true },
    'messageNetworks.ftn.netMail': { type: 'object', closedKeys: true },
    'messageNetworks.ftn.netMail.aliases': { openMap: true },
    'messageNetworks.ftn.areaFixStatusPhrases': { type: 'object' },
    'messageNetworks.qwk': { type: 'object', closedKeys: true },
    'messageNetworks.qwk.areas': { openMap: true },
    'messageNetworks.qwk.bbsID': { type: 'string' },

    'messageNetworks.bluewave': { type: 'object', closedKeys: true },
    //
    //  A mistyped key here is silently ignored and the derived value used
    //  instead -- for 'echotag' that quietly changes what a reply routes by --
    //  so the value shape is closed even though the area tags above are not.
    //
    'messageNetworks.bluewave.areas': {
        openMap: true,
        value: {
            type: 'object',
            closedKeys: true,
            children: {
                number: { type: 'number' },
                echotag: { type: 'string' },
                title: { type: 'string' },
            },
        },
    },
    'messageNetworks.bluewave.bbsID': {
        type: 'string',
        description:
            'Packet ID: the 1-8 character root name every file in a Blue Wave packet shares.',
    },

    //  ── FTN BSO scanner/tosser ───────────────────────────────────────────
    'scannerTossers.ftn_bso.nodes': { openMap: true },
    //
    //  Unlike a file area, a ticAreas entry has a short, documented and
    //  fully enumerable key set -- docs/_docs/filebase/tic-support.md lists
    //  it -- so this one really can be closed. That matters: 'storageTags'
    //  for 'storageTag', or 'hashTag' for 'hashTags', is silently ignored by
    //  the importer and the override simply never happens.
    //
    'scannerTossers.ftn_bso.ticAreas': {
        openMap: true,
        value: {
            type: 'object',
            closedKeys: true,
            //  a bare string is shorthand for { areaTag: <it> }
            scalarShorthand: true,
            children: {
                areaTag: { type: 'string' },
                storageTag: { type: 'string' },
                //  one or more; a comma separated string or an array
                hashTags: {},
                network: { type: 'string' },
                downlinks: {},
                uplinks: {},
            },
        },
    },
    'scannerTossers.ftn_bso.netMail.routes': { openMap: true },
    'scannerTossers.ftn_bso.binkp.nodes': { openMap: true },
    'scannerTossers.ftn_bso.binkp.tempDir': { type: 'string' },
    //  null, false and '' all mean "no default network" -- every network gets
    //  its own suffixed directory and nothing lands in outbound/. See
    //  resolveDefaultNetworkName() in core/bso_util.js, which is explicit about
    //  it, and the BSO Import / Export docs, which document setting it to null.
    'scannerTossers.ftn_bso.defaultNetwork': {
        type: 'string',
        nullable: true,
        description:
            'Network whose outbound goes in the unsuffixed directory; null for none.',
    },
    'scannerTossers.ftn_bso.schedule': { type: 'object' },
    'scannerTossers.ftn_bso.packetTargetByteSize': {
        type: 'number',
        min: 1,
        description: 'Start a new packet once the current one passes this size.',
    },
    'scannerTossers.ftn_bso.bundleTargetByteSize': {
        type: 'number',
        min: 1,
        description: 'Start a new bundle once the current one passes this size.',
    },
    'scannerTossers.ftn_bso.packetMsgEncoding': {
        type: 'string',
        description: 'Encoding for exported message text, e.g. "cp437" or "utf8".',
    },
    'scannerTossers.ftn_bso.packetAnsiMsgEncoding': {
        type: 'string',
        description: 'Encoding for exported messages containing ANSI art.',
    },
    'scannerTossers.ftn_bso.binkp.inbound.port': PORT,
    'scannerTossers.ftn_bso.binkp.inbound.enabled': {
        type: 'boolean',
        description: 'Listen for inbound BinkP sessions.',
    },
    'scannerTossers.ftn_bso.binkp.pullSchedule': {
        type: 'string',
        description:
            'When to poll uplinks for waiting mail, in the same syntax as eventScheduler.',
    },

    //
    //  TIC. Every enum below is the full set the code recognises; see
    //  docs/_docs/filebase/tic-support.md.
    //
    'scannerTossers.ftn_bso.tic.descPriority': {
        type: 'string',
        enum: ['diz', 'tic'],
        description:
            'Where a file description comes from: "diz" prefers a FILE_ID.DIZ inside the file, "tic" prefers the TIC\'s own Ldesc.',
    },
    'scannerTossers.ftn_bso.tic.fileCase': {
        type: 'string',
        enum: ['lower', 'upper'],
        description: 'Case of generated packet and bundle file names.',
    },
    'scannerTossers.ftn_bso.tic.addressDimensions': {
        type: 'string',
        enum: ['3D', '4D', '5D'],
        description:
            'Address form written into generated TICs. Seenby is always 4D regardless.',
    },
    'scannerTossers.ftn_bso.tic.secureInOnly': {
        type: 'boolean',
        description: 'Import only from the secure inbound, never the unsecure one.',
    },
    'scannerTossers.ftn_bso.tic.uploadBy': {
        type: 'string',
        description: 'Uploader name recorded against files imported from a TIC.',
    },
    'scannerTossers.ftn_bso.tic.allowReplace': {
        type: 'boolean',
        description: 'Honour a TIC\'s Replaces field and remove the file it names.',
    },
    'scannerTossers.ftn_bso.tic.holdMaxAgeMs': {
        type: 'number',
        min: 0,
        description:
            'How long a TIC whose file has not arrived is held before being rejected.',
    },
    'scannerTossers.ftn_bso.paths.retain': {
        type: 'string',
        description: 'Copy processed packets here; debugging aid.',
    },

    //  ── Content servers ──────────────────────────────────────────────────
    //
    //  Handler names come from modules discovered on disk, so a mod may add
    //  its own -- see core/web_handler_module.js:17-18. The template's
    //  restApi block is one of these.
    //
    'contentServers.web.handlers': { openMap: true },

    'contentServers.web.http.port': PORT,
    'contentServers.web.https.port': PORT,
    'contentServers.web.domain': {
        type: 'string',
        description: 'Domain this board is reached at; used to build links in email and on the web.',
    },
    'contentServers.gopher.port': PORT,
    'contentServers.gopher.publicPort': port(
        'Port advertised in Gopher selectors, for when the board is reached through a forward.'
    ),
    'contentServers.gopher.publicHostname': {
        type: 'string',
        description: 'Hostname advertised in Gopher selectors.',
    },
    'contentServers.nntp.nntp.port': PORT,
    'contentServers.nntp.nntps.port': PORT,
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

    'contentServers.web.overrideUrlPrefix': {
        type: 'string',
        description: 'Replaces the derived scheme://host prefix in generated URLs.',
    },
    //  The handler toggle lives under handlers.restApi; its settings live here
    'contentServers.web.restApi': { type: 'object' },

    //  ── Login servers ────────────────────────────────────────────────────
    'loginServers.telnet.port': PORT,
    'loginServers.telnet.enabled': { type: 'boolean' },
    'loginServers.telnet.firstMenu': {
        type: 'string',
        description: 'Menu entered on connect; must name an entry in menu.hjson.',
    },
    'loginServers.ssh.port': PORT,
    'loginServers.ssh.enabled': { type: 'boolean' },
    'loginServers.ssh.privateKeyPem': {
        type: 'string',
        description: 'Host key in traditional PEM form; a modern OpenSSH key will not load.',
    },
    'loginServers.ssh.firstMenu': {
        type: 'string',
        description: 'Menu entered on connect; must name an entry in menu.hjson.',
    },
    'loginServers.ssh.firstMenuNewUser': {
        type: 'string',
        description:
            'Menu entered when connecting as one of users.newUserNames; must name an entry in menu.hjson.',
    },
    'loginServers.webSocket.ws.port': PORT,
    'loginServers.webSocket.wss.port': PORT,
    'loginServers.webSocket.proxied': {
        type: 'boolean',
        description: 'Trust X-Forwarded-For when behind a reverse proxy.',
    },
    'loginServers.ssh.privateKeyPass': { type: 'string' },

    //
    //  ── Bind addresses ───────────────────────────────────────────────────
    //
    //  Undefaulted because unset means "every interface", which is what most
    //  boards want. Only the servers below actually read it: NNTP listens via
    //  a URI and MRC does not bind at all, so an "address" under either of
    //  those really is inert and should keep being reported.
    //
    'loginServers.telnet.address': BIND_ADDRESS,
    'loginServers.ssh.address': BIND_ADDRESS,
    'loginServers.webSocket.ws.address': BIND_ADDRESS,
    'loginServers.webSocket.wss.address': BIND_ADDRESS,
    'contentServers.web.http.address': BIND_ADDRESS,
    'contentServers.web.https.address': BIND_ADDRESS,
    'contentServers.gopher.address': BIND_ADDRESS,

    //  ── Email ────────────────────────────────────────────────────────────
    //  Read but never defaulted; see core/email.js:17-23 and
    //  core/scanner_tossers/email.js:258-309.
    'email.transport': {
        type: 'object',
        description: 'nodemailer transport options.',
    },
    'email.defaultFrom': { type: 'string' },
    'email.inbound.imap.port': PORT,
    'email.inbound.imap.secure': {
        type: 'boolean',
        description: 'Connect with TLS from the start, as port 993 expects.',
    },
    'email.inbound.imap.pollIntervalMs': {
        type: 'number',
        min: 0,
        description: 'How often to poll for new mail. 0 uses IMAP IDLE instead of polling.',
    },
    'email.inbound.imap.maxMessagesPerRun': {
        type: 'number',
        min: 1,
        description: 'Messages processed per pass, so a large backlog cannot stall a run.',
    },
    'email.inbound.imap.host': { type: 'string' },
    'email.inbound.imap.user': { type: 'string' },
    'email.inbound.imap.password': { type: 'string' },
    'email.inbound.imap.processedFolder': { type: 'string' },
    'email.inbound.imap.failedFolder': { type: 'string' },

    //  ── Chat servers ─────────────────────────────────────────────────────
    //  Present in the config template but not in the defaults.
    'chatServers.mrc.serverPort': PORT,
    'chatServers.mrc.serverSslPort': PORT,
    'chatServers.mrc.multiplexerPort': port(
        'Local port the MRC multiplexer listens on for this board.'
    ),
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
