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
  --no-prompt           : assume defaults/don't prompt for input where possible

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
`usage: optutil.js config <action> [<args>]

where <action> is one of:
  new                   : generate a new/initial configuration
  import-na [CONF_TAG]  : import fidonet *.NA file
                          if CONF_TAG is not supplied, it will be prompted for
`,
	FileBase :
`usage: oputil.js fb <action> [<args>] <AREA_TAG|SHA|FILE_ID[@STORAGE_TAG] ...> [<args>]

where <action> is one of:
  scan AREA_TAG|SHA|FILE_ID    : scan specified areas
                                 AREA_TAG may be suffixed with @STORAGE_TAG; for example: retro@bbs

  info AREA_TAG|FILE_ID|SHA    : display information about areas and/or files
                                 SHA may be a full or partial SHA-256

valid scan <args>:
  --tags TAG1,TAG2,...         : specify tag(s) to assign to discovered entries

valid info <args>:
  --show-desc                  : display short description, if any
`
};

function getHelpFor(command) {
	return usageHelp[command];
}