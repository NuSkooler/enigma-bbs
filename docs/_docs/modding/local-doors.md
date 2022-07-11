---
layout: page
title: Local Doors
---
## Local Doors
ENiGMA½ has many ways to add doors to your system. In addition to the [many built in door server modules](door-servers.md), local doors are of course also supported using the ! The `abracadabra` module!

:information_source: See also [Let’s add a DOS door to Enigma½ BBS](https://medium.com/retro-future/lets-add-a-dos-game-to-enigma-1-2-41f257deaa3c) by Robbie Whiting for a great writeup on adding doors!

## The abracadabra Module
The `abracadabra` module provides a generic and flexible solution for many door types. Through this module you can execute native processes & scripts directly, and perform I/O through standard I/O (stdio) or a temporary TCP server.

### Configuration
The `abracadabra` `config` block can contain the following members:

| Item | Required | Description |
|------|----------|-------------|
| `name` | :+1: | Used as a key for tracking number of clients using a particular door. |
| `dropFileType` | :-1: | Specifies the type of dropfile to generate (See **Dropfile Types** below). Can be omitted or set to `none`. |
| `cmd` | :+1: | Path to executable to launch. |
| `args` | :-1: | Array of argument(s) to pass to `cmd`. See **Argument Variables** below for information on variables that can be used here.
| `cwd` | :-1: | Sets the Current Working Directory (CWD) for `cmd`. Defaults to the directory of `cmd`. |
| `env` | :-1: | Sets the environment. Supplied in the form of an map: `{ SOME_VAR: "value" }`
| `nodeMax` | :-1: | Max number of nodes that can access this door at once. Uses `name` as a tracking key. |
| `tooManyArt` | :-1: | Art spec to display if too many instances are already in use. |
| `io` | :-1: | How to process input/output (I/O). Can be `stdio` or `socket`. When using `stdio`, I/O is handled via standard stdin/stdout. When using `socket` a temporary socket server is spawned that can be connected back to. The server listens on localhost on `{srvPort}` (See **Argument Variables** below for more information). Default value is `stdio`. |
| `encoding` | :-1: | Sets the **door's** encoding. Defaults to `cp437`. Linux binaries often produce `utf8`. |

#### Dropfile Types
Dropfile types specified by `dropFileType`:

| Value | Description |
|-------|-------------|
| `DOOR` | [DOOR.SYS](https://web.archive.org/web/20160325192739/http://goldfndr.home.mindspring.com/dropfile/doorsys.htm)
| `DOOR32` | [DOOR32.SYS](https://raw.githubusercontent.com/NuSkooler/ansi-bbs/master/docs/dropfile_formats/door32_sys.txt)
| `DORINFO` | [DORINFOx.DEF](https://web.archive.org/web/20160321190038/http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm)

#### Argument Variables
The following variables may be used in `args` entries:

| Variable | Description | Example |
|----------|-------------|---------|
| `{node}` | Current node number. | `1` |
| `{dropFile}` | Dropfile _filename_ only. | `DOOR.SYS` |
| `{dropFilePath}` | Full path to generated dropfile. The system places dropfiles in the path set by `paths.dropFiles` in `config.hjson`. | `C:\enigma-bbs\drop\node1\DOOR.SYS` |
| `{userId}` | Current user ID. | `420` |
| `{userName}` | [Sanitized](https://www.npmjs.com/package/sanitize-filename) username. Safe for filenames, etc. If the full username is sanitized away, this will resolve to something like "user_1234". | `izard` |
| `{userNameRaw}` | _Raw_ username. May not be safe for filenames! | `\/\/izard` |
| `{srvPort}` | Temporary server port when `io` is set to `socket`. | `1234` |
| `{cwd}` | Current Working Directory. | `/home/enigma-bbs/doors/foo/` |

Example `args` member using some variables described above:
```hjson
args: [
    "-D", "{dropFilePath}",
    "-N", "{node}"
    "-U", "{userId}"
]
```

### DOSEMU with abracadabra
[DOSEMU](http://www.dosemu.org/) can provide a good solution for running legacy DOS doors when running on Linux systems. For this, we will create a virtual serial port (COM1) that communicates via stdio.

As an example, here are the steps for setting up Pimp Wars:

First, create a `dosemu.conf` file with the following contents:
```
$_cpu = "80486"
$_cpu_emu = "vm86"
$_external_char_set = "utf8"
$_internal_char_set = "cp437"
$_term_updfreq = (8)
$_layout = "us"
$_rawkeyboard = (0)
$_com1 = "virtual"
```

The line `$_com1 = "virtual"` tells DOSEMU to use `stdio` as a virtual serial port on COM1.

Next, we create a virtual **X** drive for Pimp Wars to live such as `/enigma-bbs/DOS/X/PW` and map it with a custom `AUTOEXEC.BAT` file within DOSEMU:
```
@echo off
path d:\bin;d:\gnu;d:\dosemu
set TEMP=c:\tmp
prompt $P$G
REM http://www.pcmicro.com/bnu/
C:\BNU\BNU.COM /L0:57600,8N1 /F
lredir.com x: linux\fs\enigma-bbs\DOS\X
unix -e
```

Note that we also have the [BNU](http://www.pcmicro.com/bnu/) FOSSIL driver installed at `C:\BNU\\`. Another option would be to install this to X: somewhere as well.

Finally, let's create a `menu.hjson` entry to launch the game:
```hjson
doorPimpWars: {
    desc: Playing PimpWars
    module: abracadabra
    config: {
        name: PimpWars
        dropFileType: DORINFO
        cmd: /usr/bin/dosemu
        args: [
            "-quiet",
            "-f",
            "/path/to/dosemu.conf",
            "X:\\PW\\START.BAT {dropFile} {node}"
        ],
        nodeMax: 1
        tooManyArt: DOORMANY
        io: stdio
    }
}
```

### Shared Socket Descriptors
Due to Node.js limitations, ENiGMA½ does not _directly_ support `DOOR32.SYS` style socket descriptor sharing (other `DOOR32.SYS` features are fully supported). However, a separate binary called [bivrost!](https://github.com/NuSkooler/bivrost) can be used. bivrost! is available for Windows and Linux x86/i686 and x86_64/AMD64. Other platforms where [Rust](https://www.rust-lang.org/) builds are likely to work as well.

#### Example configuration
Below is an example `menu.hjson` entry using bivrost! to launch a door:

```hjson
doorWithBivrost: {
    desc: Bivrost Example
    module: abracadabra
    config: {
        name: BivrostExample
        dropFileType: DOOR32
        cmd: "C:\\enigma-bbs\\utils\\bivrost.exe"
        args: [
            "--port", "{srvPort}",          //  bivrost! will connect this port on localhost
            "--dropfile", "{dropFilePath}", //  ...and read this DOOR32.SYS produced by ENiGMA½
            "--out", "C:\\doors\\jezebel",  //  ...and produce a NEW DOOR32.SYS here.

            //
            //  Note that the final <target> params bivrost! will use to
            //  launch the door are grouped here. The {fd} variable could
            //  also be supplied here if needed.
            //
            "C:\\door\\door.exe C:\\door\\door32.sys"
        ],
        nodeMax: 1
        tooManyArt: DOORMANY
        io: socket
    }
}
```

Please see the [bivrost!](https://github.com/NuSkooler/bivrost) documentation for more information.

#### Phenom Productions Releases
Pre-built binaries of bivrost! have been released under [Phenom Productions](https://www.phenomprod.com/) and can be found on various boards.

#### Alternative Workarounds
Alternative workarounds include [Telnet Bridge module](telnet-bridge.md) to hook up Telnet-accessible (including local) door servers -- It may also be possible bridge via [NET2BBS](http://pcmicro.com/netfoss/guide/net2bbs.html).

### QEMU with abracadabra
[QEMU](http://wiki.qemu.org/Main_Page) provides a robust, cross platform solution for launching doors under many platforms (likely anywhere Node.js is supported and ENiGMA½ can run). Note however that there is an important and major caveat: **Multiple instances of a particular door/OS image should not be run at once!** Being more flexible means being a bit more complex. Let's look at an example for running L.O.R.D. under a UNIX like system such as Linux or FreeBSD.

Basically we'll be creating a bootstrap shell script that generates a temporary node specific `GO.BAT` to launch our door. This will be called from `AUTOEXEC.BAT` within our QEMU FreeDOS partition.

#### Step 1: Create a FreeDOS image
[FreeDOS](http://www.freedos.org/) is a free mostly MS-DOS compatible DOS package that works well for running 16bit doors. Follow the [QEMU/FreeDOS](https://en.wikibooks.org/wiki/QEMU/FreeDOS) guide for creating an `freedos_c.img`. This will contain FreeDOS itself and installed BBS doors.

After this is complete, copy LORD to C:\DOORS\LORD within FreeDOS. An easy way to tranfer files from host to DOS is to use QEMU's vfat as a drive. For example:
```bash
qemu-system-i386 -localtime /home/enigma/dos/images/freedos_c.img -hdb fat:/path/to/downloads
```

With the above you can now copy files from D: to C: within FreeDOS and add the following to it's `autoexec.bat`:
```bat
CALL E:\GO.BAT
```

#### Step 2: Create a bootstrap script
Our bootstrap script will prepare `GO.BAT` and launch FreeDOS. Below is an example:


```bash
#!/bin/bash

NODE=$1
DROPFILE=D:\\$2
SRVPORT=$3

mkdir -p /home/enigma/dos/go/node$NODE

cat > /home/enigma/dos/go/node$NODE/GO.BAT <<EOF
C:
CD \FOSSIL\BNU
BNU.COM
CD \DOORS\LORD
COPY /Y $DROPFILE
CALL START.BAT $NODE
FDAPM POWEROFF
EOF

unix2dos /home/enigma/dos/go/node$NODE/GO.BAT

qemu-system-i386 -localtime /home/enigma/dos/images/freedos_c.img -chardev socket,port=$SRVPORT,nowait,host=localhost,id=s0 -device isa-serial,chardev=s0 -hdb fat:/home/enigma/xibalba/dropfiles/node$NODE -hdc fat:/home/enigma/dos/go/node$NODE -nographic
```

Note the `qemu-system-i386` line. We're telling QEMU to launch and use localtime for the clock, create a character device that connects to our temporary server port on localhost and map that to a serial device. The `-hdb` entry will represent the D: drive where our dropfile is generated, while `-hdc` is the path that `GO.BAT` is generated in (`E:\GO.BAT`). Finally we specify `-nographic` to run headless.

For doors that do not *require* a FOSSIL driver, it is recommended to not load or use one unless you are having issues.

##### Step 3: Create a menu entry
Finally we can create a `menu.hjson` entry using the `abracadabra` module:
```hjson
doorLORD: {
    desc: Playing L.O.R.D.
    module: abracadabra
    config: {
        name: LORD
        dropFileType: DOOR
        cmd: /home/enigma/dos/scripts/lord.sh
        args: [
            "{node}",
            "{dropFile}",
            "{srvPort}",
        ],
        nodeMax: 1
        tooManyArt: DOORMANY
        io: socket
    }
}
```

## See Also
* [Telnet Bridge](telnet-bridge.md)
* [Door Servers](door-servers.md)

## Additional Resources
### DOS Emulation
* [DOSEMU](http://www.dosemu.org/)
* [DOSBox-X](https://github.com/joncampbell123/dosbox-x)

### Door Downloads & Support Sites
#### General
* http://bbsfiles.com/
* http://bbstorrents.bbses.info/

#### L.O.R.D.
* http://lord.lordlegacy.com/
