/* jslint node: true */
'use strict';

const _ = require('lodash');

const FTN_ADDRESS_REGEXP = /^([0-9]+:)?([0-9]+)(\/[0-9]+)?(\.[0-9]+)?(@[a-z0-9\-.]+)?$/i;
const FTN_PATTERN_REGEXP =
    /^([0-9*]+:)?([0-9*]+)(\/[0-9*]+)?(\.[0-9*]+)?(@[a-z0-9\-.*]+)?$/i;

module.exports = class Address {
    constructor(addr) {
        if (addr) {
            if (_.isObject(addr)) {
                Object.assign(this, addr);
            } else if (_.isString(addr)) {
                const temp = Address.fromString(addr);
                if (temp) {
                    Object.assign(this, temp);
                }
            }
        }
    }

    static isValidAddress(addr) {
        return addr && addr.isValid();
    }

    isValid() {
        //  FTN address is valid if we have at least a net/node
        return _.isNumber(this.net) && _.isNumber(this.node);
    }

    isEqual(other) {
        if (_.isString(other)) {
            other = Address.fromString(other);
        }

        return (
            this.net === other.net &&
            this.node === other.node &&
            this.zone === other.zone &&
            this.point === other.point &&
            this.domain === other.domain
        );
    }

    getMatchAddr(pattern) {
        const m = FTN_PATTERN_REGEXP.exec(pattern);
        if (m) {
            let addr = {};

            if (m[1]) {
                addr.zone = m[1].slice(0, -1);
                if ('*' !== addr.zone) {
                    addr.zone = parseInt(addr.zone, 10);
                }
            } else {
                addr.zone = '*';
            }

            if (m[2]) {
                addr.net = m[2];
                if ('*' !== addr.net) {
                    addr.net = parseInt(addr.net, 10);
                }
            } else {
                addr.net = '*';
            }

            if (m[3]) {
                addr.node = m[3].substr(1);
                if ('*' !== addr.node) {
                    addr.node = parseInt(addr.node, 10);
                }
            } else {
                addr.node = '*';
            }

            if (m[4]) {
                addr.point = m[4].substr(1);
                if ('*' !== addr.point) {
                    addr.point = parseInt(addr.point, 10);
                }
            } else {
                addr.point = '*';
            }

            if (m[5]) {
                addr.domain = m[5].substr(1);
            } else {
                addr.domain = '*';
            }

            return addr;
        }
    }

    //  Returns a numeric specificity score for how well |pattern| matches
    //  this address. Higher = more specific; concrete-and-matching parts
    //  count more than wildcard parts. Used to disambiguate when multiple
    //  patterns match the same address (e.g. "21:1/100" and "21:*" both
    //  matching "21:1/100" — the concrete one should win regardless of
    //  config insertion order).
    //
    //  Scoring per part (net, node, zone, point, domain):
    //    +2 — concrete pattern part equals this address part
    //    +1 — pattern part is wildcard
    //     0 — concrete pattern part disagrees (and we stop scoring)
    //
    //  Returns 0 when the pattern fails to parse.
    getMatchScore(pattern) {
        let score = 0;
        const addr = this.getMatchAddr(pattern);
        if (addr) {
            const PARTS = ['net', 'node', 'zone', 'point', 'domain'];
            for (let i = 0; i < PARTS.length; ++i) {
                const member = PARTS[i];
                if (this[member] === addr[member]) {
                    score += 2;
                } else if ('*' === addr[member]) {
                    score += 1;
                } else {
                    break;
                }
            }
        }

        return score;
    }

    //
    //  The most-specific entry of |patterned| whose key matches |addr|.
    //
    //  |patterned| is an object keyed by FTN address patterns -- concrete or
    //  wildcard -- such as scannerTossers.ftn_bso.nodes{} or the NetMail
    //  routes{} table. Configurations routinely pair a catch-all ("21:*", or
    //  even "*") with more specific overrides ("21:1/100"). A first-match-wins
    //  scan follows object iteration order, so which one wins depends only on
    //  the order the sysop happened to write the HJSON -- and a catch-all
    //  listed first silently shadows every override below it. Scoring with
    //  getMatchScore() makes the outcome deterministic and matches intent.
    //
    //  Returns { pattern, value } for the winner, or undefined when nothing
    //  matches. |addr| may be an Address or anything of the same shape.
    //
    static findBestPatternMatch(patterned, addr) {
        if (!patterned || 'object' !== typeof patterned) {
            return undefined;
        }

        const a = addr instanceof Address ? addr : new Address(addr);

        let best;
        let bestScore = 0;
        for (const [pattern, value] of Object.entries(patterned)) {
            if (!a.isPatternMatch(pattern)) {
                continue;
            }

            const score = a.getMatchScore(pattern);
            if (score > bestScore) {
                bestScore = score;
                best = { pattern, value };
            }
        }

        return best;
    }

    //
    //  Do |this| and |other| name the same system, allowing for the
    //  dimensionality differences that are ordinary in FTN control data?
    //
    //  isEqual() is a strict field-for-field comparison, which is right for
    //  routing decisions but wrong for reading addresses out of a control file.
    //  There, the *same* system is routinely written several ways:
    //
    //      1/100          2D, zone implied by context
    //      21:1/100       3D
    //      21:1/100.0     4D, an explicit point 0 meaning "not a point"
    //      21:1/100@fsxnet 5D
    //
    //  FSC-0087 requires a file forwarder to understand all of these, and
    //  explicitly permits a forwarder to rewrite the dimensions per downlink --
    //  so what we receive is whatever the last hop felt like emitting. Comparing
    //  those strictly answers "was this written identically", not "is this the
    //  same node", and using it as a loop guard means failing to recognise a
    //  system that has already seen a file, and forwarding it to them again.
    //
    //  Normalization:
    //    * point   -- absent and 0 are the same thing (FTS-5006's Seenby
    //                 example lists both "2:280/5555" and "2:280/5555.1")
    //    * domain  -- ignored unless both sides carry one, since a 3D/4D
    //                 address is not asserting a different network
    //    * zone    -- |options.defaultZone| fills in a missing zone on either
    //                 side. Callers should pass the zone of the network the
    //                 control file belongs to; without it a zone-less address
    //                 only matches another zone-less one, which is the safe
    //                 direction (no false "already seen").
    //
    isEquivalent(other, options = {}) {
        if (_.isString(other)) {
            other = Address.fromString(other);
        }

        if (!other) {
            return false;
        }

        if (this.net !== other.net || this.node !== other.node) {
            return false;
        }

        const zone = a => (_.isNumber(a.zone) ? a.zone : options.defaultZone);
        const zoneL = zone(this);
        const zoneR = zone(other);
        if (zoneL !== zoneR) {
            return false;
        }

        if ((this.point || 0) !== (other.point || 0)) {
            return false;
        }

        //  Only a disagreement between two *stated* domains is a difference.
        if (this.domain && other.domain) {
            return this.domain.toLowerCase() === other.domain.toLowerCase();
        }

        return true;
    }

    //  Is this address any of |addresses|, comparing per isEquivalent()?
    //  Convenience for the common "is this us?" test, which must span every
    //  local AKA across every configured network rather than one address.
    isAnyOf(addresses, options = {}) {
        return (addresses || []).some(a => this.isEquivalent(a, options));
    }

    isPatternMatch(pattern) {
        const addr = this.getMatchAddr(pattern);
        if (addr) {
            return (
                ('*' === addr.net || this.net === addr.net) &&
                ('*' === addr.node || this.node === addr.node) &&
                ('*' === addr.zone || this.zone === addr.zone) &&
                ('*' === addr.point || this.point === addr.point) &&
                ('*' === addr.domain || this.domain === addr.domain)
            );
        }

        return false;
    }

    static fromString(addrStr) {
        const m = FTN_ADDRESS_REGEXP.exec(addrStr);

        if (m && m[2] && m[3]) {
            //  start with a 2D
            let addr = {
                net: parseInt(m[2], 10),
                node: parseInt(m[3].substr(1), 10),
            };

            //  3D: Addition of zone if present
            if (m[1]) {
                addr.zone = parseInt(m[1].slice(0, -1), 10);
            }

            //  4D if optional point is present
            if (m[4]) {
                addr.point = parseInt(m[4].substr(1), 10);
            }

            //  5D with @domain
            if (m[5]) {
                addr.domain = m[5].substr(1);
            }

            return new Address(addr);
        }
    }

    toString(dimensions) {
        dimensions = dimensions || '5D';

        let addrStr = `${this.zone}:${this.net}`;

        //  allow for e.g. '4D' or 5
        const dim = parseInt(dimensions.toString()[0]);

        if (dim >= 3) {
            addrStr += `/${this.node}`;
        }

        //  missing & .0 are equiv for point
        if (dim >= 4 && this.point) {
            addrStr += `.${this.point}`;
        }

        if (5 === dim && this.domain) {
            addrStr += `@${this.domain.toLowerCase()}`;
        }

        return addrStr;
    }

    static getComparator() {
        return function (left, right) {
            let c = (left.zone || 0) - (right.zone || 0);
            if (0 !== c) {
                return c;
            }

            c = (left.net || 0) - (right.net || 0);
            if (0 !== c) {
                return c;
            }

            c = (left.node || 0) - (right.node || 0);
            if (0 !== c) {
                return c;
            }

            //  Points sort under their boss node, and an absent point is
            //  point 0 -- not "unordered". Without this a node and its points
            //  compare equal and their relative order is whatever the sort
            //  happened to do, which makes any sorted output (a TIC's Seenby
            //  list, for one) unstable between runs for no reason.
            c = (left.point || 0) - (right.point || 0);
            if (0 !== c) {
                return c;
            }

            return (left.domain || '').localeCompare(right.domain || '');
        };
    }
};
