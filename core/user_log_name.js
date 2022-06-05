/* jslint node: true */
'use strict';

//
//  Common (but not all!) user log names
//
module.exports = {
    NewUser: 'new_user',
    Login: 'login',
    Logoff: 'logoff',
    UlFiles: 'ul_files', //  value=count
    UlFileBytes: 'ul_file_bytes', //  value=total bytes
    DlFiles: 'dl_files', //  value=count
    DlFileBytes: 'dl_file_bytes', //  value=total bytes
    PostMessage: 'post_msg', //  value=areaTag
    SendMail: 'send_mail',
    RunDoor: 'run_door', //  value=doorTag|unknown
    RunDoorMinutes: 'run_door_minutes', //  value=minutes ran
    SendNodeMsg: 'send_node_msg', //  value=global|direct
    AchievementEarned: 'achievement_earned', //  value=achievementTag
    AchievementPointsEarned: 'achievement_pts_earned', //  value=points earned
};
