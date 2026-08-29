/* jslint node: true */
'use strict';

//  ENiGMA½
const Address = require('./ftn_address.js');

//  deps
const _ = require('lodash');

//
//  Deciding who a TIC-announced file gets passed on to.
//
//  * FTS-5006.001 @ http://ftsc.org/docs/fts-5006.001
//  * FSC-0087.001 @ http://ftsc.org/docs/fsc-0087.001
//
//  Kept apart from the file and spool work in ftn_bso.js because this is the
//  part that must not be wrong: everything here is a pure function of the TIC
//  and the configuration, and a mistake means either a file that loops around
//  the network forever or a downlink that silently never receives an echo.
//  Neither shows up against a single well-behaved test peer.
//

//  Why a configured downlink did not receive this file.
const SkipReasons = {
    AlreadySeen: 'alreadySeen',
    IsSender: 'isSender',
    IsRecipient: 'isRecipient',
    IsOrigin: 'isOrigin',
    IsUs: 'isUs',
    Unconfigured: 'unconfigured',
    Unparsable: 'unparsable',
};

//
//  Addresses in |ticFileInfo|'s Seenby, as an array.
//
//  A TIC with no Seenby at all is ordinary -- our own reader deliberately does
//  not require one, and htick merely warns ("Seen-By list is empty in TIC file
//  ... (wrong TIC)") before carrying on -- so this must cope with none.
//
function seenbyOf(ticFileInfo) {
    const value = ticFileInfo.get('seenby');
    if (undefined === value) {
        return [];
    }
    return (Array.isArray(value) ? value : [value]).filter(a => a && a.isValid());
}

function addressOf(ticFileInfo, key) {
    const value = ticFileInfo.get(key);
    const addr = Array.isArray(value) ? value[0] : value;
    return addr && addr.isValid() ? addr : undefined;
}

function containsAddress(list, addr, options) {
    return (list || []).some(a => a && addr.isEquivalent(a, options));
}

//
//  Which of |downlinks| should receive this file?
//
//  This is htick's rule (src/toss.c, sendToLinks), which is the one that
//  interoperates, and it turns on a subtlety worth stating: the Seenby snapshot
//  used here is the one that arrived, *before* we add ourselves and our
//  downlinks to it. htick keeps an explicit |old_seenby| copy for exactly this
//  reason. Testing against the updated list would exclude every downlink we
//  just added and forward to nobody.
//
//  A downlink is skipped when it:
//    * is already in the inbound Seenby      -- it has the file (loop guard)
//    * is the node that sent us this TIC     -- it obviously has it
//    * is the TIC's "To"                     -- likewise
//    * is the origin of the file             -- it hatched it
//    * is one of our own addresses           -- a config error, not a peer
//
//  |options.defaultZone| is the zone of the network this area belongs to, and
//  matters: FSC-0087 permits addresses to be written 2D through 5D and lets a
//  forwarder rewrite the dimensions per downlink, so the Seenby we receive is
//  in whatever shape the last hop felt like. Comparison is by
//  Address.isEquivalent(), never isEqual() -- see the note there.
//
function selectDownlinks({ ticFileInfo, downlinks, ourAddresses, defaultZone }) {
    const options = { defaultZone };
    const seenby = seenbyOf(ticFileInfo);
    const from = addressOf(ticFileInfo, 'from');
    const to = addressOf(ticFileInfo, 'to');
    const origin = addressOf(ticFileInfo, 'origin');

    const candidates = [];
    const skipped = [];

    (downlinks || []).forEach(entry => {
        const addr = _.isString(entry) ? Address.fromString(entry) : entry;

        if (!addr || !addr.isValid()) {
            skipped.push({ address: entry, reason: SkipReasons.Unparsable });
            return;
        }

        const skip = reason => skipped.push({ address: addr, reason });

        if (containsAddress(ourAddresses, addr, options)) {
            return skip(SkipReasons.IsUs);
        }
        if (containsAddress(seenby, addr, options)) {
            return skip(SkipReasons.AlreadySeen);
        }
        if (from && addr.isEquivalent(from, options)) {
            return skip(SkipReasons.IsSender);
        }
        if (to && addr.isEquivalent(to, options)) {
            return skip(SkipReasons.IsRecipient);
        }
        if (origin && addr.isEquivalent(origin, options)) {
            return skip(SkipReasons.IsOrigin);
        }

        candidates.push(addr);
    });

    return { candidates, skipped };
}

//
//  The complete Seenby list to write into every outgoing TIC.
//
//  FTS-5006: "This lists the systems that have 'seen' the file. [...] The
//  seenby information may be used for dupe prevention." Every downlink gets the
//  *same* full list, which is what makes it a working loop guard: a peer two
//  hops away can see that a system it also feeds already has the file.
//
//  Included: everything that arrived, plus our own address, plus every
//  configured downlink we are able to send to -- not merely the ones we are
//  sending to on this pass. htick does the same. A downlink skipped because it
//  is the sender still belongs here: it demonstrably has the file.
//
//  Sorted, because FTS-5006 permits it and a stable order makes outgoing TICs
//  comparable between runs. Points sort under their boss node.
//
function buildSeenby({ ticFileInfo, downlinks, ourAddresses, defaultZone }) {
    const options = { defaultZone };
    const result = [];

    const add = entry => {
        const addr = _.isString(entry) ? Address.fromString(entry) : entry;
        if (!addr || !addr.isValid()) {
            return;
        }
        if (!containsAddress(result, addr, options)) {
            result.push(addr);
        }
    };

    seenbyOf(ticFileInfo).forEach(add);
    (ourAddresses || []).forEach(add);
    (downlinks || []).forEach(add);

    return result.sort(Address.getComparator());
}

//
//  Downlinks configured for a TIC area, as written.
//
//  |ticAreas| is keyed by the *external* FTN area tag, which is what an echo
//  actually is -- one local file base area may carry several of them, and the
//  peer set belongs to the echo rather than to our local storage. This mirrors
//  how messageNetworks.ftn.areas names |uplinks| for EchoMail.
//
//  Accepts a space separated string as well as an array, matching how
//  isAreaConfigValid() has always treated EchoMail |uplinks|.
//
function downlinksOf(ticAreaConfig) {
    if (!ticAreaConfig || !_.isObject(ticAreaConfig)) {
        return [];
    }

    const downlinks = ticAreaConfig.downlinks;
    if (_.isString(downlinks)) {
        return downlinks.split(/\s+/).filter(s => s.length > 0);
    }

    return Array.isArray(downlinks) ? downlinks : [];
}

module.exports = {
    SkipReasons,
    seenbyOf,
    addressOf,
    selectDownlinks,
    buildSeenby,
    downlinksOf,
};
