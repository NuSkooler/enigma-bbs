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
    LastLogin: 'last_login', //  object { userId, sessionId, userName, userRealName, timestamp }; non-persistent

    FileBaseAreaStats: 'file_base_area_stats', //  object - see file_base_area.js::getAreaStats
    FileUlTotalCount: 'ul_total_count',
    FileUlTotalBytes: 'ul_total_bytes',
    FileDlTotalCount: 'dl_total_count',
    FileDlTotalBytes: 'dl_total_bytes',

    FileUlTodayCount: 'ul_today_count', //  non-persistent
    FileUlTodayBytes: 'ul_today_bytes', //  non-persistent
    FileDlTodayCount: 'dl_today_count', //  non-persistent
    FileDlTodayBytes: 'dl_today_bytes', //  non-persistent

    MessageTotalCount: 'message_post_total_count', //  total non-private messages on the system; non-persistent
    MessagesToday: 'message_post_today', //  non-private messages posted/imported today; non-persistent

    SysOpUsername: 'sysop_username', //  non-persistent
    SysOpRealName: 'sysop_real_name', //  non-persistent
    SysOpLocation: 'sysop_location', //  non-persistent
    SysOpAffiliations: 'sysop_affiliation', //  non-persistent
    SysOpSex: 'sysop_sex', //  non-persistent
    SysOpEmailAddress: 'sysop_email_address', //  non-persistent

    NextRandomRumor: 'random_rumor',

    SystemMemoryStats: 'system_memory_stats', // object { totalBytes, freeBytes }; non-persistent
    SystemLoadStats: 'system_load_stats', // object { average, current }; non-persistent
    ProcessTrafficStats: 'system_traffic_bytes_ingress', // object { ingress, egress }; non-persistent

    TotalUserCount: 'user_total_count', //  non-persistent
    NewUsersTodayCount: 'user_new_today_count', //  non-persistent
};
