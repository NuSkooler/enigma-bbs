/* jslint node: true */
'use strict';

//
//  Common user properties used throughout the system.
//
//  This IS NOT a full list. For example, custom modules
//  can utilize their own properties as well!
//
module.exports = {
    PassPbkdf2Salt          : 'pw_pbkdf2_salt',
    PassPbkdf2Dk            : 'pw_pbkdf2_dk',

    AccountStatus           : 'account_status',

    Birthdate               : 'birthdate',

    FailedLoginAttempts     : 'failed_login_attempts',
    AccountLockedTs         : 'account_locked_timestamp',
    AccountLockedPrevStatus : 'account_locked_prev_status', //  previous account status

    EmailPwResetToken       : 'email_password_reset_token',
    EmailPwResetTokenTs     : 'email_password_reset_token_ts',
};

