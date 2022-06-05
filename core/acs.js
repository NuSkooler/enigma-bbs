/* jslint node: true */
'use strict';

//  ENiGMA½
const checkAcs = require('./acs_parser.js').parse;
const Log = require('./logger.js').log;

//  deps
const assert = require('assert');
const _ = require('lodash');

class ACS {
    constructor(subject) {
        this.subject = subject;
    }

    static get Defaults() {
        return {
            MessageConfRead: 'GM[users]', //  list/read
            MessageConfWrite: 'GM[users]', //  post/write

            MessageAreaRead: 'GM[users]', //  list/read; requires parent conf read
            MessageAreaWrite: 'GM[users]', //  post/write; requires parent conf write

            FileAreaRead: 'GM[users]', //  list
            FileAreaWrite: 'GM[sysops]', //  upload
            FileAreaDownload: 'GM[users]', //  download
        };
    }

    check(acs, scope, defaultAcs) {
        acs = acs ? acs[scope] : defaultAcs;
        acs = acs || defaultAcs;
        try {
            return checkAcs(acs, { subject: this.subject });
        } catch (e) {
            Log.warn({ exception: e, acs: acs }, 'Exception caught checking ACS');
            return false;
        }
    }

    //
    //  Message Conferences & Areas
    //
    hasMessageConfRead(conf) {
        return this.check(conf.acs, 'read', ACS.Defaults.MessageConfRead);
    }

    hasMessageConfWrite(conf) {
        return this.check(conf.acs, 'write', ACS.Defaults.MessageConfWrite);
    }

    hasMessageAreaRead(area) {
        return this.check(area.acs, 'read', ACS.Defaults.MessageAreaRead);
    }

    hasMessageAreaWrite(area) {
        return this.check(area.acs, 'write', ACS.Defaults.MessageAreaWrite);
    }

    //
    //  File Base / Areas
    //
    hasFileAreaRead(area) {
        return this.check(area.acs, 'read', ACS.Defaults.FileAreaRead);
    }

    hasFileAreaWrite(area) {
        //  :TODO: create 'upload' alias?
        return this.check(area.acs, 'write', ACS.Defaults.FileAreaWrite);
    }

    hasFileAreaDownload(area) {
        return this.check(area.acs, 'download', ACS.Defaults.FileAreaDownload);
    }

    hasMenuModuleAccess(modInst) {
        const acs = _.get(modInst, 'menuConfig.config.acs');
        if (!_.isString(acs)) {
            return true; //  no ACS check req.
        }
        try {
            return checkAcs(acs, { subject: this.subject });
        } catch (e) {
            Log.warn({ exception: e, acs: acs }, 'Exception caught checking ACS');
            return false;
        }
    }

    getConditionalValue(condArray, memberName) {
        if (!Array.isArray(condArray)) {
            //  no cond array, just use the value
            return condArray;
        }

        assert(_.isString(memberName));

        const matchCond = condArray.find(cond => {
            if (_.has(cond, 'acs')) {
                try {
                    return checkAcs(cond.acs, { subject: this.subject });
                } catch (e) {
                    Log.warn(
                        { exception: e, acs: cond },
                        'Exception caught checking ACS'
                    );
                    return false;
                }
            } else {
                return true; //  no ACS check req.
            }
        });

        if (matchCond) {
            return matchCond[memberName];
        }
    }
}

module.exports = ACS;
