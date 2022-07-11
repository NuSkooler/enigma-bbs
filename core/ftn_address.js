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
                    addr.zone = parseInt(addr.zone);
                }
            } else {
                addr.zone = '*';
            }

            if (m[2]) {
                addr.net = m[2];
                if ('*' !== addr.net) {
                    addr.net = parseInt(addr.net);
                }
            } else {
                addr.net = '*';
            }

            if (m[3]) {
                addr.node = m[3].substr(1);
                if ('*' !== addr.node) {
                    addr.node = parseInt(addr.node);
                }
            } else {
                addr.node = '*';
            }

            if (m[4]) {
                addr.point = m[4].substr(1);
                if ('*' !== addr.point) {
                    addr.point = parseInt(addr.point);
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

    /*
    getMatchScore(pattern) {
        let score = 0;
        const addr = this.getMatchAddr(pattern);
        if(addr) {
            const PARTS = [ 'net', 'node', 'zone', 'point', 'domain' ];
            for(let i = 0; i < PARTS.length; ++i) {
                const member = PARTS[i];
                if(this[member] === addr[member]) {
                    score += 2;
                } else if('*' === addr[member]) {
                    score += 1;
                } else {
                    break;
                }
            }
        }

        return score;
    }
    */

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

        if (m) {
            //  start with a 2D
            let addr = {
                net: parseInt(m[2]),
                node: parseInt(m[3].substr(1)),
            };

            //  3D: Addition of zone if present
            if (m[1]) {
                addr.zone = parseInt(m[1].slice(0, -1));
            }

            //  4D if optional point is present
            if (m[4]) {
                addr.point = parseInt(m[4].substr(1));
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
