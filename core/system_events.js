/* jslint node: true */
'use strict';

module.exports = {
	ClientConnected		: 'codes.l33t.enigma.system.connected',		//	{ client, connectionCount }
	ClientDisconnected	: 'codes.l33t.enigma.system.disconnected',	//	{ client, connectionCount }
	TermDetected		: 'codes.l33t.enigma.system.term_detected',		//	{ client }

	//	User - includes { user, ...}
	UserLogin			: 'codes.l33t.enigma.system.user_login',
	UserLogoff			: 'codes.l33t.enigma.system.user_logoff',
	UserUpload			: 'codes.l33t.enigma.system.user_upload',	//	{..., files[ fileEntry, ...] }
	UserDownload		: 'codes.l33t.enigma.system.user_download',	//	{..., files[ fileEntry, ...] }
};