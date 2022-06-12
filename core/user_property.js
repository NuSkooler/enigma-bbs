/* jslint node: true */
'use strict';

//
//  Common user properties used throughout the system.
//
//  This IS NOT a full list. For example, custom modules
//  can utilize their own properties as well!
//
module.exports = {
    PassPbkdf2Salt: 'pw_pbkdf2_salt',
    PassPbkdf2Dk: 'pw_pbkdf2_dk',

    AccountStatus: 'account_status', //  See User.AccountStatus enum

    RealName: 'real_name',
    Sex: 'sex',
    Birthdate: 'birthdate',
    Location: 'location',
    Affiliations: 'affiliation',
    EmailAddress: 'email_address',
    WebAddress: 'web_address',
    TermHeight: 'term_height',
    TermWidth: 'term_width',
    ThemeId: 'theme_id',
    AccountCreated: 'account_created',
    LastLoginTs: 'last_login_timestamp',
    LoginCount: 'login_count',
    UserComment: 'user_comment', //  NYI
    AutoSignature: 'auto_signature',

    DownloadQueue: 'dl_queue', // see download_queue.js

    FailedLoginAttempts: 'failed_login_attempts',
    AccountLockedTs: 'account_locked_timestamp',
    AccountLockedPrevStatus: 'account_locked_prev_status', //  previous account status before lock out

    EmailPwResetToken: 'email_password_reset_token',
    EmailPwResetTokenTs: 'email_password_reset_token_ts',

    FileAreaTag: 'file_area_tag',
    FileBaseFilters: 'file_base_filters',
    FileBaseFilterActiveUuid: 'file_base_filter_active_uuid',
    FileBaseLastViewedId: 'user_file_base_last_viewed',
    FileDlTotalCount: 'dl_total_count',
    FileUlTotalCount: 'ul_total_count',
    FileDlTotalBytes: 'dl_total_bytes',
    FileUlTotalBytes: 'ul_total_bytes',

    MessageConfTag: 'message_conf_tag',
    MessageAreaTag: 'message_area_tag',
    MessagePostCount: 'post_count',

    DoorRunTotalCount: 'door_run_total_count',
    DoorRunTotalMinutes: 'door_run_total_minutes',

    AchievementTotalCount: 'achievement_total_count',
    AchievementTotalPoints: 'achievement_total_points',

    MinutesOnlineTotalCount: 'minutes_online_total_count',

    NewPrivateMailCount: 'new_private_mail_count', //  non-persistent
    NewAddressedToMessageCount: 'new_addr_to_msg_count', //  non-persistent
    SSHPubKey: 'ssh_public_key', //  OpenSSH format (ssh-keygen, etc.)
    AuthFactor1Types: 'auth_factor1_types', //  List of User.AuthFactor1Types value(s)
    AuthFactor2OTP: 'auth_factor2_otp', //  If present, OTP type for 2FA. See OTPTypes
    AuthFactor2OTPSecret: 'auth_factor2_otp_secret', //  Secret used in conjunction with OTP 2FA
    AuthFactor2OTPBackupCodes: 'auth_factor2_otp_backup', //  JSON array of backup codes
};
