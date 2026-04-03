---
layout: page
title: Local Doors — Native v86 Emulation
---
## Native DOS Emulation via v86

ENiGMA½ includes a built-in x86/DOS emulator powered by [v86](https://github.com/copy/v86) — a JavaScript x86 emulator that runs entirely within Node.js. The `v86_door` module boots a FreeDOS disk image and bridges COM1 directly to the user's connection, with no external emulator installed on the server.

> :information_source: The emulator runs in a dedicated worker thread, so it does not block ENiGMA½'s event loop. Each active session gets its own isolated emulator instance.

---

### How It Works

1. ENiGMA½ generates the appropriate drop file for the user (DORINFO, DOOR.SYS, etc.)
2. The drop file is written into a small in-memory FAT12 floppy image — no temp files on disk
3. v86 boots the op-supplied FreeDOS disk image from the hard drive (`C:`)
4. The drop file floppy is mounted as `A:` in FreeDOS
5. The door's `AUTOEXEC.BAT` copies the drop file from `A:` and launches the game
6. COM1 serial I/O is bridged directly between v86 and the user's connection
7. When the door exits and FreeDOS powers off, the session ends cleanly

---

### Prerequisites

#### BIOS Files

v86 requires SeaBIOS and a VGA BIOS image. The ENiGMA½ installer (`misc/install.sh`) downloads these automatically to `misc/v86_bios/`. To download manually:

```bash
mkdir -p misc/v86_bios
curl -fL https://github.com/copy/v86/raw/master/bios/seabios.bin -o misc/v86_bios/seabios.bin
curl -fL https://github.com/copy/v86/raw/master/bios/vgabios.bin -o misc/v86_bios/vgabios.bin
```

#### Disk Image

You need a raw FreeDOS disk image (`.img`) with your door game pre-installed. Raw `.img` images are **fully compatible between QEMU, DOSBox-X, and v86** — set up your image with QEMU or DOSBox-X, then point `v86_door` at it on the production server.

---

### Configuration

| Item | Required | Description |
|------|----------|-------------|
| `name` | :+1: | Door name. Used as a key for tracking concurrent sessions. |
| `image` | :+1: | Path to the raw FreeDOS disk image (`.img`). |
| `dropFileType` | :-1: | Drop file to generate and inject onto the `A:` floppy: `DORINFO`, `DOOR`, or `DOOR32`. Omit if the door needs no drop file. |
| `runBatch` | :-1: | Multi-line batch script written to `A:\RUN.BAT` at runtime. Supports [variable substitution](#runbatch-variables). See [One Image, Multiple Doors](#one-image-multiple-doors). |
| `nodeMax` | :-1: | Max concurrent sessions. `0` = unlimited. |
| `tooManyArt` | :-1: | Art spec to display when `nodeMax` is exceeded. |
| `memoryMb` | :-1: | Guest RAM in MB. Default: `64`. |
| `biosPath` | :-1: | Path to SeaBIOS image. Default: `misc/v86_bios/seabios.bin`. |
| `vgaBiosPath` | :-1: | Path to VGA BIOS image. Default: `misc/v86_bios/vgabios.bin`. |

#### Drop File Filenames on A:

| `dropFileType` | Filename on `A:` |
|----------------|-----------------|
| `DORINFO` | `DORINFOx.DEF` (x = node-based suffix per spec) |
| `DOOR` | `DOOR.SYS` |
| `DOOR32` | `door32.sys` |

#### runBatch Variables

When `runBatch` is set, ENiGMA replaces the following variables before writing `RUN.BAT`:

| Variable | Description | Example |
|----------|-------------|---------|
| `{dropFile}` | Drop file filename | `DORINFO1.DEF` |
| `{node}` | Node number | `1` |
| `{baud}` | Baud rate | `57600` |

---

### Example Menu Entry

```hjson
doorPimpWars: {
    desc: Playing PimpWars
    module: v86_door
    config: {
        name: PimpWars
        image: /path/to/images/freedos_doors.img
        dropFileType: DORINFO
        nodeMax: 1
        tooManyArt: DOORMANY
        runBatch:
            '''
            COPY A:\{dropFile} C:\DOORS\PW\
            C:\FOSSIL\X00.SYS
            CD C:\DOORS\PW
            PW.EXE {node}
            ECHO Returning to BBS, please wait... > COM1
            '''
    }
}
```

---

### Image Preparation

Your disk image must contain:
- A working FreeDOS installation
- Your door game(s) installed (e.g. `C:\DOORS\PIMPWARS\`)
- Optionally, a FOSSIL driver such as [X00](http://pcmicro.com/xtalk/x00.html) — required by most classic DOS doors
- An `AUTOEXEC.BAT` (or `FDAUTO.BAT`) that calls `A:\RUN.BAT` and powers off

#### AUTOEXEC.BAT Convention

Set up your image's `AUTOEXEC.BAT` once. ENiGMA writes `RUN.BAT` to `A:` at runtime with the door-specific launch commands:

```bat
CALL A:\RUN.BAT
ECHO Shutting down, please wait... > COM1
FDAPM POWEROFF
```

- **`CALL A:\RUN.BAT`** — executes the per-door launch script ENiGMA injects at runtime
- **`ECHO ... > COM1`** — sends a message to the user's terminal while FreeDOS shuts down (can take a few seconds)
- **`FDAPM POWEROFF`** — shuts FreeDOS down cleanly; placed after the CALL so it always fires even if the door crashes

#### One Image, Multiple Doors

Because `RUN.BAT` is generated at runtime, a single FreeDOS image can host multiple doors. Each door has its own menu entry pointing at the same `image` path with a different `runBatch`:

```hjson
doorPimpWars: {
    module: v86_door
    config: {
        name: PimpWars
        image: /path/to/images/freedos_doors.img
        dropFileType: DORINFO
        nodeMax: 1
        runBatch:
            '''
            COPY A:\{dropFile} C:\DOORS\PW\
            C:\FOSSIL\X00.SYS
            CD C:\DOORS\PW
            PW.EXE {node}
            ECHO Returning to BBS, please wait... > COM1
            '''
    }
}

doorSmurfCombat: {
    module: v86_door
    config: {
        name: SmurfCombat
        image: /path/to/images/freedos_doors.img   // same image
        dropFileType: DOOR
        nodeMax: 1
        runBatch:
            '''
            COPY A:\{dropFile} C:\DOORS\SMURF\
            C:\FOSSIL\X00.SYS
            CD C:\DOORS\SMURF
            SMURF.EXE {node}
            ECHO Returning to BBS, please wait... > COM1
            '''
    }
}
```

> :information_source: Concurrent sessions on the same image file are safe — each worker loads the image into its own isolated memory buffer. `nodeMax: 1` gates single-player doors, but even without it there is no shared state between sessions.

#### FOSSIL Driver

Most classic DOS doors use the [FOSSIL](https://en.wikipedia.org/wiki/FOSSIL) serial interface for COM1 I/O. If your door fails to start or falls back to local mode, a FOSSIL driver is needed. [X00](http://pcmicro.com/xtalk/x00.html) works well with v86.

Load it from `runBatch` (per-door, recommended) rather than `FDCONFIG.SYS` (global):

```bat
C:\FOSSIL\X00.SYS
```

Or in `FDCONFIG.SYS` if all doors on the image need it:

```
DEVICE=C:\FOSSIL\X00.SYS
```

#### Creating the Image with QEMU

```bash
# Create a 500MB raw image
qemu-img create -f raw freedos_mygame.img 500M

# Install FreeDOS (boot from CD)
qemu-system-i386 -hda freedos_mygame.img -cdrom FD14CD.iso -boot d

# Boot into FreeDOS to install your door
qemu-system-i386 -hda freedos_mygame.img

# Transfer files from host using QEMU's vfat driver — files appear on D:
qemu-system-i386 -hda freedos_mygame.img -hdb fat:/path/to/door/files
```

[DOSBox-X](https://dosbox-x.com/) is a graphical alternative for image setup on Windows, macOS, and Linux. See the DOSBox-X documentation for `imgmount`.

#### FreeDOS Boot Configuration for Fast Startup

For ~5 second boot times, configure FreeDOS to use Emergency Mode (no memory managers, no networking). In `FDCONFIG.SYS`:

```
MENUDEFAULT=5,0
```

Ensure the `5?` config block loads your FOSSIL driver:

```
5?DEVICE=C:\FOSSIL\X00.SYS
5?SHELL=C:\FreeDOS\BIN\COMMAND.COM C:\FreeDOS\BIN /E:1024 /P=C:\FDAUTO.BAT
```

---

## See Also
* [Local Doors](local-doors.md)
* [External DOS Emulators](local-doors-dos-emulation.md)
* [Scripts & Native Binaries](local-doors-abracadabra.md)
* [v86](https://github.com/copy/v86) — upstream JavaScript x86 emulator
