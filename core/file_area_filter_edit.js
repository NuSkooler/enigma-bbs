/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const getSortedAvailableFileAreas =
    require('./file_base_area.js').getSortedAvailableFileAreas;
const FileBaseFilters = require('./file_base_filter.js');
const stringFormat = require('./string_format.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');

exports.moduleInfo = {
    name: 'File Area Filter Editor',
    desc: 'Module for adding, deleting, and modifying file base filters',
    author: 'NuSkooler',
};

const MciViewIds = {
    editor: {
        searchTerms: 1,
        tags: 2,
        area: 3,
        sort: 4,
        order: 5,
        filterName: 6,
        navMenu: 7,

        //  :TODO: use the customs new standard thing - filter obj can have active/selected, etc.
        selectedFilterInfo: 10, //  { ...filter object ... }
        activeFilterInfo: 11, //  { ...filter object ... }
        error: 12, //  validation errors
    },
};

exports.getModule = class FileAreaFilterEdit extends MenuModule {
    constructor(options) {
        super(options);

        this.filtersArray = new FileBaseFilters(this.client).toArray(); //  ordered, such that we can index into them
        this.currentFilterIndex = 0; //  into |filtersArray|

        //
        //  Lexical sort + keep currently active filter (if any) as the first item in |filtersArray|
        //
        const activeFilter = FileBaseFilters.getActiveFilter(this.client);
        this.filtersArray.sort((filterA, filterB) => {
            if (activeFilter) {
                if (filterA.uuid === activeFilter.uuid) {
                    return -1;
                }
                if (filterB.uuid === activeFilter.uuid) {
                    return 1;
                }
            }

            return filterA.name.localeCompare(filterB.name, {
                sensitivity: false,
                numeric: true,
            });
        });

        this.menuMethods = {
            saveFilter: (formData, extraArgs, cb) => {
                return this.saveCurrentFilter(formData, cb);
            },
            prevFilter: (formData, extraArgs, cb) => {
                this.currentFilterIndex -= 1;
                if (this.currentFilterIndex < 0) {
                    this.currentFilterIndex = this.filtersArray.length - 1;
                }
                this.loadDataForFilter(this.currentFilterIndex);
                return cb(null);
            },
            nextFilter: (formData, extraArgs, cb) => {
                this.currentFilterIndex += 1;
                if (this.currentFilterIndex >= this.filtersArray.length) {
                    this.currentFilterIndex = 0;
                }
                this.loadDataForFilter(this.currentFilterIndex);
                return cb(null);
            },
            makeFilterActive: (formData, extraArgs, cb) => {
                const filters = new FileBaseFilters(this.client);
                filters.setActive(this.filtersArray[this.currentFilterIndex].uuid);

                this.updateActiveLabel();

                return cb(null);
            },
            newFilter: (formData, extraArgs, cb) => {
                this.currentFilterIndex = this.filtersArray.length; //  next avail slot
                this.clearForm(MciViewIds.editor.searchTerms);
                return cb(null);
            },
            deleteFilter: (formData, extraArgs, cb) => {
                const selectedFilter = this.filtersArray[this.currentFilterIndex];
                const filterUuid = selectedFilter.uuid;

                //  cannot delete built-in/system filters
                if (true === selectedFilter.system) {
                    this.showError('Cannot delete built in filters!');
                    return cb(null);
                }

                this.filtersArray.splice(this.currentFilterIndex, 1); //  remove selected entry

                //  remove from stored properties
                const filters = new FileBaseFilters(this.client);
                filters.remove(filterUuid);
                filters.persist(() => {
                    //
                    //  If the item was also the active filter, we need to make a new one active
                    //
                    if (
                        filterUuid ===
                        this.client.user.properties[UserProps.FileBaseFilterActiveUuid]
                    ) {
                        const newActive = this.filtersArray[this.currentFilterIndex];
                        if (newActive) {
                            filters.setActive(newActive.uuid);
                        } else {
                            //  nothing to set active to
                            this.client.user.removeProperty(
                                'file_base_filter_active_uuid'
                            );
                        }
                    }

                    //  update UI
                    this.updateActiveLabel();

                    if (this.filtersArray.length > 0) {
                        this.loadDataForFilter(this.currentFilterIndex);
                    } else {
                        this.clearForm();
                    }
                    return cb(null);
                });
            },

            viewValidationListener: (err, cb) => {
                const errorView = this.viewControllers.editor.getView(
                    MciViewIds.editor.error
                );
                let newFocusId;

                if (errorView) {
                    if (err) {
                        errorView.setText(err.message);
                        err.view.clearText(); //  clear out the invalid data
                    } else {
                        errorView.clearText();
                    }
                }

                return cb(newFocusId);
            },
        };
    }

    showError(errMsg) {
        const errorView = this.viewControllers.editor.getView(MciViewIds.editor.error);
        if (errorView) {
            if (errMsg) {
                errorView.setText(errMsg);
            } else {
                errorView.clearText();
            }
        }
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = self.addViewController(
                'editor',
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

                        const areasView = vc.getView(MciViewIds.editor.area);
                        if (areasView) {
                            areasView.setItems(self.availAreas.map(a => a.name));
                        }

                        self.updateActiveLabel();
                        self.loadDataForFilter(self.currentFilterIndex);
                        self.viewControllers.editor.resetInitialFocus();
                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    getCurrentFilter() {
        return this.filtersArray[this.currentFilterIndex];
    }

    setText(mciId, text) {
        const view = this.viewControllers.editor.getView(mciId);
        if (view) {
            view.setText(text);
        }
    }

    updateActiveLabel() {
        const activeFilter = FileBaseFilters.getActiveFilter(this.client);
        if (activeFilter) {
            const activeFormat = this.menuConfig.config.activeFormat || '{name}';
            this.setText(
                MciViewIds.editor.activeFilterInfo,
                stringFormat(activeFormat, activeFilter)
            );
        }
    }

    setFocusItemIndex(mciId, index) {
        const view = this.viewControllers.editor.getView(mciId);
        if (view) {
            view.setFocusItemIndex(index);
        }
    }

    clearForm(newFocusId) {
        [
            MciViewIds.editor.searchTerms,
            MciViewIds.editor.tags,
            MciViewIds.editor.filterName,
        ].forEach(mciId => {
            this.setText(mciId, '');
        });

        [MciViewIds.editor.area, MciViewIds.editor.order, MciViewIds.editor.sort].forEach(
            mciId => {
                this.setFocusItemIndex(mciId, 0);
            }
        );

        if (newFocusId) {
            this.viewControllers.editor.switchFocus(newFocusId);
        } else {
            this.viewControllers.editor.resetInitialFocus();
        }
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

    setAreaIndexFromCurrentFilter() {
        let index;
        const filter = this.getCurrentFilter();
        if (filter) {
            //  special treatment: areaTag saved as blank ("") if -ALL-
            index =
                (filter.areaTag &&
                    this.availAreas.findIndex(area => filter.areaTag === area.areaTag)) ||
                0;
        } else {
            index = 0;
        }
        this.setFocusItemIndex(MciViewIds.editor.area, index);
    }

    setOrderByFromCurrentFilter() {
        let index;
        const filter = this.getCurrentFilter();
        if (filter) {
            index =
                FileBaseFilters.OrderByValues.findIndex(ob => filter.order === ob) || 0;
        } else {
            index = 0;
        }
        this.setFocusItemIndex(MciViewIds.editor.order, index);
    }

    setSortByFromCurrentFilter() {
        let index;
        const filter = this.getCurrentFilter();
        if (filter) {
            index = FileBaseFilters.SortByValues.findIndex(sb => filter.sort === sb) || 0;
        } else {
            index = 0;
        }
        this.setFocusItemIndex(MciViewIds.editor.sort, index);
    }

    getSortBy(index) {
        return FileBaseFilters.SortByValues[index] || FileBaseFilters.SortByValues[0];
    }

    setFilterValuesFromFormData(filter, formData) {
        filter.name = formData.value.name;
        filter.areaTag = this.getSelectedAreaTag(formData.value.areaIndex);
        filter.terms = formData.value.searchTerms;
        filter.tags = formData.value.tags;
        filter.order = this.getOrderBy(formData.value.orderByIndex);
        filter.sort = this.getSortBy(formData.value.sortByIndex);
    }

    saveCurrentFilter(formData, cb) {
        const filters = new FileBaseFilters(this.client);
        const selectedFilter = this.filtersArray[this.currentFilterIndex];

        if (selectedFilter) {
            //  *update* currently selected filter
            this.setFilterValuesFromFormData(selectedFilter, formData);
            filters.replace(selectedFilter.uuid, selectedFilter);
        } else {
            //  add a new entry; note that UUID will be generated
            const newFilter = {};
            this.setFilterValuesFromFormData(newFilter, formData);

            //  set current to what we just saved
            newFilter.uuid = filters.add(newFilter);

            //  add to our array (at current index position)
            this.filtersArray[this.currentFilterIndex] = newFilter;
        }

        return filters.persist(cb);
    }

    loadDataForFilter(filterIndex) {
        const filter = this.filtersArray[filterIndex];
        if (filter) {
            this.setText(MciViewIds.editor.searchTerms, filter.terms);
            this.setText(MciViewIds.editor.tags, filter.tags);
            this.setText(MciViewIds.editor.filterName, filter.name);

            this.setAreaIndexFromCurrentFilter();
            this.setSortByFromCurrentFilter();
            this.setOrderByFromCurrentFilter();
        }
    }
};
