/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const Log = require('./logger.js').log;
const { getMessageAreaByTag, getMessageConferenceByTag } = require('./message_area.js');
const clientConnections = require('./client_connections.js');
const StatLog = require('./stat_log.js');
const FileBaseFilters = require('./file_base_filter.js');
const { formatByteSize } = require('./string_util.js');
const ANSI = require('./ansi_term.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const SysLogKeys = require('./system_log.js');

//  deps
const packageJson = require('../package.json');
const os = require('os');
const _ = require('lodash');
const moment = require('moment');

exports.getPredefinedMCIValue = getPredefinedMCIValue;
exports.init = init;

function init(cb) {
    setNextRandomRumor(cb);
}

function setNextRandomRumor(cb) {
    StatLog.getSystemLogEntries(
        SysLogKeys.UserAddedRumorz,
        StatLog.Order.Random,
        1,
        (err, entry) => {
            if (entry) {
                entry = entry[0];
            }
            const randRumor = entry && entry.log_value ? entry.log_value : '';
            StatLog.setNonPersistentSystemStat(SysProps.NextRandomRumor, randRumor);
            if (cb) {
                return cb(null);
            }
        }
    );
}

function getUserRatio(client, propA, propB) {
    const a = StatLog.getUserStatNum(client.user, propA);
    const b = StatLog.getUserStatNum(client.user, propB);
    const ratio = ~~((a / b) * 100);
    return `${ratio}%`;
}

function userStatAsString(client, statName, defaultValue) {
    return (StatLog.getUserStat(client.user, statName) || defaultValue).toLocaleString();
}

function toNumberWithCommas(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function userStatAsCountString(client, statName, defaultValue) {
    const value = StatLog.getUserStatNum(client.user, statName) || defaultValue;
    return toNumberWithCommas(value);
}

function sysStatAsString(statName, defaultValue) {
    return (StatLog.getSystemStat(statName) || defaultValue).toLocaleString();
}

const PREDEFINED_MCI_GENERATORS = {
    //
    //  Board
    //
    BN: function boardName() {
        return Config().general.boardName;
    },

    //  ENiGMA
    VL: function versionLabel() {
        return 'ENiGMA½ v' + packageJson.version;
    },
    VN: function version() {
        return packageJson.version;
    },

    //  +op info
    SN: function opUserName() {
        return StatLog.getSystemStat(SysProps.SysOpUsername);
    },
    SR: function opRealName() {
        return StatLog.getSystemStat(SysProps.SysOpRealName);
    },
    SL: function opLocation() {
        return StatLog.getSystemStat(SysProps.SysOpLocation);
    },
    SA: function opAffils() {
        return StatLog.getSystemStat(SysProps.SysOpAffiliations);
    },
    SS: function opSex() {
        return StatLog.getSystemStat(SysProps.SysOpSex);
    },
    SE: function opEmail() {
        return StatLog.getSystemStat(SysProps.SysOpEmailAddress);
    },
    //  :TODO: op age, web, ?????

    //
    //  Current user / session
    //
    UN: function userName(client) {
        return client.user.username;
    },
    UI: function userId(client) {
        return client.user.userId.toString();
    },
    UG: function groups(client) {
        return _.values(client.user.groups).join(', ');
    },
    UR: function realName(client) {
        return userStatAsString(client, UserProps.RealName, '');
    },
    LO: function location(client) {
        return userStatAsString(client, UserProps.Location, '');
    },
    UA: function age(client) {
        return client.user.getAge().toString();
    },
    BD: function birthdate(client) {
        //  iNiQUiTY
        return moment(client.user.properties[UserProps.Birthdate]).format(
            client.currentTheme.helpers.getDateFormat()
        );
    },
    US: function sex(client) {
        return userStatAsString(client, UserProps.Sex, '');
    },
    UE: function emailAddress(client) {
        return userStatAsString(client, UserProps.EmailAddress, '');
    },
    UW: function webAddress(client) {
        return userStatAsString(client, UserProps.WebAddress, '');
    },
    UF: function affils(client) {
        return userStatAsString(client, UserProps.Affiliations, '');
    },
    UT: function themeName(client) {
        return _.get(
            client,
            'currentTheme.info.name',
            userStatAsString(client, UserProps.ThemeId, '')
        );
    },
    UD: function themeId(client) {
        return userStatAsString(client, UserProps.ThemeId, '');
    },
    UC: function loginCount(client) {
        return userStatAsCountString(client, UserProps.LoginCount, 0);
    },
    ND: function connectedNode(client) {
        return client.node.toString();
    },
    IP: function clientIpAddress(client) {
        return client.remoteAddress.replace(/^::ffff:/, '');
    }, //  convert any :ffff: IPv4's to 32bit version
    ST: function serverName(client) {
        return client.session.serverName;
    },
    FN: function activeFileBaseFilterName(client) {
        const activeFilter = FileBaseFilters.getActiveFilter(client);
        return activeFilter ? activeFilter.name : '(Unknown)';
    },
    DN: function userNumDownloads(client) {
        return userStatAsCountString(client, UserProps.FileDlTotalCount, 0);
    }, //  Obv/2
    DK: function userByteDownload(client) {
        //  Obv/2 uses DK=downloaded Kbytes
        const byteSize = StatLog.getUserStatNum(client.user, UserProps.FileDlTotalBytes);
        return formatByteSize(byteSize, true); //  true=withAbbr
    },
    UP: function userNumUploads(client) {
        return userStatAsCountString(client, UserProps.FileUlTotalCount, 0);
    }, //  Obv/2
    UK: function userByteUpload(client) {
        //  Obv/2 uses UK=uploaded Kbytes
        const byteSize = StatLog.getUserStatNum(client.user, UserProps.FileUlTotalBytes);
        return formatByteSize(byteSize, true); //  true=withAbbr
    },
    NR: function userUpDownRatio(client) {
        //  Obv/2
        return getUserRatio(
            client,
            UserProps.FileUlTotalCount,
            UserProps.FileDlTotalCount
        );
    },
    KR: function userUpDownByteRatio(client) {
        //  Obv/2 uses KR=upload/download Kbyte ratio
        return getUserRatio(
            client,
            UserProps.FileUlTotalBytes,
            UserProps.FileDlTotalBytes
        );
    },

    MS: function accountCreated(client) {
        return moment(client.user.properties[UserProps.AccountCreated]).format(
            client.currentTheme.helpers.getDateFormat()
        );
    },
    PS: function userPostCount(client) {
        return userStatAsCountString(client, UserProps.MessagePostCount, 0);
    },
    PC: function userPostCallRatio(client) {
        return getUserRatio(client, UserProps.MessagePostCount, UserProps.LoginCount);
    },

    MD: function currentMenuDescription(client) {
        return _.has(client, 'currentMenuModule.menuConfig.desc')
            ? client.currentMenuModule.menuConfig.desc
            : '';
    },

    MA: function messageAreaName(client) {
        const area = getMessageAreaByTag(
            client.user.properties[UserProps.MessageAreaTag]
        );
        return area ? area.name : '';
    },
    MC: function messageConfName(client) {
        const conf = getMessageConferenceByTag(
            client.user.properties[UserProps.MessageConfTag]
        );
        return conf ? conf.name : '';
    },
    ML: function messageAreaDescription(client) {
        const area = getMessageAreaByTag(
            client.user.properties[UserProps.MessageAreaTag]
        );
        return area ? area.desc : '';
    },
    CM: function messageConfDescription(client) {
        const conf = getMessageConferenceByTag(
            client.user.properties[UserProps.MessageConfTag]
        );
        return conf ? conf.desc : '';
    },

    SH: function termHeight(client) {
        return client.term.termHeight.toString();
    },
    SW: function termWidth(client) {
        return client.term.termWidth.toString();
    },

    AC: function achievementCount(client) {
        return userStatAsCountString(client, UserProps.AchievementTotalCount, 0);
    },
    AP: function achievementPoints(client) {
        return userStatAsCountString(client, UserProps.AchievementTotalPoints, 0);
    },

    DR: function doorRuns(client) {
        return userStatAsCountString(client, UserProps.DoorRunTotalCount, 0);
    },
    DM: function doorFriendlyRunTime(client) {
        const minutes = client.user.properties[UserProps.DoorRunTotalMinutes] || 0;
        return moment.duration(minutes, 'minutes').humanize();
    },
    TO: function friendlyTotalTimeOnSystem(client) {
        const minutes = client.user.properties[UserProps.MinutesOnlineTotalCount] || 0;
        return moment.duration(minutes, 'minutes').humanize();
    },

    //
    //  Date/Time
    //
    DT: function date(client) {
        return moment().format(client.currentTheme.helpers.getDateFormat());
    },
    CT: function time(client) {
        return moment().format(client.currentTheme.helpers.getTimeFormat());
    },

    //
    //  OS/System Info
    //
    //  https://github.com/nodejs/node-v0.x-archive/issues/25769
    //
    OS: function operatingSystem() {
        return (
            {
                linux: 'Linux',
                darwin: 'OS X',
                win32: 'Windows',
                sunos: 'SunOS',
                freebsd: 'FreeBSD',
                android: 'Android',
                openbsd: 'OpenBSD',
                aix: 'IBM AIX',
            }[os.platform()] || os.type()
        );
    },

    OA: function systemArchitecture() {
        return os.arch();
    },

    SC: function systemCpuModel() {
        //
        //  Clean up CPU strings a bit for better display
        //
        return os
            .cpus()[0]
            .model.replace(/\(R\)|\(TM\)|processor|CPU/gi, '')
            .replace(/\s+(?= )/g, '')
            .trim();
    },

    //  :TODO: MCI for core count, e.g. os.cpus().length

    //  :TODO: cpu load average (over N seconds): http://stackoverflow.com/questions/9565912/convert-the-output-of-os-cpus-in-node-js-to-percentage
    NV: function nodeVersion() {
        return process.version;
    },

    AN: function activeNodes() {
        return clientConnections.getActiveConnections().length.toString();
    },

    TC: function totalCalls() {
        return StatLog.getSystemStat(SysProps.LoginCount).toLocaleString();
    },
    TT: function totalCallsToday() {
        return StatLog.getSystemStat(SysProps.LoginsToday).toLocaleString();
    },

    RR: function randomRumor() {
        //  start the process of picking another random one
        setNextRandomRumor();

        return StatLog.getSystemStat('random_rumor');
    },

    //
    //  System File Base, Up/Download Info
    //
    //  :TODO: DD - Today's # of downloads (iNiQUiTY)
    //
    SD: function systemNumDownloads() {
        return sysStatAsString(SysProps.FileDlTotalCount, 0);
    },
    SO: function systemByteDownload() {
        const byteSize = StatLog.getSystemStatNum(SysProps.FileDlTotalBytes);
        return formatByteSize(byteSize, true); //  true=withAbbr
    },
    SU: function systemNumUploads() {
        return sysStatAsString(SysProps.FileUlTotalCount, 0);
    },
    SP: function systemByteUpload() {
        const byteSize = StatLog.getSystemStatNum(SysProps.FileUlTotalBytes);
        return formatByteSize(byteSize, true); //  true=withAbbr
    },
    TF: function totalFilesOnSystem() {
        const areaStats = StatLog.getSystemStat(SysProps.FileBaseAreaStats);
        return _.get(areaStats, 'totalFiles', 0).toLocaleString();
    },
    TB: function totalBytesOnSystem() {
        const areaStats = StatLog.getSystemStat(SysProps.FileBaseAreaStats);
        const totalBytes = parseInt(_.get(areaStats, 'totalBytes', 0));
        return formatByteSize(totalBytes, true); //  true=withAbbr
    },
    PT: function messagesPostedToday() {
        //  Obv/2
        return sysStatAsString(SysProps.MessagesToday, 0);
    },
    TP: function totalMessagesOnSystem() {
        //  Obv/2
        return sysStatAsString(SysProps.MessageTotalCount, 0);
    },

    //  :TODO: NT - New users today (Obv/2)
    //  :TODO: FT - Files uploaded/added *today* (Obv/2)
    //  :TODO: DD - Files downloaded *today* (iNiQUiTY)
    //  :TODO: LC - name of last caller to system (Obv/2)
    //  :TODO: TZ - Average *system* post/call ratio (iNiQUiTY)

    //
    //  Special handling for XY
    //
    XY: function xyHack() {
        return; /* nothing */
    },

    //
    //  Various movement by N
    //
    CF: function cursorForwardBy(client, n = 1) {
        return ANSI.forward(n);
    },
    CB: function cursorBackBy(client, n = 1) {
        return ANSI.back(n);
    },
    CU: function cursorUpBy(client, n = 1) {
        return ANSI.up(n);
    },
    CD: function cursorDownBy(client, n = 1) {
        return ANSI.down(n);
    },
};

function getPredefinedMCIValue(client, code, extra) {
    if (!client || !code) {
        return;
    }

    const generator = PREDEFINED_MCI_GENERATORS[code];

    if (generator) {
        let value;
        try {
            value = generator(client, extra);
        } catch (e) {
            Log.error(
                { code: code, exception: e.message },
                'Exception caught generating predefined MCI value'
            );
        }

        return value;
    }
}
