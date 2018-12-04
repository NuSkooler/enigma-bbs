---
layout: page
title: Local Doors
---
## Local Doors
ENiGMA½ has many ways to add doors to your system. In addition to the many built in door server modules, local doors are of course also supported using the ! The `abracadabra` module!

## The abracadabra Module
The `abracadabra` module provides a generic and flexible solution for many door types. Through this module you can execute native processes & scripts directly, and perform I/O through standard I/O (stdio) or a temporary TCP server.

### Configuration
The `abracadabra` `config` block can contain the following members:
* `name`: Used as a key for tracking number of clients using a particular door.
* `dropFileType`: Specifies the type of drop file to generate (See **Argument Variables** below).
* `cmd`: Path to executable to launch.
* `args`: Array of argument(s) to pass to `cmd`. See below for information on variables that can be used here.
* `cwd`: Set the Current Working Directory for `cmd`. Defaults to the directory of `cmd`.
* `nodeMax`: Max number of nodes that can access this door at once. Uses `name` as a mapping key
* `tooManyArt`: Art file spec to display if too many instances are already in use
* `io`: Where to process I/O. Can be `stdio` or `socket`. When using `stdio`, I/O is input/output from stdin/stdout. When using `socket` a temporary socket server is spawned that can be connected to. The server listens on localhost on `{srvPort}` (see below under Argument Variables).
* `encoding`: Specify the door's encoding. Defaults to `cp437`. Linux binaries for example, often produce `utf8`.

#### Drop File Types
Drop file types specified by `dropFileType`:
* `DOOR`: [DOOR.SYS](http://goldfndr.home.mindspring.com/dropfile/doorsys.htm)
* `DOOR32`: [DOOR32.SYS](https://raw.githubusercontent.com/NuSkooler/ansi-bbs/master/docs/dropfile_formats/door32_sys.txt)
* `DORINFO`: [DORINFOx.DEF](http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm)

#### Argument Variables
The following variables may be used in `args` entries:
* `{node}`: Current node number.
* `{dropFile}`: Drop _filename_ only.
* `{dropFilePath}`: Full path to generated drop file.
* `{userId}`: Current user ID.
* `{userName}`: _Sanitized_ username. Safe for filenames, etc.
* `{userNameRaw}`: _Raw_ username. May not be safe for filenames!
* `{srvPort}`: Temporary server port when `io` is set to `socket`.
* `{cwd}`: Current Working Directory.

Example:
```hjson
args: [
    "-D", "{dropFile}", "-N", "{node}"
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

Next, we create a virtual **X** drive for Pimp Wars to live such as `/enigma-bbs/DOS/X/PW` and map it with a custom `autoexec.bat` file within DOSEMU:
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

### QEMU with abracadabra
[QEMU](http://wiki.qemu.org/Main_Page) provides a robust, cross platform solution for launching doors under many platforms (likely anwywhere Node.js is supported and ENiGMA½ can run). Note however that there is an important and major caveat: **Multiple instances of a particular door/OS image should not be run at once!** Being more flexible means being a bit more complex. Let's look at an example for running L.O.R.D. under a UNIX like system such as Linux or FreeBSD.

Basically we'll be creating a bootstrap shell script that generates a temporary node specific `go.bat` to launch our door. This will be called from `autoexec.bat` within our QEMU FreeDOS partition.

#### Step 1: Create a FreeDOS image
[FreeDOS](http://www.freedos.org/) is a free mostly MS-DOS compatible DOS package that works well for running 16bit doors. Follow the [QEMU/FreeDOS](https://en.wikibooks.org/wiki/QEMU/FreeDOS) guide for creating an `freedos_c.img`. This will contain FreeDOS itself and installed BBS doors.

After this is complete, copy LORD to C:\DOORS\LORD within FreeDOS. An easy way to tranfer files from host to DOS is to use QEMU's vfat as a drive. For example:
```bash
qemu-system-i386 -localtime /home/enigma/dos/images/freedos_c.img -hdb fat:/path/to/downloads
```

With the above you can now copy files from D: to C: within FreeDOS and add the following to it's `autoexec.bat`:
```batch
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

Note the `qemu-system-i386` line. We're telling QEMU to launch and use localtime for the clock, create a character device that connects to our temporary server port on localhost and map that to a serial device. The `-hdb` entry will represent the D: drive where our drop file is generated, while `-hdc` is the path that `GO.BAT` is generated in (`E:\GO.BAT`). Finally we specify `-nographic` to run headless.

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

## Shared Socket Descriptors
As of this writing `DOOR32.SYS` style socket descriptor sharing is **not** supported. Workarounds include using the Telnet Bridge (`telnet_bridge` module) to hook up to local Telnet-accessible door servers such as [NET2BBS](http://pcmicro.com/netfoss/guide/net2bbs.html).

## Additional Resources

### DOSBox
* [DOSBox-X](https://github.com/joncampbell123/dosbox-x)

### Door Downloads & Support Sites
#### General
* http://bbsfiles.com/
* http://bbstorrents.bbses.info/

#### L.O.R.D.
* http://lord.lordlegacy.com/