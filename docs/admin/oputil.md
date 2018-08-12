---
layout: page
title: oputil
---
## The oputil CLI
ENiGMA½ comes with `oputil.js` henceforth known as `oputil`, a command line interface (CLI) tool for sysops to perform general system and user administration. You likely used oputil to do the initial ENiGMA configuration.

Let's look the main help output as per this writing:

```
usage: optutil.js [--version] [--help]
                  <command> [<args>]

global args:
  -c, --config PATH         specify config path (./config/)
  -n, --no-prompt           assume defaults/don't prompt for input where possible

commands:
  user                      user utilities
  config                    config file management
  fb                        file base management
  mb                        message base management
```

Commands break up operations by groups:

| Command   | Description   |
|-----------|---------------|
| `user`    | User management   |
| `config`  | System configuration and maintentance |
| `fb`      | File base configuration and management    |
| `mb`      | Message base configuration and management |

Global arguments apply to most commands and actions:
* `--config`: Specify configuration directory if it is not the default of `./config/`.
* `--no-prompt`: Assume defaults and do not prompt when posisible.

Type `./oputil.js <command> --help` for additional help on a particular command. The following sections will describe them.

## User
The `user` command covers various user operations.

```
usage: optutil.js user <action> [<args>]

actions:
  pw USERNAME PASSWORD         set password to PASSWORD for USERNAME
  rm USERNAME                  permanantely removes USERNAME user from system
  activate USERNAME            sets USERNAME's status to active
  deactivate USERNAME          sets USERNAME's status to deactive
  disable USERNAME             sets USERNAME's status to disabled
  group USERNAME [+|-]GROUP    adds (+) or removes (-) USERNAME from GROUP
```

| Action    | Description       | Examples                              | Aliases   |
|-----------|-------------------|---------------------------------------|-----------|
| `pw`        | Set password      | `./oputil.js user pw joeuser s3cr37`  | `pass`, `passwd`, `password` |
| `rm`        | Removes user      | `./oputil.js user del joeuser`        | `remove`, `del`, `delete` |
| `activate` | Activates user    | `./oputil.js user activate joeuser`   | N/A   |
| `deactivate`    | Deactivates user  | `./oputil.js user deactivate joeuser` | N/A   |
| `disable`   | Disables user (user will not be able to login)    | `./oputil.js user disable joeuser`    | N/A   |
| `group`   | Modifies users group membership   | Add to group: `./oputil.js user group joeuser +derp`<br/>Remove from group: `./oputil.js user group joeuser -derp`   | N/A    |

## Configuration
The `config` command allows sysops to perform various system configuration and maintenance tasks.

```
usage: optutil.js config <action> [<args>]

actions:
  new                      generate a new/initial configuration
  import-areas PATH        import areas using fidonet *.NA or AREAS.BBS file from PATH

import-areas args:
  --conf CONF_TAG          specify conference tag in which to import areas
  --network NETWORK        specify network name/key to associate FTN areas
  --uplinks UL1,UL2,...    specify one or more comma separated uplinks
  --type TYPE              specifies area import type. valid options are "bbs" and "na"
```


| Action    | Description       | Examples                              |
|-----------|-------------------|---------------------------------------|
| `new`     | Generates a new/initial configuration | `./oputil.js config new` (follow the prompts) |
| `import-areas`    | Imports areas using a Fidonet style *.NA or AREAS.BBS formatted file  | `./oputil.js config import-areas /some/path/l33tnet.na`   |

When using the `import-areas` action, you will be prompted for any missing additional arguments described in "import-areas args".

## File Base Management
The `fb` command provides a powerful file base management interface.

```
usage: oputil.js fb <action> [<args>]

actions:
  scan AREA_TAG[@STORAGE_TAG]  scan specified area
                               may also contain optional GLOB as last parameter,
                               for examle: scan some_area *.zip

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
  --quick                      perform quick scan

info args:
  --show-desc                  display short description, if any

remove args:
  --phys-file                  also remove underlying physical file

general information:
  AREA_TAG[@STORAGE_TAG]       can specify an area tag and optionally, a storage specific tag
                               example: retro@bbs
  
  FILENAME_WC                  filename with * and ? wildcard support. may match 0:n entries
  SHA                          full or partial SHA-256
  FILE_ID                      a file identifier. see file.sqlite3
```

#### Scan File Area
The `scan` action can (re)scan a file area for new entries as well as update (`--update`) existing entry records (description, etc.). When scanning, a valid area tag must be specified. Optionally, storage tag may also be supplied in order to scan a specific filesystem location using the `@the_storage_tag` syntax. If a [GLOB](http://man7.org/linux/man-pages/man7/glob.7.html) is supplied as the last argument, only file entries with filenames matching will be processed.

#### Examples
Performing a quick scan of a specific area's storage location ("retro_warez", "retro_warez_games) matching only *.zip extentions:
```
./oputil.js fb scan --quick retro_warez@retro_warez_games *.zip`
```

Update all entries in the "artscene" area supplying the file tags "artscene", and "textmode".
```
./oputil.js fb scan --update --quick --tags artscene,textmode artscene`
```