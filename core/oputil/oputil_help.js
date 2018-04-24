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
  mb                        message base management
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
`usage: oputil.js fb <action> [<args>]

actions:
  scan AREA_TAG[@STORAGE_TAG]  scan specified area

  info AREA_TAG|SHA|FILE_ID    display information about areas and/or files
                               SHA may be a full or partial SHA-256

  mv SRC [SRC...] DST          move entry(s) from SRC to DST
                               SRC: FILENAME_WC|SHA|FILE_ID|AREA_TAG[@STORAGE_TAG]
                               DST: AREA_TAG[@STORAGE_TAG]

  rm SRC [SRC...]              remove entry(s) from the system matching SRC
                               SRC: FILENAME_WC|SHA|FILE_ID|AREA_TAG[@STORAGE_TAG]

scan args:
  --tags TAG1,TAG2,...         specify tag(s) to assign to discovered entries

  --desc-file [PATH]           prefer file descriptions from DESCRIPT.ION file over
                               other sources such as FILE_ID.DIZ.
                               if PATH is specified, use DESCRIPT.ION at PATH instead
                               of looking in specific storage locations
  --update                     attempt to update information for existing entries                               

info args:
  --show-desc                  display short description, if any

remove args:
  --phys-file                  also remove underlying physical file
`,
  FileOpsInfo :
`
general information:
  AREA_TAG[@STORAGE_TAG]       can specify an area tag and optionally, a storage specific tag
                               example: retro@bbs
  
  FILENAME_WC                  filename with * and ? wildcard support. may match 0:n entries
  SHA                          full or partial SHA-256
  FILE_ID                      a file identifier. see file.sqlite3
`,
  MessageBase :
  `usage: oputil.js mb <action> [<args>]

  actions:
  areafix CMD1 CMD2 ... ADDR  sends an AreaFix NetMail to ADDR with the supplied command(s)
                              one or more commands may be supplied. commands that are multi
                              part such as "%COMPRESS ZIP" should be quoted.
`
};

function getHelpFor(command) {
	return usageHelp[command];
}
