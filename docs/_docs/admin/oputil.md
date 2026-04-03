---
layout: page
title: oputil
---
## The oputil CLI
ENiGMA½ comes with `oputil.js` henceforth known as `oputil`, a command line interface (CLI) tool for sysops to perform general system and user administration. You likely used oputil to do the initial ENiGMA configuration.

Let's look the main help output as per this writing:

```
usage: oputil.js [--version] [--help]
                  <command> [<arguments>]

Global arguments:
  -c, --config PATH         Specify config path (default is ./config/)
  -n, --no-prompt           Assume defaults (don't prompt for input where possible)
  --verbose                 Verbose output, where applicable

Commands:
  user                      User management
  config                    Configuration management
  fb                        File base management
  mb                        Message base management
```

Commands break up operations by groups:

| Command   | Description   |
|-----------|---------------|
| `user`    | User management   |
| `config`  | System configuration and maintenance |
| `fb`      | File base configuration and management    |
| `mb`      | Message base configuration and management |
| `fat`     | FAT disk image inspection and modification |
| `v86`     | Boot disk images in the v86 x86 emulator |

Global arguments apply to most commands and actions:
* `--config`: Specify configuration directory if it is not the default of `./config/`.
* `--no-prompt`: Assume defaults and do not prompt when possible.

Type `./oputil.js <command> --help` for additional help on a particular command. The following sections will describe them.

## User
The `user` command covers various user operations.

```
usage: oputil.js user <action> [<arguments>]

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

2fa-otp arguments:
  --qr-type TYPE               Specify QR code type

  Valid QR types:
    ascii : Plain ASCII (default)
    data  : HTML data URL
    img   : HTML image tag
    svg   : SVG image

  --out PATH                   Path to write QR code to. defaults to stdout
```

| Action    | Description       | Examples                              | Aliases   |
|-----------|-------------------|---------------------------------------|-----------|
| `info` | Display user information| `./oputil.js user info joeuser` | N/A |
| `pw`        | Set password      | `./oputil.js user pw joeuser s3cr37`  | `passwd`, `password` |
| `rm`        | Removes user      | `./oputil.js user del joeuser`        | `remove`, `del`, `delete` |
| `rename` | Renames a user | `./oputil.js user rename joeuser joe` | `mv` |
| `2fa-otp` | Manage 2FA/OTP for a user | `./oputil.js user 2fa-otp joeuser googleAuth` | `otp`
| `activate` | Activates user    | `./oputil.js user activate joeuser`   | N/A   |
| `deactivate`    | Deactivates user  | `./oputil.js user deactivate joeuser` | N/A   |
| `disable`   | Disables user (user will not be able to login)    | `./oputil.js user disable joeuser`    | N/A   |
| `lock` | Locks the user account (prevents logins) | `./oputil.js user lock joeuser` | N/A |
| `group`   | Modifies users group membership   | Add to group: `./oputil.js user group joeuser +derp`<br/>Remove from group: `./oputil.js user group joeuser ~derp`   | N/A    |

#### Manage 2FA/OTP
While `oputil.js` can be used to manage a user's 2FA/OTP, it is highly recommended to require users to opt-in themselves. See [Security](../configuration/security.md) for details.

## Configuration
The `config` command allows sysops to perform various system configuration and maintenance tasks.

```
usage: oputil.js config <action> [<arguments>]

Actions:
  new                      Generate a new / default configuration

  cat                      Write current configuration to stdout

cat arguments:
  --no-color               Disable color
  --no-comments            Strip any comments
```

| Action    | Description       | Examples                              |
|-----------|-------------------|---------------------------------------|
| `new`     | Generates a new/initial configuration | `./oputil.js config new` (follow the prompts) |
| `cat` | Pretty prints current `config.hjson` configuration to stdout. | `./oputil.js config cat` |

## File Base Management
The `fb` command provides a powerful file base management interface.

```
usage: oputil.js fb <action> [<arguments>]

Actions:
  scan AREA_TAG[@STORAGE_TAG]  Scan specified area

  May contain optional GLOB as last parameter.
  Example: ./oputil.js fb scan d0pew4r3z *.zip

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

General Information:
  Generally an area tag can also include an optional storage tag. For example, the
  area of 'bbswarez' stored using 'bbswarez_main': bbswarez@bbswarez_main

  When performing an initial import of a large area or storage backing, --full
  is the best option. If re-scanning an area for updates a standard / quick scan is
  generally good enough.

  File ID's are those found in file.sqlite3.
```

