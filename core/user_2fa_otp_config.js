/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule }        = require('./menu_module.js');
const UserProps             = require('./user_property.js');
const {
    OTPTypes,
    otpFromType,
    createQRCode,
}                           = require('./user_2fa_otp.js');

//  deps
const async             = require('async');
const _                 = require('lodash');
const iconv             = require('iconv-lite');

exports.moduleInfo = {
    name        : 'User 2FA/OTP Configuration',
    desc        : 'Module for user 2FA/OTP configuration',
    author      : 'NuSkooler',
};

const FormIds = {
    menu    : 0,
};

const MciViewIds = {
    enableToggle        : 1,
    typeSelection       : 2,
    submission          : 3,
    infoText            : 4,

    customRangeStart    : 10,   //  10+ = customs
};

exports.getModule = class User2FA_OTPConfigModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });

        this.menuMethods = {
            showQRCode : (formData, extraArgs, cb) => {
                return this.showQRCode(cb);
            }
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            async.series(
                [
                    (callback) => {
                        return this.prepViewController('menu', FormIds.menu, mciData.menu, callback);
                    },
                    (callback) => {
                        const requiredCodes = [
                            MciViewIds.enableToggle,
                            MciViewIds.typeSelection,
                            MciViewIds.submission,
                        ];
                        return this.validateMCIByViewIds('menu', requiredCodes, callback);
                    },
                    (callback) => {
                        const enableToggleView = this.getView('menu', MciViewIds.enableToggle);
                        let initialIndex = this.isOTPEnabledForUser() ? 1 : 0;
                        enableToggleView.setFocusItemIndex(initialIndex);
                        this.enableToggleUpdate(initialIndex);

                        enableToggleView.on('index update', idx => {
                            return this.enableToggleUpdate(idx);
                        });

                        const typeSelectionView = this.getView('menu', MciViewIds.typeSelection);
                        initialIndex = this.typeSelectionIndexFromUserOTPType();
                        typeSelectionView.setFocusItemIndex(initialIndex);

                        typeSelectionView.on('index update', idx => {
                            return this.typeSelectionUpdate(idx);
                        });

                        this.viewControllers.menu.on('return', view => {
                            if(view === enableToggleView) {
                                return this.enableToggleUpdate(enableToggleView.focusedItemIndex);
                            } else if (view === typeSelectionView) {
                                return this.typeSelectionUpdate(typeSelectionView.focusedItemIndex);
                            }
                        });

                        return callback(null);
                    }
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    showQRCode(cb) {
        const otp = otpFromType(this.client.user.getProperty(UserProps.AuthFactor2OTP));
        let qrCodeAscii = '';
        if(!otp) {
            qrCodeAscii = '2FA/OTP is not currently enabled for this account';
        }

        const qrOptions = {
            username    : this.client.user.username,
            qrType      : 'ascii',
        };
        qrCodeAscii = createQRCode(
            otp,
            qrOptions,
            this.client.user.getProperty(UserProps.AuthFactor2OTPSecret)
        ).replace(/\n/g, '\r\n');

        const modOpts = {
            extraArgs : {
                artData : iconv.encode(`${qrCodeAscii}\r\n`, 'cp437'),
            }
        };
        this.gotoMenu(
            this.menuConfig.config.mainMenuUser2FAOTP_ShowQR || 'mainMenuUser2FAOTP_ShowQR',
            modOpts,
            cb
        );
    }

    isOTPEnabledForUser() {
        return this.typeSelectionIndexFromUserOTPType(-1) != -1;
    }

    getInfoText(key) {
        return _.get(this.config, [ 'infoText', key ], '');
    }

    enableToggleUpdate(idx) {
        const key = {
            0 : '2faDisabled',
            1 : '2faEnabled',
        }[idx];
        this.updateCustomViewTextsWithFilter('menu', MciViewIds.customRangeStart, { infoText : this.getInfoText(key) } );
    }

    typeSelectionIndexFromUserOTPType(defaultIndex = 0) {
        const type = this.client.user.getProperty(UserProps.AuthFactor2OTP);
        return {
            [ OTPTypes.RFC6238_TOTP ]           : 0,
            [ OTPTypes.RFC4266_HOTP ]           : 1,
            [ OTPTypes.GoogleAuthenticator ]    : 2,
        }[type] || defaultIndex;
    }

    otpTypeFromTypeSelectionIndex(idx) {
        return {
            0 : OTPTypes.RFC6238_TOTP,
            1 : OTPTypes.RFC4266_HOTP,
            2 : OTPTypes.GoogleAuthenticator,
        }[idx];
    }

    typeSelectionUpdate(idx) {
        const key = '2faType_' + this.otpTypeFromTypeSelectionIndex(idx);
        this.updateCustomViewTextsWithFilter('menu', MciViewIds.customRangeStart, { infoText : this.getInfoText(key) } );
    }
};

