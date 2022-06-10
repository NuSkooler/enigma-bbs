/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const Errors = require('./enig_error.js').Errors;
const FileEntry = require('./file_entry.js');
const FileBaseFilters = require('./file_base_filter.js');
const { getAvailableFileAreaTags } = require('./file_base_area.js');
const {
    getSortedAvailMessageConferences,
    getSortedAvailMessageAreasByConfTag,
    updateMessageAreaLastReadId,
    getMessageIdNewerThanTimestampByArea,
} = require('./message_area.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');
const moment = require('moment');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Set New Scan Date',
    desc: 'Sets new scan date for applicable scans',
    author: 'NuSkooler',
};

const MciViewIds = {
    main: {
        scanDate: 1,
        targetSelection: 2,
    },
};

//  :TODO: for messages, we could insert "conf - all areas" into targets, and allow such

exports.getModule = class SetNewScanDate extends MenuModule {
    constructor(options) {
        super(options);

        const config = this.menuConfig.config;

        this.target = config.target || 'message';
        this.scanDateFormat = config.scanDateFormat || 'YYYYMMDD';

        this.menuMethods = {
            scanDateSubmit: (formData, extraArgs, cb) => {
                let scanDate = _.get(formData, 'value.scanDate');
                if (!scanDate) {
                    return cb(Errors.MissingParam('"scanDate" missing from form data'));
                }

                scanDate = moment(scanDate, this.scanDateFormat);
                if (!scanDate.isValid()) {
                    return cb(
                        Errors.Invalid(
                            `"${_.get(formData, 'value.scanDate')}" is not a valid date`
                        )
                    );
                }

                const targetSelection = _.get(formData, 'value.targetSelection'); //  may be undefined if N/A

                this[`setNewScanDateFor${_.capitalize(this.target)}Base`](
                    targetSelection,
                    scanDate,
                    () => {
                        return this.prevMenu(cb);
                    }
                );
            },
        };
    }

    setNewScanDateForMessageBase(targetSelection, scanDate, cb) {
        const target = this.targetSelections[targetSelection];
        if (!target) {
            return cb(
                Errors.UnexpectedState('Unable to get target in which to set new scan')
            );
        }

        //  selected area, or all of 'em
        let updateAreaTags;
        if ('' === target.area.areaTag) {
            updateAreaTags = this.targetSelections
                .map(targetSelection => targetSelection.area.areaTag)
                .filter(areaTag => areaTag); //  remove the blank 'all' entry
        } else {
            updateAreaTags = [target.area.areaTag];
        }

        async.each(
            updateAreaTags,
            (areaTag, nextAreaTag) => {
                getMessageIdNewerThanTimestampByArea(
                    areaTag,
                    scanDate,
                    (err, messageId) => {
                        if (err) {
                            return nextAreaTag(err);
                        }

                        if (!messageId) {
                            return nextAreaTag(null); //  nothing to do
                        }

                        messageId = Math.max(messageId - 1, 0);

                        return updateMessageAreaLastReadId(
                            this.client.user.userId,
                            areaTag,
                            messageId,
                            true, //  allowOlder
                            nextAreaTag
                        );
                    }
                );
            },
            err => {
                return cb(err);
            }
        );
    }

    setNewScanDateForFileBase(targetSelection, scanDate, cb) {
        //
        //  ENiGMA doesn't currently have the concept of per-area
        //  scan pointers for users, so we use all areas avail
        //  to the user.
        //
        const filterCriteria = {
            areaTag: getAvailableFileAreaTags(this.client),
            newerThanTimestamp: scanDate,
            limit: 1,
            orderBy: 'upload_timestamp',
            order: 'ascending',
        };

        FileEntry.findFiles(filterCriteria, (err, fileIds) => {
            if (err) {
                return cb(err);
            }

            if (!fileIds || 0 === fileIds.length) {
                //  nothing to do
                return cb(null);
            }

            const pointerFileId = Math.max(fileIds[0] - 1, 0);

            return FileBaseFilters.setFileBaseLastViewedFileIdForUser(
                this.client.user,
                pointerFileId,
                true, //  allowOlder
                cb
            );
        });
    }

    loadAvailMessageBaseSelections(cb) {
        //
        //  Create an array of objects with conf/area information per entry,
        //  sorted naturally or via the 'sort' member in config
        //
        const selections = [];
        getSortedAvailMessageConferences(this.client).forEach(conf => {
            getSortedAvailMessageAreasByConfTag(conf.confTag, {
                client: this.client,
            }).forEach(area => {
                selections.push({
                    conf: {
                        confTag: conf.confTag,
                        text: conf.conf.name, //  standard
                        name: conf.conf.name,
                        desc: conf.conf.desc,
                    },
                    area: {
                        areaTag: area.areaTag,
                        text: area.area.name, //  standard
                        name: area.area.name,
                        desc: area.area.desc,
                    },
                });
            });
        });

        selections.unshift({
            conf: {
                confTag: '',
                text: 'All conferences',
                name: 'All conferences',
                desc: 'All conferences',
            },
            area: {
                areaTag: '',
                text: 'All areas',
                name: 'All areas',
                desc: 'All areas',
            },
        });

        //  Find current conf/area & move it directly under "All"
        const currConfTag = this.client.user.properties[UserProps.MessageConfTag];
        const currAreaTag = this.client.user.properties[UserProps.MessageAreaTag];
        if (currConfTag && currAreaTag) {
            const confAreaIndex = selections.findIndex(confArea => {
                return (
                    confArea.conf.confTag === currConfTag &&
                    confArea.area.areaTag === currAreaTag
                );
            });

            if (confAreaIndex > -1) {
                selections.splice(1, 0, selections.splice(confAreaIndex, 1)[0]);
            }
        }

        this.targetSelections = selections;

        return cb(null);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = self.addViewController(
                'main',
                new ViewController({ client: this.client })
            );

            async.series(
                [
                    function validateConfig(callback) {
                        if (!['message', 'file'].includes(self.target)) {
                            return callback(
                                Errors.Invalid(
                                    `Invalid "target" in config: ${self.target}`
                                )
                            );
                        }
                        //  :TOD0: validate scanDateFormat
                        return callback(null);
                    },
                    function loadFromConfig(callback) {
                        return vc.loadFromMenuConfig(
                            { callingMenu: self, mciMap: mciData.menu },
                            callback
                        );
                    },
                    function loadAvailSelections(callback) {
                        switch (self.target) {
                            case 'message':
                                return self.loadAvailMessageBaseSelections(callback);

                            default:
                                return callback(null);
                        }
                    },
                    function populateForm(callback) {
                        const today = moment();

                        const scanDateView = vc.getView(MciViewIds.main.scanDate);

                        //  :TODO: MaskTextEditView needs some love: If setText() with input that matches the mask, we should ignore the non-mask chars! Hack in place for now
                        const scanDateFormat = self.scanDateFormat.replace(
                            /[/\-. ]/g,
                            ''
                        );
                        scanDateView.setText(today.format(scanDateFormat));

                        if ('message' === self.target) {
                            const targetSelectionView = vc.getView(
                                MciViewIds.main.targetSelection
                            );

                            targetSelectionView.setItems(self.targetSelections);
                            targetSelectionView.setFocusItemIndex(0);
                        }

                        self.viewControllers.main.resetInitialFocus();
                        //vc.switchFocus(MciViewIds.main.scanDate);
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
