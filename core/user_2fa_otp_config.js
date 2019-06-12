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
const { Errors }            = require('./enig_error.js');
const { sendMail }          = require('./email.js');
const { getServer }         = require('./listening_server.js');
const WebServerPackageName  = require('./servers/content/web.js').moduleInfo.packageName;
const {
    createToken,
    WellKnownTokenTypes,
}                           = require('./user_temp_token.js');
const Config                = require('./config.js').get;

//  deps
const async             = require('async');
const _                 = require('lodash');
const iconv             = require('iconv-lite');
const fs                = require('fs-extra');

exports.moduleInfo = {
    name        : 'User 2FA/OTP Configuration',
    desc        : 'Module for user 2FA/OTP configuration',
    author      : 'NuSkooler',
};

const FormIds = {
    menu    : 0,
};

const MciViewIds = {
    enableToggle    : 1,
    otpType        : 2,
    submit          : 3,
    infoText        : 4,

    customRangeStart    : 10,   //  10+ = customs
};

const DefaultMsg = {
    otpNotEnabled   : '2FA/OTP is not currently enabled for this account.',
    noBackupCodes   : 'No backup codes remaining or set.',
};

const DefaultEmailTextTemplate =
    `%USERNAME%:
You have requested to enable 2-Factor Authentication via One-Time-Password
for your account on %BOARDNAME%.

    * If this was not you, please ignore this email and change your password.
    * Otherwise, please follow the link below:

    %REGISTER_URL%
`;

