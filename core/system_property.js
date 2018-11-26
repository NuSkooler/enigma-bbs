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

    FileBaseAreaStats   : 'file_base_area_stats',   //  object - see file_base_area.js::getAreaStats
    FileUlTotalCount    : 'ul_total_count',
    FileUlTotalBytes    : 'ul_total_bytes',

    SysOpUsername       : 'sysop_username',
    SysOpRealName       : 'sysop_real_name',
    SysOpLocation       : 'sysop_location',
    SysOpAffiliations   : 'sysop_affiliation',
    SysOpSex            : 'sysop_sex',
    SysOpEmailAddress   : 'sysop_email_address',

    NextRandomRumor     : 'random_rumor',
};
