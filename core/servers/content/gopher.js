/* jslint node: true */
'use strict';

//  ENiGMA½
const Log = require('../../logger.js').log;
const { ServerModule } = require('../../server_module.js');
const Config = require('../../config.js').get;
const { Errors } = require('../../enig_error.js');
const {
    splitTextAtTerms,
    isAnsi,
    stripAnsiControlCodes,
    wildcardMatch,
} = require('../../string_util.js');
const {
    getMessageConferenceByTag,
    getMessageAreaByTag,
    getMessageListForArea,
    getAvailableMessageAreasByConfTag,
} = require('../../message_area.js');
const { sortAreasOrConfs } = require('../../conf_area_util.js');
const AnsiPrep = require('../../ansi_prep.js');
const { wordWrapText } = require('../../word_wrap.js');
const { stripMciColorCodes } = require('../../color_codes.js');

//  deps
const net = require('net');
const _ = require('lodash');
const fs = require('graceful-fs');
const paths = require('path');
const moment = require('moment');

const ModuleInfo = (exports.moduleInfo = {
    name: 'Gopher',
    desc: 'A RFC-1436-ish Gopher Server',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.gopher.server',
    notes: 'https://tools.ietf.org/html/rfc1436',
});

const Message = require('../../message.js');

const ItemTypes = {
    Invalid: '', //  not really a type, of course!

    //  Canonical, RFC-1436
    TextFile: '0',
    SubMenu: '1',
    CCSONameserver: '2',
    Error: '3',
    BinHexFile: '4',
    DOSFile: '5',
    UuEncodedFile: '6',
    FullTextSearch: '7',
    Telnet: '8',
    BinaryFile: '9',
    AltServer: '+',
    GIFFile: 'g',
    ImageFile: 'I',
    Telnet3270: 'T',

    //  Non-canonical
    HtmlFile: 'h',
    InfoMessage: 'i',
    SoundFile: 's',
};

