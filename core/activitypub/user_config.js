const { MenuModule } = require('../menu_module');
const ActivityPubSettings = require('./settings');
const { Errors } = require('../enig_error');

// deps
const async = require('async');
const { get, truncate } = require('lodash');

exports.moduleInfo = {
    name: 'ActivityPub User Config',
    desc: 'ActivityPub User Configuration',
    author: 'NuSkooler',
};

const FormIds = {
    main: 0,
    images: 1,
};

const MciViewIds = {
    main: {
        enabledToggle: 1,
        manuallyApproveFollowersToggle: 2,
        hideSocialGraphToggle: 3,
        showRealNameToggle: 4,
        image: 5,
        icon: 6,
        manageImagesButton: 7,
        saveOrCancel: 8,
    },
};

exports.getModule = class ActivityPubUserConfig extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            submit: (formData, extraArgs, cb) => {
                switch (formData.submitId) {
                    case MciViewIds.main.manageImagesButton:
                        return this._manageImagesButton(cb);

                    case MciViewIds.main.saveOrCancel: {
                        const save = get(formData, 'value.saveOrCancel') === 0;
                        return save ? this._save(formData.value, cb) : this.prevMenu(cb);
                    }

                    default:
                        cb(
                            Errors.UnexpectedState(
                                `Unexpected submitId: ${formData.submitId}`
                            )
                        );
                }
            },
        };
    }

    initSequence() {
        async.series(
            [
                callback => {
                    return this.beforeArt(callback);
                },
                callback => {
                    return this._displayMainPage(false, callback);
                },
            ],
            () => {
                this.finishedLoading();
            }
        );
    }

    _manageImagesButton(cb) {
        return cb(null);
    }

    _save(values, cb) {
        const reqFields = [
            'enabled',
            'manuallyApproveFollowers',
            'hideSocialGraph',
            'showRealName',
        ];
        if (
            !reqFields.every(p => {
                return true === !![values[p]];
            })
        ) {
            return cb(Errors.BadFormData('One or more missing form values'));
        }

        const apSettings = ActivityPubSettings.fromUser(this.client.user);
        apSettings.enabled = values.enabled;
        apSettings.manuallyApproveFollowers = values.manuallyApproveFollowers;
        apSettings.hideSocialGraph = values.hideSocialGraph;
        apSettings.showRealName = values.showRealName;

        return apSettings.persistToUserProperties(this.client.user, cb);
    }

    _displayMainPage(clearScreen, cb) {
        async.series(
            [
                callback => {
                    return this.displayArtAndPrepViewController(
                        'main',
                        FormIds.main,
                        { clearScreen },
                        callback
                    );
                },
                callback => {
                    return this.validateMCIByViewIds(
                        'main',
                        Object.values(MciViewIds.main),
                        callback
                    );
                },
                callback => {
                    const v = id => this.getView('main', id);

                    const enabledToggleView = v(MciViewIds.main.enabledToggle);
                    const manuallyApproveFollowersToggleView = v(
                        MciViewIds.main.manuallyApproveFollowersToggle
                    );
                    const hideSocialGraphToggleView = v(
                        MciViewIds.main.hideSocialGraphToggle
                    );
                    const showRealNameToggleView = v(MciViewIds.main.showRealNameToggle);
                    const imageView = v(MciViewIds.main.image);
                    const iconView = v(MciViewIds.main.icon);

                    const apSettings = ActivityPubSettings.fromUser(this.client.user);
                    enabledToggleView.setFromBoolean(apSettings.enabled);
                    manuallyApproveFollowersToggleView.setFromBoolean(
                        apSettings.manuallyApproveFollowers
                    );
                    hideSocialGraphToggleView.setFromBoolean(apSettings.hideSocialGraph);
                    showRealNameToggleView.setFromBoolean(apSettings.showRealName);
                    imageView.setText(
                        truncate(apSettings.image, { length: imageView.getWidth() })
                    );
                    iconView.setText(
                        truncate(apSettings.icon, { length: iconView.getWidth() })
                    );

                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }
};
