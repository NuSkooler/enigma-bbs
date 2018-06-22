/* jslint node: true */
'use strict';

module.exports = {
    ClientConnected		: 'codes.l33t.enigma.system.connected',			//	{ client, connectionCount }
    ClientDisconnected	: 'codes.l33t.enigma.system.disconnected',		//	{ client, connectionCount }
    TermDetected		: 'codes.l33t.enigma.system.term_detected',		//	{ client }

    ThemeChanged		: 'codes.l33t.enigma.system.theme_changed',		//	{ themeId }
    ConfigChanged		: 'codes.l33t.enigma.system.config_changed',
    MenusChanged		: 'codes.l33t.enigma.system.menus_changed',
    PromptsChanged		: 'codes.l33t.enigma.system.prompts_changed',

    //	User - includes { user, ...}
    NewUser				: 'codes.l33t.enigma.system.new_user',
    UserLogin			: 'codes.l33t.enigma.system.user_login',
    UserLogoff			: 'codes.l33t.enigma.system.user_logoff',
    UserUpload			: 'codes.l33t.enigma.system.user_upload',		//	{..., files[ fileEntry, ...] }
    UserDownload		: 'codes.l33t.enigma.system.user_download',		//	{..., files[ fileEntry, ...] }

    //	NYI below here:
    UserPostMessage		: 'codes.l33t.enigma.system.user_post_msg',
    UserSendMail		: 'codes.l33t.enigma.system.user_send_mail',
    UserSendRunDoor		: 'codes.l33t.enigma.system.user_run_door',
};
