/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const getSortedAvailableFileAreas =
    require('./file_base_area.js').getSortedAvailableFileAreas;
const FileBaseFilters = require('./file_base_filter.js');

//  deps
const async = require('async');

exports.moduleInfo = {
    name: 'File Base Search',
    desc: 'Module for quickly searching the file base',
    author: 'NuSkooler',
};

const MciViewIds = {
    search: {
        searchTerms: 1,
        search: 2,
        tags: 3,
        area: 4,
        orderBy: 5,
        sort: 6,
        advSearch: 7,
    },
};

exports.getModule = class FileBaseSearch extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            search: (formData, extraArgs, cb) => {
                const isAdvanced = formData.submitId === MciViewIds.search.advSearch;
                return this.searchNow(formData, isAdvanced, cb);
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = self.addViewController(
                'search',
                new ViewController({ client: this.client })
            );

            async.series(
                [
                    function loadFromConfig(callback) {
                        return vc.loadFromMenuConfig(
                            { callingMenu: self, mciMap: mciData.menu },
                            callback
                        );
                    },
                    function populateAreas(callback) {
                        self.availAreas = [{ name: '-ALL-' }].concat(
                            getSortedAvailableFileAreas(self.client) || []
                        );

                        const areasView = vc.getView(MciViewIds.search.area);
                        areasView.setItems(self.availAreas.map(a => a.name));
                        areasView.redraw();
                        vc.switchFocus(MciViewIds.search.searchTerms);

                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    getSelectedAreaTag(index) {
        if (0 === index) {
            return ''; //  -ALL-
        }
        const area = this.availAreas[index];
        if (!area) {
            return '';
        }
        return area.areaTag;
    }

    getOrderBy(index) {
        return FileBaseFilters.OrderByValues[index] || FileBaseFilters.OrderByValues[0];
    }

    getSortBy(index) {
        return FileBaseFilters.SortByValues[index] || FileBaseFilters.SortByValues[0];
    }

    getFilterValuesFromFormData(formData, isAdvanced) {
        const areaIndex = isAdvanced ? formData.value.areaIndex : 0;
        const orderByIndex = isAdvanced ? formData.value.orderByIndex : 0;
        const sortByIndex = isAdvanced ? formData.value.sortByIndex : 0;

        return {
            areaTag: this.getSelectedAreaTag(areaIndex),
            terms: formData.value.searchTerms,
            tags: isAdvanced ? formData.value.tags : '',
            order: this.getOrderBy(orderByIndex),
            sort: this.getSortBy(sortByIndex),
        };
    }

    searchNow(formData, isAdvanced, cb) {
        const filterCriteria = this.getFilterValuesFromFormData(formData, isAdvanced);

        const menuOpts = {
            extraArgs: {
                filterCriteria: filterCriteria,
            },
            menuFlags: ['popParent'],
        };

        return this.gotoMenu(
            this.menuConfig.config.fileBaseListEntriesMenu || 'fileBaseListEntries',
            menuOpts,
            cb
        );
    }
};
