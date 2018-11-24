/* jslint node: true */
'use strict';

//
//  Common user properties used throughout the system.
//
//  This IS NOT a full list. For example, custom modules
//  can utilize their own properties as well!
//
module.exports = {
    PassPbkdf2Salt              : 'pw_pbkdf2_salt',
    PassPbkdf2Dk                : 'pw_pbkdf2_dk',

    AccountStatus               : 'account_status',             //  See User.AccountStatus enum

    RealName                    : 'real_name',
    Sex                         : 'sex',
    Birthdate                   : 'birthdate',
    Location                    : 'location',
    Affiliations                : 'affiliation',
    EmailAddress                : 'email_address',
    WebAddress                  : 'web_address',
    TermHeight                  : 'term_height',
    TermWidth                   : 'term_width',
    ThemeId                     : 'theme_id',
    AccountCreated              : 'account_created',
    LastLoginTs                 : 'last_login_timestamp',
    LoginCount                  : 'login_count',
    UserComment                 : 'user_comment',               //  NYI

    DownloadQueue               : 'dl_queue',                   // download_queue.js

    FailedLoginAttempts         : 'failed_login_attempts',
    AccountLockedTs             : 'account_locked_timestamp',
    AccountLockedPrevStatus     : 'account_locked_prev_status', //  previous account status before lock out

    EmailPwResetToken           : 'email_password_reset_token',
    EmailPwResetTokenTs         : 'email_password_reset_token_ts',

    FileAreaTag                 : 'file_area_tag',
    FileBaseFilters             : 'file_base_filters',
    FileBaseFilterActiveUuid    : 'file_base_filter_active_uuid',
    FileBaseLastViewedId        : 'user_file_base_last_viewed',
    FileDlTotalCount            : 'dl_total_count',
    FileUlTotalCount            : 'ul_total_count',
    FileDlTotalBytes            : 'dl_total_bytes',
    FileUlTotalBytes            : 'ul_total_bytes',

    MessageConfTag              : 'message_conf_tag',
    MessageAreaTag              : 'message_area_tag',
    MessagePostCount            : 'post_count',
};

