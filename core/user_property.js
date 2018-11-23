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

    AccountStatus               : 'account_status',

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

    FailedLoginAttempts         : 'failed_login_attempts',
    AccountLockedTs             : 'account_locked_timestamp',
    AccountLockedPrevStatus     : 'account_locked_prev_status', //  previous account status

    EmailPwResetToken           : 'email_password_reset_token',
    EmailPwResetTokenTs         : 'email_password_reset_token_ts',

    FileAreaTag                 : 'file_area_tag',
    FileBaseFilters             : 'file_base_filters',
    FileBaseFilterActiveUuid    : 'file_base_filter_active_uuid',
    FileBaseLastViewedId        : 'user_file_base_last_viewed',

    MessageConfTag              : 'message_conf_tag',
    MessageAreaTag              : 'message_area_tag',
};

