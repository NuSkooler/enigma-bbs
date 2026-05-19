//  ENiGMA½
const { MenuModule } = require('./menu_module.js');

//  deps
const async = require('async');

exports.moduleInfo = {
    name: 'User Status Config',
    desc: 'Module for toggling user availability and visibility',
    author: 'NuSkooler',
};

const FormIds = {
    menu: 0,
};

const MciViewIds = {
    menu: {
        customRangeStart: 10,
    },
};

exports.getModule = class UserStatusConfigModule extends MenuModule {
    constructor(options) {
        super(options);
        this.setConfigWithExtraArgs(options);

        this.menuMethods = {
            toggleAvailable: (formData, extraArgs, cb) => {
                this.client.user.setAvailability(!this.client.user.isAvailable());
                this._updateCustomViews();
                return cb(null);
            },
            toggleVisible: (formData, extraArgs, cb) => {
                this.client.user.setVisibility(!this.client.user.isVisible());
                this._updateCustomViews();
                return cb(null);
            },
        };
    }

    initSequence() {
        async.series(
            [
                callback => this.beforeArt(callback),
                callback => this._displayPage(callback),
            ],
            () => {
                this.finishedLoading();
            }
        );
    }

    _displayPage(cb) {
        async.series(
            [
                callback =>
                    this.displayArtAndPrepViewController(
                        'menu',
                        FormIds.menu,
                        { clearScreen: true },
                        callback
                    ),
                callback => {
                    //  TL views don't accept focus, so the VC never gets a focused
                    //  view and its key handler is never attached — force it here.
                    this.viewControllers.menu.setFocus(true);
                    this._updateCustomViews();
                    return callback(null);
                },
            ],
            err => cb(err)
        );
    }

    _getIndicators() {
        return {
            enabled: this.config.enabledIndicator ?? '\xFB', //  CP437 √
            disabled: this.config.disabledIndicator ?? 'X',
        };
    }

    _updateCustomViews() {
        const { enabled, disabled } = this._getIndicators();
        const isAvailable = this.client.user.isAvailable();
        const isVisible = this.client.user.isVisible();

        this.updateCustomViewTextsWithFilter(
            'menu',
            MciViewIds.menu.customRangeStart,
            {
                isAvailable,
                isVisible,
                availableIndicator: isAvailable ? enabled : disabled,
                visibleIndicator: isVisible ? enabled : disabled,
            }
        );
    }
};
