/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const getDefaultConfigPath			= require('./oputil_common.js').getDefaultConfigPath;

exports.getHelpFor				= getHelpFor;

const usageHelp = exports.USAGE_HELP = {
	General :
`usage: optutil.js [--version] [--help]
                   <command> [<args>]

global args:
  --config PATH         : specify config path (${getDefaultConfigPath()})

where <command> is one of:
  user                  : user utilities
  config                : config file management
  fb                    : file base management

`,
	User : 
`usage: optutil.js user --user USERNAME <args>

valid args:
  --user USERNAME       : specify username for further actions
  --password PASS       : set new password 
  --delete              : delete user
  --activate            : activate user
  --deactivate          : deactivate user
`,

	Config : 
`usage: optutil.js config <args>

valid args:
  --new                 : generate a new/initial configuration
`,
	FileBase :
`usage: oputil.js fb <action> [<args>] [<action_specific>]

where <action> is one of:
  scan <args> AREA_TAG         : (re)scan area specified by AREA_TAG for new files
                                 multiple area tags can be specified in form of AREA_TAG1 AREA_TAG2 ...

valid scan <args>:
  --tags TAG1,TAG2,...  : specify tag(s) to assign to discovered entries

ARE_TAG can optionally contain @STORAGE_TAG; for example: retro_pc@bbs
`
};

function getHelpFor(command) {
	return usageHelp[command];
}