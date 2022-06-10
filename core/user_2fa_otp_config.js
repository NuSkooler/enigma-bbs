/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const UserProps = require('./user_property.js');
const {
    OTPTypes,
    otpFromType,
    createQRCode,
    createBackupCodes,
} = require('./user_2fa_otp.js');
const { Errors } = require('./enig_error.js');
const { getServer } = require('./listening_server.js');
const WebServerPackageName = require('./servers/content/web.js').moduleInfo.packageName;
const WebRegister = require('./user_2fa_otp_web_register.js');

//  deps
const async = require('async');
const _ = require('lodash');
const iconv = require('iconv-lite');

exports.moduleInfo = {
    name: 'User 2FA/OTP Configuration',
    desc: 'Module for user 2FA/OTP configuration',
    author: 'NuSkooler',
};

const FormIds = {
    menu: 0,
};

const MciViewIds = {
    enableToggle: 1,
    otpType: 2,
    submit: 3,
    infoText: 4,

    customRangeStart: 10, //  10+ = customs
};

const DefaultMsg = {
    infoText: {
        disabled:
            'Enabling 2-factor authentication can greatly increase account security.',
        enabled:
            'A valid email address set in user config is required to enable 2-Factor Authentication.',
        rfc6238_TOTP: 'Time-Based One-Time-Password (TOTP, RFC-6238).',
        rfc4266_HOTP: 'HMAC-Based One-Time-Password (HOTP, RFC-4266).',
        googleAuth: 'Google Authenticator.',
    },
    statusText: {
        otpNotEnabled: '2FA/OTP is not currently enabled for this account.',
        noBackupCodes: 'No backup codes remaining or set.',
        saveDisabled: '2FA/OTP is now disabled for this account.',
        saveEmailSent:
            'An 2FA/OTP registration email has been sent with further instructions.',
        saveError: 'Failed to send email. Please contact the system operator.',
        qrNotAvail: 'QR code not available for this OTP type.',
        emailRequired:
            'Your account must have a valid email address set to use this feature.',
    },
};

