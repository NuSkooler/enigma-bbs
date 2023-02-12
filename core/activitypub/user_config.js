const { MenuModule } = require('../menu_module');
const ActivityPubSettings = require('./settings');
const { Errors } = require('../enig_error');
const { getServer } = require('../listening_server');
const { userNameToSubject } = require('./util');

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

        customRangeStart: 10,
    },
};

const EnabledViewGroup = [
    MciViewIds.main.manuallyApproveFollowersToggle,
    MciViewIds.main.hideSocialGraphToggle,
    MciViewIds.main.showRealNameToggle,
    MciViewIds.main.image,
    MciViewIds.main.icon,
    MciViewIds.main.manageImagesButton,
];

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

        apSettings.persistToUserProperties(this.client.user, err => {
            if (err) {
                const user = this.client.user;
                this.client.log.warn(
                    { error: err.message, user: user.username },
                    `Failed saving ActivityPub settings for user "${user.username}"`
                );
            }
            return this.prevMenu(cb);
        });
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

                    this._toggleEnabledViewGroup();
                    this._updateCustomViews();

                    enabledToggleView.on('index update', () => {
                        this._toggleEnabledViewGroup();
                        this._updateCustomViews();
                    });

                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    _toggleEnabledViewGroup() {
        const enabledToggleView = this.getView('main', MciViewIds.main.enabledToggle);
        EnabledViewGroup.forEach(id => {
            const v = this.getView('main', id);
            v.acceptsFocus = enabledToggleView.isTrue();
        });
    }

    _updateCustomViews() {
        const enabledToggleView = this.getView('main', MciViewIds.main.enabledToggle);
        const ws = this._webServer();
        const enabled = enabledToggleView.isTrue();
        const formatObj = {
            enabled,
            status: enabled ? 'enabled' : 'disabled',
            subject: enabled
                ? ws
                    ? userNameToSubject(this.client.user.username, ws)
                    : 'N/A'
                : '',
        };

        this.updateCustomViewTextsWithFilter(
            'main',
            MciViewIds.main.customRangeStart,
            formatObj
        );
    }

    _webServer() {
        if (undefined === this.webServer) {
            this.webServer = getServer('codes.l33t.enigma.web.server');
        }
        return this.webServer ? this.webServer.instance : null;
    }
};
