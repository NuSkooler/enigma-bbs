/* jslint node: true */
'use strict';

//  enigma-bbs
const MenuModule = require('./menu_module.js').MenuModule;
const { getSortedAvailableFileAreas } = require('./file_base_area.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');

//  deps
const async = require('async');

exports.moduleInfo = {
    name: 'File Area Selector',
    desc: 'Select from available file areas',
    author: 'NuSkooler',
};

const MciViewIds = {
    areaList: 1,
};

exports.getModule = class FileAreaSelectModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            selectArea: (formData, extraArgs, cb) => {
                const filterCriteria = {
                    areaTag: formData.value.areaTag,
                };

                const menuOpts = {
                    extraArgs: {
                        filterCriteria: filterCriteria,
                    },
                    menuFlags: ['popParent', 'mergeFlags'],
                };

                return this.gotoMenu(
                    this.menuConfig.config.fileBaseListEntriesMenu ||
                        'fileBaseListEntries',
                    menuOpts,
                    cb
                );
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;

            async.waterfall(
                [
                    function mergeAreaStats(callback) {
                        const areaStats = StatLog.getSystemStat(
                            SysProps.FileBaseAreaStats
                        ) || { areas: {} };

                        //  we could use 'sort' alone, but area/conf sorting has some special properties; user can still override
                        const availAreas = getSortedAvailableFileAreas(self.client);
                        availAreas.forEach(area => {
                            const stats = areaStats.areas[area.areaTag];
                            area.totalFiles = stats ? stats.files : 0;
                            area.totalBytes = stats ? stats.bytes : 0;
                        });

                        return callback(null, availAreas);
                    },
                    function prepView(availAreas, callback) {
                        self.prepViewController(
                            'allViews',
                            0,
                            mciData.menu,
                            (err, vc) => {
                                if (err) {
                                    return callback(err);
                                }

                                const areaListView = vc.getView(MciViewIds.areaList);
                                areaListView.setItems(
                                    availAreas.map(area =>
                                        Object.assign(area, {
                                            text: area.name,
                                            data: area.areaTag,
                                        })
                                    )
                                );
                                areaListView.redraw();

                                return callback(null);
                            }
                        );
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }
};