exports.getModule = class User2FA_OTPConfigModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            showQRCode: (formData, extraArgs, cb) => {
                return this.showQRCode(cb);
            },
            showSecret: (formData, extraArgs, cb) => {
                return this.showSecret(cb);
            },
            showBackupCodes: (formData, extraArgs, cb) => {
                return this.showBackupCodes(cb);
            },
            generateNewBackupCodes: (formData, extraArgs, cb) => {
                return this.generateNewBackupCodes(cb);
            },
            saveChanges: (formData, extraArgs, cb) => {
                return this.saveChanges(formData, cb);
            },
        };
    }

    initSequence() {
        const webServer = getServer(WebServerPackageName);
        if (!webServer || !webServer.instance.isEnabled()) {
            this.client.log.warn(
                'User 2FA/OTP configuration requires the web server to be enabled!'
            );
            return this.prevMenu(() => {
                /* dummy */
            });
        }
        return super.initSequence();
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    callback => {
                        return this.prepViewController(
                            'menu',
                            FormIds.menu,
                            mciData.menu,
                            callback
                        );
                    },
                    callback => {
                        const requiredCodes = [
                            MciViewIds.enableToggle,
                            MciViewIds.otpType,
                            MciViewIds.submit,
                        ];
                        return this.validateMCIByViewIds('menu', requiredCodes, callback);
                    },
                    callback => {
                        const enableToggleView = this.getView(
                            'menu',
                            MciViewIds.enableToggle
                        );
                        let initialIndex = this.isOTPEnabledForUser() ? 1 : 0;
                        enableToggleView.setFocusItemIndex(initialIndex);
                        this.enableToggleUpdate(initialIndex);

                        enableToggleView.on('index update', idx => {
                            return this.enableToggleUpdate(idx);
                        });

                        const otpTypeView = this.getView('menu', MciViewIds.otpType);
                        initialIndex = this.otpTypeIndexFromUserOTPType();
                        otpTypeView.setFocusItemIndex(initialIndex);

                        otpTypeView.on('index update', idx => {
                            return this.otpTypeUpdate(idx);
                        });

                        this.viewControllers.menu.on('return', view => {
                            if (view === enableToggleView) {
                                return this.enableToggleUpdate(
                                    enableToggleView.focusedItemIndex
                                );
                            } else if (view === otpTypeView) {
                                return this.otpTypeUpdate(otpTypeView.focusedItemIndex);
                            }
                        });

                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    displayDetails(details, cb) {
        const modOpts = {
            extraArgs: {
                artData: iconv.encode(`${details}\r\n`, 'cp437'),
            },
        };
        this.gotoMenu(
            this.menuConfig.config.userTwoFactorAuthOTPConfigShowDetails ||
                'userTwoFactorAuthOTPConfigShowDetails',
            modOpts,
            cb
        );
    }

    showQRCode(cb) {
        const otp = otpFromType(this.client.user.getProperty(UserProps.AuthFactor2OTP));

        let qrCode;
        if (!otp) {
            qrCode = this.getStatusText('otpNotEnabled');
        } else {
            const qrOptions = {
                username: this.client.user.username,
                qrType: 'ascii',
            };

            qrCode = createQRCode(
                otp,
                qrOptions,
                this.client.user.getProperty(UserProps.AuthFactor2OTPSecret)
            );

            if (qrCode) {
                qrCode = qrCode.replace(/\n/g, '\r\n');
            } else {
                qrCode = this.getStatusText('qrNotAvail');
            }
        }

        return this.displayDetails(qrCode, cb);
    }

    showSecret(cb) {
        const info =
            this.client.user.getProperty(UserProps.AuthFactor2OTPSecret) ||
            this.getStatusText('otpNotEnabled');
        return this.displayDetails(info, cb);
    }

    showBackupCodes(cb) {
        let info;
        const noBackupCodes = this.getStatusText('noBackupCodes');
        if (!this.isOTPEnabledForUser()) {
            info = this.getStatusText('otpNotEnabled');
        } else {
            try {
                info = JSON.parse(
                    this.client.user.getProperty(UserProps.AuthFactor2OTPBackupCodes) ||
                        '[]'
                ).join(', ');
                info = info || noBackupCodes;
            } catch (e) {
                info = noBackupCodes;
            }
        }
        return this.displayDetails(info, cb);
    }

    generateNewBackupCodes(cb) {
        if (!this.isOTPEnabledForUser()) {
            const info = this.getStatusText('otpNotEnabled');
            return this.displayDetails(info, cb);
        }

        const backupCodes = createBackupCodes();
        this.client.user.persistProperty(
            UserProps.AuthFactor2OTPBackupCodes,
            JSON.stringify(backupCodes),
            err => {
                if (err) {
                    return cb(err);
                }
                const info = backupCodes.join(', ');
                return this.displayDetails(info, cb);
            }
        );
    }

    saveChanges(formData, cb) {
        const enabled = 1 === _.get(formData, 'value.enableToggle', 0);
        return enabled
            ? this.saveChangesEnable(formData, cb)
            : this.saveChangesDisable(cb);
    }

    saveChangesEnable(formData, cb) {
        //  User must have an email address set to save
        const emailRegExp = /[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(.[a-z0-9-]+)*/;
        const emailAddr = this.client.user.getProperty(UserProps.EmailAddress);
        if (!emailAddr || !emailRegExp.test(emailAddr)) {
            const info = this.getStatusText('emailRequired');
            return this.displayDetails(info, cb);
        }

        const otpTypeProp = this.otpTypeFromOTPTypeIndex(
            _.get(formData, 'value.otpType')
        );

        const saveFailedError = err => {
            const info = this.getStatusText('saveError');
            this.displayDetails(info, () => {
                return cb(err);
            });
        };

        //  sanity check
        if (!otpFromType(otpTypeProp)) {
            return saveFailedError(
                Errors.Invalid('Cannot convert selected index to valid OTP type')
            );
        }

        this.removeUserOTPProperties(err => {
            if (err) {
                return saveFailedError(err);
            }
            WebRegister.sendRegisterEmail(this.client.user, otpTypeProp, err => {
                if (err) {
                    return saveFailedError(err);
                }

                const info = this.getStatusText('saveEmailSent');
                return this.displayDetails(info, cb);
            });
        });
    }

    removeUserOTPProperties(cb) {
        const props = [
            UserProps.AuthFactor2OTP,
            UserProps.AuthFactor2OTPSecret,
            UserProps.AuthFactor2OTPBackupCodes,
        ];
        return this.client.user.removeProperties(props, cb);
    }

    saveChangesDisable(cb) {
        this.removeUserOTPProperties(err => {
            if (err) {
                return cb(err);
            }

            const info = this.getStatusText('saveDisabled');
            return this.displayDetails(info, cb);
        });
    }

    isOTPEnabledForUser() {
        return this.client.user.getProperty(UserProps.AuthFactor2OTP) ? true : false;
    }

    getInfoText(key) {
        return _.get(this.config, ['infoText', key], DefaultMsg.infoText[key]);
    }

    getStatusText(key) {
        return _.get(this.config, ['statusText', key], DefaultMsg.statusText[key]);
    }

    enableToggleUpdate(idx) {
        const key = {
            0: 'disabled',
            1: 'enabled',
        }[idx];
        this.updateCustomViewTextsWithFilter('menu', MciViewIds.customRangeStart, {
            infoText: this.getInfoText(key),
        });
    }

    otpTypeIndexFromUserOTPType(defaultIndex = 0) {
        const type = this.client.user.getProperty(UserProps.AuthFactor2OTP);
        return (
            {
                [OTPTypes.RFC6238_TOTP]: 0,
                [OTPTypes.RFC4266_HOTP]: 1,
                [OTPTypes.GoogleAuthenticator]: 2,
            }[type] || defaultIndex
        );
    }

    otpTypeFromOTPTypeIndex(idx) {
        return {
            0: OTPTypes.RFC6238_TOTP,
            1: OTPTypes.RFC4266_HOTP,
            2: OTPTypes.GoogleAuthenticator,
        }[idx];
    }

    otpTypeUpdate(idx) {
        const key = this.otpTypeFromOTPTypeIndex(idx);
        this.updateCustomViewTextsWithFilter('menu', MciViewIds.customRangeStart, {
            infoText: this.getInfoText(key),
        });
    }
};
