/* jslint node: true */
'use strict';

//
//  Common SYSTEM/global properties/stats used throughout the system.
//
//  This IS NOT a full list. Custom modules & the like can create
//  their own!
//
module.exports = {
    LoginCount          : 'login_count',
    LoginsToday         : 'logins_today',   //  non-persistent

    FileBaseAreaStats   : 'file_base_area_stats',   //  object - see file_base_area.js::getAreaStats
    FileUlTotalCount    : 'ul_total_count',
    FileUlTotalBytes    : 'ul_total_bytes',

    //  begin +op non-persistent...
    SysOpUsername       : 'sysop_username',
    SysOpRealName       : 'sysop_real_name',
    SysOpLocation       : 'sysop_location',
    SysOpAffiliations   : 'sysop_affiliation',
    SysOpSex            : 'sysop_sex',
    SysOpEmailAddress   : 'sysop_email_address',
    //  end +op non-persistent

    NextRandomRumor     : 'random_rumor',
};
