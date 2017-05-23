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
  -c, --config PATH         specify config path (${getDefaultConfigPath()})
  -n, --no-prompt           assume defaults/don't prompt for input where possible

commands:
  user                      user utilities
  config                    config file management
  fb                        file base management

`,
	User : 
`usage: optutil.js user --user USERNAME <args>

valid args:
  --user USERNAME       specify username for further actions
  --password PASS       set new password 
  --delete              delete user
  --activate            activate user
  --deactivate          deactivate user
`,

	Config : 
`usage: optutil.js config <action> [<args>]

actions:
  new                      generate a new/initial configuration
  import-areas PATH        import areas using fidonet *.NA or AREAS.BBS file from PATH

import-areas args:
  --conf CONF_TAG          specify conference tag in which to import areas
  --network NETWORK        specify network name/key to associate FTN areas
  --uplinks UL1,UL2,...    specify one or more comma separated uplinks
  --type TYPE              specifies area import type. valid options are "bbs" and "na"
`,
	FileBase :
`usage: oputil.js fb <action> [<args>] <AREA_TAG|SHA|FILE_ID[@STORAGE_TAG] ...> [<args>]

actions:
  scan AREA_TAG                scan specified areas
                               AREA_TAG may be suffixed with @STORAGE_TAG; for example: retro@bbs

  info AREA_TAG|SHA|FILE_ID    display information about areas and/or files
                               SHA may be a full or partial SHA-256

  move SRC DST                 move entry(s) from SRC to DST where:
                               SRC may be FILE_ID|SHA|AREA_TAG
                               DST may be AREA_TAG, optionally suffixed with @STORAGE_TAG; for example: retro@bbs
                               SHA may be a full or partial SHA-256
                               multiple instances of SRC may exist: SRC1 SRC2 ...

scan args:
  --tags TAG1,TAG2,...         specify tag(s) to assign to discovered entries

info args:
  --show-desc                  display short description, if any
`
};

function getHelpFor(command) {
	return usageHelp[command];
}