exports.getModule = class User2FA_OTPConfigModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });

        this.menuMethods = {
            showQRCode : (formData, extraArgs, cb) => {
                return this.showQRCode(cb);
            },
            showSecret : (formData, extraArgs, cb) => {
                return this.showSecret(cb);
            },
            showBackupCodes : (formData, extraArgs, cb) => {
                return this.showBackupCodes(cb);
            },
            saveChanges : (formData, extraArgs, cb) => {
                return this.saveChanges(formData, cb);
            }
        };
    }

    initSequence() {
        this.webServer = getServer(WebServerPackageName);
        if(!this.webServer || !this.webServer.instance.isEnabled()) {
            this.client.log.warn('User 2FA/OTP configuration requires the web server to be enabled!');
            return this.prevMenu( () => { /* dummy */ } );
        }
        return super.initSequence();
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
                            MciViewIds.otpType,
                            MciViewIds.submit,
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

                        const otpTypeView = this.getView('menu', MciViewIds.otpType);
                        initialIndex = this.otpTypeIndexFromUserOTPType();
                        otpTypeView.setFocusItemIndex(initialIndex);

                        otpTypeView.on('index update', idx => {
                            return this.otpTypeUpdate(idx);
                        });

                        this.viewControllers.menu.on('return', view => {
                            if(view === enableToggleView) {
                                return this.enableToggleUpdate(enableToggleView.focusedItemIndex);
                            } else if (view === otpTypeView) {
                                return this.otpTypeUpdate(otpTypeView.focusedItemIndex);
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

    displayDetails(details, cb) {
        const modOpts = {
            extraArgs : {
                artData : iconv.encode(`${details}\r\n`, 'cp437'),
            }
        };
        this.gotoMenu(
            this.menuConfig.config.user2FAOTP_ShowDetails || 'user2FAOTP_ShowDetails',
            modOpts,
            cb
        );
    }

    showQRCode(cb) {
        const otp = otpFromType(this.client.user.getProperty(UserProps.AuthFactor2OTP));

        let qrCode;
        if(!otp) {
            qrCode = this.config.otpNotEnabled || DefaultMsg.otpNotEnabled;
        } else {
            const qrOptions = {
                username    : this.client.user.username,
                qrType      : 'ascii',
            };
            qrCode = createQRCode(
                otp,
                qrOptions,
                this.client.user.getProperty(UserProps.AuthFactor2OTPSecret)
            ).replace(/\n/g, '\r\n');
        }

        return this.displayDetails(qrCode, cb);
    }

    showSecret(cb) {
        const info =
            this.client.user.getProperty(UserProps.AuthFactor2OTPSecret) ||
            this.config.otpNotEnabled || DefaultMsg.otpNotEnabled;
        return this.displayDetails(info, cb);
    }

    showBackupCodes(cb) {
        let info;
        const noBackupCodes = this.config.noBackupCodes || DefaultMsg.noBackupCodes;
        if(!this.isOTPEnabledForUser()) {
            info = this.config.otpNotEnabled || DefaultMsg.otpNotEnabled;
        } else {
            try {
                info = JSON.parse(this.client.user.getProperty(UserProps.AuthFactor2OTPBackupCodes) || '[]').join(', ');
                info = info || noBackupCodes;
            } catch(e) {
                info = noBackupCodes;
            }
        }
        return this.displayDetails(info, cb);
    }

    saveChanges(formData, cb) {
        const enabled = 1 === _.get(formData, 'value.enableToggle', 0);
        return enabled ? this.saveChangesEnable(formData, cb) : this.saveChangesDisable(cb);
    }

    saveChangesEnable(formData, cb) {
        const otpTypeProp = this.otpTypeFromOTPTypeIndex(_.get(formData, 'value.otpType'));

        //  sanity check
        if(!otpFromType(otpTypeProp)) {
            return cb(Errors.Invalid('Cannot convert selected index to valid OTP type'));
        }

        async.waterfall(
            [
                (callback) => {
                    return this.removeUserOTPProperties(callback);
                },
                (callback) => {
                    return createToken(this.client.user.userId, WellKnownTokenTypes.AuthFactor2OTPRegister, callback);
                },
                (token, callback) => {
                    const config = Config();
                    const txtTemplateFile   = _.get(config, 'users.twoFactorAuth.otp.registerEmailText');
                    const htmlTemplateFile  = _.get(config, 'users.twoFactorAuth.otp.registerEmailHtml');

                    fs.readFile(txtTemplateFile, 'utf8', (err, textTemplate) => {
                        textTemplate = textTemplate || DefaultEmailTextTemplate;
                        fs.readFile(htmlTemplateFile, 'utf8', (err, htmlTemplate) => {
                            htmlTemplate = htmlTemplate || null;    //  be explicit for waterfall
                            return callback(null, token, textTemplate, htmlTemplate);
                        });
                    });
                },
                (token, textTemplate, htmlTemplate, callback) => {
                    const registerUrl = this.webServer.instance.buildUrl(
                        `/enable_2fa_otp?token=&otpType=${otpTypeProp}&token=${token}`
                    );

                    const user = this.client.user;

                    const replaceTokens = (s) => {
                        return s
                            .replace(/%BOARDNAME%/g,    Config().general.boardName)
                            .replace(/%USERNAME%/g,     user.username)
                            .replace(/%TOKEN%/g,        token)
                            .replace(/%REGISTER_URL%/g, registerUrl)
                        ;
                    };

                    textTemplate = replaceTokens(textTemplate);
                    if(htmlTemplate) {
                        htmlTemplate = replaceTokens(htmlTemplate);
                    }

                    const message = {
                        to      : `${user.getProperty(UserProps.RealName) || user.username} <${user.getProperty(UserProps.EmailAddress)}>`,
                        //  from will be filled in
                        subject : '2-Factor Authentication Registration',
                        text    : textTemplate,
                        html    : htmlTemplate,
                    };

                    sendMail(message, (err, info) => {
                        //  :TODO: Log info!
                        return callback(err);
                    });
                }
            ],
            err => {
                return cb(err);
            }
        );
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
        this.removeUserOTPProperties( err => {
            if(err) {
                return cb(err);
            }

            //  :TODO: show "saved+disabled" art/message -> prevMenu
            return cb(null);
        });
    }

    isOTPEnabledForUser() {
        return this.otpTypeIndexFromUserOTPType(-1) != -1;
    }

    getInfoText(key) {
        return _.get(this.config, [ 'infoText', key ], '');
    }

    enableToggleUpdate(idx) {
        const key = {
            0 : 'disabled',
            1 : 'enabled',
        }[idx];
        this.updateCustomViewTextsWithFilter('menu', MciViewIds.customRangeStart, { infoText : this.getInfoText(key) } );
    }

    otpTypeIndexFromUserOTPType(defaultIndex = 0) {
        const type = this.client.user.getProperty(UserProps.AuthFactor2OTP);
        return {
            [ OTPTypes.RFC6238_TOTP ]           : 0,
            [ OTPTypes.RFC4266_HOTP ]           : 1,
            [ OTPTypes.GoogleAuthenticator ]    : 2,
        }[type] || defaultIndex;
    }

    otpTypeFromOTPTypeIndex(idx) {
        return {
            0 : OTPTypes.RFC6238_TOTP,
            1 : OTPTypes.RFC4266_HOTP,
            2 : OTPTypes.GoogleAuthenticator,
        }[idx];
    }

    otpTypeUpdate(idx) {
        const key = this.otpTypeFromOTPTypeIndex(idx);
        this.updateCustomViewTextsWithFilter('menu', MciViewIds.customRangeStart, { infoText : this.getInfoText(key) } );
    }
};
