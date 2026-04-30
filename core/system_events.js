/* jslint node: true */
'use strict';

module.exports = {
    ClientConnected: 'codes.l33t.enigma.system.connected', //  { client, connectionCount }
    ClientDisconnected: 'codes.l33t.enigma.system.disconnected', //  { client, connectionCount }
    TermDetected: 'codes.l33t.enigma.system.term_detected', //  { client }

    ThemeChanged: 'codes.l33t.enigma.system.theme_changed', //  (theme.hjson): { themeId }
    ConfigChanged: 'codes.l33t.enigma.system.config_changed', //  (config.hjson)
    MenusChanged: 'codes.l33t.enigma.system.menus_changed', //  (menu.hjson)

    //  User - includes { user, callback, ... } where user *is* the user instance in question
    NewUserPrePersist: 'codes.l33t.enigma.system.user_new_pre_persist',
    //  User - includes { user, ...} where user is a *copy*
    NewUser: 'codes.l33t.enigma.system.user_new', //  { ... }
    UserLogin: 'codes.l33t.enigma.system.user_login', //  { ... }
    UserLogoff: 'codes.l33t.enigma.system.user_logoff', //  { ... }
    UserUpload: 'codes.l33t.enigma.system.user_upload', //  { ..., files[ fileEntry, ...] }
    UserDownload: 'codes.l33t.enigma.system.user_download', //  { ..., files[ fileEntry, ...] }
    UserPostMessage: 'codes.l33t.enigma.system.user_post_msg', //  { ..., areaTag }
    UserSendMail: 'codes.l33t.enigma.system.user_send_mail', //  { ... }
    UserRunDoor: 'codes.l33t.enigma.system.user_run_door', //  { ..., runTimeMinutes, doorTag|unknown }
    UserSendNodeMsg: 'codes.l33t.enigma.system.user_send_node_msg', //  { ..., global }
    UserPagedSysop: 'codes.l33t.enigma.system.user_paged_sysop', //  { user, nodeId, sessionId, message }
    UserStatSet: 'codes.l33t.enigma.system.user_stat_set', //  { ..., statName, statValue }
    UserStatIncrement: 'codes.l33t.enigma.system.user_stat_increment', //  { ..., statName, statIncrementBy, statValue }
    UserAchievementEarned: 'codes.l33t.enigma.system.user_achievement_earned', //  { ..., achievementTag, points, title, text }

    //  Emitted when a native BinkP session receives one or more inbound files.
    //  ftn_bso subscribes to this to trigger an immediate import/toss rather
    //  than waiting for the next scheduled run.  External mailers (binkd, etc.)
    //  are unaffected — they rely on the existing @watch / @sched mechanisms.
    NewInboundBSO: 'codes.l33t.enigma.system.new_inbound_bso',
};
