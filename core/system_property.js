/* jslint node: true */
'use strict';

//
//  Common SYSTEM/global properties/stats used throughout the system.
//
//  This IS NOT a full list. Custom modules & the like can create
//  their own!
//
module.exports = {
    LoginCount: 'login_count',
    LoginsToday: 'logins_today', //  non-persistent

    FileBaseAreaStats: 'file_base_area_stats', //  object - see file_base_area.js::getAreaStats
    FileUlTotalCount: 'ul_total_count',
    FileUlTotalBytes: 'ul_total_bytes',
    FileDlTotalCount: 'dl_total_count',
    FileDlTotalBytes: 'dl_total_bytes',

    MessageTotalCount: 'message_post_total_count', //  total non-private messages on the system; non-persistent
    MessagesToday: 'message_post_today', //  non-private messages posted/imported today; non-persistent

    //  begin +op non-persistent...
    SysOpUsername: 'sysop_username',
    SysOpRealName: 'sysop_real_name',
    SysOpLocation: 'sysop_location',
    SysOpAffiliations: 'sysop_affiliation',
    SysOpSex: 'sysop_sex',
    SysOpEmailAddress: 'sysop_email_address',
    //  end +op non-persistent

    NextRandomRumor: 'random_rumor',
};
