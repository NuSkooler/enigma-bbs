/* jslint node: true */
'use strict';

//  ENiGMA½
const configModule = require('./config.js');
//  late bound: configModule.get is replaced by the Config bootstrapper
const Config = (...args) => configModule.get(...args);
const Errors = require('./enig_error.js').Errors;

//  deps
const async = require('async');
const fs = require('graceful-fs');
const paths = require('path');
const iconv = require('iconv-lite');
const { isUtf8 } = require('buffer');
const _ = require('lodash');

//
//  Files a sysop packs into every offline mail packet for the reader to show
//  the caller, from messageNetworks.offlineMail. Both formats share them:
//  QWK names HELLO, BBSNEWS and GOODBYE in CONTROL.DAT and readers pick up
//  BLT-n.n on their own; Blue Wave lists the files in INF_HEADER.readerfiles,
//  where readers treat a HELLO* or GOODBYE* name as the welcome and logoff
//  screens.
//

//  what each is called inside the packet; QWK names these in CONTROL.DAT
const BulletinNames = {
    Hello: 'HELLO',
    News: 'BBSNEWS',
    Goodbye: 'GOODBYE',
};

//
//  A misconfigured bulletin is the same problem on every export, so it is
//  reported once per list rather than once per packet. offlineMailBulletins()
//  hands out one list per loaded config, so a reload reports it afresh.
//
const bulletinLists = new WeakMap();
const warnedKeys = new WeakMap();

const warnOnce = (bulletins, key, onWarning, makeWarning) => {
    if (!warnedKeys.has(bulletins)) {
        warnedKeys.set(bulletins, new Set());
    }
    const warned = warnedKeys.get(bulletins);
    if (!warned.has(key)) {
        warned.add(key);
        onWarning(makeWarning());
    }
};

//
//  [ { name, path } ] in the order a reader should show them. |name| is what
//  the file is called inside the packet. A relative path is taken from
//  paths.config, as menuFile is, not from wherever ENiGMA was started.
//
const offlineMailBulletins = () => {
    const systemConfig = Config();
    if (!bulletinLists.has(systemConfig)) {
        bulletinLists.set(systemConfig, bulletinList(systemConfig));
    }
    return bulletinLists.get(systemConfig);
};

const bulletinList = systemConfig => {
    const config = _.get(systemConfig, 'messageNetworks.offlineMail', {});
    const configDir = _.get(systemConfig, 'paths.config', '');
    const bulletins = [];
    const add = (name, path) => {
        if (_.isString(path) && path) {
            bulletins.push({ name, path: paths.resolve(configDir, path) });
        }
    };

    add(BulletinNames.Hello, config.hello);
    add(BulletinNames.News, config.news);
    (config.bulletins || []).forEach((path, index) => add(`BLT-0.${index + 1}`, path));
    add(BulletinNames.Goodbye, config.goodbye);

    return bulletins;
};

//
//  A packet's text is CP437 with CRLF line endings. A file already in CP437
//  (most ANSI art) is very rarely valid UTF-8 once it has a high byte, so a
//  file that is valid UTF-8 is converted and anything else is kept as is.
//  Everything from the first ^Z on is cut: that is where a SAUCE record
//  starts, and a reader would show it as garbage.
//
const bulletinData = data => {
    const eof = data.indexOf(0x1a);
    if (eof > -1) {
        data = data.slice(0, eof);
    }

    //  a BOM has no CP437 form and would arrive as a leading '?'
    const text = isUtf8(data)
        ? iconv.encode(data.toString('utf8').replace(/^\uFEFF/, ''), 'cp437')
        : data;

    return Buffer.from(text.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
};

//
//  Writes |bulletins| into |dir| and calls back with the names of those
//  written. One that cannot be read is skipped with a warning rather than
//  holding up the caller's mail.
//
const writeOfflineMailBulletins = (dir, bulletins, onWarning, cb) => {
    const written = [];
    async.eachSeries(
        bulletins,
        (bulletin, next) => {
            fs.readFile(bulletin.path, (err, data) => {
                if (err) {
                    warnOnce(bulletins, `unreadable:${bulletin.path}`, onWarning, () =>
                        Errors.General(
                            `Offline mail bulletin "${bulletin.path}" cannot be read: ${err.message}`
                        )
                    );
                    return next(null);
                }

                fs.writeFile(paths.join(dir, bulletin.name), bulletinData(data), err => {
                    if (!err) {
                        written.push(bulletin.name);
                    }
                    return next(err);
                });
            });
        },
        err => cb(err, written)
    );
};

module.exports = {
    BulletinNames,
    offlineMailBulletins,
    bulletinData,
    warnOnce,
    writeOfflineMailBulletins,
};
