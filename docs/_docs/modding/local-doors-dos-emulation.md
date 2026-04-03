---
layout: page
title: Local Doors — External DOS Emulators
---
## DOS Doors via External Emulators

This page covers running classic DOS door games using external emulators — DOSEMU and QEMU — via the `abracadabra` module. ENiGMA½ launches the emulator as a child process and bridges I/O over stdio or a socket.

> :information_source: **No emulator on the server?** See [Native v86 Emulation](local-doors-v86.md) — ENiGMA½ includes a built-in x86 emulator. Raw FreeDOS `.img` images are compatible between QEMU and v86, so you can set up your image with QEMU and run it with v86 in production.

---

## DOSEMU

[DOSEMU](http://www.dosemu.org/) provides a DOS environment on Linux via stdio. Configure COM1 as a virtual serial port to connect it to ENiGMA½'s stdio bridge.

### Step 1: Create dosemu.conf

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

`$_com1 = "virtual"` maps COM1 to stdio — ENiGMA½ speaks directly to the door over stdin/stdout.

### Step 2: Create the Door Drive

Create a virtual drive for your door, e.g. `/home/enigma/DOS/X/PW`, and map it in your DOSEMU `AUTOEXEC.BAT`:

```bat
@echo off
path d:\bin;d:\gnu;d:\dosemu
set TEMP=c:\tmp
prompt $P$G
C:\BNU\BNU.COM /L0:57600,8N1 /F
lredir.com x: linux\fs\home\enigma\DOS\X
unix -e
```

[BNU](http://www.pcmicro.com/bnu/) is a FOSSIL driver installed here at `C:\BNU\`. A FOSSIL driver is required by most classic DOS doors.

### Step 3: Menu Entry

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
        ]
        nodeMax: 1
        tooManyArt: DOORMANY
        io: stdio
    }
}
```

---

## QEMU

[QEMU](https://www.qemu.org/) provides a robust, cross-platform solution for DOS doors. The general approach is a bootstrap shell script that prepares a node-specific `GO.BAT`, then launches QEMU with the FreeDOS image.

> :warning: **Multiple concurrent sessions of the same QEMU image are not safe.** Each node needs its own image copy, or use [Native v86 Emulation](local-doors-v86.md) which isolates each session automatically.

### Step 1: Create a FreeDOS Image

Follow the [QEMU/FreeDOS](https://en.wikibooks.org/wiki/QEMU/FreeDOS) guide to create a `freedos_c.img`. Install FreeDOS, then install your door game at `C:\DOORS\LORD\` (or similar).

Transfer files from host to the image using QEMU's vfat drive:

```bash
qemu-system-i386 -localtime /home/enigma/dos/images/freedos_c.img \
    -hdb fat:/path/to/files/to/copy
```

Files appear on `D:` inside FreeDOS. Add to the image's `AUTOEXEC.BAT`:

```bat
CALL E:\GO.BAT
```

### Step 2: Create a Bootstrap Script

This script writes a per-node `GO.BAT` before launching QEMU:

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

qemu-system-i386 -localtime /home/enigma/dos/images/freedos_c.img \
    -chardev socket,port=$SRVPORT,nowait,host=localhost,id=s0 \
    -device isa-serial,chardev=s0 \
    -hdb fat:/home/enigma/drop/node$NODE \
    -hdc fat:/home/enigma/dos/go/node$NODE \
    -nographic
```

- `-chardev socket,...` connects COM1 to ENiGMA½'s socket server on `$SRVPORT`
- `-hdb fat:...` exposes the drop file directory as `D:`
- `-hdc fat:...` exposes the `GO.BAT` directory as `E:`
- `-nographic` runs headless

### Step 3: Menu Entry

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
        ]
        nodeMax: 1
        tooManyArt: DOORMANY
        io: socket
    }
}
```

---

## DOSBox-X

[DOSBox-X](https://dosbox-x.com/) is a graphical DOS environment available on Windows, macOS, and Linux. It is primarily useful for **preparing disk images** — raw `.img` images created in DOSBox-X are compatible with QEMU and with ENiGMA½'s built-in [v86_door](local-doors-v86.md).

Using DOSBox-X as a production door server (launching it per user session) is possible but uncommon. The `imgmount` command can mount raw disk images inside DOSBox-X. See the [DOSBox-X documentation](https://dosbox-x.com/wiki) for details.

---

## See Also
* [Local Doors](local-doors.md)
* [Native v86 Emulation](local-doors-v86.md) — run the same FreeDOS image without QEMU on the server
* [Scripts & Native Binaries](local-doors-abracadabra.md) — abracadabra module reference
* [Telnet Bridge](telnet-bridge.md)
