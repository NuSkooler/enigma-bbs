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
| `config`  | System configuration and maintenance |
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
  rm USERNAME                  permanently removes USERNAME user from system
  activate USERNAME            sets USERNAME's status to active
  deactivate USERNAME          sets USERNAME's status to inactive
  disable USERNAME             sets USERNAME's status to disabled
  lock USERNAME                sets USERNAME's status to locked
  group USERNAME [+|-]GROUP    adds (+) or removes (-) user from GROUP
```

| Action    | Description       | Examples                              | Aliases   |
|-----------|-------------------|---------------------------------------|-----------|
| `pw`        | Set password      | `./oputil.js user pw joeuser s3cr37`  | `pass`, `passwd`, `password` |
| `rm`        | Removes user      | `./oputil.js user del joeuser`        | `remove`, `del`, `delete` |
| `activate` | Activates user    | `./oputil.js user activate joeuser`   | N/A   |
| `deactivate`    | Deactivates user  | `./oputil.js user deactivate joeuser` | N/A   |
| `disable`   | Disables user (user will not be able to login)    | `./oputil.js user disable joeuser`    | N/A   |
| `lock` | Locks the user account (prevents logins) | `./oputil.js user lock joeuser` | N/A |
| `group`   | Modifies users group membership   | Add to group: `./oputil.js user group joeuser +derp`<br/>Remove from group: `./oputil.js user group joeuser -derp`   | N/A    |

## Configuration
The `config` command allows sysops to perform various system configuration and maintenance tasks.

```
usage: optutil.js config <action> [<args>]

actions:
  new                      generate a new/initial configuration  
  cat                      cat current configuration to stdout

cat args:
  --no-color               disable color
  --no-comments            strip any comments
```

| Action    | Description       | Examples                              |
|-----------|-------------------|---------------------------------------|
| `new`     | Generates a new/initial configuration | `./oputil.js config new` (follow the prompts) |
| `cat` | Pretty prints current `config.hjson` configuration to stdout. | `./oputil.js config cat` |

## File Base Management
The `fb` command provides a powerful file base management interface.

```
usage: oputil.js fb <action> [<args>]

actions:
  scan AREA_TAG[@STORAGE_TAG]  scan specified area
                               may also contain optional GLOB as last parameter,
                               for example: scan some_area *.zip

  info CRITERIA                display information about areas and/or files
                               where CRITERIA is one of the following:
                               AREA_TAG|SHA|FILE_ID|FILENAME_WC
                               SHA may be a full or partial SHA-256

  mv SRC [SRC...] DST          move entry(s) from SRC to DST
                               SRC: FILENAME_WC|SHA|FILE_ID|AREA_TAG[@STORAGE_TAG]
                               DST: AREA_TAG[@STORAGE_TAG]

  rm SRC [SRC...]              remove entry(s) from the system matching SRC
                               SRC: FILENAME_WC|SHA|FILE_ID|AREA_TAG[@STORAGE_TAG]
  import-areas FILEGATE.ZXX    import file base areas using FileGate RAID type format

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

import-areas args:
  --type TYPE                  sets import areas type. valid options are "zxx" or "na"
  --create-dirs                create backing storage directories

general information:
  AREA_TAG[@STORAGE_TAG]       can specify an area tag and optionally, a storage specific tag
                               example: retro@bbs
  
  FILENAME_WC                  filename with * and ? wildcard support. may match 0:n entries
  SHA                          full or partial SHA-256
  FILE_ID                      a file identifier. see file.sqlite3
```

#### Scan File Area
The `scan` action can (re)scan a file area for new entries as well as update (`--update`) existing entry records (description, etc.). When scanning, a valid area tag must be specified. Optionally, storage tag may also be supplied in order to scan a specific filesystem location using the `@the_storage_tag` syntax. If a [GLOB](http://man7.org/linux/man-pages/man7/glob.7.html) is supplied as the last argument, only file entries with filenames matching will be processed.

##### Examples
Performing a quick scan of a specific area's storage location ("retro_warez", "retro_warez_games) matching only *.zip extensions:
```bash
$ ./oputil.js fb scan --quick retro_warez@retro_warez_games *.zip`
```

Update all entries in the "artscene" area supplying the file tags "artscene", and "textmode".
```bash
$ ./oputil.js fb scan --update --quick --tags artscene,textmode artscene`
```

Scan "oldschoolbbs" area using the description file at "/path/to/DESCRIPT.ION":
```
$ ./oputil.js fb scan --desc-file /path/to/DESCRIPT.ION oldschoolbbs
```

#### Retrieve Information
The `info` action can retrieve information about an area or file entry(s).

##### Examples
Information about a particular area:
```bash
./oputil.js fb info retro_pc
areaTag: retro_pc
name: Retro PC
desc: Oldschool / retro PC
storageTag: retro_pc_tdc_1990 => /file_base/dos/tdc/1990
storageTag: retro_pc_tdc_1991 => /file_base/dos/tdc/1991
storageTag: retro_pc_tdc_1992 => /file_base/dos/tdc/1992
storageTag: retro_pc_tdc_1993 => /file_base/dos/tdc/1993
```

Perhaps we want to fetch some information about a file in which we know piece of the filename:
```bash
./oputil.js fb info "impulse*"
file_id: 143
sha_256: 547299301254ccd73eba4c0ec9cd6ab8c5929fbb655e72c4cc842f11332792d4
area_tag: impulse_project
storage_tag: impulse_project
path: /file_base/impulse_project/impulseproject01.tar.gz
hashTags: impulse.project,8bit.music,cid
uploaded: 2018-03-10T11:36:41-07:00
dl_count: 23
archive_type: application/gzip
byte_size: 114313
est_release_year: 2015
file_crc32: fc6655d
file_md5: 3455f74bbbf9539e69bd38f45e039a4e
file_sha1: 558fab3b49a8ac302486e023a3c2a86bd4e4b948
```

### Importing FileGate RAID Style Areas
Given a FileGate "RAID" style `FILEGATE.ZXX` file, one can import areas. This format also often comes in FTN-style info packs in the form of a `.NA` file i.e.: `FILEBONE.NA`.

#### Example
```bash
./oputil.js fb import-areas FILEGATE.ZXX --create-dirs
```

-or-

```bash
# fsxNet info packs contain a FSX_FILE.NA file
./oputil.js fb import-areas FSX_FILE.NA --create-dirs --type NA
```

The above command will process FILEGATE.ZXX creating areas and backing directories. Directories created are relative to the `fileBase.areaStoragePrefix` `config.hjson` setting.

## Message Base Management
The `mb` command provides various Message Base related tools:

```
usage: oputil.js mb <action> [<args>]

actions:
  areafix CMD1 CMD2 ... ADDR  sends an AreaFix NetMail to ADDR with the supplied command(s)
                              one or more commands may be supplied. commands that are multi
                              part such as "%COMPRESS ZIP" should be quoted.
  import-areas PATH           import areas using fidonet *.NA or AREAS.BBS file from PATH

import-areas args:
  --conf CONF_TAG             conference tag in which to import areas
  --network NETWORK           network name/key to associate FTN areas
  --uplinks UL1,UL2,...       one or more comma separated uplinks
  --type TYPE                 area import type. valid options are "bbs" and "na"
```

| Action    | Description       | Examples                              |
|-----------|-------------------|---------------------------------------|
| `import-areas`    | Imports areas using a FidoNet style *.NA or AREAS.BBS formatted file. Optionally maps areas to FTN networks.  | `./oputil.js config import-areas /some/path/l33tnet.na`   |

When using the `import-areas` action, you will be prompted for any missing additional arguments described in "import-areas args".
