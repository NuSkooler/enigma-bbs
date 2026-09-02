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
//  |entry| as an Address, or undefined when it is not one.
//
//  Config is hand-written hjson, so a downlink can arrive as a number
//  ("downlinks: [21]"), a boolean, a nested array or an address-shaped plain
//  object. Address.fromString() only accepts a string, and calling isValid()
//  on whatever came back threw TypeError straight into the forwarding
//  waterfall -- the same shape of failure #735 fixed, from a typo in config.
//
function toAddress(entry) {
    if (entry instanceof Address) {
        return entry.isValid() ? entry : undefined;
    }

    if (_.isString(entry)) {
        const addr = Address.fromString(entry);
        return addr && addr.isValid() ? addr : undefined;
    }

    return undefined;
}

//
//  A key identifying the *system* an address names, for O(1) dedup.
//
//  Must agree with Address.isEquivalent(): point absent and 0 are one system,
//  domain is ignored, and a missing zone is filled from the area's network.
//
function addressKey(addr, options = {}) {
    const zone = _.isNumber(addr.zone) ? addr.zone : options.defaultZone;
    return `${zone}:${addr.net}/${addr.node}.${addr.point || 0}`;
}

//
//  |addr| with a missing zone filled in from the area's network.
//
//  A 2D "Seenby 1/50" -- legal, and the ordinary 2D form -- parses to an
//  Address with no zone, and toString() interpolates it anyway: we wrote
//  "Seenby undefined:1/50" into the TIC sent to *every* downlink. Downstream
//  tossers either drop it as an illegal value, losing a loop-guard entry, or
//  refuse the whole TIC.
//
function withZone(addr, options = {}) {
    if (_.isNumber(addr.zone) || !_.isNumber(options.defaultZone)) {
        return addr;
    }
    return new Address(Object.assign({}, addr, { zone: options.defaultZone }));
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
        const addr = toAddress(entry);

        if (!addr) {
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

    //
    //  Set, not a linear scan per insert. The old form was quadratic in the
    //  size of the list, and the list comes straight off the wire: a peer's
    //  Seenby of 10,000 entries took ~2.6s of frozen event loop per forwarded
    //  file, and a large echo reaches those lengths honestly.
    //
    const seen = new Set();

    const add = entry => {
        const addr = toAddress(entry);
        if (!addr) {
            return;
        }

        const normalized = withZone(addr, options);
        const key = addressKey(normalized, options);
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        result.push(normalized);
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
//
//  Addresses permitted to *publish* into an area, as written.
//
//  The counterpart to |downlinks|, and the reason it exists: without it, the
//  only sender check anywhere is "is this From any entry in nodes{}", which is
//  not area-scoped. Any node configured for any reason -- a downlink of some
//  other echo, an EchoMail-only link -- could announce a file into an echo it
//  has no rights to, and we would relay it to that echo's subscribers under our
//  own From, our own Path and a Seenby that includes us.
//
//  htick has exactly this control: e_writeCheck() runs immediately before
//  sendToLinks(), and refuses with "Link %s not subscribed to File Area %s" or
//  "No import (or read only) from link %s" -- checking both subscription and
//  direction. Mirroring it is what a hub operator will expect.
//
function uplinksOf(ticAreaConfig) {
    return addressListOf(ticAreaConfig, 'uplinks');
}

//
//  Is |from| permitted to publish into an area whose senders are |uplinks|?
//
//  A concrete entry is compared with isEquivalent(), so the dimensional
//  differences FSC-0087 permits do not defeat it -- an uplink written
//  "21:1/100" still matches a TIC saying "21:1/100@fsxnet". An entry containing
//  a wildcard is matched as a pattern, for consistency with nodes{}; that is a
//  deliberate loosening and naming a concrete address is the point of the list.
//
//  Never true for an empty list. The caller must treat "no uplinks configured"
//  as "forward nothing", not as "forward anything".
//
function isAuthorizedSender(from, uplinks, options = {}) {
    if (!from || !from.isValid()) {
        return false;
    }

    return (uplinks || []).some(entry => {
        if (_.isString(entry) && entry.includes('*')) {
            return from.isPatternMatch(entry);
        }
        const addr = toAddress(entry);
        return addr ? from.isEquivalent(addr, options) : false;
    });
}

function addressListOf(ticAreaConfig, key) {
    if (!ticAreaConfig || !_.isObject(ticAreaConfig)) {
        return [];
    }

    const value = ticAreaConfig[key];
    if (_.isString(value)) {
        return value.split(/\s+/).filter(s => s.length > 0);
    }

    return Array.isArray(value) ? value : [];
}

function downlinksOf(ticAreaConfig) {
    return addressListOf(ticAreaConfig, 'downlinks');
}

module.exports = {
    SkipReasons,
    uplinksOf,
    isAuthorizedSender,
    seenbyOf,
    addressOf,
    selectDownlinks,
    buildSeenby,
    downlinksOf,
};
