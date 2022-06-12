/* jslint node: true */
'use strict';

const { Errors } = require('./enig_error.js');

const _ = require('lodash');

//  FNV-1a based on work here: https://github.com/wiedi/node-fnv
module.exports = class FNV1a {
    constructor(data) {
        this.hash = 0x811c9dc5;

        if (!_.isUndefined(data)) {
            this.update(data);
        }
    }

    update(data) {
        if (_.isNumber(data)) {
            data = data.toString();
        }

        if (_.isString(data)) {
            data = Buffer.from(data);
        }

        if (!Buffer.isBuffer(data)) {
            throw Errors.Invalid('data must be String or Buffer!');
        }

        for (let b of data) {
            this.hash = this.hash ^ b;
            this.hash +=
                (this.hash << 24) +
                (this.hash << 8) +
                (this.hash << 7) +
                (this.hash << 4) +
                (this.hash << 1);
        }

        return this;
    }

    digest(encoding) {
        encoding = encoding || 'binary';
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(this.hash & 0xffffffff, 0);
        return buf.toString(encoding);
    }

    get value() {
        return this.hash & 0xffffffff;
    }
};