#### Scan File Area
The `scan` action can (re)scan a file area for new entries as well as update (`--update`) existing entry records (description, etc.). When scanning, a valid area tag must be specified. Optionally, storage tag may also be supplied in order to scan a specific filesystem location using the `@the_storage_tag` syntax. If a [GLOB](https://man7.org/linux/man-pages/man7/glob.7.html) is supplied as the last argument, only file entries with filenames matching will be processed.

##### Examples
Performing a quick scan of a specific area's storage location ("retro_warez", "retro_warez_games) matching only *.zip extensions:
```bash
# note that we must quote the wildcard to prevent shell expansion
$ ./oputil.js fb scan --quick retro_warez@retro_warez_games "*.zip"`
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
usage: oputil.js mb <action> [<arguments>]

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
```

| Action    | Description       | Examples                              |
|-----------|-------------------|---------------------------------------|
| `import-areas`    | Imports areas using a FidoNet style *.NA or AREAS.BBS formatted file. Optionally maps areas to FTN networks.  | `./oputil.js mb import-areas /some/path/l33tnet.na`   |
| `areafix` | Utility for sending AreaFix mails without logging into the system | |
| `qwk-dump` | Dump a QWK packet to stdout | `./oputil.js mb qwk-dump /path/to/XIBALBA.QWK` |
| `qwk-export` | Export messages to a QWK packet | `./oputil.js mb qwk-export /path/to/XIBALBA.QWK` |

When using the `import-areas` action, you will be prompted for any missing additional arguments described in "import-areas args".

## FAT Disk Image Management
The `fat` command lets you inspect and modify raw FAT disk images directly — no running ENiGMA instance or database required. Useful for preparing and maintaining FreeDOS images used by the `v86_door` module.

Works with any partitioned FAT12/16/32 raw disk image (`.img`).

```
usage: oputil.js fat <action> <image.img> [arguments]

Actions:
  ls IMAGE [PATH]             List files and directories in image
  (dir)                       PATH defaults to the root of the partition

  cp IMAGE SRC DST [SRC DST] Copy one or more local files/directories into image
  (copy)                      SRC is a local path; DST is a DOS path within the image
                              Directories are copied recursively

  read IMAGE DOS-PATH         Read a file from the image and write it to stdout
  (cat, type)
```

| Action  | Description | Aliases |
|---------|-------------|---------|
| `ls`    | List files and directories at an optional DOS path | `dir` |
| `cp`    | Copy local files or directories into the image | `copy` |
| `read`  | Read a file from the image and write to stdout | `cat`, `type` |

#### Examples

List files at the root of the image:
```bash
./oputil.js fat ls freedos.img
```

List a subdirectory:
```bash
./oputil.js fat ls freedos.img DOORS/LORD
```

Copy a local directory recursively into the image:
```bash
./oputil.js fat cp freedos.img ./pimpwars/ DOORS/PW/PIMPWARS
```

Copy a single file:
```bash
./oputil.js fat cp freedos.img fdconfig.sys FDCONFIG.SYS
```

Read a file from the image (can be piped):
```bash
./oputil.js fat read freedos.img FDAUTO.BAT
./oputil.js fat read freedos.img FDCONFIG.SYS | less
```

## v86 Emulation Tools
The `v86` command boots raw FreeDOS disk images using the [v86](https://github.com/copy/v86) x86 emulator. Does not require a running ENiGMA instance.

BIOS files default to `misc/v86_bios/seabios.bin` and `misc/v86_bios/vgabios.bin`. Run `misc/install.sh` to download them, or see [Local Doors — v86](../modding/local-doors-v86.md) for details.

```
usage: oputil.js v86 <action> <image.img> [arguments]

Actions:
  console IMAGE               Boot image and wire COM1 to this terminal
                              Useful for verifying door I/O. Ctrl+] to exit.
                              Note: full-screen DOS programs write to VGA RAM
                              and will not appear over serial. Use 'desktop' instead.

  desktop IMAGE               Boot image and open a full VGA DOS desktop in
                              the system browser. Use to install and configure
                              doors. A "Save Image" button downloads the modified
                              image when done.

Options:
  --bios PATH                 Override SeaBIOS path
  --vga-bios PATH             Override VGA BIOS path
  --port PORT                 HTTP port for desktop mode (default: 18086)
  --memory MB                 Guest RAM in MB (default: 64)
```

| Action    | Description |
|-----------|-------------|
| `console` | Boot the image and bridge COM1 to your terminal. Press `Ctrl+]` to exit. |
| `desktop` | Boot the image in a browser with full VGA output. A **Save Image** button lets you download the modified image when done. |

#### console
`console` mode boots the image and bridges COM1 to your terminal. It is useful for monitoring door serial output — for example, verifying that a door's COM1 I/O is working correctly before going live.

```bash
./oputil.js v86 console freedos.img
```

Override BIOS paths:
```bash
./oputil.js v86 console freedos.img --bios /path/to/seabios.bin --vga-bios /path/to/vgabios.bin
```

**Limitations:**

- **Input is not supported.** A `C:\>` prompt will appear (confirming the boot chain and serial output are working), but keystrokes are not forwarded to the shell. This is a limitation of how v86's serial receive interacts with FreeDOS's BIOS INT 14h input — it works for door games that use a FOSSIL driver, but not for interactive shell use. Use `desktop` for an interactive DOS session.
- **Full-screen programs are not visible.** Programs that draw directly to VGA memory (most door games) will not appear over serial. Again, use `desktop` for those.

#### desktop
`desktop` mode starts a local HTTP server, serves the v86 emulator and the disk image, and opens your default browser automatically. The page includes a full VGA canvas and a **Save Image** button to write changes back to disk.

```bash
./oputil.js v86 desktop freedos.img
```

Use a custom HTTP port:
```bash
./oputil.js v86 desktop freedos.img --port 9000
```

Close the browser tab or press `Ctrl+C` to stop the server.

#### A note on image size

`desktop` mode downloads the entire disk image into the browser before booting. Smaller images load faster:

- A minimal FreeDOS installation with a handful of doors fits comfortably in **100–200 MB** and loads in a few seconds on a typical connection.
- A 500 MB image will take noticeably longer, especially when accessed over an SSH tunnel or slow link.
- Prefer lean images: install only what a door needs, and avoid bundling large data files that aren't required at runtime.
- The same advice applies to the live BBS door sessions — smaller images mean less RAM and faster startup for users.