exports.getModule = class GopherModule extends ServerModule {
    constructor() {
        super();

        this.routes = new Map(); //  selector->generator => gopher item
        this.log = Log.child({ server: 'Gopher' });
    }

    createServer(cb) {
        if (!this.enabled) {
            return cb(null);
        }

        const config = Config();
        this.publicHostname = config.contentServers.gopher.publicHostname;
        this.publicPort = config.contentServers.gopher.publicPort;

        this.addRoute(
            /^\/?msgarea(\/[a-z0-9_-]+(\/[a-z0-9_-]+)?(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_raw)?)?)?\/?\r\n$/,
            this.messageAreaGenerator
        );
        this.addRoute(/^(\/?[^\t\r\n]*)\r\n$/, this.staticGenerator);

        this.server = net.createServer(socket => {
            socket.setEncoding('ascii');

            socket.on('data', data => {
                //  sanitize a bit - bots like to inject garbage
                data = data.replace(/[^ -~\t\r\n]/g, '');
                if (data) {
                    this.routeRequest(data, socket);
                } else {
                    this.notFoundGenerator('**invalid selector**', res => {
                        return socket.end(`${res}`);
                    });
                }
            });

            socket.on('error', err => {
                if ('ECONNRESET' !== err.code) {
                    //  normal
                    this.log.trace({ error: err.message }, 'Socket error');
                }
            });
        });

        return cb(null);
    }

    listen(cb) {
        if (!this.enabled) {
            return cb(null);
        }

        const config = Config();
        const port = parseInt(config.contentServers.gopher.port);
        if (isNaN(port)) {
            this.log.warn(
                { port: config.contentServers.gopher.port, server: ModuleInfo.name },
                'Invalid Gopher port'
            );
            return cb(
                Errors.Invalid(`Invalid port: ${config.contentServers.gopher.port}`)
            );
        }

        return this.server.listen(port, config.contentServers.gopher.address, cb);
    }

    get enabled() {
        return (
            _.get(Config(), 'contentServers.gopher.enabled', false) && this.isConfigured()
        );
    }

    isConfigured() {
        //  public hostname & port must be set; responses contain them!
        const config = Config();
        return (
            _.isString(_.get(config, 'contentServers.gopher.publicHostname')) &&
            _.isNumber(_.get(config, 'contentServers.gopher.publicPort'))
        );
    }

    addRoute(selectorRegExp, generatorHandler) {
        if (_.isString(selectorRegExp)) {
            try {
                selectorRegExp = new RegExp(`${selectorRegExp}\r\n`);
            } catch (e) {
                this.log.warn({ pattern: selectorRegExp }, 'Invalid RegExp for selector');
                return false;
            }
        }
        this.routes.set(selectorRegExp, generatorHandler.bind(this));
    }

    routeRequest(selector, socket) {
        let match;
        for (let [regex, gen] of this.routes) {
            match = selector.match(regex);
            if (match) {
                return gen(match, res => {
                    return socket.end(`${res}`);
                });
            }
        }
        this.notFoundGenerator(selector, res => {
            return socket.end(`${res}`);
        });
    }

    makeItem(itemType, text, selector, hostname, port) {
        selector = selector || ''; //  e.g. for info
        hostname = hostname || this.publicHostname;
        port = port || this.publicPort;
        return `${itemType}${text}\t${selector}\t${hostname}\t${port}\r\n`;
    }

    staticGenerator(selectorMatch, cb) {
        this.log.debug(
            { selector: selectorMatch[1] || '(gophermap)' },
            'Serving static content'
        );

        const requestedPath = selectorMatch[1];
        let path = this.resolveContentPath(requestedPath);
        if (!path) {
            return cb('Not found');
        }

        fs.stat(path, (err, stats) => {
            if (err) {
                return cb('Not found');
            }

            let isGopherMap = false;
            if (stats.isDirectory()) {
                path = paths.join(path, 'gophermap');
                isGopherMap = true;
            }

            fs.readFile(path, isGopherMap ? 'utf8' : null, (err, content) => {
                if (err) {
                    let content = 'You have reached an ENiGMA½ Gopher server!\r\n';
                    content += this.makeItem(
                        ItemTypes.SubMenu,
                        'Public Message Area',
                        '/msgarea'
                    );
                    return cb(content);
                }

                if (isGopherMap) {
                    //  Convert any UNIX style LF's to DOS CRLF's
                    content = content.replace(/\r?\n/g, '\r\n');

                    //  variable support
                    content = content
                        .replace(/{publicHostname}/g, this.publicHostname)
                        .replace(/{publicPort}/g, this.publicPort);
                }

                return cb(content);
            });
        });
    }

    resolveContentPath(requestPath) {
        const staticRoot = _.get(Config(), 'contentServers.gopher.staticRoot');
        const path = paths.resolve(staticRoot, `.${requestPath}`);
        if (path.startsWith(staticRoot)) {
            return path;
        }
    }

    notFoundGenerator(selector, cb) {
        this.log.debug({ selector }, 'Serving not found content');
        return cb('Not found');
    }

    _getConfigForConferenceTag(confTag) {
        const sysConfig = Config();
        let config = _.get(sysConfig, [
            'contentServers',
            'gopher',
            'exposedConfAreas',
            confTag,
        ]);
        if (config) {
            return [config, false]; // new
        }

        return [
            _.get(sysConfig, ['contentServers', 'gopher', 'messageConferences', confTag]),
            true,
        ];
    }

    isAreaAndConfExposed(confTag, areaTag) {
        const [confConfig, isLegacy] = this._getConfigForConferenceTag(confTag);

        if (isLegacy) {
            return Array.isArray(confConfig) && confConfig.includes(areaTag);
        }

        if (!Array.isArray(confConfig.include)) {
            return false;
        }

        let exposed = false;
        for (let rule of confConfig.include) {
            if (wildcardMatch(areaTag, rule)) {
                exposed = true;
                break;
            }
        }

        // may still be excluded
        for (let rule of confConfig.exclude || []) {
            if (wildcardMatch(areaTag, rule)) {
                exposed = false;
                break;
            }
        }

        return exposed;
    }

    prepareMessageBody(body, cb) {
        //
        //  From RFC-1436:
        //  "User display strings are intended to be displayed on a line on a
        //   typical screen for a user's viewing pleasure.  While many screens can
        //   accommodate 80 character lines, some space is needed to display a tag
        //   of some sort to tell the user what sort of item this is.  Because of
        //   this, the user display string should be kept under 70 characters in
        //   length.  Clients may truncate to a length convenient to them."
        //
        //  Messages on BBSes however, have generally been <= 79 characters. If we
        //  start wrapping earlier, things will generally be OK except:
        //  * When we're doing with FTN-style quoted lines
        //  * When dealing with ANSI/ASCII art
        //
        //  Anyway, the spec says "should" and not MUST or even SHOULD! ...so, to
        //  to follow the KISS principle: Wrap at 79.
        //
        const WordWrapColumn = 79;
        if (isAnsi(body)) {
            AnsiPrep(
                body,
                {
                    cols: WordWrapColumn, //  See notes above
                    forceLineTerm: true, //  Ensure each line is term'd
                    asciiMode: true, //  Export to ASCII
                    fillLines: false, //  Don't fill up to |cols|
                },
                (err, prepped) => {
                    return cb(prepped || body);
                }
            );
        } else {
            const cleaned = stripMciColorCodes(
                stripAnsiControlCodes(body, { all: true })
            );
            const prepped = splitTextAtTerms(cleaned)
                .map(l =>
                    (wordWrapText(l, { width: WordWrapColumn }).wrapped || []).join('\n')
                )
                .join('\n');

            return cb(prepped);
        }
    }

    shortenSubject(subject) {
        return _.truncate(subject, { length: 30 });
    }

    messageAreaGenerator(selectorMatch, cb) {
        this.log.trace({ selector: selectorMatch[0] }, 'Message area request');
        //
        //  Selector should be:
        //  /msgarea - list confs
        //  /msgarea/conftag - list areas in conf
        //  /msgarea/conftag/areatag - list messages in area
        //  /msgarea/conftag/areatag/<UUID> - message as text
        //  /msgarea/conftag/areatag/<UUID>_raw - full message as text + headers
        //
        if (selectorMatch[3] || selectorMatch[4]) {
            // message selector - display message
            //  message
            //const raw = selectorMatch[4] ? true : false;
            //  :TODO: support 'raw'
            const msgUuid = selectorMatch[3].replace(/\r\n|\//g, '');
            const confTag = selectorMatch[1].substr(1).split('/')[0];
            const areaTag = selectorMatch[2].replace(/\r\n|\//g, '');
            return this._displayMessage(selectorMatch, msgUuid, confTag, areaTag, cb);
        } else if (selectorMatch[2]) {
            //  conf/area selector -- list messages in area
            const confTag = selectorMatch[1].substr(1).split('/')[0];
            const areaTag = selectorMatch[2].replace(/\r\n|\//g, '');
            const area = getMessageAreaByTag(areaTag);
            return this._listMessagesInArea(selectorMatch, confTag, areaTag, area, cb);
        } else if (selectorMatch[1]) {
            //  message conference selector -- list areas in this conference
            const confTag = selectorMatch[1].replace(/\r\n|\//g, '');
            return this._listExposedMessageConferenceAreas(selectorMatch, confTag, cb);
        } else {
            //  message area base selector -- list exposed message conferences
            return this._listExposedMessageConferences(cb);
        }
    }

    _makeAvailableMessageConferencesResponse(messageConferences, cb) {
        sortAreasOrConfs(messageConferences);

        const response = [
            this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
            this.makeItem(ItemTypes.InfoMessage, 'Available Message Conferences'),
            this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
            this.makeItem(ItemTypes.InfoMessage, ''),
            ...messageConferences.map(conf =>
                this.makeItem(
                    ItemTypes.SubMenu,
                    `${conf.name} ${conf.desc ? '- ' + conf.desc : ''}`,
                    `/msgarea/${conf.confTag}`
                )
            ),
        ].join('');

        this.log.debug('Gopher serving message conference list');
        return cb(response);
    }

    _exposedMessageConferenceTags(obj) {
        return Object.keys(obj || {})
            .map(confTag =>
                Object.assign({ confTag }, getMessageConferenceByTag(confTag))
            )
            .filter(conf => conf); //  remove any baddies
    }

    _noExposedMessageConferences(cb) {
        return cb(
            this.makeItem(ItemTypes.InfoMessage, 'No message conferences available')
        );
    }

    // newer format
    _listExposedMessageConferences(cb) {
        let exposedConfs = _.get(Config(), 'contentServers.gopher.exposedConfAreas');
        if (!_.isObject(exposedConfs)) {
            return this._listExposedMessageConferencesLegacy(cb);
        }

        exposedConfs = this._exposedMessageConferenceTags(exposedConfs);
        if (0 === exposedConfs.length) {
            return this._noExposedMessageConferences(cb);
        }

        return this._makeAvailableMessageConferencesResponse(exposedConfs, cb);
    }

    // older deprecated format
    _listExposedMessageConferencesLegacy(cb) {
        const exposedConfs = this._exposedMessageConferenceTags(
            _.get(Config(), 'contentServers.gopher.messageConferences')
        );

        if (0 === exposedConfs.length) {
            return this._noExposedMessageConferences(cb);
        }

        return this._makeAvailableMessageConferencesResponse(exposedConfs, cb);
    }

    _makeAvailableMessageAreasResponse(exposedConf, exposedAreas, cb) {
        // ensure nothing private is present
        exposedAreas = exposedAreas.filter(
            area => area && !Message.isPrivateAreaTag(area.areaTag)
        );

        if (0 === exposedAreas.length) {
            return cb(this.makeItem(ItemTypes.InfoMessage, 'No message areas available'));
        }

        sortAreasOrConfs(exposedAreas);

        const response = [
            this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
            this.makeItem(ItemTypes.InfoMessage, `Message areas in ${exposedConf.name}`),
            this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
            ...exposedAreas.map(area =>
                this.makeItem(
                    ItemTypes.SubMenu,
                    `${area.name} ${area.desc ? '- ' + area.desc : ''}`,
                    `/msgarea/${exposedConf.confTag}/${area.areaTag}`
                )
            ),
        ].join('');

        this.log.debug(
            { confTag: exposedConf.confTag },
            'Gopher serving message area list'
        );
        return cb(response);
    }

    _listExposedMessageConferenceAreas(selectorMatch, confTag, cb) {
        //
        //  New system -- exposedConfAreas:
        //  We have a required array |include| of area tags that may
        //  contain wildcards and a _optional_ |exclude| array that
        //  overrides any includes
        //
        //  Deprecated -- messageConferences:
        //  The key should point to an array of area tags
        //
        const [confConfig, isLegacy] = this._getConfigForConferenceTag(confTag);
        const messageConference = getMessageConferenceByTag(confTag); // we need the actual conf!

        if (!messageConference) {
            return this.notFoundGenerator(selectorMatch, cb);
        }

        let areas;
        if (isLegacy) {
            areas = (confConfig || {}).map(areaTag =>
                Object.assign({ areaTag }, getMessageAreaByTag(areaTag))
            );
        } else {
            // new system is more complex here, but nicer for the +op to manage
            areas = getAvailableMessageAreasByConfTag(confTag);
            if (!Array.isArray(confConfig.include)) {
                return cb(
                    this.makeItem(ItemTypes.InfoMessage, 'No message areas available')
                );
            }

            // filters |areas| down to what |includes| matches
            areas = _.filter(areas, (area, areaTag) => {
                for (let rule of confConfig.include) {
                    if (wildcardMatch(areaTag, rule)) {
                        area.areaTag = areaTag;
                        return true;
                    }
                }
                return false;
            });

            //  now filter out any excludes, if present
            if (Array.isArray(confConfig.exclude)) {
                areas = _.filter(areas, area => {
                    for (let rule of confConfig.exclude) {
                        if (wildcardMatch(area.areaTag, rule)) {
                            return false;
                        }
                    }
                    return true;
                });
            }
        }

        return this._makeAvailableMessageAreasResponse(messageConference, areas, cb);
    }

    _listMessagesInArea(selectorMatch, confTag, areaTag, area, cb) {
        if (Message.isPrivateAreaTag(areaTag)) {
            this.log.warn({ areaTag }, `Gopher attempted access to private "${areaTag}"`);
            return cb(this.makeItem(ItemTypes.InfoMessage, 'Area is private'));
        }

        if (!area || !this.isAreaAndConfExposed(confTag, areaTag)) {
            this.log.warn(
                { confTag, areaTag },
                `Gopher attempted access to non-exposed "${confTag}"/"${areaTag}"`
            );
            return this.notFoundGenerator(selectorMatch, cb);
        }

        const filter = {
            resultType: 'messageList',
            sort: 'messageId',
            order: 'descending', //  we want newest messages first for Gopher
        };

        return getMessageListForArea(null, areaTag, filter, (err, msgList) => {
            const response = [
                this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
                this.makeItem(ItemTypes.InfoMessage, `Messages in ${area.name}`),
                this.makeItem(ItemTypes.InfoMessage, '(newest first)'),
                this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
                ...msgList.map(msg =>
                    this.makeItem(
                        ItemTypes.TextFile,
                        `${moment(msg.modTimestamp).format(
                            'YYYY-MM-DD hh:mma'
                        )}: ${this.shortenSubject(msg.subject)}  (${
                            msg.fromUserName
                        } to ${msg.toUserName})`,
                        `/msgarea/${confTag}/${areaTag}/${msg.messageUuid}`
                    )
                ),
            ].join('');

            this.log.debug({ confTag, areaTag }, 'Gopher serving message list');
            return cb(response);
        });
    }

    _displayMessage(selectorMatch, msgUuid, confTag, areaTag, cb) {
        const message = new Message();

        return message.load({ uuid: msgUuid }, err => {
            if (err) {
                this.log.debug(
                    { uuid: msgUuid },
                    'Attempted access to non-existent message UUID!'
                );
                return this.notFoundGenerator(selectorMatch, cb);
            }

            if (
                message.areaTag !== areaTag ||
                !this.isAreaAndConfExposed(confTag, areaTag)
            ) {
                this.log.warn(
                    { areaTag },
                    `Gopher attempted access to non-exposed "${confTag}"/"${areaTag}"`
                );
                return this.notFoundGenerator(selectorMatch, cb);
            }

            if (Message.isPrivateAreaTag(areaTag)) {
                this.log.warn(
                    { areaTag },
                    `Gopher attempted access to message in private "${areaTag}"`
                );
                return this.notFoundGenerator(selectorMatch, cb);
            }

            this.prepareMessageBody(message.message, msgBody => {
                const response = `${'-'.repeat(70)}
To     : ${message.toUserName}
From   : ${message.fromUserName}
When   : ${moment(message.modTimestamp).format('dddd, MMMM Do YYYY, h:mm:ss a (UTCZ)')}
Subject: ${message.subject}
ID     : ${message.messageUuid} (${message.messageId})
${'-'.repeat(70)}
${msgBody}
`;
                this.log.debug(
                    {
                        confTag,
                        areaTag,
                        uuid: message.messageUuid,
                    },
                    `Gopher serving message "${message.subject}"`
                );
                return cb(response);
            });
        });
    }
};
