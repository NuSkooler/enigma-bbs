/* jslint node: true */
'use strict';

//
//  Which file entries a user may see (#291).
//
//  A report-only rescan (file_base_rescan.js) leaves an entry it finds
//  something in where it is and marks it scan_result=infected. With
//  fileBase.scanning.hideInfected (the default) such an entry is hidden from
//  everyone who does not pass fileBase.scanning.infectedVisibleAcs: it is not
//  listed, found, picked up by a new scan, queued, sent or served, and asking
//  for it by ID, link or queue entry answers as though it did not exist.
//  oputil fb mark-safe clears the flag and the entry is back.
//
//  This is the one place that decides. User facing callers ask here; oputil,
//  the rescan itself and dupe detection (a re-upload of a flagged file is
//  still a dupe) see everything, as they always did.
//
//  |subject|, throughout, is whoever is asking: a client, a User, or null for
//  no one in particular -- an anonymous REST caller, a remote node's FREQ, a
//  scheduled export. No one in particular never passes the ACS.
//
//  Whether an entry is infected is always read from the database (see
//  FileEntry.getInfectedFileIds()), never from an entry in memory, so an
//  entry flagged after it was listed, queued or linked is caught where it is
//  sent.
//

const ConfigModule = require('./config.js');
const ACS = require('./acs.js');

//  deps
const _ = require('lodash');

const DefaultInfectedVisibleAcs = 'GM[sysops]';

//  required lazily: file_entry.js captures the file database at load
const FileEntry = () => require('./file_entry.js');

function scanningConfig() {
    return _.get(ConfigModule.get(), 'fileBase.scanning') || {};
}

//  { client, user } for the ACS parser, or null for no one in particular
function acsSubjectFor(subject) {
    if (!subject) {
        return null;
    }
    if (subject.user) {
        //  a client
        return { client: subject, user: subject.user };
    }
    if (_.isFunction(subject.isGroupMember)) {
        //  a User, without a session (REST, web links)
        return { client: null, user: subject };
    }
    return null;
}

//
//  Does |subject| pass fileBase.scanning.infectedVisibleAcs?
//
function canSeeInfected(subject) {
    const acsSubject = acsSubjectFor(subject);
    if (!acsSubject) {
        return false;
    }

    const configured = scanningConfig().infectedVisibleAcs;
    const acs =
        _.isString(configured) && configured.trim().length > 0
            ? configured
            : DefaultInfectedVisibleAcs;

    //  ACS.check() answers false, and logs, if the string does not parse
    return new ACS(acsSubject).check(
        { infectedVisible: acs },
        'infectedVisible',
        DefaultInfectedVisibleAcs
    );
}

//
//  Is fileBase.scanning.hideInfected on? (Anything but an explicit false.)
//
function hideInfectedEnabled() {
    return false !== scanningConfig().hideInfected;
}

//
//  Are infected entries hidden from |subject|?
//
function hidesInfected(subject) {
    return hideInfectedEnabled() && !canSeeInfected(subject);
}

//
//  |filter| for FileEntry.findFiles(), as |subject| may see it: a copy with
//  excludeInfected set where infected entries are hidden from them.
//
function visibleFilesFilter(subject, filter) {
    const visible = Object.assign({}, filter);
    if (hidesInfected(subject)) {
        visible.excludeInfected = true;
    }
    return visible;
}

//
//  |items| less those hidden from |subject|. |items| are file IDs, or objects
//  with a fileId (entries, download queue items); an object without one (a
//  bare path in a send queue) is not a file entry and is kept.
//
function filterHidden(subject, items) {
    if (!Array.isArray(items) || 0 === items.length || !hidesInfected(subject)) {
        return items;
    }

    const idOf = item => (_.isObject(item) ? item.fileId : item);
    const infected = FileEntry().getInfectedFileIds(items.map(idOf));
    if (0 === infected.size) {
        return items;
    }
    return items.filter(item => !infected.has(idOf(item)));
}

//
//  Is the entry with |fileId| hidden from |subject|?
//
function isFileIdHidden(subject, fileId) {
    if (!_.isFinite(fileId) || !hidesInfected(subject)) {
        return false;
    }
    return FileEntry().getInfectedFileIds([fileId]).has(fileId);
}

//
//  Is |fileEntry|, as loaded, marked infected? For flagging an entry to those
//  who still see infected entries -- not for deciding who sees it, which goes
//  to the database (above).
//
function isEntryInfected(fileEntry) {
    return FileEntry().InfectedScanResult === _.get(fileEntry, 'meta.scan_result');
}

module.exports = {
    DefaultInfectedVisibleAcs,
    hideInfectedEnabled,
    canSeeInfected,
    hidesInfected,
    visibleFilesFilter,
    filterHidden,
    isFileIdHidden,
    isEntryInfected,
};
