//  ENiGMA½
const { MenuModule } = require('./menu_module');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name        : 'WFC',
    desc        : 'Semi-Traditional Waiting For Caller',
    author      : 'NuSkooler',
};

const FormIds = {
    main    : 0,
};

const MciViewIds = {
    main : {
        nodeStatus          : 0,
        quickLogView        : 1,

        customRangeStart    : 10,
    }
};

//  Secure + 2FA + root user + 'wfc' group.
const DefaultACS = 'SCAF2ID1GM[wfc]';

exports.getModule = class WaitingForCallerModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });

        this.config.acs = this.config.acs || DefaultACS;
        if (!this.config.acs.includes('SC')) {
            this.config.acs = 'SC' + this.config.acs;    //  secure connection at the very, very least
        }
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    (callback) => {
                        return this.prepViewController('main', FormIds.main, mciData.menu, callback);
                    },
                    (callback) => {
                        // const requiredCodes = [
                        // ];
                        // return this.validateMCIByViewIds('main', requiredCodes, callback);
                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }
};

