/* jslint node: true */
'use strict';

const MenuModule = require('./menu_module.js').MenuModule;

exports.moduleInfo = {
    name: 'Standard Menu Module',
    desc: 'A Menu Module capable of handing standard configurations',
    author: 'NuSkooler',
};

exports.getModule = class StandardMenuModule extends MenuModule {
    constructor(options) {
        super(options);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            //   we do this so other modules can be both customized and still perform standard tasks
            return this.standardMCIReadyHandler(mciData, cb);
        });
    }
};
