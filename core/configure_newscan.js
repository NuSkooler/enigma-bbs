/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const messageArea = require('./message_area.js');
const UserProps = require('./user_property.js');
const { SystemInternalConfTags } = require('./message_const');
const { Errors } = require('./enig_error.js');

//  deps
const async = require('async');
const moment = require('moment');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Configure Newscan',
    desc: 'Configure message areas and floor date for newscan',
    author: 'NuSkooler',
};

const MciViewIds = {
    areaList: 1, //  VM1
    statusSelected: 2, //  TL2 - "X of Y areas selected"
    statusFloor: 3, //  TL3 - "Floor: YYYY-MM-DD" or "Floor: not set"
    customRangeStart: 10, //  TL10+ updated on focus change
};

exports.getModule = class ConfigureNewscanModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            toggleArea: (formData, extraArgs, cb) => {
                return this._toggleArea(cb);
            },
            toggleAllAreas: (formData, extraArgs, cb) => {
                return this._toggleAllAreas(cb);
            },
            setFloorDate: (formData, extraArgs, cb) => {
                return this.gotoMenu(
                    this.menuConfig.config.setFloorDateMenu || 'configureNewscanFloor',
                    {},
                    cb
                );
            },
            done: (formData, extraArgs, cb) => {
                return this.prevMenu(cb);
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
                    next => this.prepViewController('main', 0, mciData.menu, next),
                    next => {
                        const areaListView = this.viewControllers.main.getView(
                            MciViewIds.areaList
                        );
                        if (!areaListView) {
                            return next(
                                Errors.MissingMci(
                                    `Missing area list MCI ${MciViewIds.areaList}`
                                )
                            );
                        }

                        this._buildAreaList();

                        areaListView.on('index update', idx => {
                            this._onIndexUpdate(idx);
                        });

                        areaListView.setItems(this.areaItems);
                        areaListView.redraw();
                        this._updateStatusViews();
                        this._onIndexUpdate(0);
                        return next(null);
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Failed loading configure newscan'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }

    //  Build this.areaItems from available conferences/areas, merging
    //  in the user's current selection state from NewScanAreaTags.
    _buildAreaList() {
        const selectedTags = this._getSelectedTags();

        this.areaItems = [];

        messageArea
            .getSortedAvailMessageConferences(this.client)
            .filter(conf => !SystemInternalConfTags.includes(conf.confTag))
            .forEach(conf => {
                messageArea
                    .getSortedAvailMessageAreasByConfTag(conf.confTag, {
                        client: this.client,
                    })
                    .forEach(area => {
                        const selected =
                            selectedTags === null || selectedTags.includes(area.areaTag);
                        this.areaItems.push({
                            areaTag: area.areaTag,
                            confTag: conf.confTag,
                            confName: conf.conf.name,
                            areaName: area.area.name,
                            desc: area.area.desc || '',
                            selectedIndicator: selected ? '*' : ' ',
                            text: this._itemText(
                                selected,
                                conf.conf.name,
                                area.area.name
                            ),
                        });
                    });
            });
    }

    _itemText(selected, confName, areaName) {
        const sel = selected ? '*' : ' ';
        const conf = (confName || '').padEnd(14).slice(0, 14);
        const area = areaName || '';
        return `${sel}  ${conf}  ${area}`;
    }

    //  Returns null (= all areas) or an array of selected areaTag strings.
    _getSelectedTags() {
        const raw = this.client.user.getProperty(UserProps.NewScanAreaTags);
        if (!raw) {
            return null;
        }
        try {
            const tags = JSON.parse(raw);
            return Array.isArray(tags) && tags.length > 0 ? tags : null;
        } catch (e) {
            return null;
        }
    }

    _toggleArea(cb) {
        const areaListView = this.viewControllers.main.getView(MciViewIds.areaList);
        if (!areaListView) {
            return cb(null);
        }

        const idx = areaListView.focusedItemIndex;
        const item = this.areaItems[idx];
        if (!item) {
            return cb(null);
        }

        const selected = item.selectedIndicator !== '*';
        item.selectedIndicator = selected ? '*' : ' ';
        item.text = this._itemText(selected, item.confName, item.areaName);

        this._persistSelection(err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Failed persisting newscan areas'
                );
            }
            areaListView.setItems(this.areaItems);
            areaListView.setFocusItemIndex(idx);
            areaListView.redraw();
            this._updateStatusViews();
            return cb(null);
        });
    }

    _toggleAllAreas(cb) {
        const selectedCount = this.areaItems.filter(
            i => i.selectedIndicator === '*'
        ).length;
        const selectAll = selectedCount < this.areaItems.length;

        this.areaItems.forEach(item => {
            item.selectedIndicator = selectAll ? '*' : ' ';
            item.text = this._itemText(selectAll, item.confName, item.areaName);
        });

        this._persistSelection(err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Failed persisting newscan areas (toggle all)'
                );
            }
            const areaListView = this.viewControllers.main.getView(MciViewIds.areaList);
            if (areaListView) {
                const prevIdx = areaListView.focusedItemIndex;
                areaListView.setItems(this.areaItems);
                areaListView.setFocusItemIndex(prevIdx);
                areaListView.redraw();
            }
            this._updateStatusViews();
            return cb(null);
        });
    }

    _persistSelection(cb) {
        const selectedTags = this.areaItems
            .filter(i => i.selectedIndicator === '*')
            .map(i => i.areaTag);

        //  All selected = no filter needed; store empty string so the property
        //  exists but getSelectedTags() returns null (= scan all).
        const allSelected = selectedTags.length === this.areaItems.length;
        const value = allSelected ? '' : JSON.stringify(selectedTags);

        return this.client.user.persistProperty(UserProps.NewScanAreaTags, value, cb);
    }

    _updateStatusViews() {
        const selectedCount = this.areaItems.filter(
            i => i.selectedIndicator === '*'
        ).length;
        const total = this.areaItems.length;

        const statusText =
            selectedCount === total
                ? `All ${total} areas selected`
                : `${selectedCount} of ${total} areas selected`;

        this.setViewText('main', MciViewIds.statusSelected, statusText);

        const floor = this.client.user.getProperty(UserProps.NewScanMinTimestamp);
        let floorText = 'Floor: not set';
        if (floor) {
            const m = moment(floor);
            if (m.isValid()) {
                floorText = `Floor: ${m.format('YYYY-MM-DD')}`;
            }
        }
        this.setViewText('main', MciViewIds.statusFloor, floorText);
    }

    _onIndexUpdate(idx) {
        const item = this.areaItems[idx];
        if (!item) {
            return;
        }
        this.updateCustomViewTextsWithFilter('main', MciViewIds.customRangeStart, item);
    }
};
