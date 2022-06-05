/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'User Auto-Sig Editor',
    desc: 'Module for editing auto-sigs',
    author: 'NuSkooler',
};

const FormIds = {
    edit: 0,
};

const MciViewIds = {
    editor: 1,
    save: 2,
};

exports.getModule = class UserAutoSigEditorModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            saveChanges: (formData, extraArgs, cb) => {
                return this.saveChanges(cb);
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    callback => {
                        return this.prepViewController(
                            'edit',
                            FormIds.edit,
                            mciData.menu,
                            callback
                        );
                    },
                    callback => {
                        const requiredCodes = [MciViewIds.editor, MciViewIds.save];
                        return this.validateMCIByViewIds('edit', requiredCodes, callback);
                    },
                    callback => {
                        const sig =
                            this.client.user.getProperty(UserProps.AutoSignature) || '';
                        this.setViewText('edit', MciViewIds.editor, sig);
                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    saveChanges(cb) {
        const sig = this.getView('edit', MciViewIds.editor).getData().trim();
        this.client.user.persistProperty(UserProps.AutoSignature, sig, err => {
            if (err) {
                this.client.log.error({ error: err.message }, 'Could not save auto-sig');
            }
            return this.prevMenu(cb);
        });
    }
};
