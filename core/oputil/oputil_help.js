/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const getDefaultConfigPath = require('./oputil_common.js').getDefaultConfigPath;

exports.getHelpFor = getHelpFor;

const usageHelp = (exports.USAGE_HELP = {
    General: `usage: oputil.js [--version] [--help]
                  <command> [<arguments>]

Global arguments:
  -c, --config PATH         Specify config path (default is ${getDefaultConfigPath()})
  -n, --no-prompt           Assume defaults (don't prompt for input where possible)
  --verbose                 Verbose output, where applicable

Commands:
  user                      User management
  config                    Configuration management
  fb                        File base management
  mb                        Message base management
`,
    User: `usage: oputil.js user <action> [<arguments>]

Actions:
  info USERNAME                Display information about a user

  pw USERNAME PASSWORD         Set a user's password
  (passwd|password)

  rm USERNAME                  Permanently removes user from system
  (del|delete|remove)

  rename USERNAME NEWNAME      Rename a user
  (mv)

  2fa-otp USERNAME SPEC        Enable 2FA/OTP for the user
  (otp)

  The system supports various implementations of Two Factor Authentication (2FA)
  One Time Password (OTP) authentication.

  Valid specs:
    disable : Removes 2FA/OTP from the user
    google  : Google Authenticator
    hotp    : HMAC-Based One-Time Password Algorithm (RFC-4266)
    totp    : Time-Based One-Time Password Algorithm (RFC-6238)

  activate USERNAME            Set a user's status to "active"

  deactivate USERNAME          Set a user's status to "inactive"

  disable USERNAME             Set a user's status to "disabled"

  lock USERNAME                Set a user's status to "locked"

  group USERNAME [+|~]GROUP    Adds (+) or removes (~) user from a group

  list [FILTER]                List users with optional FILTER.

  Valid filters:
    all      : All users (default).
    disabled : Disabled users.
    inactive : Inactive users.
    active   : Active (regular) users.
    locked   : Locked users.

info arguments:
  --security                   Include security information in output

list arguments:
  --sort SORT_BY               Specify field to sort by

  Valid SORT_BY values:
    id        : User ID
    username  : Username
    realname  : Real name
    status    : Account status
    created   : Account creation date
    lastlogin : Last login timestamp
    logins    : Login count

2fa-otp arguments:
  --qr-type TYPE               Specify QR code type

  Valid QR types:
    ascii : Plain ASCII (default)
    data  : HTML data URL
    img   : HTML image tag
    svg   : SVG image

  --out PATH                   Path to write QR code to. defaults to stdout
`,

    Config: `usage: oputil.js config <action> [<arguments>]

Actions:
  new                      Generate a new / default configuration

  cat                      Write current configuration to stdout

cat arguments:
  --no-color               Disable color
  --no-comments            Strip any comments
`,
    FileBase: `usage: oputil.js fb <action> [<arguments>]

Actions:
  scan AREA_TAG[@STORAGE_TAG]  Scan specified area

  Tips:
    - May contain optional GLOB as last parameter.
      Example: ./oputil.js fb scan d0pew4r3z *.zip

    - AREA_TAG may contain simple wildcards.
      Example: ./oputil.js fb scan *warez*

  info CRITERIA                Display information about areas and/or files

  mv SRC [SRC...] DST          Move matching entry(s)
  (move)

  Source may be any of the following:
    - Filename including '*' wildcards
    - SHA-1
    - File ID
    - Area tag with optional @storageTag suffix
  Destination is area tag with optional @storageTag suffix

  rm SRC [SRC...]              Remove entry(s) from the system
  (del|delete|remove)

  Source may be any of the following:
    - Filename including '*' wildcards
    - SHA-1
    - File ID
    - Area tag with optional @storageTag suffix

  desc CRITERIA                Updates an file base entry's description

  Launches an external editor using $VISUAL, $EDITOR, or vim/notepad.

  import-areas FILEGATE.ZXX    Import file base areas using FileGate RAID type format

scan arguments:
  --tags TAG1,TAG2,...         Specify hashtag(s) to assign to discovered entries

  --desc-file [PATH]           Prefer file descriptions from supplied input file

  If a file description can be found in the supplied input file, prefer that description
  over other sources such related FILE_ID.DIZ. Path must point to a valid FILES.BBS or
  DESCRIPT.ION file.

  --update                     Attempt to update information for existing entries
  --full                       Perform a full scan (default is quick)

info arguments:
  --show-desc                  Display short description, if any

remove arguments:
  --phys-file                  Also remove underlying physical file

import-areas arguments:
  --type TYPE                  Sets import areas type

  Valid types are are "zxx" or "na".

  --create-dirs                Also create backing storage directories
`,
    FileOpsInfo: `
General Information:
  Generally an area tag can also include an optional storage tag. For example, the
  area of 'bbswarez' stored using 'bbswarez_main': bbswarez@bbswarez_main

  When performing an initial import of a large area or storage backing, --full
  is the best option. If re-scanning an area for updates a standard / quick scan is
  generally good enough.

  File ID's are those found in file.sqlite3.
`,
    MessageBase: `usage: oputil.js mb <action> [<arguments>]

Actions:
  areafix CMD1 CMD2 ... ADDR  Sends an AreaFix NetMail

  NetMail is sent to supplied address  with the supplied command(s). Multi-part commands
  such as "%COMPRESS ZIP" should be quoted.

  import-areas PATH           Import areas using FidoNet *.NA or AREAS.BBS file

  qwk-dump PATH               Dumps a QWK packet to stdout.
  qwk-export [AREA_TAGS] PATH Exports one or more configured message area to a QWK
                              packet in the directory specified by PATH. The QWK
                              BBS ID will be obtained by the final component of PATH.

import-areas arguments:
  --conf CONF_TAG             Conference tag in which to import areas
  --network NETWORK           Network name/key to associate FTN areas
  --uplinks UL1,UL2,...       One or more uplinks (comma separated)
  --type TYPE                 Area import type

  Valid types are "bbs" and "na".

qwk-export arguments:
  --user USER                 User in which to export for. Defaults to the SysOp.
  --after TIMESTAMP           Export only messages with a timestamp later than
                              TIMESTAMP.
  --no-qwke                   Disable QWKE extensions.
  --no-synchronet             Disable Synchronet style extensions.
`,
});

function getHelpFor(command) {
    return usageHelp[command];
}
