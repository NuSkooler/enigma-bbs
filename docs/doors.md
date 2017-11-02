# Doors
ENiGMA½ supports a variety of methods for interacting with doors — not limited to:
* `abracadabra` module: Standard in/out (stdio) capture or temporary socket server that can be used with [DOSEMU](http://www.dosemu.org/), [DOSBox](http://www.dosbox.com/), [QEMU](http://wiki.qemu.org/Main_Page), etc.
* `bbs_link` module for interaction with [BBSLink](http://www.bbslink.net/)

## The abracadabra Module
The `abracadabra` module provides a generic and flexible solution for many door types. Through this module you can execute native processes & scripts directly, and process I/O through stdio or a temporary TCP server.

The `abracadabra` `config` block can contain the following:
* `name`: Used as a key for tracking number of clients using a particular door
* `dropFileType`: Specifies the type of drop file to generate (See table below)
* `cmd`: Path to executable to launch
* `args`: Array of argument(s) to pass to `cmd`. See below for information on variables that can be used here.
* `nodeMax`: Max number of nodes that can access this door at once. Uses `name` as a mapping key
* `tooManyArt`: Art file spec to display if too many instances are already in use
* `io`: Where to process I/O. Can be `stdio` or `socket`

Drop file types specified by `dropFileType`:
* `DOOR`: [DOOR.SYS](http://goldfndr.home.mindspring.com/dropfile/doorsys.htm)
* `DOOR32`: [DOOR32.SYS](http://wiki.bbses.info/index.php/DOOR32.SYS)
* `DORINFO`: [DORINFOx.DEF](http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm)

Variables for use in `args`:
* `{node}`: Current node number
* `{dropFile}`: Path to generated drop file
* `{userId}`: Current user ID
* `{srvPort}`: Tempoary server port when `io` is `socket`


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

#### Step 4: Create a menu entry
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


## The bbs_link Module
Native support for [BBSLink](http://www.bbslink.net/) doors is provided via the `bbs_link` module.

Configuration for a BBSLink door is straight forward. Take a look at the following example for launching Tradewars 2002:

```hjson
doorTradeWars2002BBSLink: {
	desc: Playing TW 2002 (BBSLink)
	module: bbs_link
	config: {
		sysCode: XXXXXXXX
		authCode: XXXXXXXX
		schemeCode: XXXXXXXX
		door: tw
	}
}

```

Fill in your credentials in `sysCode`, `authCode`, and `schemeCode` and that's it!

## The door_party Module
The module `door_party` provides native support for [DoorParty!](http://www.throwbackbbs.com/) Configuration is quite easy:

```hjson
doorParty: {
    desc: Using DoorParty!
    module: @systemModule:door_party
    config: {
        username: XXXXXXXX
        password: XXXXXXXX
        bbsTag: XX
    }
}
```

Fill in `username`, `password`, and `bbsTag` with credentials provided to you and you should be in business!

## The CombatNet Module
The `combatnet` module provides native support for [CombatNet](http://combatnet.us/). Add the following to your menu config:

````hjson
combatNet: {
    desc: Using CombatNet
    module: @systemModule:combatnet
    config: {
        bbsTag: CBNxxx
        password: XXXXXXXXX
    }
}
````
Update `bbsTag` (in the format CBNxxx) and `password` with the details provided when you register, then
you should be ready to rock!

# Resources

### DOSBox
* Custom DOSBox builds http://home.arcor.de/h-a-l-9000/

## Door Downloads & Support Sites
### General
* http://bbsfiles.com/
* http://bbstorrents.bbses.info/

### L.O.R.D.
* http://lord.lordlegacy.com/