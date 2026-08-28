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

            return (left.domain || '').localeCompare(right.domain || '');
        };
    }
};
