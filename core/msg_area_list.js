/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule            = require('./menu_module.js').MenuModule;
const ViewController        = require('./view_controller.js').ViewController;
const messageArea           = require('./message_area.js');
const displayThemeArt       = require('./theme.js').displayThemeArt;
const resetScreen           = require('./ansi_term.js').resetScreen;
const stringFormat          = require('./string_format.js');
const Errors                = require('./enig_error.js').Errors;

//  deps
const async             = require('async');
const _                 = require('lodash');

exports.moduleInfo = {
    name    : 'Message Area List',
    desc    : 'Module for listing / choosing message areas',
    author  : 'NuSkooler',
};

/*
    :TODO:

    Obv/2 has the following:
    CHANGE .ANS - Message base changing ansi
          |SN      Current base name
          |SS      Current base sponsor
          |NM      Number of messages in current base
          |UP      Number of posts current user made (total)
          |LR      Last read message by current user
          |DT      Current date
          |TI      Current time
*/

const MciViewIds = {
    AreaList        : 1,
    SelAreaInfo1    : 2,
    SelAreaInfo2    : 3,
};

exports.getModule = class MessageAreaListModule extends MenuModule {
    constructor(options) {
        super(options);

        this.messageAreas = messageArea.getSortedAvailMessageAreasByConfTag(
            this.client.user.properties.message_conf_tag,
            { client : this.client }
        );

        const self = this;
        this.menuMethods = {
            changeArea : function(formData, extraArgs, cb) {
                if(1 === formData.submitId) {
                    let area        = self.messageAreas[formData.value.area];
                    const areaTag   =  area.areaTag;
                    area = area.area;   //  what we want is actually embedded

                    messageArea.changeMessageArea(self.client, areaTag, err => {
                        if(err) {
                            self.client.term.pipeWrite(`\n|00Cannot change area: ${err.message}\n`);

                            self.prevMenuOnTimeout(1000, cb);
                        } else {
                            if(_.isString(area.art)) {
                                const dispOptions = {
                                    client  : self.client,
                                    name    : area.art,
                                };

                                self.client.term.rawWrite(resetScreen());

                                displayThemeArt(dispOptions, () => {
                                    //  pause by default, unless explicitly told not to
                                    if(_.has(area, 'options.pause') && false === area.options.pause) {
                                        return self.prevMenuOnTimeout(1000, cb);
                                    } else {
                                        self.pausePrompt( () => {
                                            return self.prevMenu(cb);
                                        });
                                    }
                                });
                            } else {
                                return self.prevMenu(cb);
                            }
                        }
                    });
                } else {
                    return cb(null);
                }
            }
        };
    }

    prevMenuOnTimeout(timeout, cb) {
        setTimeout( () => {
            return this.prevMenu(cb);
        }, timeout);
    }

    //  :TODO: these concepts have been replaced with the {someKey} style formatting - update me!
    updateGeneralAreaInfoViews(areaIndex) {
        /*
        const areaInfo = self.messageAreas[areaIndex];

        [ MciViewIds.SelAreaInfo1, MciViewIds.SelAreaInfo2 ].forEach(mciId => {
            const v = self.viewControllers.areaList.getView(mciId);
            if(v) {
                v.setFormatObject(areaInfo.area);
            }
        });
        */
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            const self  = this;
            const vc    = self.viewControllers.areaList = new ViewController( { client : self.client } );

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu : self,
                            mciMap      : mciData.menu,
                            formId      : 0,
                        };

                        vc.loadFromMenuConfig(loadOpts, function startingViewReady(err) {
                            callback(err);
                        });
                    },
                    function populateAreaListView(callback) {
                        const areaListView = vc.getView(MciViewIds.AreaList);
                        if(!areaListView) {
                            return callback(Errors.MissingMci('A MenuView compatible MCI code is required'));
                        }

                        let i = 1;
                        areaListView.setItems(self.messageAreas.map(a => {
                            return {
                                index       : i++,
                                areaTag     : a.area.areaTag,
                                text        : a.area.name,  //  standard
                                name        : a.area.name,
                                desc        : a.area.desc,
                            };
                        }));

                        areaListView.on('index update', areaIndex => {
                            self.updateGeneralAreaInfoViews(areaIndex);
                        });

                        areaListView.redraw();
                        return callback(null);
                    }
                ],
                function complete(err) {
                    return cb(err);
                }
            );
        });
    }
};
